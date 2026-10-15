-- Run after schema.sql and admin.sql in the AMYO Supabase SQL editor as
-- the table owner (normally postgres). Test rows and table changes ROLL BACK.
-- PostgreSQL identity sequences may advance; harmless ID gaps are expected.
-- No real enquiry, Auth user, Auth session or credential is created/deleted.
-- The phone trigger is briefly disabled only to construct a synthetic legacy
-- blank-phone fixture, then restored before testing. The transaction holds
-- table locks until rollback, so run this short verification when convenient.
-- Auth rate-limit rows are isolated under the same advisory lock as the RPC;
-- their original contents are restored by rollback. No email is sent.
-- If any assertion fails, run ROLLBACK; before retrying or investigating.
begin;

do $$
declare
  v_id uuid := gen_random_uuid();
  v_marker text := 'AMYO-ADMIN-VERIFY-' || gen_random_uuid()::text;
begin
  perform set_config('amyo.verify_legacy_id', v_id::text, true);
  perform set_config('amyo.verify_marker', v_marker, true);
  -- ALTER TABLE takes a transactional lock; concurrent requests cannot see
  -- or use the temporary trigger change. It is restored before role changes.
  alter table public.inquiries disable trigger validate_inquiry_phone_trigger;
  insert into public.inquiries (
    request_id, service, property_type, location, timeline, budget,
    description, name, email, phone, consent, request_fingerprint
  ) values (
    v_id, 'Renovation', 'Residential', 'Synthetic verification location',
    'Verification only', 'Not applicable', v_marker || ' legacy fixture',
    'AMYO Admin Verification', 'verification@example.invalid', '', true,
    repeat('b', 64)
  );
  alter table public.inquiries enable trigger validate_inquiry_phone_trigger;
end $$;

set local role service_role;

do $$
declare
  v_legacy uuid := current_setting('amyo.verify_legacy_id')::uuid;
  v_marker text := current_setting('amyo.verify_marker');
  v_id uuid;
  v_result jsonb;
  v_before timestamptz;
  v_after timestamptz;
  v_payload jsonb;
  v_role text;
  v_table text;
  v_privilege text;
  v_signature text;
  v_bad_phone text;
  v_rejected boolean;
  v_hash text := encode(sha256(gen_random_uuid()::text::bytea), 'hex');
begin
  if current_user <> 'service_role' then
    raise exception 'FAIL: assertions must execute as service_role';
  end if;

  -- Browser roles cannot bypass the Vercel authorization layer through REST,
  -- RPC, or direct access to Auth session rows.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_table in array array[
      'public.inquiries', 'public.inquiry_rate_limits',
      'public.admin_auth_attempts', 'public.admin_revoked_sessions',
      'auth.sessions'
    ] loop
      foreach v_privilege in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(v_role, v_table, v_privilege) then
          raise exception 'FAIL: % has % on %', v_role, v_privilege, v_table;
        end if;
      end loop;
      if v_table like 'public.%' and not (
        select relrowsecurity from pg_class where oid = v_table::regclass
      ) then
        raise exception 'FAIL: RLS is disabled on %', v_table;
      end if;
    end loop;
    foreach v_signature in array array[
      'public.submit_inquiry(uuid,jsonb,text,text)',
      'public.admin_rate_limit(text,text)',
      'public.admin_session_active(uuid,uuid)',
      'public.admin_revoke_session(uuid,uuid)',
      'public.admin_list_inquiries(integer,text,text)',
      'public.admin_update_inquiry(uuid,text,text,timestamptz)',
      'public.validate_inquiry_phone()', 'public.touch_inquiry_updated_at()'
    ] loop
      if has_function_privilege(v_role, v_signature, 'EXECUTE') then
        raise exception 'FAIL: % can execute %', v_role, v_signature;
      end if;
    end loop;
  end loop;
  foreach v_signature in array array[
    'public.admin_rate_limit(text,text)',
    'public.admin_session_active(uuid,uuid)',
    'public.admin_revoke_session(uuid,uuid)',
    'public.admin_list_inquiries(integer,text,text)',
    'public.admin_update_inquiry(uuid,text,text,timestamptz)'
  ] loop
    if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'FAIL: service_role cannot execute %', v_signature;
    end if;
  end loop;

  -- The only session result exposed by the authorized helper is a status.
  -- Null and unknown IDs must fail closed without touching Auth tables.
  v_result := public.admin_session_active(null, null);
  if v_result is distinct from '{"active":false}'::jsonb then
    raise exception 'FAIL: missing session did not fail closed';
  end if;
  v_result := public.admin_session_active(gen_random_uuid(), gen_random_uuid());
  if v_result is distinct from '{"active":false}'::jsonb then
    raise exception 'FAIL: unknown session did not fail closed';
  end if;
  if public.admin_session_active(gen_random_uuid(),null) is distinct from '{"active":false}'::jsonb
    or public.admin_session_active(null,gen_random_uuid()) is distinct from '{"active":false}'::jsonb then
    raise exception 'FAIL: a partially missing session did not fail closed';
  end if;
  v_rejected := false;
  begin
    perform public.admin_revoke_session(gen_random_uuid(), gen_random_uuid());
  exception when insufficient_privilege then v_rejected := true;
  end;
  if not v_rejected then raise exception 'FAIL: unknown user could revoke a session'; end if;

  -- Legacy blanks stay blank and remain eligible for admin-only edits.
  select updated_at into v_before from public.inquiries where request_id = v_legacy;
  v_result := public.admin_update_inquiry(v_legacy, 'contacted', 'Synthetic review note', v_before);
  if v_result ->> 'status' is distinct from 'updated'
    or v_result #>> '{item,phone}' is distinct from ''
    or v_result #>> '{item,status}' is distinct from 'contacted'
    or v_result #>> '{item,admin_notes}' is distinct from 'Synthetic review note'
    or v_result #>> '{item,updated_by}' is distinct from 'amyoconstruction@gmail.com'
    or (v_result -> 'item') ? 'request_fingerprint' then
    raise exception 'FAIL: legacy blank-phone update or response projection failed';
  end if;
  v_after := (v_result #>> '{item,updated_at}')::timestamptz;
  if v_after <= v_before then raise exception 'FAIL: update revision did not advance'; end if;
  v_result := public.admin_update_inquiry(v_legacy, 'quoted', 'Stale edit', v_before);
  if v_result ->> 'status' is distinct from 'conflict' then
    raise exception 'FAIL: stale update did not return conflict';
  end if;
  if (select status from public.inquiries where request_id = v_legacy) <> 'contacted' then
    raise exception 'FAIL: stale update changed stored status';
  end if;
  v_result := public.admin_update_inquiry(gen_random_uuid(), 'new', '', v_after);
  if v_result ->> 'status' is distinct from 'not_found' then
    raise exception 'FAIL: missing enquiry was not reported';
  end if;

  -- Enforce the allowlist at both RPC and table layers, including notes caps.
  v_rejected := false;
  begin
    perform public.admin_update_inquiry(v_legacy, 'unexpected-status', '', v_after);
  exception when invalid_parameter_value then v_rejected := true;
  end;
  if not v_rejected then raise exception 'FAIL: RPC accepted an unknown status'; end if;
  v_rejected := false;
  begin
    update public.inquiries set status = 'unexpected-status' where request_id = v_legacy;
  exception when check_violation then v_rejected := true;
  end;
  if not v_rejected then raise exception 'FAIL: table accepted an unknown status'; end if;
  v_rejected := false;
  begin
    perform public.admin_update_inquiry(v_legacy, 'contacted', repeat('n',4001), v_after);
  exception when invalid_parameter_value then v_rejected := true;
  end;
  if not v_rejected then raise exception 'FAIL: RPC accepted oversized notes'; end if;

  -- Phone is required for new submissions, while old values are not invented.
  v_payload := jsonb_build_object(
    'service','Renovation','propertyType','Residential',
    'location','Synthetic verification location','timeline','Verification only',
    'budget','Not applicable','description',v_marker || ' new fixture',
    'name','AMYO Admin Verification','email','verification@example.invalid',
    'phone','+1 202 555 0147','consent',true
  );
  foreach v_bad_phone in array array['', '   ', '123456', '1234567890123456', 'invalid-phone'] loop
    v_id := gen_random_uuid();
    v_rejected := false;
    begin
      perform public.submit_inquiry(v_id, v_payload || jsonb_build_object('phone',v_bad_phone), repeat('c',64), v_hash);
    exception when check_violation then v_rejected := true;
    end;
    if not v_rejected or exists (select 1 from public.inquiries where request_id=v_id) then
      raise exception 'FAIL: invalid new phone was accepted';
    end if;
  end loop;
  v_id := gen_random_uuid();
  v_result := public.submit_inquiry(v_id, v_payload, repeat('d',64), v_hash);
  if v_result ->> 'status' is distinct from 'created' then
    raise exception 'FAIL: valid new phone could not be submitted';
  end if;
  v_rejected := false;
  begin
    update public.inquiries set phone='' where request_id=v_id;
  exception when check_violation then v_rejected := true;
  end;
  if not v_rejected then raise exception 'FAIL: valid phone could be cleared'; end if;

  v_result := public.admin_list_inquiries(1, 'all', v_marker);
  if (v_result ->> 'total')::integer <> 2
    or (v_result ->> 'pageSize')::integer <> 25
    or jsonb_array_length(v_result -> 'items') <> 2
    or exists (select 1 from jsonb_array_elements(v_result -> 'items') e where e ? 'request_fingerprint') then
    raise exception 'FAIL: catalog count, pagination or response projection failed';
  end if;
  v_rejected := false;
  begin perform public.admin_list_inquiries(0,'all','');
  exception when invalid_parameter_value then v_rejected := true; end;
  if not v_rejected then raise exception 'FAIL: invalid page accepted'; end if;
  v_rejected := false;
  begin perform public.admin_list_inquiries(1,'all',repeat('q',121));
  exception when invalid_parameter_value then v_rejected := true; end;
  if not v_rejected then raise exception 'FAIL: oversized search accepted'; end if;
end $$;

do $$
declare
  v_hash text := repeat('a',64);
  v_other text := repeat('b',64);
  v_result jsonb;
  v_rejected boolean;
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('amyo-admin-auth-rate-limit',0));
  -- All original throttle rows are restored by the enclosing rollback.
  delete from public.admin_auth_attempts;

  v_result := public.admin_rate_limit('send-link',v_hash);
  if v_result ->> 'allowed' is distinct from 'true' then raise exception 'FAIL: first link attempt denied'; end if;
  v_result := public.admin_rate_limit('send-link',v_other);
  if v_result ->> 'allowed' is distinct from 'false' or (v_result ->> 'retryAfter')::integer <> 60 then
    raise exception 'FAIL: one-minute global send-link boundary failed';
  end if;
  update public.admin_auth_attempts set created_at=clock_timestamp()-interval '61 seconds';
  v_result := public.admin_rate_limit('send-link',v_other);
  if v_result ->> 'allowed' is distinct from 'true' then raise exception 'FAIL: link cooldown did not expire'; end if;
  update public.admin_auth_attempts set created_at=clock_timestamp()-interval '2 minutes';
  v_result := public.admin_rate_limit('send-link',repeat('c',64));
  if v_result ->> 'allowed' is distinct from 'false' or (v_result ->> 'retryAfter')::integer <> 3600 then
    raise exception 'FAIL: two-per-hour global send-link limit failed';
  end if;
  select count(*) into v_count from public.admin_auth_attempts;
  if v_count<>2 then raise exception 'FAIL: rejected link attempts consumed stored allowance'; end if;
  update public.admin_auth_attempts set created_at=clock_timestamp()-interval '1 hour 1 second';
  v_result := public.admin_rate_limit('send-link',v_hash);
  if v_result ->> 'allowed' is distinct from 'true' then raise exception 'FAIL: hourly link allowance did not reopen'; end if;

  delete from public.admin_auth_attempts;
  for i in 1..5 loop
    v_result := public.admin_rate_limit('authenticate',v_hash);
    if v_result ->> 'allowed' is distinct from 'true' then raise exception 'FAIL: authentication attempt % denied early',i; end if;
  end loop;
  v_result := public.admin_rate_limit('authenticate',v_hash);
  if v_result ->> 'allowed' is distinct from 'false' or (v_result ->> 'retryAfter')::integer <> 900 then
    raise exception 'FAIL: sixth per-IP authentication attempt was not limited';
  end if;
  v_result := public.admin_rate_limit('authenticate',v_other);
  if v_result ->> 'allowed' is distinct from 'true' then raise exception 'FAIL: independent IP denied before global limit'; end if;

  delete from public.admin_auth_attempts;
  for i in 1..20 loop
    v_result := public.admin_rate_limit('authenticate',lpad(to_hex(i),64,'0'));
    if v_result ->> 'allowed' is distinct from 'true' then raise exception 'FAIL: global authentication attempt % denied early',i; end if;
  end loop;
  v_result := public.admin_rate_limit('authenticate',repeat('f',64));
  if v_result ->> 'allowed' is distinct from 'false' or (v_result ->> 'retryAfter')::integer <> 900 then
    raise exception 'FAIL: twenty-first global authentication attempt was not limited';
  end if;
  update public.admin_auth_attempts set created_at=clock_timestamp()-interval '15 minutes 1 second';
  v_result := public.admin_rate_limit('authenticate',repeat('f',64));
  if v_result ->> 'allowed' is distinct from 'true' then raise exception 'FAIL: authentication window did not reopen'; end if;

  v_rejected := false;
  begin perform public.admin_rate_limit('unknown-kind',v_hash);
  exception when invalid_parameter_value then v_rejected := true; end;
  if not v_rejected then raise exception 'FAIL: unknown limiter kind accepted'; end if;
  v_rejected := false;
  begin perform public.admin_rate_limit('authenticate','not-a-hash');
  exception when invalid_parameter_value then v_rejected := true; end;
  if not v_rejected then raise exception 'FAIL: malformed limiter hash accepted'; end if;
end $$;

select 'PASS: admin permissions, fail-closed sessions, legacy/new phone handling, status/notes, stale updates, search and persistent authentication throttle boundaries. All test rows and table changes are rolled back.' as verification_result;
rollback;
