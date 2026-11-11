# PayRoost — Phase P1: Product Workflow Completion Report

**Date:** 2026-11-11  
**Base Commit:** `a81e3c1` (`feat(payments): complete Phase 3B.R5 payment operations, investigation, and recovery`)  
**Scope:** Client and Freelancer product workflow completion, `/app` workspace usability, agreement & milestone lifecycle continuity, and `/portal/[token]` consistency without touching R4/R5 payment infrastructure, AI provider config, or database migrations.

---

## 1. Preflight Findings & Confirmed Decisions

### Confirmed Preflight Architecture Decisions
1. **Workspace Ownership (Option 1):** Keep `/app` as the authenticated Freelancer workspace scoped to `projects.owner_id`, and keep `/review/[token]` and `/portal/[token]` as the OTP/session-verified Client review and workspace flows. Preserve existing schema, RLS policies, OTP verification, HMAC portal sessions, and CSRF protections with zero database migrations.
2. **Milestone Acceptance vs. Payment Eligibility:** Preserve strict separation between deliverable acceptance and payment completion. A client may accept a `SUBMITTED` milestone when it is already `PAID` (or non-USD). For an unpaid USD milestone, display an explicit warning that current PayPal checkout flows do not permit checkout initiation once a milestone status becomes `ACCEPTED`, and **block any override** so the milestone remains `SUBMITTED` until payment is completed (or revisions are requested). Payment completion never automatically marks deliverables as accepted.
3. **Strict Boundary Isolation:** No edits to `src/lib/paypal/**`, `src/features/payments/**`, payment routes/RPCs/migrations, seller onboarding (`PayPalSellerSettingsCard`), webhook processing, Gemini configuration, or `.env.local`.

### Identified Workflow & Product Gaps Resolved in P1
1. **Authenticated Shell & Overview Placeholders:** `AppHeader` had a hardcoded `"Good morning, Sam"` greeting, non-interactive mobile menu icon, and non-functional notification bell; `/app` displayed static `"Foundation mode"` and `"0"` placeholder cards; `/app/projects` lacked search and status filtering; `/app/settings` had a static `"Profile controls"` placeholder card.
2. **Agreement Lifecycle Visibility & Revisions:** `AgreementEditor` rendered `versions.length === 0` or `DRAFT` nicely, but lacked dedicated rendering and controls when the latest version was `PENDING_CLIENT`, `APPROVED`, `CHANGES_REQUESTED`, or `SUPERSEDED`, lacked an interactive Version History viewer, and lacked a `Create draft revision (vN+1)` flow. `PublicReviewView` and `/portal/[token]` lacked unified structured agreement terms formatting.
3. **Client Portal Invitation Disconnect:** `POST /api/projects/[projectId]/portal-link` existed on the backend, but freelancers had no workspace UI trigger in `/app/projects/[projectId]` to send a verified client into `/portal/[token]` (nor gating feedback before client email verification).
4. **Milestone Promotion & Deliverable Delivery Loop:** Client agreement approval did not promote `DRAFT`/`AWAITING_APPROVAL` milestones to `APPROVED` (or materialize approved agreement milestones when missing); owner milestone `PUT` lacked post-approval locks and returned `500` on unauthenticated calls; freelancers had no structured deliverable submission action (`APPROVED -> IN_PROGRESS -> SUBMITTED`); clients had no deliverable review UI/endpoint (`SUBMITTED -> ACCEPTED` or `CHANGES_REQUESTED`) inside `/portal/[token]`.
5. **Payment/Escrow Wording Consistency:** `src/lib/email/templates.ts` referenced `"payment escrow"` in the shared email footer, and `ClientPortalWorkspaceView` used `"authorize milestone release payments"` wording inconsistent with PayRoost's non-escrow PayPal Platform model.

---

## 2. Features Completed

### Wave 1 — Workspace Shell, Overview Dashboard, Projects Filtering & Profile Settings
- Shared navigation constants ([`APP_NAV_LINKS`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/components/app/nav-links.ts) and [`isNavLinkActive`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/components/app/nav-links.ts)), client-side active route highlighting in [`sidebar.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/components/app/sidebar.tsx), and non-escrow footer copy.
- Dynamic user identity (`userLabel`/`userEmail`), responsive mobile navigation drawer, and interactive Workspace Notifications bell popover in [`header.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/components/app/header.tsx) hydrated via [`getWorkspaceChromeData`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/projects/data.ts) in [`layout.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/(app)/layout.tsx).
- Live SSR workspace summary (`export const dynamic = "force-dynamic"`) in [`app/page.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/(app)/app/page.tsx) powered by [`getDashboardSummary`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/projects/data.ts): project counts, Needs Attention queue, Recent Projects, Recent Activity, and a read-only link to Payment Operations (`/app/payments`), with safe fallback when Supabase env vars are unconfigured.
- Search input, status filters with counts, project progress badges, and clean empty-filter recovery in [`projects-list-view.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/projects/projects-list-view.tsx) wired into [`projects/page.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/(app)/app/projects/page.tsx).
- Controlled currency/amount live formatted total hint (`formatMoney`) in [`new-project-form.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/projects/new-project-form.tsx).
- Functional freelancer profile editing (`display_name`, `country_code`) via CSRF-protected [`PATCH /api/app/profile`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/app/profile/route.ts), [`ProfileSettingsCard`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/freelancer/profile-settings-card.tsx), and [`settings/page.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/(app)/app/settings/page.tsx) (keeping `PayPalSellerSettingsCard` untouched).

### Wave 2 — Structured Agreement Rendering, Version History, Revisions & Portal Invites
- Shared structured agreement renderer [`AgreementDocumentView`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/agreements/agreement-document-view.tsx) displaying executive summary, objective, deliverables, acceptance criteria, assumptions, milestone schedule with formatted currency totals, timeline, exclusions, payment/revision/change terms, non-legal disclaimer, and browser print action.
- Enhanced [`AgreementEditor`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/agreements/agreement-editor.tsx) supporting non-`DRAFT` versions (`PENDING_CLIENT`, `APPROVED`, `CHANGES_REQUESTED`, `SUPERSEDED`), interactive Version History selector, and explicit `Create draft revision (vN+1)` button cloning prior content without breaking existing draft/AI-3 preview behavior.
- Upgraded [`PublicReviewView`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/agreements/public-review-view.tsx) to render the complete agreement terms and milestone schedule via `AgreementDocumentView`.
- Added [`PortalInviteCard`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/projects/portal-invite-card.tsx) in [`projects/[projectId]/page.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/(app)/app/projects/[projectId]/page.tsx) invoking `POST /api/projects/[projectId]/portal-link`, gated on verified client email (`isClientVerified`), showing expiry/delivery confirmation and surfacing provider/rate-limit errors without exposing raw tokens.

### Wave 3 — Authoritative Milestone Promotion, Deliverable Submission & Portal Consistency
- Idempotent milestone promotion helper [`syncApprovedAgreementMilestones`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/milestones/sync.ts) triggered upon agreement approval in [`POST /api/public/review/[token]`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/public/review/[token]/route.ts), via [`POST /api/projects/[projectId]/milestones/sync`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/projects/[projectId]/milestones/sync/route.ts), and as catch-up SSR sync on workspace/portal loads: promotes `DRAFT`/`AWAITING_APPROVAL` rows to `APPROVED` or materializes rows from `approvedVersion.content.milestones` while preserving committed or payment-linked milestones.
- Activity note extraction helper [`extractMilestoneNotes`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/milestones/activity-notes.ts) deriving submission notes, safe `http(s)` deliverable links, and client feedback from `activity_events.metadata`.
- Hardened [`/api/projects/[projectId]/milestones/[milestoneId]`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/projects/[projectId]/milestones/[milestoneId]/route.ts): fixed `401` on unauthenticated calls, locked `PUT` editing post-approval (`409 MILESTONE_LOCKED_AFTER_APPROVAL`), blocked owner self-`ACCEPTED` (`403`), and added `PATCH` work-state transitions (`APPROVED -> IN_PROGRESS -> SUBMITTED`, `CHANGES_REQUESTED -> IN_PROGRESS | SUBMITTED`) with active payment intent checks and structured `activity_events`.
- Added [`MilestoneWorkspacePanel`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/milestones/milestone-workspace-panel.tsx) plus a 4-stage workflow progress indicator, Project Brief & Dates summary card, and section anchors (`#agreement`, `#milestones`, `#scope-changes`) in `/app/projects/[projectId]`, separating **Work status** badges from read-only **Payment status** badges.
- Added verified Client Portal deliverable review endpoint [`POST /api/public/portal/[token]/milestones/[milestoneId]/review`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/public/portal/[token]/milestones/[milestoneId]/review/route.ts) using [`authenticatePortalRequest`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/scope-changes/portal-auth.ts) (`rateLimitPrefix: "portal-milestone-review"`), enforcing `SUBMITTED` state, blocking concurrent active payment intents, blocking acceptance on unpaid USD milestones (`409 PAYMENT_REQUIRED_BEFORE_ACCEPTANCE`), allowing acceptance on `PAID` (or non-USD) milestones (`-> ACCEPTED`), and allowing revision requests with a >= 3-character note (`-> CHANGES_REQUESTED`).
- Updated [`portal/[token]/page.tsx`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/portal/[token]/page.tsx), [`portal/types.ts`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/portal/types.ts), and [`ClientPortalWorkspaceView`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/portal/client-portal-workspace-view.tsx) to include agreed agreement terms + version history viewer, acceptance criteria & deliverable/feedback notes, separated work vs. payment badges, Client deliverable review controls honoring Decision #2 (warning banner + disabled/blocked unpaid USD acceptance), sanitized Activity History, and corrected non-escrow copy.
- Updated shared email footer copy in [`templates.ts`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/lib/email/templates.ts) from `"payment escrow"` to `"Verified freelance agreements, milestone tracking, and payment coordination."`.

---

## 3. Files Created and Modified

### Modified Files (19)
- `src/app/(app)/layout.tsx`
- `src/app/(app)/app/page.tsx`
- `src/app/(app)/app/projects/page.tsx`
- `src/app/(app)/app/projects/[projectId]/page.tsx`
- `src/app/(app)/app/settings/page.tsx`
- `src/app/api/projects/[projectId]/milestones/[milestoneId]/route.ts`
- `src/app/api/public/review/[token]/route.ts`
- `src/app/portal/[token]/page.tsx`
- `src/components/app/header.tsx`
- `src/components/app/sidebar.tsx`
- `src/features/agreements/agreement-editor.tsx`
- `src/features/agreements/public-review-view.tsx`
- `src/features/portal/client-portal-workspace-view.tsx`
- `src/features/portal/types.ts`
- `src/features/projects/data.ts`
- `src/features/projects/new-project-form.tsx`
- `src/features/projects/types.ts`
- `src/features/scope-changes/portal-auth.ts`
- `src/lib/email/templates.ts`

### Created Files (20, including this report)
- `src/app/api/app/profile/route.ts`
- `src/app/api/app/profile/route.test.ts`
- `src/app/api/projects/[projectId]/milestones/[milestoneId]/route.test.ts`
- `src/app/api/projects/[projectId]/milestones/sync/route.ts`
- `src/app/api/public/portal/[token]/milestones/[milestoneId]/review/route.ts`
- `src/app/api/public/portal/[token]/milestones/[milestoneId]/review/route.test.ts`
- `src/components/app/nav-links.ts`
- `src/features/agreements/agreement-document-view.tsx`
- `src/features/agreements/agreement-versions-ui.test.tsx`
- `src/features/freelancer/profile-settings-card.tsx`
- `src/features/milestones/activity-notes.ts`
- `src/features/milestones/milestone-workspace-and-portal-consistency.test.tsx`
- `src/features/milestones/milestone-workspace-panel.tsx`
- `src/features/milestones/sync.ts`
- `src/features/milestones/sync.test.ts`
- `src/features/projects/portal-invite-card.tsx`
- `src/features/projects/portal-invite-card.test.tsx`
- `src/features/projects/projects-list-view.tsx`
- `src/features/projects/workspace-ui.test.tsx`
- `phase-p1-product-workflow-completion-report.md` (this report)

Zero files were modified under `src/lib/paypal/**`, `src/features/payments/**`, `supabase/migrations/**`, PayPal payment API routes, or seller onboarding components.

---

## 4. Client Workflow Results

- **Verification & Agreement Review (`/review/[token]`):** Client accesses OTP-verified agreement proposals rendered consistently with `AgreementDocumentView` (scope, deliverables, acceptance criteria, assumptions, milestones, formatted totals, exclusions, terms) and approves or requests revisions.
- **Client Portal Entry & Agreement Transparency (`/portal/[token]`):** After email verification and freelancer portal invitation (via `PortalInviteCard`), client signs in with OTP, views the active approved agreement summary, full terms modal/drawer (`AgreementDocumentView`), and historical agreement versions.
- **Deliverable Review & Payment Separation:** Client sees acceptance criteria, freelancer submission notes, clickable `http(s)` deliverable URLs, and separated Work status vs. PayPal payment status badges. For paid `SUBMITTED` milestones (or non-USD), client can accept deliverables (`-> ACCEPTED`) or request revisions (`-> CHANGES_REQUESTED`). For unpaid USD `SUBMITTED` milestones, an explicit warning explains that PayPal checkout cannot initiate once `ACCEPTED`, acceptance is blocked (UI + `409 PAYMENT_REQUIRED_BEFORE_ACCEPTANCE` server enforcement), and payment/revision actions remain distinct.
- **Scope Changes & Project Assistant:** Client submits and reviews scope changes + AI analyses and asks questions via the verified portal endpoints (`x-csrf-token`, HMAC session).

---

## 5. Freelancer Workflow Results

- **Workspace Navigation & Discovery (`/app`, `/app/projects`, `/app/settings`):** Freelancer sees dynamic header identity, mobile navigation drawer, actionable notification bell popover, live dashboard KPIs, Needs Attention queue, Recent Projects, Recent Activity, searchable/filterable projects list, live formatted amount hints in `/app/projects/new`, and editable profile settings alongside PayPal seller onboarding.
- **Project Workspace (`/app/projects/[projectId]`):** 4-stage workflow stepper guides the freelancer from Brief & Agreement -> Client Approval -> Milestone Delivery & Payment -> Project Activity.
- **Agreement Negotiation & Revision Cloning:** Freelancer creates/edits `DRAFT` agreements (with AI-3 preview), views `PENDING_CLIENT` / `APPROVED` / `CHANGES_REQUESTED` / `SUPERSEDED` versions, inspects historical versions, and clones a new `DRAFT` `vN+1` cleanly after client feedback or approval.
- **Client Handoff & Delivery:** Freelancer sends Client Portal invitations once client email is verified (`PortalInviteCard`), reviews formally agreed milestones synced from the approved agreement, starts work (`APPROVED -> IN_PROGRESS`), submits deliverable notes + `http(s)` links (`-> SUBMITTED`), sees client revision notes (`CHANGES_REQUESTED`), and manages scope changes + Project Assistant.

---

## 6. Client Portal & Dashboard Consistency Results

- **Shared Agreement Presentation:** Both `/app/projects/[projectId]`, `/review/[token]`, and `/portal/[token]` use `AgreementDocumentView` and identical formatting helpers, clearly distinguishing `DRAFT` vs. `PENDING_CLIENT` vs. `APPROVED` vs. `CHANGES_REQUESTED` vs. `SUPERSEDED`.
- **Single Authoritative Milestone Promotion:** `syncApprovedAgreementMilestones` ensures both freelancer workspace and client portal reflect `APPROVED` milestones with identical titles, amounts, currencies, due dates, and acceptance criteria after agreement approval.
- **Consistent Deliverable & Payment State Model:** Work lifecycle (`DRAFT`, `AWAITING_APPROVAL`, `APPROVED`, `IN_PROGRESS`, `SUBMITTED`, `CHANGES_REQUESTED`, `ACCEPTED`) and PayPal lifecycle (`UNPAID`, `INTENT_CREATED`, `ORDER_CREATED`, `CAPTURING`, `PAID`, etc.) remain visually and behaviorally decoupled on both surfaces.
- **Activity History Alignment:** Portal Activity History exposes project-relevant sanitized activity summaries without leaking internal operational noise.

---

## 7. Security and Authorization Checks

- **Portal Auth, OTP, Session & CSRF:** Zero relaxation of `/review/[token]` or `/portal/[token]` OTP challenge, timing-safe HMAC portal session validation, or double-submit CSRF checks (`x-csrf-token`). `POST /api/public/portal/[token]/milestones/[milestoneId]/review` reuses `authenticatePortalRequest` with dedicated rate-limit prefix `"portal-milestone-review"`.
- **Freelancer Route Authorization:**
  - `PATCH /api/app/profile` validates authenticated session and operator CSRF origin/token checks before updating `public.profiles` and auth metadata for the caller only.
  - `POST /api/projects/[projectId]/milestones/sync` verifies project ownership (`owner_id`).
  - `/api/projects/[projectId]/milestones/[milestoneId]` (`PUT` & `PATCH`) returns `401` when unauthenticated, enforces `owner_id`, rejects post-approval structural edits (`409 MILESTONE_LOCKED_AFTER_APPROVAL`), prevents freelancer self-acceptance (`403`), guards against mutating milestones under active PayPal payment intents (`ORDER_CREATED`, `CAPTURING`, `RECONCILIATION_REQUIRED`), and validates URL schemes (`http:`/`https:` only).
- **Portal Token Privacy:** `PortalInviteCard` triggers server-side invite email dispatch without displaying raw tokenized portal URLs in workspace DOM responses.

---

## 8. Tests and Build Results

All checks below were executed cleanly **after the final code edit**:

| Check | Command | Outcome | Notes |
| --- | --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | Passed (exit `0`) | Zero errors |
| ESLint | `npx eslint .` | Passed (exit `0`) | Zero errors/warnings |
| Full Test Suite | `npm test` (`vitest run`) | **83 / 83** test files passed; **1,142 / 1,142** tests passed (`0` failures, `0` skipped) | Uses deterministic mocks where Supabase/Resend/Gemini/PayPal external services are absent |
| Production Build | `npm run build` (`next build`) | Passed (exit `0`) | All 21 static/dynamic route passes compiled cleanly with Next.js 16.4.4 (Turbopack) |

### Highlighted P1 New / Updated Test Coverage (verified in `npm test`)
- `src/app/api/app/profile/route.test.ts` — **3** passed (auth, validation, profile update)
- `src/features/projects/workspace-ui.test.tsx` — **4** passed (header identity/drawer/notifications, projects filter/empty state, non-escrow email footer)
- `src/features/agreements/agreement-versions-ui.test.tsx` — **3** passed (non-`DRAFT` viewer, version history switcher, `vN+1` draft revision cloning, `PublicReviewView` rendering)
- `src/features/projects/portal-invite-card.test.tsx` — **3** passed (verification gating, invite dispatch without raw token leak, error display)
- `src/features/milestones/sync.test.ts` — **4** passed (idempotent milestone promotion/materialization & note extraction)
- `src/app/api/projects/[projectId]/milestones/[milestoneId]/route.test.ts` — **7** passed (`401` auth, `409` post-approval `PUT` lock, `403` owner self-accept block, `PATCH` deliverable transitions & URL validation)
- `src/app/api/public/portal/[token]/milestones/[milestoneId]/review/route.test.ts` — **5** passed (portal auth, `SUBMITTED` requirement, `409 PAYMENT_REQUIRED_BEFORE_ACCEPTANCE` on unpaid USD, `PAID` accept -> `ACCEPTED`, revision request -> `CHANGES_REQUESTED`)
- `src/features/milestones/milestone-workspace-and-portal-consistency.test.tsx` — **3** passed (freelancer submission + separated badges, unpaid USD override block in Client Portal, paid acceptance without payment side effects)
- Regression coverage verified intact (`0` failures): `client-checkout.test.tsx` (**29** passed), `agreement-editor.test.ts` (**8** passed), `agreement-editor-preview.test.tsx` (**4** passed), `milestone-planner.test.tsx` (**3** passed), `scope-change-panel.test.tsx` (**4** passed), `project-brief-assistant.test.tsx` (**8** passed), `project-assistant-panel.test.tsx` (**3** passed), `email.test.ts` (**12** passed), `data.test.ts` (**1** passed), plus all R1–R5 payment test suites.

---

## 9. Known Limitations & Deferred Dependencies

- **Live External Credentials:** Vitest verification uses deterministic mocks; end-to-end live behavior with Supabase Auth/RLS email delivery, Resend templates, Gemini Free Tier API, and live/sandbox PayPal checkout depends on configured environment secrets outside repository scope.
- **Unpaid USD Acceptance Constraint:** By design under confirmed Preflight Decision #2, clients cannot accept an unpaid USD milestone while PayPal checkout disallows `ACCEPTED` milestones; the milestone must either be paid while `SUBMITTED` or returned via `REQUEST_REVISION`.
- **Client Account Auth Deferred:** Clients authenticate via email verification + OTP + portal token links (`/review/[token]`, `/portal/[token]`) rather than standalone client Supabase login accounts, preserving schema/RLS boundaries.

---

## 10. Coordination Required with R4 / R5

- **`ACCEPTED` Milestone PayPal Checkout Eligibility:** Currently, all four PayPal portal payment endpoints reject `milestone.status === "ACCEPTED"` with `400 MILESTONE_NOT_PAYABLE` because their allowlist is restricted to `["APPROVED", "IN_PROGRESS", "SUBMITTED"]`:
  - `src/app/api/public/portal/[token]/payments/intents/route.ts` (line 257)
  - `src/app/api/public/portal/[token]/payments/orders/route.ts` (line 397)
  - `src/app/api/public/portal/[token]/payments/orders/[orderId]/capture/route.ts` (line 478)
  - `src/app/api/public/portal/[token]/payments/capture/route.ts` (line 502)
- If product workflow later permits clients to accept deliverables *before* initiating PayPal payment, R5 / payment operations (and any corresponding PostgreSQL payment RPCs/constraints) must be explicitly updated and verified to allow checkout initiation, order capture, and recovery on unpaid `ACCEPTED` milestones before removing the P1 unpaid-USD acceptance block.

---

## 11. Database Changes Proposed

**None.** No migrations were proposed, created, modified, or applied remotely. All P1 workflows reuse existing tables, RPCs, and RLS policies.
