# PayRoost — Security & Privacy Architecture

## 1. Secrets & Server-Only Boundaries

All external provider modules (`src/lib/supabase/service.ts`, `src/lib/ai/`, `src/lib/paypal/`, `src/lib/email/`, `src/lib/security/`) enforce `import "server-only"`. Credentials are never returned in API JSON errors, logs, or UI bundles.

### Fail-Closed Environment Controls
- **`PAYROOST_OTP_SECRET`** (`>= 32` bytes, no placeholders): Required in both development and production for hashing agreement review OTPs.
- **`PORTAL_OTP_HMAC_SECRET`** (`>= 32` bytes): Required in production for client portal OTP verification (dev/test falls back only when omitted in non-production).
- **`PAYROOST_AI_SNAPSHOT_SECRET`** (`>= 32` bytes): Required whenever AI scope-change impact snapshots (`AI-5`) are signed or verified; missing configuration fails closed with `503 CONFIGURATION_UNAVAILABLE`.
- **`PAYROOST_APP_URL` / `NEXT_PUBLIC_APP_URL`**: Verification, onboarding, and PayPal return/cancel URLs are built strictly from validated app origin variables (`src/lib/security/app-url.ts`). In production, `PAYROOST_APP_URL` must be a valid non-localhost HTTPS URL without credentials, query parameters, or fragments. Request `Host`, `Origin`, and `X-Forwarded-Host` headers are never trusted.
- **`CRON_SECRET`** (optional, `>= 16` chars when enabled): Protects `POST /api/internal/payments/recover`.

---

## 2. Authentication, Sessions & CSRF

- **Freelancer Workspace (`/app/*`):** Protected by Supabase SSR authentication (`@supabase/ssr`, `src/lib/auth/require-user.ts`). Operator write routes validate CSRF tokens issued via `/api/app/csrf` (`src/lib/security/operator-csrf.ts`).
- **Public Review Links (`/review/[token]`):** High-entropy random bearer tokens hashed in `public.review_links`, time-limited, revocable, and gated behind email-delivered 6-digit OTP verification for approvals.
- **Client Portal (`/portal/[token]`):** Separate hashed bearer token (`public.client_portal_tokens`) paired with a 6-digit OTP challenge to mint an `HttpOnly`, `__Host-`-capable `12-hour` project-scoped session (`public.client_portal_sessions`). Portal mutations verify `64-character` hex CSRF tokens with `crypto.timingSafeEqual`.
- **Client Email Verification (`/verify-client-email`):** Clients verify ownership of the invited email address before completing agreement/portal verification flows.

---

## 3. Multi-Dimensional Rate Limiting

Public verification, OTP issuance, review, portal, and payment routes enforce PostgreSQL-backed throttling via `consume_rate_limit` (`public.rate_limit_buckets`):
- **Primary key:** Normalized bearer token hash (cannot be bypassed by spoofing IP headers). In production, failure to connect to the database rate limiter fails closed with `503 RATE_LIMITER_UNAVAILABLE`.
- **Secondary IP limiting (`src/lib/security/client-ip.ts`):** Disabled unless `TRUST_PROXY="true"` is explicitly configured behind a proxy that overwrites `X-Real-IP` / `X-Forwarded-For`.

---

## 4. Payment & Webhook Integrity

- **Direct Server Authority:** Amounts (`amount_minor`) and currency are derived strictly from PostgreSQL milestone/project rows on the server — client payloads cannot alter price, currency, or payee.
- **Purchase-Unit Binding:** Each PayPal order encodes `custom_id` = Payment Intent UUID, `reference_id` = Milestone ID, and `payee.merchant_id` = verified seller merchant ID (in `PLATFORM` mode). Capture and reconciliation verify every field before updating state.
- **Lease Fencing & Idempotency:** Payment order creation, capture retries, and background sweeps (`/api/app/payments/recovery`, `/api/internal/payments/recover`) enforce lease fencing and idempotency keys to eliminate double charges or stale overrides.
- **Webhook Verification:** `POST /api/webhooks/paypal` verifies PayPal cryptographic webhook signatures against `PAYPAL_WEBHOOK_ID` and deduplicates event IDs in `public.provider_webhook_events`.
- **No Custody / Non-Escrow Disclosure:** PayRoost records payment status accurately in PostgreSQL and never claims to hold funds or provide escrow. No raw card numbers or CVVs pass through PayRoost.

---

## 5. AI Safety & Tamper-Proof Scope Snapshots

- Prompts treat all user briefs, notes, and messages as untrusted text and never pass secrets, credentials, or cross-project records to external model providers (Groq or Gemini).
- Structured JSON responses are validated with Zod before use, and humans must review/approve all agreements, milestones, dates, and change requests.
- Scope-change analyses (`AI-5`) are signed server-side with `PAYROOST_AI_SNAPSHOT_SECRET` so clients/freelancers cannot alter a generated assessment payload prior to submitting a `change_requests` record.
