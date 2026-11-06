-- PayRoost Phase 3B.2.1: Client Portal Session Revocation
--
-- Objective:
-- Implement privileged database session revocation for client portal logout handlers.
--
-- Security Invariants:
-- 1. SECURITY DEFINER with empty search_path to prevent search-path hijacking.
-- 2. Schema-qualified object access (public.client_portal_sessions).
-- 3. Execution restricted to service_role; explicitly revoked from PUBLIC, anon, and authenticated.
-- 4. Validates 64-character hexadecimal session hash format before execution.
-- 5. Revokes only active matching sessions (sets revoked_at = now()).
-- 6. Fully idempotent: safe to call repeatedly with the same hash.
-- 7. Returns void to avoid disclosing whether a supplied session hash exists in the database.
-- 8. Preserves existing RLS policies and table permissions on public.client_portal_sessions.

create or replace function public.revoke_portal_session(
  p_session_token_hash text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Validate session token hash format (strictly 64-char hexadecimal SHA-256 digest)
  if p_session_token_hash is null
     or char_length(trim(p_session_token_hash)) <> 64
     or p_session_token_hash !~* '^[0-9a-f]{64}$' then
    raise exception 'Invalid session token hash format';
  end if;

  -- Idempotently revoke the session if it exists and is currently active
  update public.client_portal_sessions
  set revoked_at = now()
  where session_token_hash = lower(trim(p_session_token_hash))
    and revoked_at is null;
end;
$$;

-- Revoke execution from public, anon, and authenticated roles
revoke all on function public.revoke_portal_session(text) from public, anon, authenticated;

-- Explicitly grant execution solely to the privileged service_role
grant execute on function public.revoke_portal_session(text) to service_role;
