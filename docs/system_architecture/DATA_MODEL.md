# PayRoost — Current Data Model

PayRoost stores state in **Supabase PostgreSQL** managed across **35 sequential SQL migrations** (`supabase/migrations/202611020001_initial_identity.sql` through `202611120002_restore_postgrest_table_and_rpc_grants.sql`).

## 1. Core Schema Rules

- UUID primary keys and UTC `timestamptz` timestamps across all tables.
- Monetary values stored as integer `bigint` minor units (`amount_minor`, `total_amount_minor`) with ISO 4217 currency codes — zero floating-point currency math.
- Immutable sent agreements: once an `agreement_versions` row is sent/approved, PostgreSQL triggers prevent mutation; edits require creating `version_number + 1`.
- Hash-only public credentials: bearer tokens (`review_links`, `client_portal_tokens`, `client_email_verifications`, `client_portal_sessions`) and OTPs are stored as hashes/HMAC digests, never raw plaintext tokens.
- Server-only `service_role` access for privileged portal, OTP, verification, payment reconciliation, and webhook RPCs; PostgREST table and RPC grants explicitly restored and verified (`202611120002_restore_postgrest_table_and_rpc_grants.sql`).

---

## 2. Tables (`20` Total)

### Identity & Workspace Access
1. `profiles` — Freelancer profile metadata (`display_name`, `avatar_url`, user-declared `country_code`, timestamps).
2. `projects` — Project header, client identity (`client_name`, `client_email`), brief, currency, integer `total_amount_minor`, lifecycle status, and target dates.
3. `project_participants` — Project membership & role mapping supporting freelancer and client participation boundaries.

### Agreements, Milestones & Scope Governance
4. `agreements` — One-to-one agreement header per project linking `current_version_id` and lifecycle status.
5. `agreement_versions` — Versioned JSONB agreement drafts/approved snapshots (`version_number`, `content`, `content_hash`, `sent_at`, `approved_at`, `approved_by_label`).
6. `milestones` — Billable deliverable milestones linked to project & agreement version (`amount_minor`, `currency`, `acceptance_criteria`, deliverable review state, `sort_order`).
7. `change_requests` — Client/freelancer scope-change proposals with structured `ai_assessment` JSONB (`AI-5`) and verified signed snapshot metadata (`202611110002_change_requests_ai_analysis.sql`).

### Public Verification, Review & Portal Security
8. `client_email_verifications` — Explicit client email verification records (`/verify-client-email`).
9. `review_links` — Hashed bearer tokens for `/review/[token]` agreement reviews with expiry and revocation.
10. `review_link_otp_challenges` — Single-use OTP challenge state for agreement review approvals.
11. `client_portal_tokens` — Hashed bearer tokens granting access to `/portal/[token]`.
12. `client_portal_otp_challenges` — Project/portal OTP challenge challenges verified against `PORTAL_OTP_HMAC_SECRET`.
13. `client_portal_sessions` — `12-hour` authenticated client portal sessions supporting explicit revocation (`revoke_portal_session` / `revoke_portal_session_v2`).
14. `rate_limit_buckets` — Persistent sliding-window / bucket rate limiting keyed by token hash or trusted proxy IP.

### Marketplace Payments, Onboarding & Reconciliation
15. `freelancer_paypal_accounts` — Seller Partner Referrals onboarding state, PayPal merchant ID (`merchant_id`), permissions/capabilities, email confirmation, and eligibility status (`202611100003`–`202611100004`).
16. `payment_intents` — Canonical server-computed payment attempts binding milestone ID (`reference_id`), seller merchant ID, exact currency/amount minor units, idempotency, and lease fencing (`202611060001`–`202611110001`).
17. `payment_transactions` — Append-only financial ledger rows recording order creation, capture, completion, failures, and provider references.
18. `provider_webhook_events` — Signature-verified, deduplicated PayPal webhook event records (`event_id` uniqueness).

### History & Notifications
19. `activity_events` — Audience-filtered chronological project history covering agreement, deliverable, scope-change, verification, and payment events.
20. `notifications` — Role-scoped persistent notifications projected from `activity_events` with immutability triggers (`202611120001_notifications_and_project_history.sql`).

---

## 3. Key PostgreSQL RPCs & Triggers

- **Identity & Rate Limiting:** `verify_client_email`, `consume_rate_limit`
- **Portal Sessions:** `create_portal_otp_challenge`, `verify_portal_otp_and_create_session`, `validate_portal_session`, `revoke_portal_session`, `revoke_portal_session_v2`
- **Payments & Reconciliation:** `create_client_payment_intent`, `create_sandbox_demo_payment_intent`, `record_paypal_order_captured`, `reconcile_and_complete_payment_intent`
- **Data Integrity Triggers:** Agreement version post-send/approval immutability triggers, single active purchase-unit / milestone payment constraints, notification immutability triggers, and `activity_events` -> `notifications` projection trigger.
