-- Run once in the AMYO-owned Supabase project's SQL editor.
-- Re-running this initial schema is safe; it does not delete existing enquiries.
-- Browser clients have no direct read/write or RPC access. The Vercel function
-- uses a server-only Supabase secret key (or legacy service_role key).
begin;

create table if not exists public.inquiries (
  request_id uuid primary key,
  created_at timestamptz not null default now(),
  service text not null check (char_length(service) between 2 and 100),
  property_type text not null check (char_length(property_type) between 2 and 80),
  location text not null check (char_length(location) between 2 and 160),
  timeline text not null check (char_length(timeline) between 2 and 100),
  budget text not null default '' check (char_length(budget) <= 100),
  description text not null check (char_length(description) between 10 and 4000),
  name text not null check (char_length(name) between 2 and 120),
  email text not null check (char_length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  phone text not null default '' check (char_length(phone) <= 30),
  consent boolean not null check (consent = true),
  consent_at timestamptz not null default now(),
  consent_version text not null default 'project-enquiry-v1',
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$')
);

create index if not exists inquiries_created_at_idx on public.inquiries (created_at desc);
alter table public.inquiries enable row level security;
revoke all on table public.inquiries from public, anon, authenticated;
grant select, insert, update, delete on table public.inquiries to service_role;

-- Only an HMAC of the client IP is retained, never the raw IP. Buckets older
-- than two days are deleted during subsequent submissions.
create table if not exists public.inquiry_rate_limits (
  client_hash text not null check (client_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  attempts integer not null check (attempts between 1 and 5),
  primary key (client_hash, window_start)
);
create index if not exists inquiry_rate_limits_expiry_idx on public.inquiry_rate_limits (window_start);
alter table public.inquiry_rate_limits enable row level security;
revoke all on table public.inquiry_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.inquiry_rate_limits to service_role;

create or replace function public.submit_inquiry(
  p_request_id uuid,
  p_payload jsonb,
  p_fingerprint text,
  p_client_hash text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing text;
  v_now timestamptz := clock_timestamp();
  v_window timestamptz := to_timestamp(floor(extract(epoch from v_now) / 1800) * 1800);
  v_attempts integer;
begin
  if p_request_id is null or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_client_hash is null or p_client_hash !~ '^[0-9a-f]{64}$'
    or (p_payload -> 'consent') is distinct from 'true'::jsonb then
    raise exception 'Invalid enquiry payload' using errcode = '22023';
  end if;

  -- Serialize matching request IDs. Concurrent retries are checked before
  -- counting against the rate limit and cannot insert duplicate enquiries.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select request_fingerprint into v_existing
    from public.inquiries where request_id = p_request_id;
  if found then
    if v_existing = p_fingerprint then
      return jsonb_build_object('status', 'duplicate');
    end if;
    return jsonb_build_object('status', 'conflict');
  end if;

  delete from public.inquiry_rate_limits where window_start < v_now - interval '2 days';
  insert into public.inquiry_rate_limits as limiter (client_hash, window_start, attempts)
    values (p_client_hash, v_window, 1)
    on conflict (client_hash, window_start) do update
      set attempts = limiter.attempts + 1
      where limiter.attempts < 5
    returning attempts into v_attempts;
  if not found then
    return jsonb_build_object(
      'status', 'rate_limited',
      'retryAfter', greatest(1, ceil(extract(epoch from (v_window + interval '30 minutes' - v_now))))
    );
  end if;

  insert into public.inquiries (
    request_id, service, property_type, location, timeline, budget,
    description, name, email, phone, consent, request_fingerprint
  ) values (
    p_request_id, p_payload ->> 'service', p_payload ->> 'propertyType',
    p_payload ->> 'location', p_payload ->> 'timeline', coalesce(p_payload ->> 'budget', ''),
    p_payload ->> 'description', p_payload ->> 'name', p_payload ->> 'email',
    coalesce(p_payload ->> 'phone', ''), true, p_fingerprint
  );
  return jsonb_build_object('status', 'created');
end;
$$;

revoke all on function public.submit_inquiry(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.submit_inquiry(uuid, jsonb, text, text) to service_role;

comment on table public.inquiries is 'Private AMYO project enquiries. Review only in the authorized Supabase dashboard; no public read or write policies.';
comment on function public.submit_inquiry(uuid, jsonb, text, text) is 'Server-only atomic submission with UUID idempotency and five enquiries per hashed client IP per 30-minute window.';

commit;
