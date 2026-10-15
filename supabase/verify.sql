-- Run after schema.sql in the AMYO Supabase SQL editor.
-- Uses synthetic data and service_role privileges, then ROLLS BACK every write.
-- Expected: all assertions succeed and the PASS result is returned.
-- If any assertion fails, run ROLLBACK; before inspecting/retrying.
-- If execution happens across a half-hour boundary, rerun the rate-limit test.
begin;
set local role service_role;

do $$
declare
  v_first_id uuid := gen_random_uuid();
  v_next_id uuid;
  v_ids uuid[] := array[]::uuid[];
  v_client_hash text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_fingerprint text := repeat('b', 64);
  v_payload jsonb := jsonb_build_object(
    'service', 'Renovation',
    'propertyType', 'Residential',
    'location', 'Synthetic verification location',
    'timeline', 'Verification only',
    'budget', 'Not applicable',
    'description', 'Synthetic deployment verification. This transaction will be rolled back.',
    'name', 'AMYO Deployment Verification',
    'email', 'verification@example.invalid',
    'phone', '+1 202 555 0147',
    'consent', true
  );
  v_result jsonb;
  v_count integer;
  v_role text;
  v_relation text;
  v_privilege text;
  v_consent_rejected boolean := false;
begin
  if current_user <> 'service_role' then
    raise exception 'FAIL: integration test must execute as service_role';
  end if;

  -- Verify the anonymous and signed-in browser roles cannot invoke the RPC
  -- or use the tables directly. No browser role receives a public RLS policy.
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_role, 'public.submit_inquiry(uuid,jsonb,text,text)', 'EXECUTE') then
      raise exception 'FAIL: % can execute submit_inquiry', v_role;
    end if;
    foreach v_relation in array array['public.inquiries', 'public.inquiry_rate_limits'] loop
      foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(v_role, v_relation, v_privilege) then
          raise exception 'FAIL: % has % on %', v_role, v_privilege, v_relation;
        end if;
      end loop;
      if not (select relrowsecurity from pg_class where oid = v_relation::regclass) then
        raise exception 'FAIL: RLS is not enabled on %', v_relation;
      end if;
    end loop;
  end loop;

  v_result := public.submit_inquiry(v_first_id, v_payload, v_fingerprint, v_client_hash);
  if v_result ->> 'status' is distinct from 'created' then
    raise exception 'FAIL: initial create returned %', v_result;
  end if;
  v_ids := array_append(v_ids, v_first_id);

  v_result := public.submit_inquiry(v_first_id, v_payload, v_fingerprint, v_client_hash);
  if v_result ->> 'status' is distinct from 'duplicate' then
    raise exception 'FAIL: identical retry returned %', v_result;
  end if;

  v_result := public.submit_inquiry(
    v_first_id,
    v_payload || jsonb_build_object('description', 'Different synthetic enquiry content for conflict verification.'),
    repeat('c', 64),
    v_client_hash
  );
  if v_result ->> 'status' is distinct from 'conflict' then
    raise exception 'FAIL: changed-payload retry returned %', v_result;
  end if;

  -- Four further unique submissions reach five accepted enquiries. Neither
  -- the duplicate nor the conflict above may consume another allowance.
  for i in 2..5 loop
    v_next_id := gen_random_uuid();
    v_result := public.submit_inquiry(v_next_id, v_payload, v_fingerprint, v_client_hash);
    if v_result ->> 'status' is distinct from 'created' then
      raise exception 'FAIL: allowed submission % returned %', i, v_result;
    end if;
    v_ids := array_append(v_ids, v_next_id);
  end loop;

  v_next_id := gen_random_uuid();
  v_result := public.submit_inquiry(v_next_id, v_payload, v_fingerprint, v_client_hash);
  if v_result ->> 'status' is distinct from 'rate_limited'
    or (v_result ->> 'retryAfter')::numeric not between 1 and 1800 then
    raise exception 'FAIL: sixth unique submission returned %', v_result;
  end if;
  if exists (select 1 from public.inquiries where request_id = v_next_id) then
    raise exception 'FAIL: rate-limited enquiry was inserted';
  end if;

  -- An existing request must remain safely retryable after the rate limit.
  v_result := public.submit_inquiry(v_first_id, v_payload, v_fingerprint, v_client_hash);
  if v_result ->> 'status' is distinct from 'duplicate' then
    raise exception 'FAIL: retry after rate limit returned %', v_result;
  end if;

  select count(*) into v_count from public.inquiries where request_id = any(v_ids);
  if v_count <> 5 then
    raise exception 'FAIL: expected five stored synthetic enquiries, found %', v_count;
  end if;
  if not exists (
    select 1 from public.inquiries where request_id = v_first_id
      and name = 'AMYO Deployment Verification'
      and email = 'verification@example.invalid'
      and consent = true and consent_at is not null
      and consent_version = 'project-enquiry-v1'
  ) then
    raise exception 'FAIL: payload or consent audit fields were not saved';
  end if;

  -- Database validation still rejects false consent even if the API is bypassed.
  begin
    perform public.submit_inquiry(
      gen_random_uuid(), v_payload || jsonb_build_object('consent', false),
      v_fingerprint, v_client_hash
    );
  exception when sqlstate '22023' then
    v_consent_rejected := true;
  end;
  if not v_consent_rejected then
    raise exception 'FAIL: database accepted false consent';
  end if;

  raise notice 'PASS: create, duplicate, conflict, rate limit, consent and browser-access assertions passed. Rolling back all synthetic writes.';
end;
$$;

select 'PASS: create, duplicate, conflict, sixth-request rate limit, retry after rate limit, consent and anonymous/authenticated access checks. All synthetic writes are rolled back.' as verification_result;
rollback;
