# PayRoost — Phase AI-6: Context-Aware Project Assistant Completion Report

**Phase:** AI-6 (Final Phase of PayRoost AI Workstream)  
**Model:** Gemini 3.8 Flash Free Tier (`DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"` via central AI Foundation)  
**Interaction Model:** Strictly Read-Only, Server-Grounded Project Q&A  

---

## 1. Architecture and Implementation

Phase AI-6 builds on PayRoost's central AI Foundation (`getAiProvider()`, `recordAiAudit()`, and normalized `AiError` classes) without adding paid models, new dependencies, autonomous tools, or database migrations.

### Core Modules & Files Created / Updated

- **Bounded Zod Schemas (`src/features/assistant/schema.ts`):**
  - Request validation schemas: `.strict()` `freelancerAssistantRequestSchema` (`projectId`, trimmed `question` 2–2,000 chars, bounded `history` up to 8 session turns max 2,000 chars each) and `portalAssistantRequestSchema` (`question`, bounded `history` only—never accepts `projectId` or participant identity from the browser).
  - Model output schema (`aiRawAssistantResponseSchema`) and server-enriched response schema (`projectAssistantReplySchema`): enforces `answerStatus` (`ANSWERED`, `PARTIAL_INFORMATION`, `INSUFFICIENT_INFORMATION`, `CONFLICTING_RECORDS`, `ACTION_REDIRECT`), `summary`, `recordedFacts` (up to 15 items each pairing `fact`, `authorityLabel`, and `sourceRef`), `aiInterpretation`, `uncertaintiesAndGaps`, `clarificationQuestions`, `recommendedNextSteps`, plus server-attached `isAiGenerated: true`, `readOnlyNotice`, `model`, `participantRole`, `generatedAt`, and `contextStats`.
- **Server-Side Context Assembly (`src/features/assistant/context.ts`):**
  - `assembleProjectAssistantContext()` loads bounded, authoritative records directly from Supabase for the authorized participant, summarizes agreement versions (identifying baseline `APPROVED` version vs. `currentVersion` vs. historical versions and deterministic version diffs), summarizes milestone and change-request statuses, payment ledger states, activity history, deterministic `outstandingItems`, `detectedConflicts`, `dataLimitations`, and an explicit `validSourceRefs` allowlist.
- **Anti-Injection Prompt Construction (`src/features/assistant/prompts.ts`):**
  - `PROJECT_ASSISTANT_SYSTEM_INSTRUCTION` and `buildProjectAssistantPrompt()` enforce read-only behavior, XML-escape (`<`/`>`) all untrusted user inputs, conversation history, and free-text database fields, and segregate `<ALLOWED_SOURCE_REFS>`, `<AUTHORITATIVE_PROJECT_CONTEXT>`, `<UNTRUSTED_CONVERSATION_HISTORY>`, and `<USER_QUESTION>`.
- **Grounding Verification & AI Execution (`src/features/assistant/service.ts`):**
  - `askProjectAssistant()` invokes `provider.generateStructured(..., aiRawAssistantResponseSchema, { temperature: 0.2, timeoutMs: 30_000 })`, runs `validateAndGroundAssistantReply()`, and logs sanitized metadata via `recordAiAudit({ feature: "project_assistant", ... })`.
  - `validateAndGroundAssistantReply()` performs deterministic post-Zod verification: rejects unrecognized `sourceRef` values, rejects `APPROVED_AGREEMENT` / `MILESTONE_RECORD` / `PAYMENT_RECORD` / `AI_SCOPE_PROPOSAL` claims when no underlying records exist, rejects foreign ISO currency amounts not present in project records, rejects false `COMPLETED`/paid or seller bank payout settlement claims, rejects responses claiming write actions or legal enforceability advice, rejects sensitive secret/system-prompt leaks, merges database conflicts into `uncertaintiesAndGaps`, and elevates conflicting queries to `CONFLICTING_RECORDS`.
- **Shared Execution Pipeline & API Routes:**
  - `src/features/assistant/handler.ts`: `handleProjectAssistantRequest()` rebuilds authoritative project context per turn, invokes `askProjectAssistant()`, maps errors via `mapAssistantAiError()` (`403`, `404`, `422`, `429`, `500`, `503`), and attaches `Cache-Control: no-store`.
  - `src/app/api/ai/project-assistant/route.ts`: Authenticated Freelancer Dashboard `POST` endpoint verifying Supabase user ownership (`expectedOwnerId: user.id`) and rate limiting (`ai:assistant:owner:${user.id}`, 15 requests / 60s, fail-closed in production).
  - `src/app/api/public/portal/[token]/assistant/route.ts`: Verified Client Portal `POST` endpoint reusing `authenticatePortalRequest()` (`src/features/scope-changes/portal-auth.ts`, widened `rateLimitPrefix` union to include `"portal-assistant"`, 15 requests / 300s, OTP/session + CSRF validated, deriving `projectId` and `expectedClientEmail` strictly server-side).
- **UI Component & Dual-Surface Integration:**
  - `src/features/assistant/project-assistant-panel.tsx`: Shared `ProjectAssistantPanel` client UI wired into both `src/app/(app)/app/projects/[projectId]/page.tsx` and `src/features/portal/client-portal-workspace-view.tsx`.

---

## 2. Context Sources and Their Authority

`assembleProjectAssistantContext()` queries and separates PayRoost tables according to their authoritative hierarchy:

| Domain | Authoritative DB Source (Query Cap) | Authority Label / Treatment |
| :--- | :--- | :--- |
| **Project & Brief** | `projects` (brief text sanitized/bounded) | `PROJECT_RECORD` — confirmed budget (`total_amount_minor`), currency, status, dates, brief text. No separate `structured_briefs` table exists in PayRoost. |
| **Approved Agreement** | `agreements` + `agreement_versions` (`limit(12)`, `status = 'APPROVED'`) | `APPROVED_AGREEMENT` — mutually approved baseline contract terms, scope items, exclusions, milestone schedule, open questions. |
| **Draft / Pending Agreement** | `agreement_versions` (`current_version_id`, e.g., `DRAFT`, `PENDING_CLIENT`, `CHANGES_REQUESTED`) | `CURRENT_DRAFT_OR_PENDING` — explicitly flagged as not mutually approved; deterministic diff computed against `APPROVED` baseline. |
| **Historical Agreements** | `agreement_versions` (older non-current / `SUPERSEDED` rows) | `HISTORICAL_VERSION` — preserved timeline excerpts only; distinguished from active contractual terms. |
| **Milestones & Deliverables** | `milestones` (`limit(40)`) | `MILESTONE_RECORD` — amounts, due dates, deliverables, acceptance criteria, and workflow status (`DRAFT`, `AWAITING_APPROVAL`, `APPROVED`, `IN_PROGRESS`, `SUBMITTED`, `ACCEPTED`, `CHANGES_REQUESTED`, `CANCELLED`). PayRoost tracks deliverable submission/acceptance on `milestones.status`; there is no separate deliverable file upload log. |
| **Scope Change Requests** | `change_requests` (`limit(15)`) | `SUBMITTED_CHANGE_REQUEST` (`request_text`, `status`: `OPEN`/`RESOLVED`/`WITHDRAWN`) — participant request text without altering contract terms unless a new agreement version is approved. |
| **AI Scope Advice** | `change_requests.ai_analysis` (validated via `storedScopeChangeAnalysisSchema`) | `AI_SCOPE_PROPOSAL` — explicitly tagged `isAiGeneratedAdviceOnly: true` (non-contractual). |
| **Payment Ledger** | `payment_intents` (`limit(40)`) + `payment_transactions` (`limit(50)`) | `PAYMENT_RECORD` — strictly distinguishes `ORDER_CREATING`/`ORDER_CREATED`, `BUYER_APPROVED` (checkout approved, **not** captured), `CAPTURING`/`RECONCILING`/`RECONCILIATION_REQUIRED` (verification pending, **not** paid), and `COMPLETED` intent + `COMPLETED CAPTURE` transaction. Explicitly documents that PayRoost does **not** track downstream PayPal-to-bank seller payout settlement. |
| **Activity History** | `activity_events` (`limit(20)`) | `ACTIVITY_LOG` — recent milestone, agreement, change-request, and project audit log entries. |

Deterministic conflict checks flag mismatches such as: project total budget differing from sum of non-cancelled milestones; an unapproved `currentVersion` coexisting alongside an `APPROVED` agreement; `BUYER_APPROVED` uncaptured intents; and `CAPTURING`/`RECONCILING`/`RECONCILIATION_REQUIRED` intents.

---

## 3. Authorization and Privacy Controls

- **Zero New Auth Systems & Strict Participant Scoping:**
  - **Freelancer Dashboard:** Uses Supabase `createClient()` + `supabase.auth.getUser()` and verifies `project.owner_id === user.id` inside `assembleProjectAssistantContext()` (`403 FORBIDDEN` otherwise).
  - **Client Portal:** Reuses `authenticatePortalRequest()` (`src/features/scope-changes/portal-auth.ts`) enforcing signed portal session token, OTP verification, client email match (`project.client_email === expectedClientEmail`), and `x-csrf-token` validation on `POST`, with rate limiting (`portal-assistant`, 15 / 300s).
  - **Browser Payload Isolation:** `portalAssistantRequestSchema` forbids `projectId` or role parameters; `.strict()` request validation rejects client-supplied context overrides, roles, or payment states. Context is always rebuilt server-side from Supabase per request.
- **PII, Secret & Cross-Participant Redaction:**
  - Database column projections exclude `created_by`, `actor_user_id`, `freelancer_paypal_accounts`, PayPal `expected_merchant_id`/`payee_merchant_id`/`paypal_merchant_id`, raw provider webhooks/payloads, `session_token_hash`, `csrf_secret`, `capture_lease_token`, `tracking_id`, and `partner_referral_id`.
  - `sanitizeTextForAssistant()` applies `redactSensitiveData()`, masks email addresses (`[redacted-email]`), and replaces raw UUIDs (`[id]`).
  - `normalizeActorRoleLabel()` strips embedded email/user identifiers from actor labels.
  - `summarizeReconciliationStatusForRole()` exposes only generic pending verification messaging to `"CLIENT"` callers instead of internal reconciliation codes.
  - `containsSensitiveLeak()` rejects model outputs echoing secret patterns, internal system instructions/XML wrappers, or private merchant/token field names before returning responses.
- **Audit Telemetry & Provider Policy:**
  - Uses Gemini 3.8 Flash Free Tier (`DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"`) exclusively; no paid billing or paid fallback is enabled; Gemini API credentials remain server-side.
  - Note on Free-Tier Provider Privacy: Under Gemini API free-tier terms, data submitted to the provider may be handled according to Google's free-tier API policy; therefore PayRoost minimizes PII, omits credentials/seller account IDs, and bounds context excerpts before sending prompts.
  - `recordAiAudit()` stores only sanitized metadata (`participantRole`, `questionLength`, `historyTurns`, `answerStatus`, counts, duration, token usage, `outcome`) and strips prompt/response/raw text keys.
  - **No DB Chat Persistence:** Conversations exist only in browser session state (`Cache-Control: no-store` on API responses).

---

## 4. Assistant Behaviour and Read-Only Boundaries

- **Fact vs. AI Interpretation Separation:** Returned replies separate cited database claims (`recordedFacts` with `authorityLabel` and verified `sourceRef`) from synthesis (`aiInterpretation`), `uncertaintiesAndGaps`, `clarificationQuestions`, and `recommendedNextSteps`.
- **Conflict & Uncertainty Transparency:** When context is missing or records conflict (e.g., pending reconciliation, budget vs. milestone sum mismatch, or unapproved draft alongside an `APPROVED` baseline), the assistant preserves and surfaces `detectedConflicts` (`CONFLICTING_RECORDS`) or missing records (`INSUFFICIENT_INFORMATION` / `PARTIAL_INFORMATION`) rather than silently guessing.
- **Strict Read-Only Interaction Boundary:**
  - No function calling or write tools exist; the assistant has read-only database queries (`SELECT`) and cannot create/approve agreements, change milestones/deliverables, submit/resolve change requests, trigger payments/captures/refunds, trigger PayPal onboarding, or send emails/notifications.
  - Mutation requests return `ACTION_REDIRECT` guidance pointing participants to existing PayRoost controls, and post-Zod validation rejects outputs claiming completed state mutations (`claimedWriteRegex`) or offering legal enforceability advice (`legalAdviceRegex`).
- **Prompt Injection Defense:** `<USER_QUESTION>`, `<UNTRUSTED_CONVERSATION_HISTORY>`, and database free-text strings are XML-escaped (`escapeUntrustedText` / `escapeStructure`) and isolated from `<ALLOWED_SOURCE_REFS>` and `<AUTHORITATIVE_PROJECT_CONTEXT>`. Client conversation history (max 8 turns) is explicitly marked untrusted continuity context only.

---

## 5. UI Integration on Both Surfaces

Implemented `ProjectAssistantPanel` (`src/features/assistant/project-assistant-panel.tsx`) matching PayRoost's existing card/badge/button components without redesigning either page:

- Integrated into **Freelancer Dashboard** (`src/app/(app)/app/projects/[projectId]/page.tsx`) in `"owner"` mode calling `POST /api/ai/project-assistant`.
- Integrated into **Verified Client Portal** (`src/features/portal/client-portal-workspace-view.tsx`) in `"client"` mode calling `POST /api/public/portal/[token]/assistant` with `x-csrf-token`.
- Displays:
  - AI-generated & Read-Only badges plus grounding/non-legal disclaimer.
  - Role-appropriate suggested starter questions.
  - Session-only conversation history (`messages` React state, clearable via button) with preserved draft question on error.
  - Distinct visual blocks for **Recorded PayRoost Facts** (with authority badges and verified `sourceRef` citations), **AI Interpretation**, **Uncertainties, Missing Info & Conflicting Records**, **Clarifying Questions**, and **Read-Only Next Steps**.

---

## 6. Tests and Exact Results

All tests ran using deterministic mocks (`MockAiProvider` and mocked Supabase/portal auth) **after the final code edit**:

1. **Phase AI-6 Suite** (`npx vitest run src/features/assistant src/app/api/ai/project-assistant 'src/app/api/public/portal/[token]/assistant'`):
   - **5 test files passed (5), 18 tests passed (18)**, exit code `0`:
     - `src/features/assistant/context.test.ts` (3 tests): covers authoritative context assembly, version separation (`APPROVED` vs pending vs historical), milestone/change-request/payment status distinctions, PII/seller ID redaction, conflict detection, and owner/client authorization checks.
     - `src/features/assistant/service.test.ts` (6 tests): covers valid grounded Q&A, `ACTION_REDIRECT`, fabricated `sourceRef`/currency blocking, uncaptured `BUYER_APPROVED` & seller bank payout claim blocking, missing-record `APPROVED_AGREEMENT` rejection, prompt injection & system leak blocking, conflict surfacing (`CONFLICTING_RECORDS`), and `recordAiAudit` payload sanitization.
     - `src/app/api/ai/project-assistant/route.test.ts` (3 tests): covers unauthenticated `401`, cross-owner `403`, rate limit `429`, `.strict()` schema rejection, and read-only owner Q&A flow.
     - `src/app/api/public/portal/[token]/assistant/route.test.ts` (3 tests): covers portal session/CSRF validation, cross-project/forged body `.strict()` rejection, rate limiting (`portal-assistant`), and normalized AI error mapping (`503`).
     - `src/features/assistant/project-assistant-panel.test.tsx` (3 tests): covers suggested questions, visual separation of Recorded Facts vs AI Interpretation, session history & clear action, client `x-csrf-token` header + portal endpoint routing, and draft question preservation on network/API errors.

2. **Full Repository Suite** (`npx vitest run` — includes AI Foundation, AI-2 through AI-5, Projects, Agreements, Milestones, Client Portal security, and Payments/PayPal suites):
   - **73 test files passed (73), 1,067 tests passed (1,067)**, exit code `0` (0 failed, 0 skipped).

---

## 7. Typecheck, Lint, and Build Results

All checks ran **after the final code edit** and completed cleanly with exit code `0`:

- **TypeScript Typecheck (`npx tsc --noEmit`):** Exited `0` (0 errors across the entire workspace).
- **ESLint — Touched Phase AI-6 Files (`npx eslint ...`):** Exited `0` (0 errors, 0 warnings).
- **ESLint — Full Workspace (`npx eslint .`):** Exited `0` (0 errors, 0 warnings).
- **Next.js Production Build (`npm run build`):** Exited `0` (Next.js 16.4.4 Turbopack compiled successfully and generated all routes including `/api/ai/project-assistant`, `/api/public/portal/[token]/assistant`, `/app/projects/[projectId]`, and `/portal/[token]`).

---

## 8. Known Limitations

1. **No Dedicated Deliverable Upload Log:** PayRoost records deliverable status via `milestones.status` (`SUBMITTED`, `ACCEPTED`, `CHANGES_REQUESTED`); the assistant cannot list individual uploaded files or external file URLs.
2. **No Downstream Seller Payout Tracking:** PayRoost records payment intent lifecycle and captured/refunded `payment_transactions`, not downstream PayPal-to-bank disbursement timing or bank settlement confirmation.
3. **Bounded Context Windows:** Context queries intentionally cap historical records (`40` milestones, `12` agreement versions, `15` change requests, `40` payment intents, `50` transactions, `20` activity events) and truncate long prose/brief strings (`briefText` max `4,000` chars) to remain within free-tier token budgets.
4. **Heuristic Post-Zod Guardrails:** Deterministic regex checks in `validateAndGroundAssistantReply()` block common hallucinated citations, false completed-capture/seller-payout claims, foreign currencies, legal-advice wording, claimed writes, and secret leaks, while exact semantic faithfulness on subtle paraphrased claims within valid source bounds still depends on prompt constraints and the `gemini-3.8-flash` model.
5. **Ephemeral Chat State:** Closing or refreshing the browser tab clears the conversation because no database chat history table exists.

---

## 9. Live Gemini or Supabase Testing

- **Live Gemini API testing:** **Not run.** All verification used `MockAiProvider` and mocked provider error paths. A real `GEMINI_API_KEY` request against Google's Gemini 3.8 Flash endpoint was not executed in this environment.
- **Live / Remote Supabase testing:** **Not run.** All database assembly and route tests used mocked Supabase clients; no remote Supabase database queries or migrations were executed.

---

## 10. Deferred Work & Scope Boundaries

- **AI Workstream Complete:** Phase AI-6 completes the planned AI workstream; no further AI phases were started.
- **Deferred (Out of Scope for AI-6):** Persistent encrypted chat storage (if product requirements later justify retention/deletion policies), streaming SSE responses, and multi-turn server-side semantic search across archived projects beyond per-project caps.
- **Strict Isolation Maintained:** Zero modifications were made to PayPal integration (`src/lib/paypal/**`), payment routes, seller onboarding, `milestone-checkout.tsx`, payment migrations, or AI-5 scope-change submission/approval semantics; concurrent PayPal working-tree changes remain untouched.
