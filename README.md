# PayRoost

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16.4.4-black.svg)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Auth%20%7C%20PostgreSQL-3ECF8E.svg)](https://supabase.com/)
[![PayPal](https://img.shields.io/badge/PayPal-Multiparty%20Sandbox-003087.svg)](https://developer.paypal.com/)
[![AG Grid](https://img.shields.io/badge/AG%20Grid-React%20Community-0088cc.svg)](https://www.ag-grid.com/)
[![Tests](https://img.shields.io/badge/Tests-1%2C224%20Passing-brightgreen.svg)](vitest.config.ts)

**AI-assisted freelance agreements, milestone lifecycle management, and seller-directed marketplace payments.**

PayRoost bridges the gap between independent professionals and clients by turning informal project briefs into structured scopes and mutually reviewed agreements. It provides immutable version-controlled agreements, verified client email/portal/OTP workflows, milestone deliverable tracking, HMAC-signed AI scope-change proposals, a chronological project history and persistent notification system, a read-only transactional payment ledger, and PayPal Complete Payments Platform (Multiparty) Sandbox checkout and reconciliation.

---

## Product Highlights

- **AI-Assisted Project Workflows (AI-1 to AI-6):** Supports Gemini-powered project brief structuring (`AI-2`), agreement drafting (`AI-3`), standalone milestone planning (`AI-4`), cryptographically signed read-only scope-change impact proposals (`AI-5`), and a context-aware project assistant (`AI-6`) with strict non-escalation boundaries.
- **Cryptographically Immutable Agreements:** Agreement versions lock upon client OTP approval. Changes require an explicit new draft revision (`vN+1`) and bilateral review, leaving an immutable approval history.
- **Verified Client Email, Review & Portal Access:** Clients verify their email explicitly (`/verify-client-email`) and access agreement reviews (`/review/[token]`) and the workspace portal (`/portal/[token]`) via hashed bearer links, HMAC-protected OTP challenges, and timing-safe CSRF-bound sessions.
- **Seller-Directed Marketplace Payments:** Built for **PayPal Complete Payments Platform (Multiparty)** Sandbox (`PAYPAL_PAYMENT_MODE=PLATFORM`), connecting freelancer seller accounts via Partner Referrals and routing payments directly to verified seller accounts.
- **Audit-Ready Double-Entry Ledger & Recovery:** Financial transactions, captures, leases, and verified webhooks (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`) are tracked in PostgreSQL with canonical purchase-unit invariants and server-side reconciliation/recovery (`/app/payments`).
- **Notifications & Project History:** Role-scoped persistent notifications (`public.notifications`) and audience-filtered chronological project history (`public.activity_events`) distinguish work acceptance from payment confirmation across both Freelancer Workspace and Client Portal.

---

## Architectural & Security Invariants

1. **Milestone Workflow Is Not Escrow:** PayRoost routes marketplace payments directly to eligible seller accounts upon capture. It does not hold, pool, or escrow customer funds, and work acceptance stays separate from payment completion.
2. **Canonical Financial Invariants:** Payment intent purchase units enforce exact 2-decimal USD formatting, pure integer cents calculations, and strict identity binding (`custom_id` = Payment Intent UUID, `reference_id` = Milestone ID, `payee.merchant_id` = Seller Merchant ID).
3. **Fail-Closed Secrets & Canonical Redirects:** Review OTP HMACs (`PAYROOST_OTP_SECRET`), Portal OTP HMACs (`PORTAL_OTP_HMAC_SECRET`), AI scope-change snapshot signatures (`PAYROOST_AI_SNAPSHOT_SECRET`), and server-constructed OAuth/PayPal redirect origins (`PAYROOST_APP_URL` / `NEXT_PUBLIC_APP_URL`) fail closed with `503 CONFIGURATION_UNAVAILABLE` when missing, weak, or invalid — never trusting request `Host` / `Origin` / `X-Forwarded-Host` headers.
4. **Multi-Dimensional Rate Limiting:** Public review, portal, email verification, and payment endpoints enforce non-bypassable token-hash rate limits via PostgreSQL `consume_rate_limit` (failing closed with `503 RATE_LIMITER_UNAVAILABLE` in production when unavailable); secondary IP rate limiting runs only when `TRUST_PROXY="true"` behind a sanitized reverse proxy.
5. **Timing-Safe CSRF & 12-Hour Portal Sessions:** Portal mutations validate 64-character hex CSRF secrets with `crypto.timingSafeEqual`, bound to `__Host-` / `HttpOnly` 12-hour project-scoped sessions.

---

## Tech Stack

| Domain | Technology |
| :--- | :--- |
| **Framework** | [Next.js](https://nextjs.org/) (App Router, Turbopack, Server Actions) |
| **Language** | [TypeScript](https://www.typescriptlang.org/) (Strict Mode) |
| **Database & Auth** | [Supabase](https://supabase.com/) (PostgreSQL 15+, Row Level Security, RPCs) |
| **Styling & UI** | [Tailwind CSS](https://tailwindcss.com/), custom UI primitives (`src/components/ui/`), Lucide icons & self-hosted `Plus Jakarta Sans` / `Manrope` |
| **Data Grid** | [AG Grid React Community](https://www.ag-grid.com/) |
| **AI Integration** | [Google Gemini API](https://ai.google.dev/) (Briefs, Agreements, Scope Analysis & Assistant) |
| **Email Delivery** | Gmail SMTP via [Nodemailer](https://nodemailer.com/) (server-only, no custom domain required) |
| **Payments** | [PayPal Complete Payments Platform (Multiparty)](https://developer.paypal.com/) Sandbox |
| **Testing** | [Vitest](https://vitest.dev/) with `jsdom`, static SQL invariant suites |

---

## Getting Started

### Prerequisites

- **Node.js:** `v20.x` or higher
- **Package Manager:** `npm` (v10+)
- **Supabase Account:** Free local or cloud project
- **PayPal Developer Account:** Sandbox multiparty credentials

---

### Installation & Environment Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/oxmoriarty/payroost.git
   cd payroost
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Copy `.env.example` to `.env.local` and populate the required secrets:
   ```bash
   cp .env.example .env.local
   ```

   Key environment variables (see [`.env.example`](.env.example) for required vs optional annotations):
   ```ini
   # Supabase (Required)
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

   # AI Assistant (Optional unless AI routes are used)
   GEMINI_API_KEY=your-gemini-api-key
   GEMINI_MODEL=gemini-3.8-flash
   GEMINI_TIMEOUT_MS=25000
   GEMINI_MAX_RETRIES=2

   # PayPal Sandbox Multiparty Platform (Required for seller onboarding & checkout)
   PAYPAL_ENV=sandbox
   PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_PAYMENT_MODE=PLATFORM
   PAYPAL_CLIENT_ID=your-sandbox-client-id
   PAYPAL_CLIENT_SECRET=your-sandbox-client-secret
   PAYPAL_EXPECTED_MERCHANT_ID=your-sandbox-merchant-id
   PAYPAL_PARTNER_MERCHANT_ID=your-platform-sandbox-merchant-id
   PAYPAL_WEBHOOK_ID=your-sandbox-webhook-id
   # Optional PayPal overrides
   PAYPAL_PLATFORM_CLIENT_ID=
   PAYPAL_PLATFORM_CLIENT_SECRET=
   PAYPAL_PARTNER_ATTRIBUTION_ID=

   # Application URL & Gmail SMTP Email Delivery
   PAYROOST_APP_URL=http://localhost:3000
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   SMTP_USER=youraddress@gmail.com
   SMTP_PASS=your-16-char-google-app-password
   # Optional SMTP overrides (defaults target Gmail SSL)
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   PAYROOST_EMAIL_FROM=Payroost <youraddress@gmail.com>

   # Security Secrets (Server-only, >= 32 bytes for HMAC keys)
   PAYROOST_OTP_SECRET=your-32-plus-byte-review-otp-secret
   PORTAL_OTP_HMAC_SECRET=your-32-plus-byte-portal-otp-secret
   PAYROOST_AI_SNAPSHOT_SECRET=your-32-plus-byte-ai-snapshot-secret
   CRON_SECRET=
   TRUST_PROXY=false
   ```

---

### Database Setup & Migrations

PayRoost uses `35` sequential SQL migrations located in `supabase/migrations/` (`202611020001_initial_identity.sql` through `202611120002_restore_postgrest_table_and_rpc_grants.sql`):

```bash
# Inspect remote vs local migration state
supabase migration list

# Push migrations using Supabase CLI
supabase db push
```

Key database functions and triggers:
- `verify_client_email` and `consume_rate_limit`
- `create_client_payment_intent`, `create_sandbox_demo_payment_intent`, `record_paypal_order_captured`, and `reconcile_and_complete_payment_intent`
- `create_portal_otp_challenge`, `verify_portal_otp_and_create_session`, `validate_portal_session`, and `revoke_portal_session` / `revoke_portal_session_v2`
- `public.notifications` immutability triggers and `public.activity_events` notification projection trigger
- Agreement immutability triggers and active milestone payment constraints

---

### Running Locally & Live Sandbox Verification

```bash
# Start local development server
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) in your browser.

For deploying/testing against live Supabase, Gmail SMTP, Gemini, and PayPal Sandbox endpoints, follow [`docs/system_architecture/DEPLOYMENT_AND_SANDBOX_CHECKLIST.md`](docs/system_architecture/DEPLOYMENT_AND_SANDBOX_CHECKLIST.md). See [`docs/README.md`](docs/README.md) for updated system architecture docs and preserved original starter specs.

---

## Verification & Quality Gates

PayRoost includes an extensive automated test suite covering unit tests, route handlers, UI workflows, session/secret security, and database invariant contracts.

```bash
# 1. Run all 1,224 tests across 98 suites
npm test

# 2. Run TypeScript compiler diagnostics
npm run typecheck

# 3. Run ESLint checks
npm run lint

# 4. Create optimized production build
npm run build
```

---

## Project Structure

```text
payroost/
├── docs/
│   ├── README.md                 # Documentation directory index
│   ├── system_architecture/      # Live architecture, model changes, schema, security & UI docs
│   │   ├── ARCHITECTURE.md       # App Router pages, 47 API routes & domain modules
│   │   ├── DATA_MODEL.md         # 20 PostgreSQL tables, triggers & RPCs across 35 migrations
│   │   ├── DEPLOYMENT_AND_SANDBOX_CHECKLIST.md
│   │   ├── MODEL_AND_ARCHITECTURE_CHANGES.md
│   │   ├── SECURITY_PRIVACY.md   # Fail-closed secrets, CSRF, OTP, rate limiting & AI guards
│   │   └── UX_UI_SPEC.md         # Brand tokens, self-hosted fonts, motion & landing assets
│   └── Payroost_Codex_Starter/   # Preserved original Codex starter specs & phase reports
├── public/
│   ├── brand/                    # Custom PayRoost SVG logos & favicon
│   └── images/landing/           # Editorial showcase imagery for /
├── src/
│   ├── app/                      # Next.js App Router (pages & 47 backend API routes)
│   │   ├── (app)/app/            # Freelancer workspace (/app, projects, payments, notifications, settings)
│   │   ├── (auth)/               # Login & signup routes
│   │   ├── api/                  # Secure routes (ai, app, projects, public, webhooks, internal)
│   │   ├── portal/[token]/       # Verified client workspace portal
│   │   ├── review/[token]/       # Public client agreement review & OTP approval
│   │   ├── verify-client-email/  # Client email verification flow
│   │   └── page.tsx              # Redesigned editorial landing page
│   ├── components/               # Brand mark, app shell, auth form, landing showcase & UI primitives
│   ├── features/                 # Modular domain logic (agreements, ai, milestones, payments, portal, etc.)
│   ├── lib/                      # Server-only ai, auth, email (nodemailer), paypal, security & supabase
│   └── test/                     # Vitest environment & shared test setup
├── supabase/
│   └── migrations/               # 35 sequential PostgreSQL migrations
├── .env.example                  # Annotated environment template (no secrets)
├── LICENSE                       # MIT Open Source License
└── README.md                     # Repository documentation & setup guide
```

---

## License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for complete terms.
