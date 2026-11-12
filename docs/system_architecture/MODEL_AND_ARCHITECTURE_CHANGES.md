# PayRoost — Model & Architecture Changes

This document records the concrete differences between the initial specifications preserved in [`../Payroost_Codex_Starter/`](../Payroost_Codex_Starter/) and the current PayRoost implementation.

## 1. Payment Architecture: Platform Multiparty & Server-Redirect Checkout

- **Default Payment Mode (`PLATFORM`):** PayRoost operates in PayPal Complete Payments Platform (Multiparty) Sandbox mode by default (`PAYPAL_PAYMENT_MODE=PLATFORM`), with server-side partner attribution (`PAYPAL_PARTNER_MERCHANT_ID`, optional `PAYPAL_PARTNER_ATTRIBUTION_ID`, and optional dedicated `PAYPAL_PLATFORM_CLIENT_ID` / `PAYPAL_PLATFORM_CLIENT_SECRET`).
- **Freelancer Seller Onboarding:** Added a Partner Referrals onboarding flow (`/api/app/freelancer/paypal/onboard`, `/api/app/freelancer/paypal/callback`, `/api/app/freelancer/paypal/status`) backed by `public.freelancer_paypal_accounts` and strict server-side seller readiness checks.
- **Conservative Country Eligibility Rule Preserved:** Freelancers in send-only / review-required jurisdictions (such as Nigeria) remain blocked from PayPal seller payment routing (`PAYPAL_ELIGIBILITY_REVIEW_REQUIRED`).
- **Server-Redirect Approval Replaces Client PayPal JS SDK:** Rather than loading the browser PayPal JavaScript SDK on client payment pages, the server creates multiparty PayPal orders bound with canonical identifiers (`custom_id` = intent UUID, `reference_id` = milestone ID, `payee.merchant_id` = seller merchant ID), returns the PayPal approval redirect URL, captures completed orders server-side, verifies webhook signatures (`PAYPAL_WEBHOOK_ID`), and supports internal/operator reconciliation and recovery (`/app/payments`, `/api/app/payments/recovery`, `/api/internal/payments/recover`).
- **No Escrow Claim:** Work/deliverable acceptance remains separate from payment completion; PayRoost does not custody, pool, or escrow client funds.

## 2. Email Delivery: Resend Removed -> Gmail SMTP via Nodemailer

- **Zero Resend Integration:** All Resend dependencies, webhook assumptions, and environment variables (`RESEND_API_KEY`, etc.) were completely removed across runtime code, tests, `.env.example`, and documentation.
- **Gmail SMTP via `nodemailer`:** Transactional emails (client email verification links, review OTPs, client portal OTPs, and portal invitations) are now delivered through `nodemailer` (`^10.5.0`) in [`src/lib/email/provider.ts`](../../src/lib/email/provider.ts), configured via `SMTP_USER` and `SMTP_PASS` (with automatic whitespace normalization for 16-character Google App Passwords when `SMTP_HOST=smtp.gmail.com`) and optional overrides `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and `PAYROOST_EMAIL_FROM`. This removes any custom sending domain requirement.

## 3. AI Features: Gemini `gemini-3.8-flash`, AI-2 to AI-6 & Signed Scope Snapshots

- **Model & Client:** Switched from older Gemini starter assumptions to a dedicated server-only Gemini REST client (`src/lib/ai/`) defaulting to `gemini-3.8-flash` (`GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_RETRIES`) with Zod schema validation and error/secret redaction.
- **Implemented AI Workflows:**
  - `AI-2`: Project brief structuring (`/api/ai/structure-brief`)
  - `AI-3`: Structured agreement drafting (`/api/ai/generate-agreement`)
  - `AI-4`: Standalone milestone planning (`/api/ai/generate-milestones`)
  - `AI-5`: Cryptographically signed read-only scope-change impact analysis (`/api/ai/analyze-scope-change` and `/api/public/portal/[token]/scope-change/analyze`) using HMAC-SHA256 verification (`PAYROOST_AI_SNAPSHOT_SECRET`) when submitting change requests
  - `AI-6`: Context-aware project assistant for both freelancers (`/api/ai/project-assistant`) and verified portal clients (`/api/public/portal/[token]/assistant`)

## 4. Client Access, Verification & Security Hardening

- **Dedicated Client Email Verification Flow:** Added `/verify-client-email` and `/api/public/verify-client-email` (`public.client_email_verifications`, `verify_client_email` RPC) initiated by project owners (`/api/projects/[projectId]/client-verification`).
- **Dual Public Entry Flows:** Retained hashed Agreement Review links (`/review/[token]`) with OTP verification (`PAYROOST_OTP_SECRET`) and expanded the persistent **Client Portal** (`/portal/[token]`) with hashed bearer tokens (`client_portal_tokens`), OTP challenges (`PORTAL_OTP_HMAC_SECRET`), `12-hour` `HttpOnly` project-scoped sessions (`client_portal_sessions`), and `64-character` hex CSRF validation via `crypto.timingSafeEqual`.
- **Fail-Closed Origins & Rate Limiting:** Server redirects and verification/portal links are built exclusively from validated origins (`PAYROOST_APP_URL` / `NEXT_PUBLIC_APP_URL`), failing closed (`503 CONFIGURATION_UNAVAILABLE`) rather than trusting request headers. Public and sensitive routes enforce non-bypassable PostgreSQL token-hash rate limits (`consume_rate_limit`), with IP-based secondary throttling active only when `TRUST_PROXY="true"`.

## 5. Collaboration, Notifications & Data Model Expansion

- **Schema Expansion:** Evolved from the initial starter draft to **35 sequential SQL migrations** (`supabase/migrations/202611020001_initial_identity.sql` through `202611120002_restore_postgrest_table_and_rpc_grants.sql`) and **20 relational tables**.
- **History & Notifications:** Added `public.project_participants`, audience-filtered chronological history (`public.activity_events`), and append/read-only projected notifications (`public.notifications`) surfaced in `/app/notifications`, project detail views, and `/portal/[token]`.

## 6. Brand, UI System, Typography & Landing Redesign

- **Custom Brand & Self-Hosted Typography:** Replaced starter typography (`Inter` / `Geist` / early serif prototypes) with self-hosted `@fontsource-variable/plus-jakarta-sans` (display) and `@fontsource-variable/manrope` (body) over a warm paper surface (`#f6f5f0`), deep ink palette (`#07131a`–`#0d1c25`), and teal accent (`#057f79` / `#056760`).
- **No Radix UI:** Built custom accessible UI primitives directly in `src/components/ui/` (`badge.tsx`, `button.tsx`, `card.tsx`, `motion.tsx`) paired with `lucide-react` icons and custom brand SVGs (`public/brand/PayRoostLogo.svg`, `PayRoostLogo-dark.svg`, `PayRoostFavicon.svg`).
- **Editorial Landing Showcase & Motion System:** Redesigned `/` with editorial layout rhythm, custom studio/payment visual assets (`public/images/landing/*`), interactive `WorkflowShowcase` (`src/components/landing/workflow-showcase.tsx`), `Reveal` / `pr-page-enter` / `pr-interactive-card` micro-interactions across pages (honoring `prefers-reduced-motion`), and responsive mobile navigation/layouts.
- **AG Grid Community:** Retained `ag-grid-react` Community exclusively on `/app/payments` (`src/features/payments/payment-operations-grid.tsx`) with mobile card fallbacks and no Enterprise modules.
