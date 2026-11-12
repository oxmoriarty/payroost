# Payroost

**AI-assisted freelance agreements, milestone management and seller-directed marketplace payments.**

Payroost helps independent professionals and clients turn a project brief into a mutually reviewed agreement. It organises deliverables and milestones, tracks payment events, and uses AI to compare new requests against the approved scope so potential changes can be reviewed before they become disagreements.

## Product promise

Agree on the work. Track the milestones. See the payment record. Surface scope changes early.

## Payment model

Payroost is designed as a marketplace workflow in which the freelancer is the intended seller/payee for an eligible milestone payment. The PayPal integration target is **PayPal Complete Payments Platform (Multiparty)**, including the relevant platform and seller onboarding process. The hackathon build uses Sandbox. Production access requires PayPal's review and approval, and each seller/payment route remains subject to the product's country and capability rules.

A milestone workflow is not escrow. Do not describe Payroost as holding funds or conditionally releasing them unless a specifically approved provider product and the applicable legal/commercial arrangement support that claim.

**Nigeria eligibility:** PayPal's seller-onboarding page labels Nigeria `Send only` and says sellers in send-only countries cannot receive payments through these payment integrations. The same table shows `Yes` for two business PayPal Checkout columns for Nigeria. Because the page's explicit instruction and table entries conflict, Payroost blocks PayPal seller routing for Nigeria until PayPal confirms the precise marketplace flow in writing. This is a conservative product rule, not a claim that PayPal has issued a case-specific decision for Payroost.

## AG Grid in Payroost

AG Grid React powers the Payment Operations transaction table. The MVP uses documented Community functionality: structured columns, sorting, filtering, pagination, custom cell rendering, keyboard navigation and accessible table interactions. The grid displays authorized payment records; it does not perform financial mutations. Enterprise-only features such as the Server-Side Row Model are not required for this build. Integrated Charts are also outside this MVP; check their current module and licensing requirements before adding chart integration.

## Read the specifications in this order

1. `docs/PRODUCT_SPEC.md` — product requirements and MVP boundaries.
2. `docs/ARCHITECTURE.md` — system design and flows.
3. `docs/DATA_MODEL.md` — database entities and invariants.
4. `docs/PAYPAL_INTEGRATION.md` — PayPal multiparty requirements and implementation guardrails.
5. `docs/AG_GRID_INTEGRATION.md` — AG Grid implementation and licensing boundary.
6. `docs/PAYMENTS_MARKETPLACE_PRODUCTION.md` — production readiness gates.
7. `docs/AI_SPEC.md` — AI features and safety.
8. `docs/UX_UI_SPEC.md` — screens and visual direction.
9. `docs/SECURITY_PRIVACY.md` — security and privacy.
10. `docs/TEST_PLAN.md` — acceptance tests.
11. `docs/BUILD_PLAN.md` — implementation sequence.
12. `docs/CODEX_BUILD_PROMPT.md` — primary implementation prompt.
13. `docs/CODEX_WORKFLOW.md` — Codex workflow.
14. `docs/DEPLOYMENT.md` — deployment checklist.
15. `docs/DEMO_SCRIPT.md` — demo flow.
16. `docs/DECISIONS.md` — fixed product decisions.
17. `docs/SOURCES_AND_ASSUMPTIONS.md` — official documentation references and boundaries.

## Intended stack

- Next.js App Router + TypeScript
- Tailwind CSS + accessible UI primitives
- Supabase Auth + PostgreSQL + RLS
- Gemini API for AI analysis (verify the selected model/API against its current official documentation during implementation)
- PayPal Complete Payments Platform (Multiparty) Sandbox
- AG Grid React Community
- Vercel deployment, subject to the existing repository and deployment requirements

Preserve a sound existing repository setup rather than replacing it without reason. Verify all current package APIs and integration details before coding.

## MVP success definition

A judge can:
1. Create a project from a brief.
2. Generate and edit an agreement draft using AI.
3. Share a secure client review link.
4. Approve the exact agreement version as the client.
5. Define and track milestones.
6. Complete a PayPal Multiparty Sandbox seller-onboarding/payment flow for a seller the Sandbox configuration confirms is eligible.
7. See payment state updated only after server-side confirmation and webhook processing.
8. Inspect payment records in the AG Grid Payment Operations table.
9. Submit a new project request and see AI compare it with the approved scope.
10. Review, edit and approve a change request.

If the Sandbox environment does not support a particular seller onboarding or payment capability, report the blocker accurately. Do not replace the marketplace flow with a different payment model and present it as equivalent.
