# PayRoost — Phase P2 Completion Report: Notifications & Project History

**Base Commit:** `6d1eff1` (`feat(workflows): complete Phase P1 client and freelancer product workflows`, branch `main`)  
**Phase Scope:** Persistent in-app notifications (`USER` + `CLIENT_PORTAL`), privacy-filtered chronological project history reusing `public.activity_events`, R4/R5 verified payment & reconciliation notification projection, security/CSRF enforcement, and UI integration across the Freelancer Workspace (`/app`) and Verified Client Portal (`/portal/[token]`).

---

## 1. Preflight Audit Summary & Existing Infrastructure Reused

Before implementing changes, repository inspection confirmed:

- **`public.activity_events` already recorded core lifecycle, OTP review, milestone, scope-change, and R4/R5 payment/webhook/recovery events**, including:
  - Onboarding & review: `project.created`, `client_email.verified`, `client_email.changed`, `agreement.version_created`, `agreement.edited`, `agreement.sent`, `agreement.approved`, `agreement.changes_requested`.
  - Milestones & scope changes: `milestone.plan_applied`, `milestone.plan_synced`, `milestone.submitted`, `milestone.accepted`, `milestone.revision_requested`, `change_request.submitted`, `change_request.resolved`, `change_request.withdrawn`.
  - Verified R4 webhooks & R5 payment operations: `payment.webhook_order_approved`, `payment.order_captured`, `payment.reconciliation_completed`, `payment.capture_pending`, `payment.webhook_capture_pending`, `payment.capture_failed`, `payment.webhook_capture_denied`, `payment.marked_reconciliation_required`, `payment.capture_reconciliation_required`, `payment.order_recovered`, `payment.reconciliation_resolved_without_payment`, plus internal lease/operator operations (`payment.capture_initiated`, `payment.clear_expired_lease`, `payment.expired_lease_cleared`, `payment.webhook_reprocessed`, `payment.operator_reconcile`, `payment.retry_order_creation`).
- **Missing or incomplete prior state:**
  1. No persistent `public.notifications` table existed (only a top-15 dynamic `WorkspaceNotification` reminder feed in `src/features/projects/data.ts`), so unread counts, read/unread state, mark-one/mark-all-read, pagination, grouping, and client portal notifications did not exist.
  2. Non-R4/R5 activity events missing or under-attributed: `portal.invited`, `client_email.verification_resent`, enriched revision metadata on `agreement.version_created`, explicit `change_request.analysis_stale` alerts when agreement revisions advance past prior AI analyses, and `agreementVersionId`/`submittedByLabel` context on change-request status resolution.
  3. Client Portal (`src/app/portal/[token]/page.tsx` and `src/features/portal/client-portal-workspace-view.tsx`) rendered raw top-30 `activity_events` rows without privacy filtering, human-readable titles, AI-vs-manual attribution, state-discipline badges, category filters, sort order switching, or pagination.
- **Unmodified R4/R5 Gap Explicitly Documented (Out-of-Scope Boundary):**
  - `record_paypal_order_created` does not insert an `ORDER_CREATED` `activity_events` row, and `payment.capture_initiated` represents an internal lease attempt rather than a settled payment. In accordance with strict P2 boundaries, R1–R5 PayPal routes, payment RPCs (`src/lib/paypal/**`, `src/features/payments/**`, `/api/webhooks/paypal`, `/api/app/payments/recovery`, `/api/public/portal/[token]/payments/**`), and payment migrations were **not** modified.

---

## 2. Database Migration (Local Only — Not Applied Remotely)

Created [202611120001_notifications_and_project_history.sql](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/supabase/migrations/202611120001_notifications_and_project_history.sql) (not pushed or applied remotely in P2):

- **`public.notifications` table:** Supports both `recipient_type = 'USER'` (freelancer owner via `recipient_user_id`) and `recipient_type = 'CLIENT_PORTAL'` (lower-cased `recipient_client_email` scoped by `project_id`). Enforces relative-path `action_href` constraint (`left(action_href, 1) = '/'`), text length bounds, and recipient consistency check.
- **Database-enforced idempotency:** Partial unique indexes `notifications_user_idempotency_idx` (`(recipient_user_id, idempotency_key) WHERE recipient_type = 'USER'`) and `notifications_client_idempotency_idx` (`(project_id, recipient_client_email, idempotency_key) WHERE recipient_type = 'CLIENT_PORTAL'`), plus paginated unread/listing indexes (`notifications_user_created_idx`, `notifications_user_unread_idx`, `notifications_client_created_idx`, `notifications_client_unread_idx`, `notifications_project_created_idx`).
- **RLS & immutability defense-in-depth:** `notifications_user_select_own`, `notifications_user_mark_read`, column-level `GRANT UPDATE (read_at) ON public.notifications TO authenticated`, and `protect_notification_immutable_fields()` trigger blocking tampering with ownership/identity/content while allowing `ON DELETE SET NULL` on `source_activity_event_id` and preserving the original `read_at` once set.
- **Authoritative projection trigger:** `SECURITY DEFINER` `AFTER INSERT ON public.activity_events` trigger (`project_activity_event_to_notifications`) using `safe_insert_user_notification` and `safe_insert_client_notification` (`ON CONFLICT ... DO NOTHING`) to project workflow events and verified R4/R5 payment/reconciliation events without duplicating webhook retries or modifying payment code.

---

## 3. Notification System Implementation

### Shared Mapper, Types & CSRF Helper
- [src/features/notifications/types.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/notifications/types.ts): `NotificationRecipientType`, `NotificationCategory`, `NotificationSeverity`, `NotificationFilter`, `NotificationRecord`, `NotificationInsertDraft`, `NotificationPageResult`.
- [src/features/notifications/mapper.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/notifications/mapper.ts): `sanitizeNotificationText`, `safeRelativeHref`, and `mapActivityEventToNotificationDrafts` — skips noisy internal operational events (`IGNORED_INTERNAL_EVENTS`), normalizes client emails, omits raw portal tokens and `paymentIntentId` from `CLIENT_PORTAL` notifications, uses canonical idempotency keys (e.g., sharing `payment.captured:${intentId}` between `payment.order_captured` and `payment.reconciliation_completed`), and excludes "escrow" wording.
- [src/features/notifications/client-csrf.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/notifications/client-csrf.ts): `fetchAppCsrfToken()` fetching `/api/app/csrf` before mutating `/api/app/notifications/*` requests.

### Server Service & Catch-Up Sync
- [src/features/notifications/service.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/notifications/service.ts) (`server-only`):
  - `syncNotificationsFromActivityEvents` and `syncNotificationsForUser`: Idempotent catch-up projection handling pre-existing events and partial-index `23505` conflict races cleanly.
  - `listUserNotifications`, `markUserNotificationRead`, `markAllUserNotificationsRead`: Authenticated user queries enforcing `recipient_type = 'USER'` and `recipient_user_id = userId`, preserving initial `read_at`, supporting filters (`all`, `unread`, `action_required`), category filtering, pagination, and safe pre-migration `42P01`/`PGRST205` fallback (`isMissingNotificationsTableError`) while rethrowing real database errors.
  - `listPortalNotifications`, `markPortalNotificationRead`, `markAllPortalNotificationsRead`: Service-role portal queries strictly scoped to both `project_id` and lower-cased `recipient_client_email`.

### Activity Event Emitters (Non-R4/R5 Routes Only)
- [src/app/api/projects/[projectId]/portal-link/route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/projects/[projectId]/portal-link/route.ts): Emits non-fatal `portal.invited` activity (`{ expiresAt }` only; zero raw tokens or URLs).
- [src/app/api/projects/[projectId]/client-verification/route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/projects/[projectId]/client-verification/route.ts): Emits `client_email.verification_resent`.
- [src/app/api/projects/[projectId]/agreement/route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/projects/[projectId]/agreement/route.ts): Enriches `agreement.version_created` metadata with `{ source, agreementVersionId, versionNumber, isRevision }`, emits `change_request.analysis_stale` for prior `OPEN` AI-analyzed change requests on revision drafts (`nextNumber > 1`), and runs non-fatal notification catch-up sync.
- [src/app/api/public/review/[token]/route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/public/review/[token]/route.ts): On OTP `APPROVED` or `CHANGES_REQUESTED`, syncs notifications non-fatally and checks prior `OPEN` analyzed change requests to record `change_request.analysis_stale` if not already emitted for that agreement version.
- [src/app/api/projects/[projectId]/change-requests/[changeRequestId]/route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/projects/[projectId]/change-requests/[changeRequestId]/route.ts): Enriches `change_request.resolved` / `change_request.withdrawn` metadata with `agreementVersionId` and `submittedByLabel`.

### API Endpoints & Portal Auth Hardening
- Extended [src/features/scope-changes/portal-auth.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/scope-changes/portal-auth.ts) with `rateLimitPrefix` options `"portal-notifications" | "portal-history"` and `requireCsrf?: boolean` (default `true`, allowing read-only portal `GET` routes while enforcing strict CSRF on `PATCH`/`POST`).
- Freelancer endpoints (`Cache-Control: no-store`, Zod validation, rate-limited, `validateOperatorCsrf` on mutations):
  - `GET /api/app/notifications` ([route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/app/notifications/route.ts))
  - `PATCH /api/app/notifications/[notificationId]/read` ([route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/app/notifications/[notificationId]/read/route.ts))
  - `POST /api/app/notifications/mark-all-read` ([route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/app/notifications/mark-all-read/route.ts))
- Client portal endpoints (`authenticatePortalRequest`, token + OTP session + project binding):
  - `GET /api/public/portal/[token]/notifications` ([route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/public/portal/[token]/notifications/route.ts))
  - `PATCH /api/public/portal/[token]/notifications/[notificationId]/read` ([route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/public/portal/[token]/notifications/[notificationId]/read/route.ts))
  - `POST /api/public/portal/[token]/notifications/mark-all-read` ([route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/public/portal/[token]/notifications/mark-all-read/route.ts))

---

## 4. Project History & Workspace / Portal UI Integration

### Shared History Pipeline
- [src/features/history/types.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/history/types.ts) & [src/features/history/mapper.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/history/mapper.ts): Derives chronological `ProjectHistoryItem` records from existing `activity_events` with `CLIENT_HIDDEN_EVENTS` filtering (`audience: "client"`), sanitized actor labels, `AI-assisted` vs `Manual` attribution, explicit state-discipline badges (`Order Approved (Not Captured)`, `Payment Confirmed (Work Acceptance Separate)`, `Submitted (Not Accepted)`, `Deliverables Accepted (Payment Separate)`, `Proposal Only`), and entity links (`AGREEMENT_VERSION`, `MILESTONE`, `CHANGE_REQUEST`, `PAYMENT_INTENT`).
- [src/features/history/service.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/history/service.ts) (`server-only`): `getProjectHistory` and `getPortalProjectHistory` supporting single-query chronological sorting (`desc`/`asc`), category filtering, and accurate post-filter pagination counts.
- Endpoints:
  - `GET /api/projects/[projectId]/history` ([route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/projects/[projectId]/history/route.ts))
  - `GET /api/public/portal/[token]/history` ([route.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/api/public/portal/[token]/history/route.ts))

### UI Surfaces
- **Workspace Shell & Notification Center:** Updated [nav-links.ts](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/components/app/nav-links.ts), [layout.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/(app)/layout.tsx), and [header.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/components/app/header.tsx) (unread badge, urgent grouping, CSRF-protected mark-one / mark-all read, `/app/notifications` link, plus backward compatibility with P1 state-reminder mode). Added `/app/notifications` route via [page.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/(app)/app/notifications/page.tsx) and [notifications-center.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/notifications/notifications-center.tsx).
- **Project History Panels & Stale Baseline Indicator:** Added [project-history-panel.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/history/project-history-panel.tsx), wired into [projects/[projectId]/page.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/(app)/app/projects/[projectId]/page.tsx) (plus `#milestones` anchor wrapper) and Client Portal [portal/[token]/page.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/app/portal/[token]/page.tsx) + [client-portal-workspace-view.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/portal/client-portal-workspace-view.tsx) + [portal-notifications-panel.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/portal/portal-notifications-panel.tsx) (`id="agreement"`, `id="milestones"`, `id="scope-changes"`, `id="history"` section jumps without exposing tokens). Added stale-baseline badge to historical `OPEN` AI-analyzed change requests in [scope-change-panel.tsx](file:///c:/Users/Engr%20sam/Documents/Dev/PayRoost/src/features/scope-changes/scope-change-panel.tsx).

---

## 5. Verification Results

All verification commands below were executed cleanly against mocked unit/component/route environments:

1. **TypeScript (`npx tsc --noEmit`):** Exited `0` after all source and test edits (0 errors).
2. **ESLint (`npx eslint .`):** Exited `0` after all source and test edits (0 errors, 0 warnings).
3. **Full Test Suite (`npm test` -> `vitest run`):** Exited `0` — **91/91 test files passed, 1,175/1,175 tests passed** (run after all production code changes were complete). Two test files (`src/app/api/app/notifications/route.test.ts` and `src/app/api/public/portal/[token]/notifications/route.test.ts`) received strict mock type refinements during that window and were explicitly re-run standalone afterward (`npx vitest run ...`, **2/2 files, 6/6 tests passed**, exit `0`). Covered suites include:
   - `src/features/notifications/mapper.test.ts` (5 tests)
   - `src/features/notifications/service.test.ts` (3 tests)
   - `src/features/notifications/notifications-ui.test.tsx` (4 tests)
   - `src/features/history/mapper.test.ts` (2 tests)
   - `src/features/history/service.test.ts` (2 tests)
   - `src/app/api/app/notifications/route.test.ts` (3 tests)
   - `src/app/api/public/portal/[token]/notifications/route.test.ts` (3 tests)
   - Alongside existing P1, AI-1..AI-6, security, webhook, and R1–R5 payment tests (`client-checkout.test.tsx`, `milestone-workspace-and-portal-consistency.test.tsx`, `workspace-ui.test.tsx`, `agreement/route.test.ts`, `portal-link/route.test.ts`, `change-requests/route.test.ts`, etc.). Note: `src/app/api/projects/[projectId]/agreement/route.test.ts` line 216 was updated cleanly to assert the enriched `agreement.version_created` metadata fields.
4. **Production Build (`npm run build`):** Exited `0` after all source and test edits — Turbopack compile succeeded (`14.5s`), Next.js TypeScript verification succeeded (`18.5s`), static generation completed (`23/23`), and dynamic SSR/API routes (`/app/notifications`, `/api/app/notifications/*`, `/api/projects/[projectId]/history`, `/api/public/portal/[token]/{notifications,history}/*`, `/portal/[token]`) built cleanly.

**Scope Boundary Note:** All tests above executed against mocked Supabase/fetch/JSDOM harnesses rather than a live PostgreSQL instance or live PayPal Sandbox; local migration `supabase/migrations/202611120001_notifications_and_project_history.sql` remains local and unapplied remotely per P2 rules. Two pre-existing untracked non-P2 files in the workspace (`src/features/payments/postgrest-capture-and-webhook-alignment.test.ts` and `supabase/migrations/202611110004_postgrest_capture_and_webhook_alignment.sql`) were left untouched and excluded from the Phase P2 commit.
