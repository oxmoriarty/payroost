# Payroost — Data Model

Use PostgreSQL via Supabase. Create SQL migrations and generated TypeScript types. Use UUID primary keys and UTC timestamps. Monetary amounts are integer minor units, not floating-point values.

The table names below are Payroost's proposed internal schema. They are not PayPal API requirements. Use provider-neutral names where practical and retain provider identifiers in explicit provider-reference columns.

## 1. Product tables

### `profiles`
- `id uuid PK references auth.users(id)`
- `display_name text`
- `avatar_url text nullable`
- `country_code char(2) nullable` — user-declared country; validate and use for provider eligibility, never infer from IP alone.
- `created_at`, `updated_at timestamptz`

### `projects`
- `id uuid PK`
- `owner_id uuid FK profiles.id`
- `title text`
- `client_name text`
- `client_email text`
- `brief text`
- `currency char(3)` — ISO 4217; allow only a currency supported by the selected provider/configuration.
- `total_amount_minor bigint`
- `status project_status`
- `start_date date nullable`
- `target_end_date date nullable`
- `created_at`, `updated_at timestamptz`

### `agreements`
- `id uuid PK`
- `project_id uuid FK UNIQUE`
- `current_version_id uuid nullable`
- `status agreement_status`
- `created_at`, `updated_at timestamptz`

### `agreement_versions`
- `id uuid PK`
- `agreement_id uuid FK`
- `version_number integer`
- `content jsonb` — schema defined in `AI_SPEC.md`
- `content_hash text`
- `created_by uuid FK profiles.id`
- `created_at timestamptz`
- `sent_at timestamptz nullable`
- `approved_at timestamptz nullable`
- `approved_by_label text nullable`
- Unique `(agreement_id, version_number)`

Do not edit a version after it has been sent. Create a new version instead.

### `review_links`
- `id uuid PK`
- `project_id uuid FK`
- `agreement_version_id uuid FK`
- `token_hash text UNIQUE` — store hash, not raw token.
- `expires_at timestamptz`
- `revoked_at timestamptz nullable`
- `created_at timestamptz`

### `milestones`
- `id uuid PK`
- `project_id uuid FK`
- `agreement_version_id uuid FK`
- `title text`
- `description text`
- `acceptance_criteria jsonb`
- `amount_minor bigint`
- `currency char(3)`
- `due_date date nullable`
- `status milestone_status`
- `sort_order integer`
- `created_at`, `updated_at timestamptz`

### `change_requests`
- `id uuid PK`
- `project_id uuid FK`
- `submitted_by uuid nullable`
- `request_text text`
- `ai_assessment jsonb`
- `classification text`
- `suggested_amount_minor bigint nullable`
- `suggested_days integer nullable`
- `final_amount_minor bigint nullable`
- `final_days integer nullable`
- `status change_request_status`
- `decision_note text nullable`
- `created_at`, `updated_at timestamptz`

## 2. Provider and payment tables

### `payment_providers`
- `id uuid PK`
- `provider_code text UNIQUE` — e.g. `PAYPAL_MULTIPARTY`; do not add an alternative provider until researched and contracted.
- `display_name text`
- `environment text` — `sandbox` or `live`.
- `enabled boolean`
- `created_at`, `updated_at timestamptz`

### `provider_seller_accounts`
- `id uuid PK`
- `provider_id uuid FK payment_providers.id`
- `seller_profile_id uuid FK profiles.id`
- `provider_seller_reference text` — provider-issued seller/account identifier.
- `country_code char(2)`
- `account_type text nullable` — only values returned/required by the provider integration.
- `onboarding_status text` — internal normalized state; retain raw provider state only when necessary and safe.
- `capabilities jsonb` — documented capability values returned by provider, not invented values.
- `eligibility_status text` — internal state such as `ELIGIBLE`, `INELIGIBLE`, `REVIEW_REQUIRED`.
- `last_verified_at timestamptz nullable`
- `created_at`, `updated_at timestamptz`
- Unique `(provider_id, provider_seller_reference)`.

### `seller_onboarding_events`
- `id uuid PK`
- `provider_seller_account_id uuid FK provider_seller_accounts.id`
- `provider_event_reference text nullable`
- `event_type text`
- `status text`
- `occurred_at timestamptz nullable`
- `received_at timestamptz`
- `safe_metadata jsonb` — exclude credentials, secrets and unnecessary personal data.

### `payment_intents`
- `id uuid PK`
- `project_id uuid FK`
- `milestone_id uuid FK`
- `seller_profile_id uuid FK profiles.id`
- `provider_id uuid FK payment_providers.id`
- `provider_seller_account_id uuid FK provider_seller_accounts.id`
- `amount_minor bigint`
- `currency char(3)`
- `status text` — internal payment lifecycle; do not conflate capture with payout or milestone acceptance.
- `idempotency_key text UNIQUE`
- `created_at`, `updated_at timestamptz`

### `payment_attempts`
- `id uuid PK`
- `payment_intent_id uuid FK payment_intents.id`
- `provider_id uuid FK payment_providers.id`
- `provider_order_reference text nullable`
- `provider_request_reference text nullable`
- `attempt_number integer`
- `status text`
- `failure_code text nullable`
- `created_at`, `updated_at timestamptz`
- Unique `(payment_intent_id, attempt_number)`.
- Unique `(provider_id, provider_order_reference)` when the provider order reference is not null.

### `payment_transactions`
- `id uuid PK`
- `provider_id uuid FK payment_providers.id`
- `payment_intent_id uuid FK payment_intents.id`
- `payment_attempt_id uuid FK payment_attempts.id nullable`
- `provider_transaction_reference text`
- `transaction_type text` — normalized internal type such as capture, refund or reversal; map only documented provider events/responses.
- `amount_minor bigint`
- `currency char(3)`
- `status text`
- `provider_occurred_at timestamptz nullable`
- `recorded_at timestamptz`
- Unique `(provider_id, provider_transaction_reference)`.

### `payment_allocations`
- `id uuid PK`
- `payment_transaction_id uuid FK payment_transactions.id`
- `allocation_type text` — e.g. seller proceeds or platform fee, only when the provider confirms the allocation.
- `recipient_provider_reference text nullable`
- `amount_minor bigint`
- `currency char(3)`
- `created_at timestamptz`

Do not calculate or persist a platform fee as payable unless the approved provider configuration and provider transaction confirm the applicable fee treatment.

### `ledger_accounts`
- `id uuid PK`
- `account_code text UNIQUE`
- `owner_profile_id uuid nullable FK profiles.id`
- `currency char(3)`
- `created_at timestamptz`

### `ledger_entries`
- `id uuid PK`
- `ledger_transaction_group_id uuid` — groups balanced postings for one financial event.
- `ledger_account_id uuid FK ledger_accounts.id`
- `payment_transaction_id uuid FK payment_transactions.id nullable`
- `direction text` — `DEBIT` or `CREDIT`.
- `amount_minor bigint CHECK amount_minor > 0`
- `currency char(3)`
- `description text`
- `created_at timestamptz`

Ledger entries are append-only. Enforce balanced postings per transaction group and currency in the posting service/database transaction. Correct errors with compensating entries; never edit or delete posted entries.

### `provider_webhook_events`
- `id uuid PK`
- `provider_id uuid FK payment_providers.id`
- `provider_event_reference text`
- `event_type text`
- `resource_reference text nullable`
- `verification_status text`
- `processing_status text` — `RECEIVED`, `PROCESSED`, `IGNORED`, `FAILED`.
- `received_at timestamptz`
- `processed_at timestamptz nullable`
- `failure_code text nullable`
- Unique `(provider_id, provider_event_reference)`.

### `refund_requests`
- `id uuid PK`
- `payment_transaction_id uuid FK payment_transactions.id`
- `requested_by uuid FK profiles.id`
- `amount_minor bigint`
- `currency char(3)`
- `reason text nullable`
- `status text`
- `provider_refund_reference text nullable`
- `created_at`, `updated_at timestamptz`

### `disputes`
- `id uuid PK`
- `provider_id uuid FK payment_providers.id`
- `payment_transaction_id uuid FK payment_transactions.id nullable`
- `provider_dispute_reference text`
- `status text`
- `reason_code text nullable`
- `response_due_at timestamptz nullable`
- `created_at`, `updated_at timestamptz`

### `payout_records`
- `id uuid PK`
- `provider_id uuid FK payment_providers.id`
- `provider_seller_account_id uuid FK provider_seller_accounts.id`
- `provider_payout_reference text`
- `amount_minor bigint`
- `currency char(3)`
- `status text`
- `provider_confirmed_at timestamptz nullable`
- `created_at`, `updated_at timestamptz`

Only create a payout record when the selected provider product exposes a payout concept and the provider confirms the relevant state. Do not infer it from capture.

### `reconciliation_runs`
- `id uuid PK`
- `provider_id uuid FK payment_providers.id`
- `started_at timestamptz`
- `completed_at timestamptz nullable`
- `status text`
- `records_checked integer`
- `mismatch_count integer`
- `summary jsonb`

## 3. Other tables

### `activity_events`
- `id uuid PK`
- `project_id uuid FK`
- `actor_user_id uuid nullable`
- `actor_label text`
- `event_type text`
- `summary text`
- `metadata jsonb` — avoid secrets and unnecessary personal data.
- `created_at timestamptz`

## 4. Enums and lifecycle separation

Suggested product enums:
- `project_status`: `DRAFT`, `AWAITING_CLIENT`, `ACTIVE`, `COMPLETED`, `CANCELLED`
- `agreement_status`: `DRAFT`, `PENDING_CLIENT`, `APPROVED`, `CHANGES_REQUESTED`, `SUPERSEDED`
- `milestone_status`: `NOT_STARTED`, `IN_PROGRESS`, `READY_FOR_PAYMENT`, `PAID`, `ACCEPTED`, `BLOCKED`
- `change_request_status`: `DRAFT`, `PENDING_CLIENT`, `APPROVED`, `REJECTED`, `WITHDRAWN`

Payment, provider seller onboarding, provider transaction, refund, dispute and payout states must be separate state machines. Normalize provider states internally without discarding the original provider reference/state needed for support and reconciliation. Do not assume a fixed list of provider states before reviewing the selected PayPal flow.

## 5. Relationships and invariants

- Project owner must own all private project records.
- Every milestone belongs to exactly one project and references the agreement version that defined it.
- Client approval is attached to a specific immutable agreement version.
- A review link grants access only to the specific project/version and allowed client actions.
- Payment amount, currency, seller identity, provider seller reference and any applicable fee are loaded/derived server-side from trusted records.
- A milestone cannot have multiple concurrent active payment intents unless explicitly supported.
- Provider order, transaction, refund, dispute and event references are unique within the provider where applicable.
- Webhook event processing is idempotent.
- A payment capture cannot be treated as seller payout or milestone acceptance.
- Refunds/reversals are separate transactions; they do not erase the original capture.
- Use database transactions for financial posting and state changes that must be atomic.

## 6. Row Level Security

Enable RLS on all user-owned tables.

- `profiles`: user can read/update own profile.
- `projects`: owner can CRUD own projects.
- `agreements`, `agreement_versions`, `milestones`, `change_requests`, `payment_intents`, `activity_events`: access only through ownership relationship.
- `review_links`: do not expose token hashes or allow broad direct client access; use server-side operations after token validation.
- Provider credentials, webhook events, ledger entries, reconciliation records and privileged payment records: no direct browser writes; service-role/server-only access with narrow policies.
- Payment Operations API: return only the minimum records the signed-in user is authorized to view.

Do not rely on RLS alone. Enforce authorization in server route handlers too.

## 7. Seed scenario

Create a clearly fictional demo project:
- Title: E-commerce Website
- Client: Jordan Lee
- Brief: responsive storefront, product catalogue, cart, checkout handoff, admin product management.
- Total: USD 2,000.00
- Milestones: Discovery/design $400; frontend $600; backend $600; final QA/handover $400.
- New request for scope demo: referral/rewards programme.
- AI classifies the new request against the approved brief and explains evidence/uncertainty.

Seed payment rows must be labelled as demo records until replaced by actual Sandbox provider transactions.
