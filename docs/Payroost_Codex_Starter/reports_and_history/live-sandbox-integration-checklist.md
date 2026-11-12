# PayRoost — Live Sandbox Integration Checklist

Use this runbook to transition PayRoost from mocked local verification (`95` suites / `1,212` tests passing) to a working live Sandbox environment across **Supabase**, **Gmail SMTP**, **Google Gemini**, and **PayPal Complete Payments Platform (Multiparty) Sandbox**.

> **Important Scope Note:** `src/lib/paypal/env.ts` strictly enforces `PAYPAL_ENV=sandbox` and `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`. Live real-money PayPal production endpoints are rejected by design.

---

## 1. Environment & Secrets Provisioning

Populate `.env.local` (for local development) or your deployment provider's encrypted secrets using `.env.example`:

- [ ] **Supabase (`src/lib/supabase/`):**
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
- [ ] **Canonical Application Origin (`src/lib/security/app-url.ts`):**
  - `PAYROOST_APP_URL` and `NEXT_PUBLIC_APP_URL`
  - Local testing with webhooks/OAuth callback: set to your public HTTPS tunnel origin (e.g. `https://<subdomain>.ngrok-free.app`) or `http://localhost:3000` (if not testing external PayPal callbacks/webhooks remotely).
  - Deployed / `NODE_ENV=production`: **must** be a valid `https://` non-localhost origin with no username, password, query string, or hash fragment — otherwise `/api/projects/[projectId]/portal-link`, `/review-link`, PayPal onboarding/callback, and `/payments/orders` fail closed with `503 CONFIGURATION_UNAVAILABLE`.
- [ ] **Mandatory Server Cryptographic Secrets (all `>= 32` UTF-8 bytes, non-placeholder):**
  - `PAYROOST_OTP_SECRET` — required in `development` and `production` for review OTP HMACs (`src/lib/security/tokens.ts`).
  - `PORTAL_OTP_HMAC_SECRET` — required in `production` for client-portal OTP HMACs (`src/lib/security/portal-otp.ts`).
  - `PAYROOST_AI_SNAPSHOT_SECRET` — required in **all** environments for AI-5 scope-change analysis signing and verification (`src/features/scope-changes/snapshot.ts`).
  - Generate three distinct 32+ byte random secrets (e.g., `openssl rand -hex 32`).
- [ ] **Proxy Trust (`src/lib/security/client-ip.ts`):**
  - Keep `TRUST_PROXY=false` locally or on direct Node hosts.
  - Set `TRUST_PROXY=true` **only** behind a trusted reverse proxy (e.g., Vercel/Cloudflare/ALB) configured to sanitize/overwrite `X-Real-IP` and `X-Forwarded-For`.
- [ ] **Gemini AI (`src/lib/ai/env.ts`):**
  - `GEMINI_API_KEY`
  - `GEMINI_MODEL=gemini-3.8-flash` (default)
- [ ] **Gmail SMTP Email (`src/lib/email/provider.ts`):**
  - `SMTP_USER` and `SMTP_PASS` (16-character Google App Password)
  - `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true` (optional overrides)
  - `PAYROOST_EMAIL_FROM` (optional; defaults to `Payroost <SMTP_USER>`)
- [ ] **PayPal Complete Payments Platform Sandbox (`src/lib/paypal/env.ts` & `src/lib/paypal/payment-mode.ts`):**
  - `PAYPAL_ENV=sandbox`
  - `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`
  - `PAYPAL_PAYMENT_MODE=PLATFORM`
  - `PAYPAL_CLIENT_ID` & `PAYPAL_CLIENT_SECRET`
  - `PAYPAL_EXPECTED_MERCHANT_ID`
  - `PAYPAL_PLATFORM_CLIENT_ID` & `PAYPAL_PLATFORM_CLIENT_SECRET` (optional if identical to `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, must be paired symmetrically if set)
  - `PAYPAL_PARTNER_MERCHANT_ID` (PayRoost's own Sandbox Partner/Platform Merchant ID, 3–64 chars)
  - `PAYPAL_PARTNER_ATTRIBUTION_ID` (leave blank if you do not have an assigned BN code)
  - `PAYPAL_WEBHOOK_ID` (set after registering the webhook in Step 3)
- [ ] **Optional Scheduled Recovery Bearer (`src/app/api/internal/payments/recover/route.ts`):**
  - `CRON_SECRET` (`>= 16` chars if calling `POST /api/internal/payments/recover` on a cron schedule)

---

## 2. Supabase Database Migration & Auth Verification

- [ ] Link Supabase CLI to your target project (`supabase link --project-ref <ref>`).
- [ ] Inspect migration drift **before** pushing:
  ```bash
  supabase migration list
  ```
- [ ] Confirm all `35` migrations (`202611020001_initial_identity.sql` through `202611120002_restore_postgrest_table_and_rpc_grants.sql`) — especially `202611110003_paypal_platform_webhooks.sql`, `202611110004_postgrest_capture_and_webhook_alignment.sql`, `202611120001_notifications_and_project_history.sql`, and `202611120002_restore_postgrest_table_and_rpc_grants.sql` — are applied via `supabase db push` or your controlled migration pipeline.
- [ ] Verify Supabase Auth redirect URLs in the Supabase Dashboard include:
  - `<PAYROOST_APP_URL>/login`
  - `<PAYROOST_APP_URL>/app`
- [ ] Smoke-test rate-limit RPC (`public.consume_rate_limit`) availability; in `NODE_ENV=production`, public routes fail closed with `503 RATE_LIMITER_UNAVAILABLE` if this RPC is missing or failing.

---

## 3. PayPal Developer Sandbox & Webhook Registration

- [ ] Confirm you have three distinct Sandbox accounts in PayPal Developer Dashboard:
  1. **Platform / Partner Business Sandbox Account** matching `PAYPAL_PARTNER_MERCHANT_ID` and your Partner/Platform REST App credentials.
  2. **Freelancer Seller Sandbox Account** (to test Partner Referrals seller onboarding).
  3. **Client Buyer Sandbox Account** (personal/buyer test account for approving milestone checkouts).
- [ ] Start your app (or deploy staging) at an HTTPS URL reachable by PayPal (`PAYROOST_APP_URL`). For local runs, start an HTTPS tunnel (e.g. `ngrok http 3000`) and set `PAYROOST_APP_URL` + `NEXT_PUBLIC_APP_URL` to that tunnel URL.
- [ ] In PayPal Developer Dashboard -> Sandbox REST App -> **Webhooks**, create a webhook pointing to:
  - `<PAYROOST_APP_URL>/api/webhooks/paypal`
- [ ] Subscribe to all supported webhook events (`SUPPORTED_PAYPAL_WEBHOOK_EVENTS` in `src/lib/paypal/webhooks.ts`):
  - `CHECKOUT.ORDER.APPROVED`
  - `PAYMENT.CAPTURE.PENDING`
  - `PAYMENT.CAPTURE.COMPLETED`
  - `PAYMENT.CAPTURE.DENIED`
- [ ] Copy the generated Webhook ID into `PAYPAL_WEBHOOK_ID` and restart the server.

---

## 4. End-to-End Live Smoke Walkthrough

Run these journeys sequentially using real test accounts and verify database/UI state after each step:

### A. Freelancer Onboarding & Project Setup (`/app`)
- [ ] Sign up / log in as a Freelancer at `/signup` or `/login` and confirm `/app` renders workspace navigation and profile settings.
- [ ] Update display profile in `/app/settings` (`PATCH /api/app/profile`).
- [ ] Connect Freelancer PayPal Sandbox seller account in `/app/settings` (`POST /api/app/freelancer/paypal/onboard` -> PayPal Sandbox Partner Referrals consent -> `/api/app/freelancer/paypal/callback`).
  - Verify status transitions to `COMPLETED` with `payments_receivable = true` and `primary_email_confirmed = true`.
- [ ] Create a new project (`/app/projects/new`) with a USD budget and test client email.

### B. Client Email Verification & AI-2 / AI-3 / AI-4 Authoring
- [ ] Trigger client email verification and verify SMTP delivery to the client inbox.
- [ ] Open the verification email link (`/verify-client-email?token=...`) and click verify (`POST /api/public/verify-client-email`).
  - Confirm `client_email_verified_at` is populated (`verify_client_email` RPC) and rate limiting (`checkRateLimit` / `consume_rate_limit`) protects repeated attempts.
- [ ] Run **AI-2** Project Brief Structuring, **AI-3** Agreement Drafting, and **AI-4** Milestone Planning; explicitly apply/save the draft and inspect saved milestones in `/app/projects/[projectId]`.

### C. Client Agreement Review & OTP Approval (`/review/[token]`)
- [ ] Generate a Client Review Link (`POST /api/projects/[projectId]/review-link`) and confirm the URL uses `PAYROOST_APP_URL` / `NEXT_PUBLIC_APP_URL`.
- [ ] Open `/review/[token]` -> request OTP (`POST /api/public/review/[token]/otp`) -> confirm SMTP OTP email delivery (`PAYROOST_OTP_SECRET`).
- [ ] Approve the agreement with the 6-digit OTP (`POST /api/public/review/[token]`).
  - Confirm agreement locks as `APPROVED`, milestones materialize/sync (`syncApprovedAgreementMilestones`), and notifications + history events appear.

### D. Client Portal Auth, Deliverable Cycle & PayPal Sandbox Checkout (`/portal/[token]`)
- [ ] Invite client to Client Portal (`POST /api/projects/[projectId]/portal-link`) -> confirm email contains canonical portal link and raw token is not leaked in freelancer DOM.
- [ ] Open `/portal/[token]` -> request Portal OTP (`POST /api/public/portal/[token]/otp`) -> verify session creation (`POST /api/public/portal/[token]/session`, 12-hour `HttpOnly` cookie + CSRF secret).
- [ ] On the Freelancer workspace, submit deliverables on Milestone 1 (`SUBMITTED`).
- [ ] Verify unpaid-USD rule in Client Portal: unpaid `SUBMITTED` USD milestone blocks `ACCEPTED` override until paid (`409 PAYMENT_REQUIRED_BEFORE_ACCEPTANCE`).
- [ ] Initiate PayPal Sandbox payment from Client Portal (`intents` -> `orders`):
  - Confirm `return_url` and `cancel_url` point to `PAYROOST_APP_URL` even if custom `Host`/`Origin` headers exist.
  - Approve checkout in PayPal Sandbox using the **Client Buyer Sandbox Account**.
  - Return to `/portal/[token]?payment_intent_id=...&payment_status=approved` -> confirm server-side capture (`capture`), ledger entries, and milestone paid status.
- [ ] Inspect PayPal Sandbox webhook delivery logs for `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` returning HTTP `200` from `/api/webhooks/paypal`.
- [ ] Accept the paid milestone deliverables in Client Portal (`POST /api/public/portal/[token]/milestones/[milestoneId]/review` -> `ACCEPTED`).
- [ ] Check Freelancer `/app/payments` Operations Grid and (optionally) trigger recovery check on any pending/reconciliation test row.

### E. AI-5 Scope Change, AI-6 Assistant & Notifications/History
- [ ] Run **AI-5** scope-change preview (`analyze-scope-change` / portal `scope-change/analyze`) -> edit request text to verify `STALE_ANALYSIS` warning -> regenerate -> submit with valid `PAYROOST_AI_SNAPSHOT_SECRET` signature.
- [ ] Ask a question in **AI-6** Project Assistant and verify grounded, non-leaky responses.
- [ ] Verify `/app/notifications` + header bell + Client Portal notifications + Project History panels:
  - Client history and notifications redact internal actor emails and hide internal reconciliation/reprocess/draft-edit noise.
  - Mark-one-read and mark-all-read update unread badges persistently.
