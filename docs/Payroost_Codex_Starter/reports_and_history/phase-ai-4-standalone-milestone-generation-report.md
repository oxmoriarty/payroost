# PayRoost — Phase AI-4: Standalone Milestone Generation Report

**Date:** 2026-11-11  
**Phase:** AI-4 — Standalone Milestone Generation  
**Status:** Completed (Mock-Verified; Typecheck, ESLint, Regression Suites, and Production Build Passed)

---

## 1. Preflight Findings and Existing AI-3 Overlap

Before implementing AI-4, a complete preflight audit of `src/lib/ai/`, `src/features/briefs/`, `src/features/agreements/`, `src/features/projects/`, `src/app/api/projects/`, `src/app/portal/`, and `supabase/migrations/` established:

1. **AI Foundation Ready:** `src/lib/ai/env.ts` configures `gemini-3.8-flash` (Free Tier) cleanly through `getAiEnv()`, `getAiProvider()` returns `GeminiProvider`, `MockAiProvider` provides zero-network test execution, and `recordAiAudit()` sanitizes telemetry without persisting raw prompts or project text.
2. **Existing AI-3 Scope vs. AI-4 Gap:**
   - AI-3 (`src/features/agreements/gemini.ts`, `agreementDraftSchema`) generates full contractual agreement drafts containing simplified `AgreementDraft.milestones` (`id`, `title`, `description`, `amountMinor`, `currency`, `dueDate`, `deliverables`, `acceptanceCriteria`), always requiring a full positive budget allocation and full legal/scope prose.
   - Standalone milestone planning was missing: users had no way to generate, inspect, sequence, link dependencies, estimate durations, or track unconfirmed budget allocations/assumptions for milestones independently of full agreement prose.
3. **Database & Payment Schema Findings:**
   - `public.milestones` (`202611020002_project_agreement_workflow.sql`) requires `agreement_version_id` (NOT NULL FK to `agreement_versions`), positive integer `amount_minor > 0`, 3-letter `currency`, unique `(project_id, sort_order)`, and `status` (`DRAFT`, `AWAITING_APPROVAL`, `APPROVED`, `IN_PROGRESS`, `SUBMITTED`, `ACCEPTED`, `CHANGES_REQUESTED`, `CANCELLED`).
   - Database trigger `protect_milestone_payment_invariants` (`202611090001_ledger_and_milestone_integrity_remediation.sql`) prohibits deleting or modifying financial/status attributes on milestones referenced by active/completed `payment_intents` or `ACCEPTED` states.
   - `agreement_versions_immutable` prohibits updating/deleting `PENDING_CLIENT`, `APPROVED`, or `SUPERSEDED` agreement versions.
   - Meanwhile, `/app/projects/[projectId]/page.tsx` did not display `workspace.milestones` or `workspace.agreement` directly on the workspace view.
4. **Design Rule:** Rather than duplicating `agreementDraftSchema` or `saveAgreementDraft` (or silently altering amounts as loosely sketched in the earlier `ai-1-ai-architecture-roadmap.md`), AI-4 reuses AI Foundation, `structuredBriefSchema`, `agreementDraftSchema`, and `saveAgreementDraft` cleanly, and strictly rejects any unreconciled or fabricated financial output without silent adjustment.

---

## 2. Architecture and Files Changed

### Created in AI-4
- `src/features/milestones/schema.ts` — Bounded Zod schemas for AI milestone plan proposals (`plannedMilestoneSchema`, `milestonePlanSchema`) and strict API payloads (`generateMilestonesRequestSchema`, `applyMilestonePlanRequestSchema`).
- `src/features/milestones/prompts.ts` — Untrusted-data prompt boundaries (`<PROJECT_CONTEXT>`, `<STRUCTURED_BRIEF>`, `<AGREEMENT_CONTEXT>`, `<EXISTING_MILESTONES>`, `<PLANNING_GOAL>`) and Free-Tier `MILESTONE_GENERATION_SYSTEM_INSTRUCTION`.
- `src/features/milestones/planning-utils.ts` — Client-safe pure helpers for sequence reordering (`movePlannedMilestone`), acyclic prerequisite validation/pruning (`normalizeMilestonePositionsAndDeps`, `toggleMilestoneDependency`), integer minor-unit summation (`sumAllocatedMinorUnits`), and `AgreementDraft["milestones"]` mapping (`toAgreementMilestone`).
- `src/features/milestones/service.ts` — `generateMilestonePlan()` delegating to `getAiProvider()` / `MockAiProvider`, running deterministic validation, and recording minimal sanitized telemetry via `recordAiAudit`.
- `src/features/milestones/milestone-planner.tsx` — Client UI component (`MilestonePlanner`) distinguishing **Formally Agreed Milestones**, **Saved Milestones**, **AI-Proposed Milestones**, and **User-Edited Proposals**, with editing, sequence reordering, dependency toggling, regeneration, discard, and explicit apply controls.
- `src/app/api/ai/generate-milestones/route.ts` — Dedicated preview-only milestone generation route (`POST /api/ai/generate-milestones`).
- `src/app/api/projects/[projectId]/milestones/apply/route.ts` — Explicit persistence route (`POST /api/projects/[projectId]/milestones/apply`) connecting accepted milestone plans into PayRoost's agreement/milestone workflow safely.
- `src/features/milestones/service.test.ts` — Unit tests for AI-4 planning service and helpers (`10` tests).
- `src/app/api/ai/generate-milestones/route.test.ts` — API route tests (`6` tests).
- `src/app/api/projects/[projectId]/milestones/apply/route.test.ts` — Persistence & consistency route tests (`6` tests).
- `src/features/milestones/milestone-planner.test.tsx` — React UI component tests (`3` tests).

### Modified in AI-4
- `src/app/(app)/app/projects/[projectId]/page.tsx` — Passed `agreement`, `versions`, `milestones`, and `canUseAi` from `getProjectWorkspace` into `<MilestonePlanner />` alongside `<AgreementEditor />` (keyed so refreshing on apply reloads updated draft state cleanly).

---

## 3. Milestone Schema and Validation Rules

Every input and output boundary uses bounded Zod schemas plus deterministic server checks in `src/features/milestones/service.ts`:

- **Planned Milestone Bounds (`plannedMilestoneSchema`):**
  - `id` (`1..64` chars), `position` (`1..20` int), `title` (`2..140` chars matching DB check constraint), `description` (`1..3000` chars).
  - Bounded string arrays (`deliverables`, `acceptanceCriteria`: `1..20` items each <= 500 chars; `assumptions`, `openQuestions`: <= 20 items; `dependsOn`: <= 19 IDs).
  - `estimatedDuration` (nullable <= 120 chars), `dueDate` (nullable ISO `YYYY-MM-DD`).
  - `proposedAmountMinor` (nullable positive safe integer in minor units), `currency` (nullable 3-letter uppercase ISO code).
- **Plan-Level Bounds (`milestonePlanSchema`):**
  - `overallTimelineEstimate` (nullable <= 300 chars), `milestoneCount` (`1..20` int), `allocatesFullBudget` (`boolean`), `totalProposedAmountMinor` (nullable positive int), `currency` (nullable 3-letter ISO), `milestones` (`1..20`), `assumptions`, `unresolvedQuestions`, `risksAndDependencies` (<= 25 items each).
- **Deterministic Server Rules (`validateMilestonePlanInvariants`):**
  - Enforces `milestoneCount === milestones.length`.
  - Enforces unique IDs and contiguous sequential positions `1..N`.
  - Enforces strict DAG dependencies: rejects missing IDs, self-dependencies, and dependencies where `dep.position >= milestone.position`.
  - **No Invented Budgets or Currencies:** If `confirmedBudgetMinor` is absent or `allocateBudget === false`, rejects any non-null `proposedAmountMinor`, `totalProposedAmountMinor`, `allocatesFullBudget: true`, or unconfirmed `currency` with `AiFinancialReconciliationError`.
  - **Confirmed Budget Reconciliation:** Rejects non-integer/non-positive amounts, currency mismatches, or `sum !== confirmedBudgetMinor` when `allocatesFullBudget === true` (and `sum > confirmedBudgetMinor` when partial) — **never silently adjusts amounts to force reconciliation**.

---

## 4. AI Generation and Review Flow

1. **Free-Tier Model Compliance:** Uses `getAiProvider()` (`gemini-3.8-flash` default in `src/lib/ai/env.ts`) with `temperature: 0.2`, `timeoutMs: 30000`, zero paid-model fallbacks, and zero additional AI dependencies.
2. **Untrusted Input Isolation:** `buildMilestonePlanPrompt` encloses project brief, structured brief, existing agreement prose, saved milestone titles, and planning goals inside explicit XML boundaries with anti-injection system instructions; server-side Zod + invariant checks prevent injected overrides from taking effect.
3. **Preview-Only Generation (`POST /api/ai/generate-milestones`):**
   - Loads authoritative `project`, `agreements`, `agreement_versions`, and `milestones` server-side.
   - Returns `{ data: { plan, preview: true, persisted: false, projectContext } }` with zero database writes.
4. **Interactive Review UI (`MilestonePlanner`):**
   - Displays all 4 milestone states with distinct badges (`Formally Agreed`, `Saved Draft`, `AI-Proposed Milestones`, `User-Edited Proposal`).
   - Supports editing titles, descriptions, deliverables, acceptance criteria, estimated durations, target dates, minor-unit amounts, reordering sequence (`Move up`/`Move down` with automatic invalid dependency pruning), toggling prerequisite dependencies, regenerating, and discarding proposals.

---

## 5. Persistence and Agreement Consistency

Explicit application flows through `POST /api/projects/[projectId]/milestones/apply` using PayRoost's single source of truth (`agreement_versions` + draft `public.milestones`):

1. **Preserves Agreement Context & Reuses `saveAgreementDraft`:** Merges edited milestones into existing `AgreementDraft` content (or initializes from `manualAgreementDraft` if none exists yet) and persists via AI-3's `saveAgreementDraft(projectId, nextDraft, { source })`, keeping deterministic SHA-256 `content_hash` intact.
2. **Financial Reconciliation on Apply:** Verifies all applied milestones carry positive integer minor units in `project.currency` summing exactly to `project.total_amount_minor` (`400 CURRENCY_MISMATCH` / `BUDGET_RECONCILIATION_MISMATCH` otherwise).
3. **Approved & Pending Agreement Protection:**
   - If the active `agreement_version` is `"APPROVED"` or `"PENDING_CLIENT"`, applying without `confirmNewRevision: true` returns `409 APPROVED_AGREEMENT_REVISION_REQUIRED` / `AGREEMENT_REVIEW_IN_PROGRESS`.
   - When confirmed (`confirmNewRevision: true`), `saveAgreementDraft` leaves the immutable `APPROVED` version untouched and creates a **new `DRAFT` version (`version_number + 1`)** requiring formal client OTP approval (`submit_public_review_with_otp`).
4. **Milestone Table Consistency (`public.milestones`):**
   - If all existing `public.milestones` rows are `"DRAFT"` (or none exist) and zero `payment_intents` exist, cleanly replaces `"DRAFT"` rows bound to the active `DRAFT` `agreement_version_id` (`status: "DRAFT"`, sequential `sort_order`).
   - If any milestone is non-`"DRAFT"` (e.g., `APPROVED`, `IN_PROGRESS`, `SUBMITTED`, `ACCEPTED`, `CANCELLED`) or linked to `payment_intents`, leaves all `public.milestones` rows **completely untouched** (`milestonesTableSynced: false`, `syncNote: "PRESERVED_COMMITTED_OR_PAYMENT_LINKED_MILESTONES"`).
5. **Audit Events:** Logs `milestone.plan_applied` to `activity_events` recording attribution `source` (`"AI_ASSISTED"` | `"AI_EDITED"` | `"MANUAL"`), version info, and sync status.

---

## 6. Authorization and Security

- **Authentication:** Both `POST /api/ai/generate-milestones` and `POST /api/projects/[projectId]/milestones/apply` require authenticated `supabase.auth.getUser()` (`401 UNAUTHORIZED`).
- **Project Ownership & DB Error Separation:** Explicit UUID validation (`400 VALIDATION_ERROR`), separate `500 DATABASE_ERROR` on Supabase query failures, and strict `project.owner_id !== user.id` -> `403 FORBIDDEN`.
- **Untrusted Input Rejection:** `generateMilestonesRequestSchema.strict()` rejects client-supplied `totalAmountMinor`, `currency`, `ownerId`, or `paymentStatus`; server reads financial/ownership state strictly from PostgreSQL.
- **Rate Limiting:** ``allowRequest(`ai:milestones:${user.id}`, 5, 60_000)`` on AI generation and ``allowRequest(`milestone-apply:${user.id}:${projectId}`, 15, 60_000)`` on apply (`429 RATE_LIMITED`).
- **Sanitized AI Audit Telemetry:** `recordAiAudit` for `"milestone_generation"` records only counts/booleans and error category (`errorCategory`); raw prompts and confidential brief contents are never stored.
- **Normalized HTTP Error Mapping:** `AiConfigurationError -> 500`, `AiRateLimitError -> 429`, `AiUnavailableError -> 503`, `AiOutputValidationError | AiFinancialReconciliationError -> 422`.

---

## 7. Test Results and Exact Commands

All checks ran cleanly on the final codebase with **exit code `0`**:

1. **AI-4, AI Foundation, AI-2, AI-3 & Regression Vitest Suites:**
   ```powershell
   npx vitest run src/lib/ai src/features/briefs src/features/milestones src/app/api/ai src/features/agreements src/app/api/projects src/features/projects src/features/portal
   ```
   **Result:** Exit code `0` — **`24` test files passed, `264` tests passed (`0` failed, `0` skipped)**, duration `70.57s`.
   - **AI-4 (`4` files, `25` tests):** `src/features/milestones/service.test.ts` (`10`), `src/app/api/ai/generate-milestones/route.test.ts` (`6`), `src/app/api/projects/[projectId]/milestones/apply/route.test.ts` (`6`), `src/features/milestones/milestone-planner.test.tsx` (`3`).
   - **AI Foundation (`5` files, `44` tests):** `client.test.ts` (`13`), `env.test.ts` (`10`), `errors.test.ts` (`9`), `provider.test.ts` (`7`), `audit.test.ts` (`5`).
   - **AI-2 Project Briefs (`4` files, `47` tests):** `schema.test.ts` (`17`), `structure-brief/route.test.ts` (`13`), `service.test.ts` (`9`), `project-brief-assistant.test.tsx` (`8`).
   - **AI-3, Agreement, Project & Portal Regressions (`11` files, `148` tests):** `verified-decision-security.test.ts` (`36`), `client-checkout.test.tsx` (`28`), `portal-link/route.test.ts` (`19`), `agreement-generation.test.ts` (`16`), `review-security.test.ts` (`16`), `generate-agreement/route.test.ts` (`11`), `agreement-editor.test.ts` (`8`), `agreement/route.test.ts` (`5`), `agreement-editor-preview.test.tsx` (`4`), `versioning.test.ts` (`4`), `projects/data.test.ts` (`1`).

2. **TypeScript Typecheck:**
   ```powershell
   npx tsc --noEmit
   ```
   **Result:** Exit code `0` (`0` errors).

3. **ESLint:**
   ```powershell
   npx eslint .
   ```
   **Result:** Exit code `0` (`0` errors, `0` warnings).

4. **Production Build:**
   ```powershell
   npm run build
   ```
   **Result:** Exit code `0` (`Next.js 16.4.4 (Turbopack)`, compiled in `37.2s`, TypeScript check finished in `48s`, generated `20/20` static pages; new routes `/api/ai/generate-milestones` and `/api/projects/[projectId]/milestones/apply` built cleanly).

5. **Mocking & Runtime Caveat:** All Vitest tests run deterministically against `MockAiProvider`, mocked Supabase clients, or stubbed `fetch`. **No live Gemini API calls or live PostgreSQL/Supabase database mutations were executed** during test verification; live AI generation requires configuring `GEMINI_API_KEY` at runtime.

---

## 8. Known Limitations and Deferred Work

1. **Agreement Revision Re-Sync of `public.milestones` Upon Client Approval:** When a project already has committed (`APPROVED` / `IN_PROGRESS` / `ACCEPTED`) or payment-linked rows in `public.milestones`, applying a revised milestone plan writes the proposed schedule into a new unapproved `DRAFT` `agreement_version` (`vN+1`) and preserves existing committed/paid `public.milestones` rows untouched (`milestonesTableSynced: false`). Automating delta promotion from newly client-approved `vN+1` into `public.milestones` inside the OTP approval workflow (or a database RPC) belongs to a future schema/workflow enhancement so live milestones are never prematurely altered before bilateral sign-off.
2. **Optional UI `structuredBrief` Forwarding:** `POST /api/ai/generate-milestones` accepts an optional validated `structuredBrief` payload alongside the database `project` record, while `MilestonePlanner` currently invokes it with `{ projectId, planningGoal, includeFinancialAllocation }` (using the persisted `projects.brief` and active agreement context until `StructuredBrief` JSON is stored as a project column in future work).
3. **Additional Standalone Milestone Cards (Add/Delete Rows in AI-4 Preview):** Users can edit, reorder, update dependencies, allocate/unassign amounts, regenerate, discard, and apply milestones in `MilestonePlanner`; adding or removing individual rows within the applied draft schedule remains supported in the `AgreementEditor` below or via milestone regeneration.

---

## 9. Confirmation That No Payment or PayPal Behaviour Was Changed

Verified via `git status --short` and code inspection:
- **Zero modifications** were made to `src/lib/paypal/**`, `src/features/payments/**`, `src/features/freelancer/**`, or `supabase/migrations/**`.
- Neither `generateMilestonePlan`, `/api/ai/generate-milestones`, `/api/projects/[projectId]/milestones/apply`, nor `MilestonePlanner` creates payment intents, initiates PayPal orders, triggers captures, changes payment states, marks milestones paid/accepted/completed, or writes to `payment_intents` or `payment_transactions`.
