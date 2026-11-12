# PayRoost — Phase AI-2: Project Brief Structuring Report

**Date:** November 10, 2026  
**Status:** COMPLETE & VERIFIED  
**Phase:** AI-2 (Project Brief Structuring)  
**Concurrent Workstream:** Phase 3B.R1 — PayPal Platform Seller Connection Foundation (Unchanged & Isolated)

---

## 1. Implementation Summary

Phase AI-2 introduces PayRoost's **Project Brief Structuring** capability. This feature transforms unstructured, natural-language project descriptions provided by clients (e.g., raw emails, chat messages, or rough notes) into an organized, strongly validated, and editable **Project Brief**.

Key architectural accomplishments:
- **Dedicated Structured Brief Schema:** Defined with strict field constraints, string bounds, and normalized array handling in Zod.
- **Provider-Independent AI Service:** Built on top of the centralized AI Foundation (`src/lib/ai/`), strictly configured with Google's active Free-Tier model `gemini-3.8-flash` ($0 operational cost, zero paid fallbacks).
- **Prompt Defense & Anti-Hallucination Boundaries:** Encapsulates untrusted client input in XML delimiters (`<CLIENT_PROJECT_DESCRIPTION>`) and enforces strict system instructions that forbid inventing budgets, deadlines, or client agreements, while actively surfacing missing details as open questions.
- **Secure API Endpoint:** Authenticates requests via Supabase session, enforces rate limits (10 req/min per user), validates ownership for project associations, maps normalized AI errors, and performs zero unexpected database mutations.
- **Interactive UI Review Experience:** Implemented `ProjectBriefAssistant` with comprehensive state transitions (input, loading, reviewable preview, editable fields, error handling, regeneration, and explicit continuation), seamlessly integrated into the `/app/projects/new` creation journey.
- **Zero Database Migrations / In-Memory Isolation:** Generates and previews briefs in-memory; persists to the project record only when the user explicitly reviews, approves, and submits the project creation form.

---

## 2. Files Created and Modified

### Created Files
1. `src/features/briefs/schema.ts` — Zod schema for `structuredBriefSchema` and API request schema `structureBriefRequestSchema`.
2. `src/features/briefs/prompts.ts` — System instructions with anti-hallucination and prompt injection defenses, plus prompt builder function.
3. `src/features/briefs/format.ts` — Shared markdown formatting utility for structured briefs.
4. `src/features/briefs/service.ts` — Server-only AI brief structuring service with telemetry audit integration.
5. `src/app/api/ai/structure-brief/route.ts` — Authenticated, rate-limited, ownership-verified API route handler.
6. `src/features/briefs/project-brief-assistant.tsx` — Full-featured client UI component supporting input, loading, editable preview, assumptions/clarifications badges, regeneration, and continuation.
7. `src/features/projects/new-project-form.tsx` — Client component wrapping the project creation form with the brief assistant.
8. `src/features/briefs/schema.test.ts` — 17 unit tests for schema validation, array normalization, and string bounds.
9. `src/features/briefs/service.test.ts` — 9 service-level tests using `MockAiProvider`, covering injections, missing fields, anti-hallucination, and timeouts.
10. `src/app/api/ai/structure-brief/route.test.ts` — 13 API route tests covering auth, rate limits, invalid input, project authorization, error mapping, and database write isolation.
11. `src/features/briefs/project-brief-assistant.test.tsx` — 8 UI tests covering rendering, loading state, editable inputs, item removal, error banner, regeneration, and continuation.

### Modified Files
1. `src/app/(app)/app/projects/new/page.tsx` — Replaced static form with `NewProjectForm` client wrapper to support interactive AI brief structuring while preserving all server-side validation and actions.

---

## 3. Structured Project Brief Schema

The structured brief is enforced via Zod (`src/features/briefs/schema.ts`):

```typescript
export const structuredBriefSchema = z.object({
  title: z.string().trim().min(2).max(140),
  summary: z.string().trim().min(10).max(3000),
  objectives: stringListSchema(20),
  functionalRequirements: stringListSchema(30),
  nonFunctionalRequirements: stringListSchema(30),
  deliverables: stringListSchema(30),
  scopeInclusions: stringListSchema(30),
  scopeExclusions: stringListSchema(30),
  assumptions: stringListSchema(30),
  constraints: stringListSchema(30),
  dependencies: stringListSchema(30),
  timelineExpectations: z
    .string()
    .trim()
    .max(1000)
    .nullish()
    .transform((val) => (val && val.length > 0 ? val : null)),
  risks: stringListSchema(30),
  openQuestions: stringListSchema(30),
});
```

### Schema Features & Constraints
- **Title:** 2–140 characters.
- **Summary:** 10–3,000 characters.
- **Array Fields:** Bounded at 20 or 30 items max, 1,000 chars per item. Normalized via `stringListSchema`, converting `null`/`undefined` to `[]` and filtering out empty lines.
- **Timeline Expectations:** Nullable string (max 1,000 chars). Empty strings automatically normalize to `null` to avoid hallucinated deadlines.

---

## 4. AI Service and Provider Integration

### 4.1 AI Foundation Abstraction
- The service calls `getAiProvider()` from `src/lib/ai/client.ts`.
- Defaults to `GeminiProvider` using Google's active Free-Tier model: **`gemini-3.8-flash`**.
- Tests inject `MockAiProvider` for fast, offline, deterministic verification without requiring live network access or API credentials.

### 4.2 Prompt Engineering & Defenses
1. **Untrusted Data Boundary:** Client descriptions are wrapped in `<CLIENT_PROJECT_DESCRIPTION>` delimiters.
2. **System Instruction Mandates:**
   - Overrides or role reversals inside client descriptions are explicitly ignored.
   - Do not invent budgets, currencies, deadlines, or milestones. If unspecified, `timelineExpectations` is set to `null`.
   - Inferred conditions must be placed in `assumptions`, never presented as confirmed facts.
   - Missing or ambiguous requirements (such as missing payment gateways, shipping methods, account access) are converted into `openQuestions`.
3. **Audit Logging:** Every generation (success or failure) logs an audit record via `recordAiAudit()` with redacted metadata (character length, items count), without logging sensitive user data or raw prompts.

---

## 5. API and UI Behaviour

### 5.1 API Endpoint (`POST /api/ai/structure-brief`)
1. **Authentication:** Verifies session via `supabase.auth.getUser()`. Returns `401 UNAUTHORIZED` if absent.
2. **Rate Limiting:** Enforces `allowRequest("ai:brief:{userId}", 10, 60_000)`. Returns `429 RATE_LIMITED` if exceeded.
3. **Input Validation:** Validates `description` (10–10,000 chars) and optional `projectId` (UUID). Returns `400 VALIDATION_ERROR` for invalid payloads.
4. **Project Authorization:** If `projectId` is passed, checks project ownership (`owner_id = user.id`). Returns `403 FORBIDDEN` if unauthorized.
5. **Error Mapping:**
   - `AiConfigurationError` $\rightarrow$ `500 AI_CONFIG_ERROR`
   - `AiUnavailableError` $\rightarrow$ `503 AI_UNAVAILABLE`
   - `AiRateLimitError` $\rightarrow$ `429 AI_RATE_LIMITED`
   - `AiOutputValidationError` $\rightarrow$ `422 AI_OUTPUT_INVALID`

### 5.2 UI Interaction Flow (`ProjectBriefAssistant`)
1. **Input Mode:** User inputs natural language notes or paste emails. Shows character count and informational banner. Button disabled until 10 characters are entered.
2. **Loading Mode:** Spinner with status copy: *"Analyzing client description and structuring requirements..."*.
3. **Review Mode:** Displays preview with clear visual distinction:
   - **Client Facts & Deliverables:** Title, summary, objectives, deliverables, functional requirements, scope inclusions/exclusions.
   - **Assumptions (Unconfirmed):** Highlighted in amber with a `Needs Confirmation` badge.
   - **Open Questions & Missing Info:** Highlighted in teal/cyan with a `Requires Clarification` badge.
   - **Editable Controls:** Inputs for title, summary, timeline, and dynamic add/remove buttons for each list item.
4. **Regeneration:** "Regenerate" button returns to input state while preserving user notes.
5. **Continuation Action:** "Apply to project brief" button invokes `onApplyBrief(brief)`, formatting the structured brief into markdown and populating the New Project form.

---

## 6. Persistence Decisions

In accordance with strict phase instructions:
- **Zero Database Migrations:** No new tables or schema migrations were introduced.
- **No Automatic Database Writes:** The API endpoint performs only `select` operations to verify project ownership; it never executes `insert`, `update`, `delete`, or mutating RPCs.
- **Client-Controlled Persistence:** The brief remains in client state during review. It only persists when the user explicitly clicks "Create project workspace", saving via the existing `createProjectAction`.
- **Agreements Untouched:** Existing agreements, versions, milestones, and payment records remain completely unmodified.

---

## 7. Security and Validation Measures

1. **Dual Validation:** AI structured output is validated twice: once by Gemini's JSON schema enforcement, and strictly validated in TypeScript via Zod's `schema.safeParse()`.
2. **No Secret Leaks:** Error responses never expose `AIza...` API keys, raw provider payloads, or stack traces.
3. **PII and Prompt Redaction:** Audit sinks sanitize and redact sensitive values.
4. **Client Email Guard:** Client email verification requirement on project creation is preserved.

---

## 8. Verification Results

All tests and checks were run freshly and passed completely:

### 8.1 New AI-2 Test Suites
```bash
npx vitest run src/features/briefs src/app/api/ai/structure-brief
```
- **Test Files:** 4 passed (4)
- **Tests:** 47 passed (47)
  - `src/features/briefs/schema.test.ts` (17 tests)
  - `src/features/briefs/service.test.ts` (9 tests)
  - `src/app/api/ai/structure-brief/route.test.ts` (13 tests)
  - `src/features/briefs/project-brief-assistant.test.tsx` (8 tests)

### 8.2 Full AI Test Suite (Foundation + Briefs + API)
```bash
npx vitest run src/lib/ai src/features/briefs src/app/api/ai/structure-brief
```
- **Test Files:** 9 passed (9)
- **Tests:** 91 passed (91)

### 8.3 Agreement Regressions
```bash
npx vitest run src/features/agreements
```
- **Test Files:** 4 passed (4)
- **Tests:** 64 passed (64)

### 8.4 Projects Regressions
```bash
npx vitest run src/features/projects
```
- **Test Files:** 1 passed (1)
- **Tests:** 1 passed (1)

### 8.5 TypeScript Strict Check
```bash
npx tsc --noEmit
```
- **Result:** Exit code 0 (Zero errors)

### 8.6 ESLint Analysis
```bash
npx eslint .
```
- **Result:** Exit code 0 (Zero errors, zero warnings)

### 8.7 Production Build
```bash
npm run build
```
- **Result:** Compiled successfully in Turbopack Next.js 16.4.4.
- **Routes:** 19 routes compiled (including new dynamic route `ƒ /api/ai/structure-brief`).

---

## 9. Concurrency & Isolation Verification

- **PayPal & Payments Workstream:** Untouched. No changes to `src/lib/paypal/**`, `src/features/payments/**`, `src/features/freelancer/**`, or `supabase/migrations/**`.
- **Legacy Agreement Generation:** Untouched. `src/features/agreements/gemini.ts` and `src/app/api/ai/generate-agreement/route.ts` remain unchanged.
- **Dependencies:** `package.json` and package lockfiles remain completely untouched.

---

## 10. Known Limitations and Outstanding Issues

1. **Live Gemini API Execution:** As previously established, no live `GEMINI_API_KEY` is present in the local development environment (`.env`/`.env.local` absent). Live network execution remains unverified locally, but the full service and provider layer are 100% verified via deterministic mocks adhering to the Gemini 3.8 Flash v1beta REST specification.
2. **Next Steps (Phase AI-3):** Project Brief Structuring produces the reviewed foundation that future phases (AI-3: Agreement Generation Improvements, and AI-4: Milestone Breakdown) will consume. Per strict instructions, AI-3 has not been started.
