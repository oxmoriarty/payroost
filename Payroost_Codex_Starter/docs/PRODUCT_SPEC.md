# Payroost — Product Requirements Document

**Version:** 1.1  
**Status:** Hackathon build specification

## 1. Product overview

Payroost is an AI-assisted workspace for independent professionals and their clients. It structures project briefs into reviewable agreements, organises work into milestones, records provider payment events and identifies potential scope changes by comparing new requests with the approved agreement.

### One-line pitch
Payroost turns freelance agreements into an actionable workflow, combining AI scope intelligence, milestone tracking and seller-directed marketplace payments through eligible payment providers.

### Core value
- Clear expectations before work starts.
- Traceable approvals and changes.
- Payment status visible alongside project progress.
- Early warning when a new request appears outside the agreed scope.

## 2. Problem

Independent professionals often agree work through chat, email, calls or informal documents. This can leave scope, deliverables, deadlines, acceptance criteria and payment schedules unclear. When requirements change, the parties may disagree about whether the new work was included in the original price.

Payroost does not claim to eliminate disputes. It reduces avoidable ambiguity by creating a structured source of truth and making changes explicit.

## 3. Target users

Primary: freelance developers, designers, creative professionals, consultants and small agencies.

Secondary: small businesses hiring independent contractors and clients who want transparent deliverables, milestones and payment records.

## 4. MVP scope

### P0 — required for a credible demo
1. Authentication.
2. Freelancer dashboard with projects and summary states.
3. Create project with client name/email, title, brief, total fee, currency and optional dates.
4. AI agreement generation into a validated structured schema.
5. Agreement editor; user can correct all AI-generated fields.
6. Client review page using a secure, unguessable token.
7. Client approve or request-changes action.
8. Agreement versioning and audit trail.
9. Milestones with title, description, amount, due date and acceptance criteria.
10. Provider seller onboarding state and eligibility check.
11. PayPal Complete Payments Platform (Multiparty) Sandbox seller onboarding/payment flow for a seller and configuration that PayPal Sandbox confirms are eligible.
12. Server-side order creation/capture according to the selected official PayPal multiparty guide; amount, currency and seller/payee context come from trusted records.
13. PayPal webhook signature verification and idempotent event processing.
14. Internal payment transaction records and append-only ledger postings after verified provider events.
15. Payment Operations page powered by AG Grid React Community, displaying authorized payment records with sorting, filtering, pagination and read-only details.
16. Country-aware provider eligibility; unsupported or unresolved sellers are blocked from unavailable routes.
17. AI scope comparison for a new request against the currently approved agreement.
18. Human review of AI result; user can edit/decline/create a change request.
19. Change request with additional fee/time and client approval.
20. Responsive, polished UI with useful empty/loading/error states.
21. Seed/demo scenario and clear setup instructions.

### P1 — only after P0 works
- AI project Q&A grounded in the project record.
- PDF export of approved agreement.
- Activity timeline filters.
- Email notifications if reliable and quick.
- Project completion summary.

## 5. Explicitly out of scope

- Payroost acting as an escrow or custody provider.
- Conditional fund release or guaranteed seller payout without a specifically approved provider capability and legal/commercial review.
- Automated legal advice or claims that generated agreements are legally enforceable.
- AI deciding whether a party has breached a contract.
- AI approving work, agreements, refunds or payments.
- Live production payment processing during the hackathon unless PayPal has separately approved the platform and supplied live access.
- Multi-provider live routing before an alternative provider has been researched, contracted and integrated.
- Tax calculation, invoicing compliance, identity verification or sanctions screening beyond the provider's own documented onboarding flow.
- Native mobile applications or a full project-management suite.
- AG Grid Enterprise features unless a valid production licence is provided and approved.

## 6. Core user journeys

### A — freelancer creates a project
1. Sign in.
2. Select New project.
3. Enter client details, brief, fee, currency and optional dates.
4. Generate structured agreement draft with AI.
5. Freelancer edits and saves the draft.
6. Freelancer checks milestone totals and sends client review link.

### B — client reviews
1. Client opens secure link.
2. Page shows agreement version, scope, deliverables, milestones, dates, exclusions, acceptance criteria and payment schedule.
3. Client approves or requests changes with a written note.
4. Approval records timestamp, actor and exact agreement version.
5. Freelancer sees status update.

### C — marketplace milestone payment
1. Freelancer completes the applicable provider seller onboarding.
2. Server checks seller country, account type, onboarding state and required provider capabilities.
3. Client opens the approved milestone payment page.
4. Server loads the amount, currency, seller/payee and any permitted platform fee from trusted records.
5. If PayPal confirms eligibility, the PayPal Multiparty Sandbox checkout flow is presented using the selected official integration guide.
6. Client approves; backend captures and validates the provider response.
7. Verified provider webhooks update the transaction record and ledger idempotently.
8. Payment Operations displays the persisted transaction in AG Grid.
9. Seller settlement/payout is shown only if the selected provider exposes and confirms that state.
10. Sellers with unsupported or unresolved eligibility are told that this payment route is unavailable. No substitute routing is performed without an enabled, contracted provider.

### D — scope-change analysis
1. Freelancer or client submits a proposed new requirement.
2. AI compares it with the approved agreement and deliverables.
3. AI returns classification, evidence, impact, uncertainty and suggested next step.
4. UI displays relevant original clauses/deliverables alongside the request.
5. User reviews and edits suggested fee/time.
6. Freelancer sends a change request.
7. Client approves or rejects it.
8. If approved, a new agreement version/change record and optional additional milestone are created.
9. Additional payment uses the same provider eligibility and payment flow.

## 7. Functional requirements

### Projects and agreements
- Project statuses: `DRAFT`, `AWAITING_CLIENT`, `ACTIVE`, `COMPLETED`, `CANCELLED`.
- Agreement statuses: `DRAFT`, `PENDING_CLIENT`, `APPROVED`, `CHANGES_REQUESTED`, `SUPERSEDED`.
- Every send/approval/change creates an immutable version snapshot.
- Approval binds to a specific version hash/version number.
- AI-generated content is labelled as a draft until reviewed.

### Milestones
- Milestone statuses: `NOT_STARTED`, `IN_PROGRESS`, `READY_FOR_PAYMENT`, `PAID`, `ACCEPTED`, `BLOCKED`.
- `PAID` means the provider capture has been verified. It does not mean work was accepted or seller payout completed.
- `ACCEPTED` is a separate human action.
- Sum of milestone amounts must equal project fee unless explicitly marked as a change-order addition.
- Currency is fixed per project in the MVP.

### Payments
- Keep provider seller onboarding, buyer payment/capture, refund, dispute and seller payout as distinct states.
- A browser redirect or client callback alone must never mark a payment complete.
- Store provider order/capture references with appropriate uniqueness constraints.
- Use application idempotency and the provider's documented idempotency mechanism where applicable.
- An ambiguous capture must be reconciled before another charge is initiated.
- A payout state is displayed only when the provider confirms it.

### Payment Operations / AG Grid
- AG Grid Community is used for the read-only transaction table.
- Sorting, filtering, pagination, currency/date formatting, accessible status rendering and row-to-detail navigation are required.
- Only server-authorized payment records are returned to the grid.
- No inline financial edits or direct ledger mutation from the grid.

## 8. AI requirements

AI must produce schema-validated JSON, identify missing information rather than inventing it, cite relevant agreement section/deliverable IDs for scope comparisons, distinguish `IN_SCOPE`, `OUT_OF_SCOPE`, `PARTIALLY_IN_SCOPE` and `UNCERTAIN`, explain uncertainty, and never independently approve, reject, price, charge, refund or modify a project.

## 9. Non-functional requirements

- Responsive from 360px mobile width to desktop.
- Accessible semantic controls, keyboard navigation, visible focus, labels and contrast.
- Server-side authorization on every protected read/write.
- Secure token generation and expiry for client review links.
- No secrets in browser bundles, logs, Git or demo video.
- Structured error messages; no raw stack traces in production.
- Basic rate limiting on AI and public-token endpoints.
- Audit trail for approvals, payment events, scope decisions and material edits.

## 10. Marketplace payment constraints

- PayPal Complete Payments Platform is available only to approved partners for production. Sandbox testing does not equal production authorization.
- PayPal seller onboarding country eligibility marks Nigeria `Send only`; the same row contains conflicting business Checkout `Yes` entries. Payroost blocks PayPal seller routing for Nigeria pending written PayPal clarification for the precise flow.
- A provider adapter is an internal design boundary. Do not enable another provider until its capabilities, country coverage, legal status, recipient onboarding, settlement and dispute/refund model have been verified and contracted.
- Do not claim escrow, conditional release or payout guarantees unless the selected provider product and legal review support the exact flow.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| AI invents terms | Structured extraction, explicit unknowns, editable draft, human approval. |
| PayPal integration consumes time | Validate Sandbox seller onboarding and payment flow early; surface external blockers rather than substituting another funds flow. |
| Misleading settlement claims | Distinguish buyer capture, milestone acceptance and provider-confirmed seller payout. |
| Webhook replay/duplicates | Verify signature, store event IDs, idempotent processing. |
| Scope analysis overstates certainty | Evidence references and `UNCERTAIN` outcome. |
| AG Grid Enterprise feature accidentally used | Keep the required build on documented Community features and verify edition before adding a feature. |
| Hackathon scope creep | P0 first; defer P1 and all out-of-scope features. |
