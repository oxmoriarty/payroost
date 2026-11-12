# PayRoost — Deployment & Live Sandbox Checklist

This checklist reflects the live requirements defined in [`.env.example`](../../.env.example), `package.json`, and `supabase/migrations/`.

## 1. Environment Configuration (`.env.local`)

Copy `.env.example` to `.env.local` and supply server-only values (never commit `.env.local`).

### Supabase (Required)
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

### Google Gemini AI (Optional unless AI routes are used)
- `GEMINI_API_KEY`
- Optional overrides: `GEMINI_MODEL=gemini-3.8-flash`, `GEMINI_TIMEOUT_MS=25000`, `GEMINI_MAX_RETRIES=2`

### PayPal Multiparty Sandbox (Required for Seller Onboarding & Payments)
- `PAYPAL_ENV=sandbox`
- `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`
- `PAYPAL_PAYMENT_MODE=PLATFORM`
- `PAYPAL_CLIENT_ID` & `PAYPAL_CLIENT_SECRET`
- `PAYPAL_EXPECTED_MERCHANT_ID`
- `PAYPAL_PARTNER_MERCHANT_ID` (required when `PAYPAL_PAYMENT_MODE=PLATFORM`, 3-64 chars)
- `PAYPAL_WEBHOOK_ID` (required for `/api/webhooks/paypal` signature verification, 8-128 chars)
- Optional overrides: `PAYPAL_PLATFORM_CLIENT_ID` / `PAYPAL_PLATFORM_CLIENT_SECRET`, `PAYPAL_PARTNER_ATTRIBUTION_ID`

### App Origin & Gmail SMTP (Required for Links, OTPs & Invitations)
- `PAYROOST_APP_URL` (`http://localhost:3000` locally; **strict HTTPS non-localhost** in production)
- `NEXT_PUBLIC_APP_URL` (optional public fallback)
- `SMTP_USER` — Gmail address (e.g., `yourname@gmail.com`)
- `SMTP_PASS` — 16-character Google App Password (no custom sending domain required)
- Optional SMTP overrides: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `PAYROOST_EMAIL_FROM`

### Security Secrets & Proxy Trust
- `PAYROOST_OTP_SECRET` (required in dev & prod, `>= 32` bytes)
- `PORTAL_OTP_HMAC_SECRET` (required in prod, `>= 32` bytes)
- `PAYROOST_AI_SNAPSHOT_SECRET` (required when AI scope-change snapshot signing/verification runs, `>= 32` bytes)
- `CRON_SECRET` (optional bearer token for `POST /api/internal/payments/recover`, `>= 16` chars if set)
- `TRUST_PROXY=false` (set `"true"` only behind a reverse proxy that strips/overwrites `X-Real-IP` / `X-Forwarded-For`)

---

## 2. Supabase Schema Setup

Push all **35 sequential migrations** to your Supabase database:

```bash
supabase migration list
supabase db push
```

Confirm tables, RLS policies, and RPC grants (including `202611120002_restore_postgrest_table_and_rpc_grants.sql`) applied cleanly without drift.

---

## 3. PayPal Sandbox Verification Flow

1. Sign in as a freelancer (`/signup` or `/login`), configure a non-send-only eligible country in `/app/settings`, and complete PayPal Partner Referrals onboarding via `/api/app/freelancer/paypal/onboard`.
2. Confirm `/api/app/freelancer/paypal/status` reports verified merchant onboarding and capabilities.
3. Create a project in `/app/projects/new`, generate/edit an agreement (`AI-3`), send client verification (`/verify-client-email`), and issue a `/review/[token]` link.
4. Approve the agreement via OTP on `/review/[token]`, verify version immutability, then open `/portal/[token]` using a portal invitation + 6-digit OTP.
5. Accept a milestone deliverable, initiate checkout (`POST /api/public/portal/[token]/payments/orders`), approve on the PayPal Sandbox redirect URL, and verify capture + webhook reconciliation in `/app/payments`.

---

## 4. Automated Verification Gates

Run all four checks before deploying or pushing updates:

```bash
npm test       # 1,224 tests across 98 Vitest suites
npm run typecheck
npm run lint
npm run build
```
