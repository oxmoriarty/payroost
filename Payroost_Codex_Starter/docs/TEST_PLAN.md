# Payroost — Test Plan and Acceptance Criteria

## 1. Test layers

- Unit: money calculations, state transitions, token hashing, schema validation.
- Integration: Supabase queries/RLS, AI schema parsing, PayPal service with mocked HTTP.
- End-to-end: project creation through approval, payment, scope analysis, change request.
- Manual: responsive layout, keyboard accessibility, AG Grid sorting/filtering/pagination, read-only payment detail view, and PayPal Multiparty Sandbox checkout for an eligible onboarded seller.

## 2. Critical acceptance tests

### Projects and agreements
- Owner can create a project.
- Another authenticated user cannot access it.
- Invalid/empty project fields are rejected.
- AI draft parses against schema.
- AI output cannot directly mark an agreement approved.
- Editing draft does not mutate a previously sent/approved version.
- Approval binds to exact version number/hash.
- Expired/revoked review token is rejected.
- Client can request changes without approving.

### Milestones
- Milestone amount uses integer minor units.
- Milestone allocations reconcile with project total.
- Wrong currency or negative amount is rejected.
- Paid status is not equivalent to accepted status.
- A milestone cannot be charged before agreement approval.

### PayPal Multiparty
- Eligible Sandbox seller can start the documented seller onboarding flow.
- Payment remains unavailable until required onboarding completion and seller capability checks are verified server-side.
- Nigeria seller route is blocked pending written PayPal clarification of the published country-table conflict.
- Server creates the multiparty order with database amount/currency and the verified seller/payee context required by the selected PayPal integration.
- Tampering with browser amount has no effect.
- Client secret is never exposed to browser.
- Successful Sandbox buyer approval and server capture marks the buyer payment as captured only after provider response verification.
- Buyer cancellation does not mark paid.
- Failed capture does not mark paid.
- Duplicate capture attempt does not double charge.
- Timeout/ambiguous capture enters reconciliation state.
- Valid webhook updates state once.
- Duplicate webhook is safely ignored.
- Invalid webhook signature is rejected.
- Amount/currency/payee mismatch is rejected or flagged.
- Browser callback cannot independently mark payment complete.
- Capture is not treated as seller payout or milestone acceptance.

### AG Grid Payment Operations
- Grid loads only payment rows authorized for the signed-in user.
- Sorting, filtering and pagination operate correctly on the returned dataset.
- Currency, date and status formatting are correct and accessible.
- Row navigation opens the matching read-only payment detail.
- No inline editing or grid action can mutate payment, ledger, refund or payout state.
- Loading, empty, error and no-results states are shown.
- Keyboard navigation and narrow-screen layout are usable.

### AI scope analysis
- Clearly included request => `IN_SCOPE` with evidence.
- Clearly excluded request => `OUT_OF_SCOPE` with evidence.
- Mixed request => `PARTIALLY_IN_SCOPE`.
- Ambiguous request => `UNCERTAIN` and clarification questions.
- Model does not invent scope IDs or exclusions.
- Prompt injection in brief/request does not override system instructions.
- AI cannot create a charge or approve a change request.

### UI
- Mobile layout works at 360px.
- All buttons have real actions.
- Empty/loading/error/success states are visible.
- Form validation is understandable.
- Keyboard navigation works for primary journey.
- Status is not conveyed by colour alone.

## 3. Demo end-to-end scenario

1. Sign in as freelancer.
2. Create "E-commerce Website" project for Jordan Lee.
3. Generate and edit agreement.
4. Send client review link.
5. Open client link in private browser.
6. Approve agreement.
7. Open first milestone payment.
8. Pay using an eligible Sandbox buyer account configured for the selected multiparty checkout solution.
9. Confirm payment in Payroost only after server verification.
10. Submit "Add a referral rewards programme".
11. Run scope analysis.
12. Review evidence and create a proposed change request.
13. Show client-facing change request and additional milestone.

## 4. Release gate

Do not submit until:
- `npm run lint` passes.
- `npm run typecheck` passes.
- `npm run test` passes (or documented equivalent).
- Production build passes.
- No secrets in repository history.
- All P0 flows tested on deployed URL.
- PayPal Sandbox flow tested end-to-end.
- GitHub repository is public and has a recognised open-source license.
- Demo video is under 3 minutes and shows the working application.
