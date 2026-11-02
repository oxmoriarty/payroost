# PayRoost

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16.4.4-black.svg)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Auth%20%7C%20PostgreSQL-3ECF8E.svg)](https://supabase.com/)
[![PayPal](https://img.shields.io/badge/PayPal-Multiparty%20Sandbox-003087.svg)](https://developer.paypal.com/)
[![AG Grid](https://img.shields.io/badge/AG%20Grid-React%20Community-0088cc.svg)](https://www.ag-grid.com/)
[![Tests](https://img.shields.io/badge/Tests-412%20Passing-brightgreen.svg)](vitest.config.ts)

**AI-assisted freelance agreements, milestone lifecycle management, and seller-directed marketplace payments.**

PayRoost bridges the gap between independent professionals and clients by turning informal project briefs into mutually agreed, legally sound scopes. It provides immutable version-controlled agreements, client milestone tracking, a read-only transactional payment ledger, and AI-powered scope protection to catch deviations before they become costly disputes.

---

## Product Highlights

- **AI Agreement Drafting & Scope Comparison:** Draft clear milestones and deliverables using Google Gemini API. Compare proposed scope changes against locked, approved agreement versions to flag scope creep early.
- **Cryptographically Immutable Agreements:** Agreement drafts lock upon client approval. Edits require explicit new version drafts, leaving a tamper-evident audit trail of past approvals.
- **Client Verification & Access Control:** Clients access project reviews and the client portal via secure magic links and timed OTP verification—no permanent credentials required.
- **Seller-Directed Marketplace Payments:** Built for **PayPal Complete Payments Platform (Multiparty)** Sandbox. The freelancer is the seller/payee; payments bind directly to approved milestone scopes.
- **Audit-Ready Double-Entry Ledger:** Financial transactions (intents, captures, releases) are tracked in an immutable PostgreSQL ledger with strict canonical invariants.
- **AG Grid Payment Operations Table:** High-performance, keyboard-accessible data grid visualizing transactions, payment statuses, and reconciliation timestamps.

---

## Architectural & Security Invariants

1. **Milestone Workflow Is Not Escrow:** PayRoost routes marketplace payments directly to eligible seller accounts upon capture. It does not hold or pool customer funds.
2. **Canonical Financial Invariants:** Payment intent purchase units enforce exact 2-decimal USD formatting, pure integer cents calculation (zero floating-point math), and mandatory identity binding (`custom_id` = Intent UUID, `reference_id` = Milestone ID, `payee.merchant_id` = Project Merchant ID).
3. **Multi-Dimensional Rate Limiting:** All public endpoints enforce a non-partitionable token-hash rate limit; secondary IP-based rate limiting activates strictly when `TRUST_PROXY === "true"` behind a validated reverse proxy.
4. **Timing-Safe CSRF Protection:** State-changing portal endpoints validate 64-character hex CSRF secrets using constant-time comparison (`crypto.timingSafeEqual`).
5. **Session Lifecycle Security:** Portal sessions enforce a 30-minute idle timeout, a 24-hour absolute expiration, and project binding to prevent cross-tenant session reuse.

---

## Tech Stack

| Domain | Technology |
| :--- | :--- |
| **Framework** | [Next.js](https://nextjs.org/) (App Router, Turbopack, Server Actions) |
| **Language** | [TypeScript](https://www.typescriptlang.org/) (Strict Mode) |
| **Database & Auth** | [Supabase](https://supabase.com/) (PostgreSQL 15+, Row Level Security, RPCs) |
| **Styling** | [Tailwind CSS](https://tailwindcss.com/) & Radix UI primitives |
| **Data Grid** | [AG Grid React Community](https://www.ag-grid.com/) |
| **AI Integration** | [Google Gemini API](https://ai.google.dev/) (Agreements & Change Analysis) |
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

   Key environment variables:
   ```ini
   # Supabase
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

   # AI Assistant
   GEMINI_API_KEY=your-gemini-api-key
   GEMINI_MODEL=gemini-1.5-flash

   # PayPal Sandbox (Multiparty)
   PAYPAL_ENV=sandbox
   PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_CLIENT_ID=your-sandbox-client-id
   PAYPAL_CLIENT_SECRET=your-sandbox-client-secret
   PAYPAL_EXPECTED_MERCHANT_ID=your-sandbox-merchant-id
   NEXT_PUBLIC_PAYPAL_CLIENT_ID=your-sandbox-client-id

   # Application & Email
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   RESEND_API_KEY=your-resend-key
   PAYROOST_EMAIL_FROM=Payroost <onboarding@resend.dev>

   # Security Secrets
   PAYROOST_OTP_SECRET=your-32-byte-hex-secret
   PORTAL_OTP_HMAC_SECRET=your-32-byte-hex-secret
   TRUST_PROXY=false
   ```

---

### Database Setup & Migrations

PayRoost uses 16 sequential SQL migrations located in `supabase/migrations/`:

```bash
# Push migrations using Supabase CLI
supabase db push
```

Key database functions and triggers:
- `create_client_payment_intent` / `create_sandbox_demo_payment_intent`
- `validate_portal_session` / `revoke_portal_session`
- `create_portal_otp_challenge` / `consume_portal_otp_and_create_session`
- Agreement immutability triggers and active milestone payment constraints

---

### Running Locally

```bash
# Start local development server
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) in your browser.

---

## Verification & Quality Gates

PayRoost includes an extensive automated test suite covering unit tests, route handlers, session security, and database invariant contracts.

```bash
# 1. Run all 412 tests
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
├── Payroost_Codex_Starter/       # Product specifications and architecture docs
│   ├── ARCHITECTURE.md           # System design & flow specifications
│   ├── DATA_MODEL.md             # Entity relationships & state machine
│   ├── PAYPAL_INTEGRATION.md     # Multiparty integration & country rules
│   └── SECURITY_PRIVACY.md       # Access model & risk boundaries
├── src/
│   ├── app/                      # Next.js App Router (pages & API routes)
│   │   ├── api/                  # Secure backend routes
│   │   │   ├── ai/               # Agreement drafting & scope comparison
│   │   │   ├── projects/         # Project agreements, milestones & links
│   │   │   └── public/           # Client review & portal OTP/session endpoints
│   │   ├── app/                  # Authenticated freelancer dashboard
│   │   ├── review/               # Public client review portal
│   │   └── verify-client-email/  # Email verification flow
│   ├── features/                 # Modular domain logic
│   │   ├── agreements/           # Scope editor, versioning & review security
│   │   ├── payments/             # AG Grid operations table & ledger tests
│   │   └── projects/             # Project state management
│   └── lib/                      # Core cross-cutting infrastructure
│       ├── email/                # Resend transactional email provider
│       ├── paypal/               # PayPal SDK client & webhook validator
│       ├── security/             # CSRF, token hashing, rate limiters & IP logic
│       └── supabase/             # Server, client & service role DB factories
├── supabase/
│   └── migrations/               # 16 sequential PostgreSQL migrations
├── LICENSE                       # MIT Open Source License
└── README.md                     # Documentation for judges & developers
```

---

## License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for complete terms.
