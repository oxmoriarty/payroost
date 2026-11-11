# PayRoost — Phase AI-3: AI-Powered Agreement Generation Improvements Report

**Date:** 2026-11-11  
**Phase:** AI-3 — AI-Powered Agreement Generation Improvements  
**Status:** Completed (Mock-Verified; Typecheck, ESLint, and Production Build Passed)

---

## 1. Preflight Findings

Inspection of PayRoost's agreement workflow, AI Foundation (`src/lib/ai/`), AI-2 structured brief module (`src/features/briefs/`), and Supabase schema identified the following pre-AI-3 gaps:

1. **Direct Fetch & Legacy Wiring:** `src/features/agreements/gemini.ts` previously bypassed the central AI Foundation (`src/lib/ai/`), missing centralized configuration validation (`gemini-3.8-flash`), unified error classification, structured parsing, and `recordAiAudit` telemetry.
2. **Silent Draft Persistence / Overwrites:** `POST /api/ai/generate-agreement` immediately invoked `saveAgreementDraft()` after generating a draft, mutating or overwriting an active `DRAFT` agreement version before the user could review or edit the AI proposal.
3. **Weak Brief Grounding & Prompt Hygiene:** Agreement prompts did not consume AI-2's `StructuredBrief` schema fields (deliverables, scope inclusions/exclusions, constraints, dependencies, unconfirmed assumptions, unresolved open questions, and risks) or enforce untrusted `<PROJECT_BRIEF>` delimiters.
4. **Incomplete Financial & Authorization Boundary Checks:**
   - Unauthenticated calls or unexpected errors risked inconsistent status codes or missing UUID validation.
   - Database query errors were not explicitly separated from missing-record / cross-user `403 FORBIDDEN` responses.
   - Server-side financial validation needed explicit integer minor-unit reconciliation and per-milestone currency checks using `AiFinancialReconciliationError`.
5. **Audit-History Attribution:** `activity_events` already included a `metadata jsonb` column in Supabase, but agreement saves did not distinguish `"AI_ASSISTED"` saves from `"MANUAL"` saves in `metadata.source`.

---

## 2. Existing Architecture Reused

AI-3 upgrades the existing PayRoost architecture rather than creating a parallel system:

- **AI Foundation (`src/lib/ai/`):** Reused `getAiProvider()`, `recordAiAudit()`, and typed errors (`AiConfigurationError`, `AiRateLimitError`, `AiUnavailableError`, `AiOutputValidationError`, `AiFinancialReconciliationError`).
- **AI-2 Brief Schema (`src/features/briefs/schema.ts`):** Reused `structuredBriefSchema` and `StructuredBrief` to accept and validate reviewed project brief structures.
- **Agreement Schema & Versioning (`src/features/agreements/schema.ts`, `versioning.ts`):** Reused `agreementDraftSchema`, `agreementVersionUpdateSchema`, `agreementContentHash` (SHA-256 deterministic hashing), and `manualAgreementDraft`.
- **Supabase Agreement & Review Pipeline (`supabase/migrations/202611020002_project_agreement_workflow.sql`, `202611030003_verified_client_identity_and_otp.sql`):** Reused existing `agreements`, `agreement_versions`, `activity_events`, immutable-version DB triggers, client email verification checks, and OTP-based public review routes.
- **Security Helpers:** Reused `createClient()` (`@/lib/supabase/server`), `allowRequest()` (`@/lib/security/rate-limit`), and `apiError()` (`@/lib/http`).

---

## 3. Files Created and Modified

### Modified in AI-3
- `src/features/agreements/gemini.ts` — Upgraded `generateAgreementDraft`, `buildAgreementPrompt`, `AGREEMENT_GENERATION_SYSTEM_INSTRUCTION`, pre-normalization, server-side financial reconciliation, error propagation, and AI telemetry logging.
- `src/app/api/ai/generate-agreement/route.ts` — Upgraded `POST` handler with UUID/payload validation, `401`/`403`/`500` separation, rate limiting, financial parameter validation, structured error mapping, and preview-first response (`preview: true` by default).
- `src/app/api/projects/[projectId]/agreement/route.ts` — Upgraded `saveAgreementDraft` and `POST` with UUID validation, `401`/`500`/`403` separation, immutable-version preservation (creating new `DRAFT` versions when current is non-`DRAFT`), and `activity_events.metadata.source` attribution (`"AI_ASSISTED"` | `"MANUAL"`).
- `src/features/agreements/agreement-editor.tsx` — Added preview-mode staging (`isPreviewDraft`), non-reloading AI generation flow, `"AI Proposed Agreement (Preview Mode)"` banner, `"Re-propose with AI"` header button, `"Discard proposal"` restore action when an initial saved draft exists, and explicit `source: isPreviewDraft ? "AI_ASSISTED" : "MANUAL"` attribution on `Save draft`.

### Created in AI-3
- `src/features/agreements/agreement-generation.test.ts` — Unit tests for prompt construction, `StructuredBrief` consumption, normalization, financial reconciliation, error mapping, and `recordAiAudit`.
- `src/app/api/ai/generate-agreement/route.test.ts` — API route tests for validation, auth (`401`), ownership (`403`), DB error separation (`500`), rate limiting (`429`), preview-mode non-persistence, optional `saveImmediately`, `structuredBrief` validation, and normalized AI error responses.
- `src/app/api/projects/[projectId]/agreement/route.test.ts` — API route tests for `saveAgreementDraft` / `POST`, UUID validation, `"AI_ASSISTED"` vs `"MANUAL"` `activity_events` attribution, and creating a new `DRAFT` version when the current version is immutable (e.g., `APPROVED`).
- `src/features/agreements/agreement-editor-preview.test.tsx` — React Testing Library UI tests for preview-mode staging without auto-save/page reload, user editing prior to `Save draft`, `"AI_ASSISTED"` persistence payload, and `"Discard proposal"` restoration of an existing saved draft.

### Concurrent Workstream Isolation
Zero files were modified in `src/lib/paypal/**`, `src/features/payments/**`, `src/features/freelancer/**`, or `supabase/migrations/**`.

---

## 4. Agreement Generation Improvements

1. **AI Foundation Integration:** `generateAgreementDraft` (`src/features/agreements/gemini.ts`) now delegates structured generation to `getAiProvider()` (or an injected `options.provider` for testing) using `provider.generateStructured(...)` at `temperature: 0.2` and default `timeoutMs: 30000`.
2. **Structured Brief Support:** `buildAgreementPrompt` accepts optional `structuredBrief?: StructuredBrief | null` alongside `raw` `brief` fallback, mapping working title, summary, objectives, deliverables, functional/non-functional requirements, scope inclusions/exclusions, constraints, dependencies, timeline expectations, risks, **unconfirmed assumptions**, and **unresolved open questions**.
3. **Untrusted Data & Grounding Boundaries:**
   - Wraps project brief text in `<PROJECT_BRIEF>...</PROJECT_BRIEF>` and instructs Gemini to treat all enclosed text strictly as descriptive data, ignoring embedded instructions or role overrides.
   - Explicitly instructs the model that outputs are editable workflow drafts rather than legal advice, forbids inventing agreed client decisions or unrequested budgets/currencies, keeps unconfirmed assumptions in `assumptions`, and captures ambiguities in `openQuestions` and `warnings`.
   - Marks proposed milestones with `"PROPOSED — REQUIRES BOTH PARTIES' APPROVAL"` framing and sets `dueDate: null` when no deadline is specified.
4. **LLM Quirks Pre-Normalization & Compatibility:** `normalizeRawDraft` coerces non-`YYYY-MM-DD` `milestones[].dueDate` and `timeline[].date` strings to `null` before `agreementDraftSchema.safeParse(...)`.
5. **Backward-Compatible Error Subclasses:** `GeminiUnavailableError extends AiUnavailableError` and `GeminiOutputError extends AiOutputValidationError` remain exported and preserve `instanceof` compatibility across callers and tests. Non-subclass `AiUnavailableError` instances are re-wrapped into `GeminiUnavailableError` with `status`, `isTimeout`, and `cause` preserved.

---

## 5. Milestone and Financial Validation

1. **Pre-Call Financial Input Checks:** Both `POST /api/ai/generate-agreement` and `generateAgreementDraft` reject non-integer or non-positive `totalAmountMinor` and non-3-letter uppercase `currency` codes before calling AI.
2. **Server-Side Reconciliation:** After schema validation passes, `generateAgreementDraft` iterates all generated `draft.milestones`:
   - Verifies every `m.amountMinor` is a positive integer.
   - Verifies every `m.currency === input.currency`.
   - Verifies exact minor-unit equality: `sum(m.amountMinor) === input.totalAmountMinor`.
3. **Failure Handling:** Any mismatch raises `AiFinancialReconciliationError` (wrapped in `GeminiOutputError` with `.cause` preserved for legacy callers), recorded via `recordAiAudit(..., { outcome: "error" })`, and mapped by `POST /api/ai/generate-agreement` to HTTP `422` (`AI_OUTPUT_INVALID`).
4. **Proposal-Only Boundary:** Generated milestones live inside the editable `AgreementDraft` JSON preview and never directly mutate payment ledger tables or PayPal state.

---

## 6. Preview, Editing, and Explicit Application Workflow

1. **Preview-First API Contract:** `POST /api/ai/generate-agreement` returns `{ data: { draft, preview: true, reconciled: true, totalAmountMinor, currency } }` by default without touching `agreement_versions` or overwriting saved drafts. (An explicit `saveImmediately: true` flag remains supported for programmatic callers.)
2. **Staged Editor UI (`AgreementEditor`):**
   - Clicking `Generate with AI` or `Re-propose with AI` loads the returned `draft` into React state with `isPreviewDraft = true`, displaying the `"AI Proposal (Preview)"` badge and `"AI Proposed Agreement (Preview Mode)"` banner without triggering `window.location.reload()` or database writes.
   - Users can review and edit summary, objective, scope items, deliverables, acceptance criteria, exclusions, payment terms, revision policy, change request procedure, open questions, and milestones in full.
   - If a previously saved `DRAFT` existed (`initial`), clicking `Discard proposal` restores `initial` and clears preview mode cleanly.
   - Clicking `Save draft` explicitly persists the reviewed draft via `POST /api/projects/[projectId]/agreement` with `source: "AI_ASSISTED"` (or `"MANUAL"` for manual edits).

---

## 7. Versioning and Audit-History Behaviour

- **Active `DRAFT` Updates:** `saveAgreementDraft` updates `content` and recomputes `content_hash` via `agreementContentHash(parsed.data.content)` on the active `DRAFT` row in `agreement_versions`, inserting `activity_events` with `event_type: "agreement.edited"` and `metadata: { source }`.
- **Immutable History Preservation:** If `agreement.current_version_id` is absent or its status is not `"DRAFT"` (e.g., `SENT`, `PENDING_CLIENT`, `APPROVED`, `CHANGES_REQUESTED`), `saveAgreementDraft` preserves the existing version untouched and inserts a new `version_number` (`max + 1`) draft row, updating `agreements.current_version_id` and `agreements.status = "DRAFT"`, and logging `event_type: "agreement.version_created"` with `metadata: { source }`.
- **AI Telemetry (`recordAiAudit`):** Every `generateAgreementDraft` attempt records `feature: "agreement_generation"`, `projectId`, `userId`, `model`, `durationMs`, `tokenUsage`, `outcome` (`"success"` | `"error"`), `errorCategory`, and structured metadata without logging raw secrets or private full brief text.
- **No Auto-Approval:** Neither AI generation nor saving an AI-assisted draft approves agreements or triggers review/OTP flows; client review links still enforce `isClientVerified`.

---

## 8. Authorization and Security Measures

- **Strict UUID Validation:** `POST /api/ai/generate-agreement`, `saveAgreementDraft`, and `POST /api/projects/[projectId]/agreement` validate `projectId` against `z.string().uuid()` (`400 VALIDATION_ERROR`).
- **Explicit Payload Validation:** Optional `structuredBrief` in `POST /api/ai/generate-agreement` is parsed with `structuredBriefSchema` (`400 VALIDATION_ERROR` with Zod issues on invalid shape).
- **Clean Auth vs Authz vs DB Errors:**
  - Unauthenticated requests return `401 UNAUTHORIZED` (`authError || !user`).
  - Database query failures on project or version lookup return `500 DATABASE_ERROR` instead of leaking into `403`.
  - Missing project or `project.owner_id !== user.id` returns `403 FORBIDDEN`.
- **Per-User / Per-Project Rate Limiting:**
  - `POST /api/ai/generate-agreement` enforces ``allowRequest(`ai:agreement:${user.id}`, 5, 60_000)`` (`429 RATE_LIMITED`).
  - `POST /api/projects/[projectId]/agreement` enforces ``allowRequest(`agreement-save:${projectId}`, 30, 60_000)`` (`429 RATE_LIMITED`).
- **Structured AI Error HTTP Mapping:** `AiConfigurationError -> 500`, `AiRateLimitError -> 429`, `AiUnavailableError / GeminiUnavailableError -> 503`, `AiOutputValidationError / AiFinancialReconciliationError / GeminiOutputError -> 422`.

---

## 9. Database and Migration Decisions

**Zero new database migrations were required or added.**  
Existing Supabase schema in `supabase/migrations/202611020002_project_agreement_workflow.sql` already includes `activity_events.metadata jsonb not null default '{}'::jsonb`, `agreement_versions` SHA-256 hashing columns, and immutability triggers (`prevent_immutable_agreement_version_change`). Adding `metadata: { source }` required no DDL or RLS policy changes and avoided touching migration files concurrently used by Phase 3B.R1.

---

## 10. Test Results

All targeted AI, brief, agreement, and project Vitest suites were executed after the final edit via:

```powershell
npx vitest run src/lib/ai src/features/briefs src/app/api/ai src/features/agreements src/app/api/projects src/features/projects
```

**Observed Output:** `Test Files  19 passed (19)` | `Tests  211 passed (211)` | `Duration  35.38s` | Exit code `0`.

| Suite Group | Files | Tests Passed | Notes / Verification Basis |
| --- | ---: | ---: | --- |
| AI-3 Agreement Generation Unit (`agreement-generation.test.ts`) | 1 | 16 | Mock `AiProvider`, schema/reconciliation/audit spy |
| AI-3 Generate Route (`src/app/api/ai/generate-agreement/route.test.ts`) | 1 | 11 | Mocked Supabase client & `generateAgreementDraft` / provider |
| AI-3 Agreement Save Route (`src/app/api/projects/[projectId]/agreement/route.test.ts`) | 1 | 5 | Mocked Supabase queries & activity logger |
| AI-3 Editor Preview UI (`agreement-editor-preview.test.tsx`) | 1 | 4 | jsdom React Testing Library with stubbed `fetch` |
| AI Foundation (`src/lib/ai/*.test.ts`) | 5 | 44 | Existing foundation suites (`client`, `provider`, `env`, `errors`, `audit`) |
| AI-2 Project Briefs (`src/features/briefs/*`, `structure-brief/route.test.ts`) | 4 | 47 | Schema, service, UI, API route regressions |
| Existing Agreement & Project Regressions (`versioning`, `agreement-editor`, `review-security`, `verified-decision-security`, `portal-link`, `projects/data`) | 6 | 84 | Existing security & versioning regressions |
| **Total** | **19** | **211** | **Zero failed, zero skipped** |

**Important Verification Caveats:**
- All AI-3 tests use `MockAiProvider`, mocked Supabase clients, or stubbed `fetch`; **no live Gemini API calls were executed** in this environment (live `GEMINI_API_KEY` generation remains runtime-unverified).
- **Zero live PayPal or payment execution tests were run**, and Phase 3B.R1 payment/seller test files were intentionally left outside AI-3 scope.

---

## 11. Typecheck, Lint, and Build Results

All checks below ran after the final code/test edit and exited with code `0`:

- **TypeScript (`npx tsc --noEmit`):** Exit code `0` (zero errors).
- **ESLint (`npx eslint .`):** Exit code `0` (zero errors, zero warnings).
- **Production Build (`npm run build`):** Exit code `0` (`Next.js 16.4.4 (Turbopack)`, compiled in `48s`, TypeScript check finished in `32.9s`, generated `19/19` static pages cleanly; routes including `/api/ai/generate-agreement`, `/api/projects/[projectId]/agreement`, `/app/projects/[projectId]`, and concurrent Phase 3B.R1 routes built cleanly).

---

## 12. Known Limitations and Outstanding Issues

1. **Client UI Brief Forwarding:** While `POST /api/ai/generate-agreement` strictly validates and forwards optional `structuredBrief` payloads to `generateAgreementDraft`, [`AgreementEditor`](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/agreements/agreement-editor.tsx) currently invokes `POST /api/ai/generate-agreement` with `{ projectId }` when generating from the project page; passing an edited pre-save `StructuredBrief` object directly from the UI (or storing structured brief state on the project record in a future phase) can hook into this parameter cleanly without API changes.
2. **Client-Side Milestone Sum Guard:** While server-side AI generation enforces exact `sum(amountMinor) === project.total_amount_minor`, `AgreementEditor` relies on user review when manually adjusting milestone amounts prior to clicking `Save draft`; client/freelancer mutual approval remains enforced before acceptance.
3. **Runtime Gemini Dependency:** Enabling AI agreement generation in runtime environments requires setting a valid `GEMINI_API_KEY` configured for `gemini-3.8-flash` (subject to Google Gemini API availability and the configured `5 req/min` per-user rate limit).
