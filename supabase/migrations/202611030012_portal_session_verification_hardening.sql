-- PayRoost Phase 3B.2.5: Client Portal OTP Verification Hardening & Session Establishment
--
-- Objectives:
-- 1. Revoke execution on obsolete consume_portal_otp_and_create_session to eliminate invitation-challenge dissociation vulnerability.
-- 2. Introduce public.verify_portal_otp_and_create_session:
--    - Requires invitation token hash, binding the challenge cryptographically and relationally to the invitation in the URL.
--    - Employs row-level locking (FOR UPDATE) on both invitation token and challenge rows.
--    - Verifies token validity (unrevoked, unconsumed, unexpired).
--    - Verifies challenge binding (portal_token_id and project_id match invitation token).
--    - Enforces 5-attempt ceiling and commits failed attempt counter on HMAC mismatch.
--    - Re-verifies project client email verification status.
--    - Atomically marks both OTP challenge and invitation token consumed upon success.
--    - Issues active client portal session with 12-hour absolute lifetime.
--    - SECURITY DEFINER with empty search_path, explicit schema qualification.
--    - Granted to anon, authenticated, and service_role.
-- 3. Introduce public.revoke_portal_session_v2:
--    - Enforces project binding using the invitation token hash.
--    - Prevents cross-project session revocation.
--    - Idempotent and leak-free.
--    - SECURITY DEFINER with empty search_path, explicit schema qualification.
--    - Granted to anon, authenticated, and service_role.

-- 1. Revoke obsolete un-bound verification RPC
revoke all on function public.consume_portal_otp_and_create_session(uuid, text, text, text, interval) from public, anon, authenticated;

-- 2. Cryptographically Bound Portal OTP Verification & Session Establishment RPC
create or replace function public.verify_portal_otp_and_create_session(
  p_portal_token_hash text,
  p_challenge_id uuid,
  p_otp_hmac text,
  p_session_token_hash text,
  p_csrf_secret text,
  p_session_duration interval default interval '12 hours'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_token public.client_portal_tokens%rowtype;
  v_challenge public.client_portal_otp_challenges%rowtype;
  v_project public.projects%rowtype;
  v_new_attempts integer;
  v_session_id uuid;
  v_duration interval;
begin
  -- Validate format of input parameters
  if p_portal_token_hash is null
     or char_length(trim(p_portal_token_hash)) <> 64
     or p_portal_token_hash !~* '^[0-9a-f]{64}$'
     or p_challenge_id is null
     or p_otp_hmac is null
     or char_length(trim(p_otp_hmac)) <> 64
     or p_otp_hmac !~* '^[0-9a-f]{64}$'
     or p_session_token_hash is null
     or char_length(trim(p_session_token_hash)) <> 64
     or p_session_token_hash !~* '^[0-9a-f]{64}$'
     or p_csrf_secret is null
     or char_length(trim(p_csrf_secret)) <> 64
     or p_csrf_secret !~* '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'INVALID_ARGUMENT');
  end if;

  -- Validate session duration bounds (positive and max 12 hours)
  v_duration := coalesce(p_session_duration, interval '12 hours');
  if v_duration <= interval '0' or v_duration > interval '12 hours' then
    v_duration := interval '12 hours';
  end if;

  -- 1. Lock and verify invitation token
  select * into v_token
  from public.client_portal_tokens
  where token_hash = lower(trim(p_portal_token_hash))
  for update;

  if not found
     or v_token.revoked_at is not null
     or v_token.consumed_at is not null
     or v_token.expires_at <= now() then
    return jsonb_build_object('status', 'INVITATION_NOT_FOUND');
  end if;

  -- 2. Lock and verify OTP challenge
  select * into v_challenge
  from public.client_portal_otp_challenges
  where id = p_challenge_id
  for update;

  if not found
     or v_challenge.portal_token_id <> v_token.id
     or v_challenge.project_id <> v_token.project_id then
    return jsonb_build_object('status', 'CHALLENGE_NOT_FOUND');
  end if;

  -- 3. Check challenge lifecycle state
  if v_challenge.consumed_at is not null then
    return jsonb_build_object('status', 'CHALLENGE_ALREADY_CONSUMED');
  end if;

  if v_challenge.expires_at <= now() then
    return jsonb_build_object('status', 'OTP_EXPIRED');
  end if;

  if v_challenge.attempts >= 5 then
    return jsonb_build_object('status', 'OTP_EXHAUSTED', 'attempts', v_challenge.attempts, 'remainingAttempts', 0);
  end if;

  -- 4. Atomically increment attempt counter
  update public.client_portal_otp_challenges
  set attempts = attempts + 1
  where id = v_challenge.id
  returning attempts into v_new_attempts;

  -- 5. Constant-comparison check of OTP HMAC
  if lower(trim(v_challenge.otp_hmac)) <> lower(trim(p_otp_hmac)) then
    if v_new_attempts >= 5 then
      return jsonb_build_object('status', 'OTP_EXHAUSTED', 'attempts', v_new_attempts, 'remainingAttempts', 0);
    else
      return jsonb_build_object('status', 'INVALID_OTP', 'attempts', v_new_attempts, 'remainingAttempts', 5 - v_new_attempts);
    end if;
  end if;

  -- 6. Re-verify project still has verified client email matching challenge
  select * into v_project
  from public.projects
  where id = v_token.project_id;

  if not found
     or v_project.client_email_verified_at is null
     or v_project.client_email is null
     or v_project.client_email <> v_challenge.client_email then
    return jsonb_build_object('status', 'CLIENT_EMAIL_CHANGED');
  end if;

  -- 7. Atomically consume OTP challenge and invitation token
  update public.client_portal_otp_challenges
  set consumed_at = now()
  where id = v_challenge.id;

  update public.client_portal_tokens
  set consumed_at = now()
  where id = v_token.id;

  -- 8. Issue active client portal session
  insert into public.client_portal_sessions (
    project_id,
    client_email,
    session_token_hash,
    csrf_secret,
    expires_at
  ) values (
    v_token.project_id,
    v_challenge.client_email,
    lower(trim(p_session_token_hash)),
    lower(trim(p_csrf_secret)),
    now() + v_duration
  ) returning id into v_session_id;

  return jsonb_build_object(
    'status', 'SUCCESS',
    'sessionId', v_session_id
  );
end;
$$;

revoke all on function public.verify_portal_otp_and_create_session(text, uuid, text, text, text, interval) from public;
grant execute on function public.verify_portal_otp_and_create_session(text, uuid, text, text, text, interval) to anon, authenticated, service_role;

-- 3. Project-Bound Portal Session Revocation RPC (v2)
create or replace function public.revoke_portal_session_v2(
  p_portal_token_hash text,
  p_session_token_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_project_id uuid;
begin
  -- Validate format of token and session hashes
  if p_portal_token_hash is null
     or char_length(trim(p_portal_token_hash)) <> 64
     or p_portal_token_hash !~* '^[0-9a-f]{64}$'
     or p_session_token_hash is null
     or char_length(trim(p_session_token_hash)) <> 64
     or p_session_token_hash !~* '^[0-9a-f]{64}$' then
    return jsonb_build_object('success', false, 'error', 'INVALID_ARGUMENT');
  end if;

  -- Resolve project binding from client portal token
  select project_id into v_project_id
  from public.client_portal_tokens
  where token_hash = lower(trim(p_portal_token_hash));

  if not found then
    -- Safe idempotent return: does not leak whether invitation token exists
    return jsonb_build_object('success', true, 'revoked', false);
  end if;

  -- Revoke active session matching both session token hash and bound project_id
  update public.client_portal_sessions
  set revoked_at = now()
  where session_token_hash = lower(trim(p_session_token_hash))
    and project_id = v_project_id
    and revoked_at is null;

  return jsonb_build_object('success', true, 'revoked', found);
end;
$$;

revoke all on function public.revoke_portal_session_v2(text, text) from public;
grant execute on function public.revoke_portal_session_v2(text, text) to anon, authenticated, service_role;
