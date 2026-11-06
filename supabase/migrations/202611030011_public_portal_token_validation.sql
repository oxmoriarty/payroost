-- Payroost Phase 3B.2.4: Read-Only Public Portal Invitation Validation RPC
-- Provides secure, read-only validation of client portal invitation tokens for public entry.
--
-- Security properties:
-- 1. SECURITY DEFINER with search_path = ''
-- 2. Accepts only the SHA-256 token hash (never the raw token)
-- 3. Pure read-only (does not lock rows or mutate invitation state)
-- 4. Validates existence, expiry, revocation, consumption, and client email verification
-- 5. Returns only safe public metadata (valid, projectTitle, expiresAt)
-- 6. Returns NULL if token is invalid, expired, revoked, consumed, or unverified
-- 7. Revokes execution from public; grants only to anon and authenticated

create or replace function public.validate_portal_invitation(
  p_token_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_token public.client_portal_tokens%rowtype;
  v_project public.projects%rowtype;
begin
  select * into v_token
  from public.client_portal_tokens
  where token_hash = p_token_hash;

  if not found or v_token.revoked_at is not null or v_token.consumed_at is not null or v_token.expires_at <= now() then
    return null;
  end if;

  select * into v_project
  from public.projects
  where id = v_token.project_id;

  if not found or v_project.client_email_verified_at is null then
    return null;
  end if;

  return jsonb_build_object(
    'valid', true,
    'projectTitle', v_project.title,
    'expiresAt', v_token.expires_at
  );
end;
$$;

revoke all on function public.validate_portal_invitation(text) from public;
grant execute on function public.validate_portal_invitation(text) to anon, authenticated;
