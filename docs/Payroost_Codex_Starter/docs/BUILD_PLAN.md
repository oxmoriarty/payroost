# Payroost — 9-Day Hackathon Build Plan

> Target: a polished, production-oriented foundation and a working PayPal Multiparty Sandbox demonstration where the configured Sandbox account supports the required seller flow. This plan does not promise PayPal live approval or production launch.

## Day 1 — Foundation and data model
- Inspect the existing repository; preserve sound setup.
- Next.js, TypeScript, Tailwind, Supabase Auth, migrations and RLS.
- Core project/agreement/milestone schema.
- Provider-neutral payment schema and internal provider interface.
- Install AG Grid React Community using the current official docs.
- Create Payment Operations page shell and typed grid with clearly labelled seed records.

## Day 2 — Projects and AI agreements
- Project creation and dashboard.
- Gemini agreement generation with schema validation.
- Editable agreement draft and immutable versioning.

## Day 3 — Client review and seller onboarding
- Secure review links and client approval.
- Seller profile and provider onboarding state machine.
- PayPal Multiparty Sandbox partner referral/onboarding flow using current official documentation.
- Persist provider seller reference, onboarding status and documented capabilities.
- Test country/account-type eligibility gates.

## Day 4 — PayPal Multiparty payment vertical slice
- Configure platform Sandbox REST app and required Sandbox accounts.
- Create a milestone payment using the documented multiparty seller/payee context.
- Apply partner fees only if explicitly enabled by the PayPal Sandbox configuration and documented for the selected integration.
- Client approval, server-side capture and provider response validation.

## Day 5 — Ledger, webhooks and Payment Operations
- Append-only ledger and provider transaction records.
- Webhook signature verification, deduplication and out-of-order event handling.
- Populate AG Grid from authorized persisted payment records.
- Implement sorting, filtering, pagination, formatted values and read-only detail navigation.
- Refund/dispute/reconciliation records only to the extent supported by the selected Sandbox integration.

## Day 6 — Scope intelligence and change orders
- AI comparison against approved agreement.
- Evidence-linked scope result and uncertainty.
- Human-edited change request, client approval, new agreement version/milestone.

## Day 7 — Payment hardening and marketplace operations
- Idempotency and ambiguous capture recovery.
- Seller eligibility tests and provider-state mapping.
- Admin audit trail and basic operational monitoring.
- Verify no unsupported escrow, conditional release or payout claims.

## Day 8 — UX, security and end-to-end testing
- Responsive UI and accessibility pass, including AG Grid keyboard interaction.
- Security review, RLS tests, cross-tenant tests and rate limits.
- Full buyer/seller journey in the deployed Sandbox environment if available.

## Day 9 — Submission and final verification
- Public repository, license, setup docs and migrations.
- Demo video and hackathon submission.
- Confirm Sandbox labels and disclose production approval dependencies.

## Release gates
- Never enable a seller route without verified provider eligibility and required capabilities.
- Never mark seller payout complete without provider confirmation.
- Never infer capture, refund, dispute or payout state from browser UI alone.
- Never claim escrow, conditional release or production availability without provider approval and legal review.
- AG Grid required implementation must not rely on Enterprise features without an approved production licence.
