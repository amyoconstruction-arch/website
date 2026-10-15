-- Apply after schema.sql. Preserves all existing enquiry records.
begin;
alter table public.inquiries add column if not exists status text not null default 'new';
alter table public.inquiries add column if not exists admin_notes text not null default '';
alter table public.inquiries add column if not exists updated_at timestamptz not null default now();
alter table public.inquiries add column if not exists updated_by text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inquiries'::regclass and conname = 'inquiries_status_allowed') then
    alter table public.inquiries add constraint inquiries_status_allowed check (status in ('new','contacted','quoted','won','closed'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.inquiries'::regclass and conname = 'inquiries_admin_notes_length') then
    alter table public.inquiries add constraint inquiries_admin_notes_length check (char_length(admin_notes) <= 4000);
  end if;
end $$;
create index if not exists inquiries_status_created_idx on public.inquiries (status, created_at desc);

-- A blanket NOT VALID check would also reject later status updates of older
-- blank-phone records. Validate only inserts and actual changes to phone.
create or replace function public.validate_inquiry_phone() returns trigger
language plpgsql set search_path = '' as $$ begin
  if TG_OP = 'INSERT' or NEW.phone is distinct from OLD.phone then
    if NEW.phone is null or char_length(NEW.phone) > 30
      or NEW.phone !~ '^[+0-9[:space:]().-]+$'
      or char_length(regexp_replace(NEW.phone, '[^0-9]', '', 'g')) not between 7 and 15 then
      raise exception 'A valid phone number is required' using errcode = '23514';
    end if;
  end if;
  return NEW;
end $$;
drop trigger if exists validate_inquiry_phone_trigger on public.inquiries;
create trigger validate_inquiry_phone_trigger before insert or update of phone
  on public.inquiries for each row execute function public.validate_inquiry_phone();

create or replace function public.touch_inquiry_updated_at() returns trigger
language plpgsql set search_path = '' as $$ begin
  NEW.updated_at := clock_timestamp();
  return NEW;
end $$;
drop trigger if exists touch_inquiry_updated_at_trigger on public.inquiries;
create trigger touch_inquiry_updated_at_trigger before update on public.inquiries
  for each row execute function public.touch_inquiry_updated_at();

create table if not exists public.admin_auth_attempts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('send-link','authenticate')),
  client_hash text not null check (client_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists admin_auth_attempts_window_idx on public.admin_auth_attempts (kind, created_at);
create table if not exists public.admin_revoked_sessions (
  session_id uuid primary key,
  user_id uuid not null,
  revoked_at timestamptz not null default clock_timestamp()
);
alter table public.admin_auth_attempts enable row level security;
alter table public.admin_revoked_sessions enable row level security;
revoke all on table public.admin_auth_attempts, public.admin_revoked_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_auth_attempts, public.admin_revoked_sessions to service_role;

-- Serializes the single permitted account's attempts across every server/IP.
create or replace function public.admin_rate_limit(p_kind text, p_client_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_global bigint; v_ip bigint;
begin
  if p_kind not in ('send-link','authenticate') or p_kind is null
    or p_client_hash is null or p_client_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid rate-limit parameters' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('amyo-admin-auth-rate-limit', 0));
  delete from public.admin_auth_attempts where created_at < v_now - interval '1 day';
  if p_kind = 'send-link' then
    if exists (select 1 from public.admin_auth_attempts where kind = p_kind and created_at > v_now - interval '1 minute') then
      return jsonb_build_object('allowed', false, 'retryAfter', 60);
    end if;
    select count(*), count(*) filter (where client_hash = p_client_hash) into v_global, v_ip
      from public.admin_auth_attempts where kind = p_kind and created_at > v_now - interval '1 hour';
    if v_global >= 2 or v_ip >= 2 then
      return jsonb_build_object('allowed', false, 'retryAfter', 3600);
    end if;
  else
    select count(*), count(*) filter (where client_hash = p_client_hash) into v_global, v_ip
      from public.admin_auth_attempts where kind = p_kind and created_at > v_now - interval '15 minutes';
    if v_global >= 20 or v_ip >= 5 then
      return jsonb_build_object('allowed', false, 'retryAfter', 900);
    end if;
  end if;
  insert into public.admin_auth_attempts (kind, client_hash) values (p_kind, p_client_hash);
  return jsonb_build_object('allowed', true);
end $$;

-- Access JWTs alone can survive sign-out. Check the server's session row on
-- every request, including an absolute eight-hour session lifetime.
create or replace function public.admin_session_active(p_user_id uuid, p_session_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object('active', true, 'expiresAt', s.created_at + interval '8 hours')
    from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = p_session_id and s.user_id = p_user_id
      and lower(u.email) = 'amyoconstruction@gmail.com'
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now())
      and s.created_at > now() - interval '8 hours'
      and (s.not_after is null or s.not_after > now())
      and not exists (select 1 from public.admin_revoked_sessions r where r.session_id = s.id)
  ), jsonb_build_object('active', false));
$$;

create or replace function public.admin_revoke_session(p_user_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$ begin
  if not exists (select 1 from auth.users where id = p_user_id and lower(email) = 'amyoconstruction@gmail.com' and email_confirmed_at is not null) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  -- The server passes IDs obtained from a remotely verified access token.
  insert into public.admin_revoked_sessions (session_id, user_id) values (p_session_id, p_user_id)
    on conflict (session_id) do nothing;
  delete from public.admin_revoked_sessions where revoked_at < now() - interval '9 hours';
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_list_inquiries(p_page integer, p_status text, p_q text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if p_page is null or p_page not between 1 and 10000
    or p_status is null or p_status not in ('all','new','contacted','quoted','won','closed')
    or p_q is null or char_length(p_q) > 120 then
    raise exception 'Invalid filter' using errcode = '22023';
  end if;
  with matched as (
    select i.* from public.inquiries i
    where (p_status = 'all' or i.status = p_status)
      and (p_q = '' or position(lower(p_q) in lower(concat_ws(' ', i.name, i.email, i.phone, i.location, i.service, i.description))) > 0)
  ), paged as (
    select * from matched order by created_at desc, request_id desc limit 25 offset (p_page - 1) * 25
  ) select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(p) - 'request_fingerprint' order by p.created_at desc, p.request_id desc) from paged p), '[]'::jsonb),
    'total', (select count(*) from matched), 'page', p_page, 'pageSize', 25
  ) into v_result;
  return v_result;
end $$;

create or replace function public.admin_update_inquiry(p_request_id uuid, p_status text, p_notes text, p_updated_at timestamptz)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_item public.inquiries;
begin
  if p_request_id is null or p_updated_at is null or p_status is null
    or p_status not in ('new','contacted','quoted','won','closed')
    or p_notes is null or char_length(p_notes) > 4000 then
    raise exception 'Invalid update' using errcode = '22023';
  end if;
  select * into v_item from public.inquiries where request_id = p_request_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_item.updated_at is distinct from p_updated_at then
    return jsonb_build_object('status', 'conflict', 'item', to_jsonb(v_item) - 'request_fingerprint');
  end if;
  update public.inquiries set status = p_status, admin_notes = p_notes,
    updated_by = 'amyoconstruction@gmail.com'
    where request_id = p_request_id returning * into v_item;
  return jsonb_build_object('status', 'updated', 'item', to_jsonb(v_item) - 'request_fingerprint');
end $$;

revoke all on function public.validate_inquiry_phone(), public.touch_inquiry_updated_at() from public, anon, authenticated;
revoke all on function public.admin_rate_limit(text,text), public.admin_session_active(uuid,uuid), public.admin_revoke_session(uuid,uuid), public.admin_list_inquiries(integer,text,text), public.admin_update_inquiry(uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.admin_rate_limit(text,text), public.admin_session_active(uuid,uuid), public.admin_revoke_session(uuid,uuid), public.admin_list_inquiries(integer,text,text), public.admin_update_inquiry(uuid,text,text,timestamptz) to service_role;
-- Reassert no browser access even if this migration is rerun.
alter table public.inquiries enable row level security;
revoke all on table public.inquiries from public, anon, authenticated;
commit;
