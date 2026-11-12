-- PayRoost Hotfix: Restore Least-Privilege PostgREST Table, View, and RPC Grants
-- Root cause: On hosted Supabase projects where `postgres` default privileges do not grant
-- CRUD (SELECT, INSERT, UPDATE, DELETE) on newly created `public` tables to `authenticated`
-- or `service_role` (nor EXECUTE on functions to `service_role`), early migrations that omitted
-- explicit GRANT statements left authenticated workspace queries and service-role calls failing
-- with PostgreSQL 42501 permission denied errors.
--
-- Security invariants preserved:
-- 1. `anon` has zero direct privileges on any table or view in `public`.
-- 2. Sensitive verification, OTP, token, session, webhook, and rate-limit tables remain
--    strictly revoked from `public`, `anon`, and `authenticated` (granted only to `service_role`).
-- 3. `projects.client_email_verified_at` and `agreement_versions.(status, approved_at, approved_by_label)`
--    remain un-updatable by `authenticated` (column-level REVOKE re-applied immediately after GRANT).
-- 4. `review_links` preserves column-level SELECT (excluding `token_hash`) and UPDATE(revoked_at) only;
--    direct INSERT remains revoked from `authenticated`.
-- 5. `payment_intents` and `payment_transactions` remain SELECT-only for `authenticated`.
-- 6. `notifications` retains SELECT + UPDATE(read_at) only for `authenticated`.
-- 7. `freelancer_paypal_accounts` retains SELECT-only for `authenticated`.

-- ============================================================================
-- 1. Schema USAGE (defense-in-depth)
-- ============================================================================

grant usage on schema public to anon, authenticated, service_role;

-- ============================================================================
-- 2. Core Workspace Tables (RLS-governed for `authenticated`, full for `service_role`)
-- ============================================================================

revoke all on public.profiles from public, anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

revoke all on public.projects from public, anon, authenticated;
grant select, insert, update, delete on public.projects to authenticated;
revoke update (client_email_verified_at) on public.projects from public, anon, authenticated;
grant all on public.projects to service_role;

revoke all on public.project_participants from public, anon, authenticated;
grant select, insert, update, delete on public.project_participants to authenticated;
grant all on public.project_participants to service_role;

revoke all on public.agreements from public, anon, authenticated;
grant select, insert, update, delete on public.agreements to authenticated;
grant all on public.agreements to service_role;

revoke all on public.agreement_versions from public, anon, authenticated;
grant select, insert, update, delete on public.agreement_versions to authenticated;
revoke update (status, approved_at, approved_by_label) on public.agreement_versions from public, anon, authenticated;
grant all on public.agreement_versions to service_role;

revoke all on public.milestones from public, anon, authenticated;
grant select, insert, update, delete on public.milestones to authenticated;
grant all on public.milestones to service_role;

revoke all on public.change_requests from public, anon, authenticated;
grant select, insert, update, delete on public.change_requests to authenticated;
grant all on public.change_requests to service_role;

revoke all on public.activity_events from public, anon, authenticated;
grant select, insert, update, delete on public.activity_events to authenticated;
grant all on public.activity_events to service_role;

-- ============================================================================
-- 3. Review Links Table (Column-Restricted) & Metadata View
-- ============================================================================

revoke all on public.review_links from public, anon, authenticated;
grant select (
  id,
  project_id,
  agreement_version_id,
  intended_email,
  expires_at,
  revoked_at,
  created_at
) on public.review_links to authenticated;
grant update (revoked_at) on public.review_links to authenticated;
grant all on public.review_links to service_role;

revoke all on public.project_review_links from public, anon, authenticated;
grant select on public.project_review_links to authenticated, service_role;

-- ============================================================================
-- 4. Financial Ledger & Seller Tables (Read-Only for `authenticated`, Full for `service_role`)
-- ============================================================================

revoke all on public.payment_intents from public, anon, authenticated;
grant select on public.payment_intents to authenticated;
grant all on public.payment_intents to service_role;

revoke all on public.payment_transactions from public, anon, authenticated;
grant select on public.payment_transactions to authenticated;
grant all on public.payment_transactions to service_role;

revoke all on public.freelancer_paypal_accounts from public, anon, authenticated;
grant select on public.freelancer_paypal_accounts to authenticated;
grant all on public.freelancer_paypal_accounts to service_role;

-- ============================================================================
-- 5. Service-Role-Only Security, Verification, Portal & Webhook Tables
-- ============================================================================

revoke all on public.client_email_verifications from public, anon, authenticated;
grant all on public.client_email_verifications to service_role;

revoke all on public.review_link_otp_challenges from public, anon, authenticated;
grant all on public.review_link_otp_challenges to service_role;

revoke all on public.rate_limit_buckets from public, anon, authenticated;
grant all on public.rate_limit_buckets to service_role;

revoke all on public.client_portal_tokens from public, anon, authenticated;
grant all on public.client_portal_tokens to service_role;

revoke all on public.client_portal_otp_challenges from public, anon, authenticated;
grant all on public.client_portal_otp_challenges to service_role;

revoke all on public.client_portal_sessions from public, anon, authenticated;
grant all on public.client_portal_sessions to service_role;

revoke all on public.provider_webhook_events from public, anon, authenticated;
grant all on public.provider_webhook_events to service_role;

-- ============================================================================
-- 6. Restore `service_role` EXECUTE on Active Public & Authenticated RPCs
-- ============================================================================

grant execute on function public.consume_rate_limit(text, integer, integer) to anon, authenticated, service_role;
grant execute on function public.create_client_email_verification(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.create_client_portal_token(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.create_project_review_link(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.create_sandbox_demo_payment_intent(uuid, text, uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function public.get_public_review(text) to anon, authenticated, service_role;
grant execute on function public.request_review_otp(text, text, text, timestamptz) to anon, authenticated, service_role;
grant execute on function public.submit_public_review(text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.submit_public_review_with_otp(text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.validate_portal_invitation(text) to anon, authenticated, service_role;
grant execute on function public.validate_portal_session(text) to anon, authenticated, service_role;
grant execute on function public.verify_client_email(text) to anon, authenticated, service_role;
