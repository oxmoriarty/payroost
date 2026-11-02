# Official Sources and Assumptions Register

## Source policy

PayPal product capabilities, onboarding, eligibility, API and webhook claims in this repository must be verified against PayPal's official developer documentation. AG Grid integration, feature edition, installation and licensing claims must be verified against AG Grid's official documentation. Do not treat blogs, tutorials from third parties, search snippets or model memory as authority for those integrations.

The product requirements, database schema and internal architecture are Payroost design decisions. They are not claims that PayPal or AG Grid requires these exact implementation choices.

## PayPal official references

1. **Complete Payments Platform overview** — https://developer.paypal.com/platforms/overview
   - Source for CCPP marketplace/multiparty positioning and the overview's listed capabilities (seller onboarding, payment methods, partner fees, FX, payouts, disputes and chargebacks).
   - States Sandbox testing is available and live credentials/go-live follow platform/marketplace approval.
2. **Get Started** — https://developer.paypal.com/platforms/get-started/
   - Source for platform onboarding/review and approved-partner requirement.
   - States CCPP API calls without approval return `401 Unauthorized` in production and that Sandbox testing can be done before approval.
3. **Seller onboarding overview** — https://developer.paypal.com/platforms/seller-onboarding
   - Source for seller onboarding, PayPal risk/compliance checks, before-payment onboarding, seller consent and country eligibility.
   - Its text says sellers in send-only countries cannot receive payments through these payment integrations.
   - Its Nigeria row is labelled `Send only` but shows `Yes` for two business PayPal Checkout columns. Treat the inconsistency as unresolved; Payroost's block is a conservative internal policy pending written PayPal clarification.
4. **REST webhooks integration** — https://developer.paypal.com/api/rest/webhooks/rest/
   - Source for webhook listener configuration, webhook ID and signature verification guidance.
5. **Orders API v2 reference** — https://developer.paypal.com/api/orders/v2/
   - Source to consult for the exact order creation/capture schema and endpoint details applicable to the selected multiparty checkout integration. This specification intentionally does not guess request fields.

## AG Grid official references

1. **React installation** — https://www.ag-grid.com/react-data-grid/installation/
   - Source for installing `ag-grid-react`, package relationship and Community/Enterprise package setup.
2. **React quick start** — https://www.ag-grid.com/react-data-grid/getting-started/
   - Source for initial React grid setup.
3. **Community vs Enterprise** — https://www.ag-grid.com/react-data-grid/community-vs-enterprise/
   - Source for Community features, Enterprise-only features and licensing. Community is free for production; Enterprise requires a production licence.
4. **Modules** — https://www.ag-grid.com/react-data-grid/modules/
   - Source for `AllCommunityModule`, `AgGridProvider` and module registration.
5. **Creating a basic React grid** — https://www.ag-grid.com/react-data-grid/deep-dive/
   - Source for row data, column definitions, grid options, custom components and events.
6. **Row models** — https://www.ag-grid.com/react-data-grid/row-models/
   - Source for Client-Side, Infinite, Server-Side and Viewport row model distinctions.

## Assumptions and decisions that are not vendor facts

- The provider adapter, database tables, payment ledger, normalized state machines, audit trail and reconciliation model are Payroost engineering decisions.
- The Payment Operations page and its columns are Payroost product decisions.
- The decision to use AG Grid Community and exclude Enterprise-only features is a project scope/licensing decision.
- The Nigeria block is a conservative Payroost rule based on the wording conflict in PayPal's seller-onboarding page. It is not a substitute for PayPal's written determination for Payroost.
- Do not add a fee percentage, payout schedule, settlement guarantee, escrow claim or alternative PSP without a source and approval specific to the exact product arrangement.

## Verification requirement

Before implementation, Codex must open the current official pages above and confirm the relevant details have not changed. If an official page is unclear or contradictory, stop and report the uncertainty instead of filling the gap with an assumption.
