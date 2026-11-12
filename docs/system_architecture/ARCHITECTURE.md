# PayRoost — Current System Architecture

## 1. Architectural Overview

PayRoost is implemented as a **Next.js `16.4.4` (App Router, Turbopack) modular monolith** written in strict TypeScript, backed by **Supabase** (Auth + PostgreSQL + Row Level Security + PL/pgSQL RPCs), **Groq** (`llama-3.3-70b-versatile`, high-speed primary AI provider) with **Google Gemini** (`gemini-3.8-flash`, automatic fallback AI provider), **PayPal Complete Payments Platform (Multiparty) Sandbox**, **Gmail SMTP (`nodemailer`)**, and **AG Grid React Community**.

External provider clients (`supabase/service.ts`, `ai/`, `paypal/`, `email/`, `security/`) live under `src/lib/` using `import "server-only"` so credentials and privileged operations never reach client bundles.

---

## 2. Application Page Routes (`src/app/`)

### Public & Client Entry Routes
- `/` — Editorial landing page and interactive workflow showcase (`src/app/page.tsx`)
- `/login`, `/signup` — Freelancer authentication pages (`src/app/(auth)/`)
- `/verify-client-email` — Explicit client email verification landing page
- `/review/[token]` — Token-gated public agreement review & OTP approval flow
- `/portal/[token]` — OTP-authenticated client workspace portal (agreements, deliverable acceptance, PayPal milestone checkout, scope-change requests, assistant, history, notifications)

### Authenticated Freelancer Workspace (`src/app/(app)/app/`)
- `/app` — Workspace overview dashboard
- `/app/projects` — Project directory
- `/app/projects/new` — Guided project creation & AI brief/agreement setup
- `/app/projects/[projectId]` — Project workspace (briefs, agreement versions, milestones, review/portal links, change requests, AI assistant, history)
- `/app/payments` — Payment Operations console (`ag-grid-react` Community table, inspection modal, recovery actions)
- `/app/notifications` — Persistent freelancer notification center
- `/app/settings` — Profile & PayPal Partner Referrals seller onboarding status

---

## 3. Complete Backend API Surface (`47` Routes)

### AI Endpoints (`/api/ai/*`)
- `POST /api/ai/structure-brief` (`AI-2`)
- `POST /api/ai/generate-agreement` (`AI-3`)
- `POST /api/ai/generate-milestones` (`AI-4`)
- `POST /api/ai/analyze-scope-change` (`AI-5`, returns HMAC-signed analysis snapshot)
- `POST /api/ai/project-assistant` (`AI-6`)

### Workspace & Freelancer Endpoints (`/api/app/*`)
- `GET /api/app/csrf` — Operator CSRF token issuance
- `GET, PATCH /api/app/profile` — Profile read/update (country eligibility, identity fields)
- `GET /api/app/notifications` — List freelancer notifications
- `POST /api/app/notifications/[notificationId]/read` — Mark single notification read
- `POST /api/app/notifications/mark-all-read` — Mark all notifications read
- `GET /api/app/payments/[intentId]` — Payment intent inspection
- `POST /api/app/payments/recovery` — Operator reconciliation/recovery action
- `POST /api/app/freelancer/paypal/onboard` — Create PayPal Partner Referral onboarding link
- `GET /api/app/freelancer/paypal/callback` — Verify and persist onboarding callback result
- `GET /api/app/freelancer/paypal/status` — Refresh seller capability/onboarding status

### Project & Workflow Endpoints (`/api/projects/[projectId]/*`)
- `POST /api/projects/[projectId]/client-verification` — Send client email verification link
- `GET, POST, PATCH /api/projects/[projectId]/agreement` — Manage agreement draft versions & send for review
- `POST, DELETE /api/projects/[projectId]/review-link` — Issue/revoke hashed review links
- `POST, DELETE /api/projects/[projectId]/portal-link` — Issue/revoke/email client portal invitations
- `GET, POST /api/projects/[projectId]/milestones` — Read/create milestones
- `PATCH, DELETE /api/projects/[projectId]/milestones/[milestoneId]` — Update/delete draft/active milestones
- `POST /api/projects/[projectId]/milestones/apply` — Apply planned milestones
- `POST /api/projects/[projectId]/milestones/sync` — Sync milestones from agreement draft
- `GET, POST /api/projects/[projectId]/change-requests` — List/create change requests (verifying signed AI snapshots when supplied)
- `PATCH /api/projects/[projectId]/change-requests/[changeRequestId]` — Approve/reject/resolve change requests
- `GET /api/projects/[projectId]/history` — Audience-filtered project activity history

### Public & Client Portal Endpoints (`/api/public/*`)
- `GET, POST /api/public/verify-client-email` — Complete client email verification challenge
- `GET, POST /api/public/review/[token]` — Load agreement version & submit review approval/revision note
- `POST /api/public/review/[token]/otp` — Issue agreement review 6-digit OTP
- `GET /api/public/portal/[token]` — Portal entry metadata & public state
- `POST /api/public/portal/[token]/otp` — Issue client portal 6-digit OTP
- `POST, DELETE /api/public/portal/[token]/session` — Verify OTP -> issue 12h session + CSRF / revoke session
- `POST /api/public/portal/[token]/milestones/[milestoneId]/review` — Client deliverable acceptance / revision feedback (independent of payment capture)
- `GET, POST /api/public/portal/[token]/payments/intents` — List/create milestone payment intent
- `POST /api/public/portal/[token]/payments/orders` — Create PayPal Multiparty order & approval link
- `POST /api/public/portal/[token]/payments/orders/[orderId]/capture` — Capture specific PayPal order
- `POST /api/public/portal/[token]/payments/capture` — Legacy/shared capture reconciliation endpoint
- `GET, POST /api/public/portal/[token]/change-requests` — List/submit client change requests (with signed AI impact snapshot verification)
- `POST /api/public/portal/[token]/scope-change/analyze` — Portal client scope-change preview (`AI-5`)
- `POST /api/public/portal/[token]/assistant` — Portal context-aware assistant (`AI-6`)
- `GET /api/public/portal/[token]/history` — Client-visible chronological project history
- `GET /api/public/portal/[token]/notifications` — List portal notifications
- `POST /api/public/portal/[token]/notifications/[notificationId]/read` — Mark notification read
- `POST /api/public/portal/[token]/notifications/mark-all-read` — Mark all portal notifications read

### Webhooks & Internal Recovery
- `POST /api/webhooks/paypal` — Signature-verified, deduplicated PayPal webhook processor (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, etc.)
- `POST /api/internal/payments/recover` — Optional `CRON_SECRET`-authenticated background payment recovery sweep

---

## 4. Feature & Infrastructure Layout

- **`src/features/`** — Domain logic cleanly separated into `agreements/`, `assistant/`, `briefs/`, `freelancer/`, `history/`, `milestones/`, `notifications/`, `payments/`, `portal/`, `projects/`, and `scope-changes/`.
- **`src/lib/ai/`** — Dual-provider AI infrastructure with Groq (`llama-3.3-70b-versatile`, primary) and Google Gemini (`gemini-3.8-flash`, fallback), unified under `ResilientAiProvider` with transparent failover on timeout or rate limit, 48s timeout budget, Zod schema validation, secret/error redaction, and audit logging.
- **`src/lib/email/`** — `nodemailer` SMTP transport (`provider.ts`) and HTML/text transactional templates (`templates.ts`).
- **`src/lib/paypal/`** — OAuth token manager (`auth.ts`), REST client (`client.ts`), env/mode resolution (`env.ts`, `payment-mode.ts`), webhook verifier & processor (`webhooks.ts`, `webhook-processor.ts`), and reconciliation service (`reconciliation-service.ts`).
- **`src/lib/security/`** — Canonical URL resolution (`app-url.ts`), trusted proxy client IP extraction (`client-ip.ts`), operator CSRF (`operator-csrf.ts`), portal OTP & sessions (`portal-otp.ts`, `portal-session.ts`), Postgres rate limiters (`rate-limit.ts`, `review-rate-limit.ts`), and HMAC/token utilities (`tokens.ts`).
- **`src/lib/supabase/`** — Server, browser, middleware, and service-role Supabase clients (`server.ts`, `client.ts`, `middleware.ts`, `service.ts`, `env.ts`, `server-env.ts`).
