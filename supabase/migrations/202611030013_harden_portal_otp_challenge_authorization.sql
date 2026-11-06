-- PayRoost Phase 3B.2.5.1: Critical OTP Challenge Creation Authorization Remediation
--
-- Vulnerability Classification: CRITICAL
-- In migration 202611030005, public.create_portal_otp_challenge was granted to anon and authenticated.
-- An anonymous caller could invoke this RPC directly via PostgREST with an arbitrary OTP HMAC,
-- creating an active challenge without the server dispatching an email to the verified client.
--
-- Remediation:
-- 1. Revoke EXECUTE privileges on public.create_portal_otp_challenge(text, text, timestamptz)
--    from PUBLIC, anon, and authenticated.
-- 2. Grant EXECUTE privileges on public.create_portal_otp_challenge(text, text, timestamptz)
--    EXCLUSIVELY to service_role.
-- 3. Preserve search_path = '', explicit schema qualification, and SECURITY DEFINER behavior.

revoke all on function public.create_portal_otp_challenge(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_portal_otp_challenge(text, text, timestamptz) to service_role;
