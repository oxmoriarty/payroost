# Payroost — PayPal Complete Payments Platform Integration

## 1. Scope and source boundary

The PayPal integration target is **PayPal Complete Payments Platform (CCPP), using its multiparty marketplace capabilities**. Payroost's intended payment model is that a client pays for an approved project milestone and the eligible freelancer is the seller/payee in the provider transaction.

This document separates:
- **PayPal-documented capabilities and requirements**, which must be rechecked against the linked official pages during implementation.
- **Payroost engineering decisions**, which are internal design choices and are not PayPal requirements.

Do not invent API endpoints, request fields, response fields, capability names, webhook event names, fee structures or settlement timing. Use the exact integration guide and API reference for the approved PayPal product and checkout solution selected for the Sandbox app.

## 2. PayPal-documented facts

The official CCPP overview describes multiparty payment processing for marketplaces/platforms and lists seller onboarding, multiple payment methods, partner fees, foreign exchange, payouts, disputes and chargebacks among its capabilities. PayPal states that the integration can be tested in Sandbox, while live credentials and go-live follow platform/marketplace approval.

The official Get Started guide says CCPP is available only to approved partners. It describes platform onboarding and evaluation. It also says CCPP API calls without approval return `401 Unauthorized` in production, while Sandbox testing can be performed before approval.

The official seller-onboarding overview says sellers must complete onboarding to accept PayPal payments on the platform, and PayPal performs local and global risk/compliance checks. The before-payment onboarding flow is described as the recommended and most common route; sellers use the onboarding link, sign in or create an account, and grant the platform permission to process payments on their behalf. The seller must complete onboarding and confirm their email before payment processing can begin.

PayPal's seller-onboarding country eligibility section states that partners or third-party providers onboarding an integration that receives payments should only onboard sellers who are not in send-only countries, because sellers in send-only countries cannot receive payments through these payment integrations.

PayPal's Nigeria row is marked `Send only`, while two business PayPal Checkout columns in that same row display `Yes`. The page's explicit instruction and table entries therefore require clarification from PayPal. Payroost's conservative product rule is to disable PayPal seller payment routing for Nigeria until PayPal confirms the exact seller account type, checkout product and marketplace flow in writing. Do not represent this as a case-specific PayPal decision about Payroost.

PayPal's REST webhook guide requires a configured listener and webhook ID and documents signature verification. Implement the verification procedure using the current official guide; do not accept an unverified webhook as payment evidence.

## 3. Target integration sequence

### A. Platform setup
1. Create/use a PayPal Developer account and Sandbox environment.
2. Submit Payroost's platform/business details through PayPal's CCPP onboarding process when seeking platform approval.
3. Follow the current PayPal guide to configure the Sandbox platform REST app and required credentials.
4. Confirm the exact CCPP checkout solution and seller account types supported by the Sandbox configuration.
5. Keep Sandbox and Live credentials, URLs and webhook IDs separate.

Sandbox testing does not confer production partner approval.

### B. Seller onboarding
1. A freelancer creates a Payroost account and enters the profile information Payroost requires.
2. The server checks whether the seller's country, account type and intended checkout flow are eligible according to the current PayPal documentation and approved configuration.
3. For an eligible seller, the server creates the onboarding referral/link using the current Partner Referrals API documentation and approved integration configuration.
4. The seller completes the PayPal-hosted onboarding and consent process.
5. The server stores the provider account reference and onboarding state returned by PayPal, then retrieves/validates the required capabilities using documented APIs.
6. Payroost enables payment only after the required onboarding state, email confirmation and capabilities are verified.

Do not store PayPal passwords or login credentials. Do not infer completion from a browser redirect alone.

### C. Milestone payment
1. The client opens a payment page for an approved milestone.
2. The server loads the milestone amount, currency, project, seller and payment eligibility from trusted records.
3. The server checks that the seller is onboarded and has the required PayPal capability for the selected flow.
4. The server creates the PayPal order using the exact CCPP multiparty instructions for the chosen checkout solution. The seller/payee context must be the onboarded freelancer as specified by that integration.
5. The client approves using the PayPal-supported checkout UI/JavaScript SDK flow.
6. The server captures the order using the documented server-side API flow and validates the returned transaction details against the internal payment attempt.
7. PayPal webhooks are signature-verified, deduplicated and processed to update provider event/payment records.
8. Payment state is shown as confirmed only after trusted server-side confirmation.

The exact API fields and call sequence must be taken from the current PayPal CCPP integration guide and API reference, not inferred from this conceptual sequence.

### D. Platform fees and settlement

PayPal's CCPP overview lists partner fees as a capability. Whether Payroost can apply a partner fee, its amount, recipient, disclosure, and settlement behaviour depend on PayPal's approved integration and commercial configuration. Do not add fee fields or assume a percentage without the applicable official integration instructions and written commercial approval.

Do not promise that a captured payment is held for later release. Do not equate milestone acceptance with a PayPal payout instruction. Use payout-related APIs or features only if they are part of the approved product configuration and current PayPal documentation for the platform.

## 4. Nigeria eligibility handling

The PayPal seller-onboarding page's country table marks Nigeria `Send only`, and its adjacent instruction says sellers in send-only countries cannot receive payments through these payment integrations. The same Nigeria row has `Yes` entries in two business PayPal Checkout columns. Because of that inconsistency, the application must:

- Mark Nigeria as `PAYPAL_ELIGIBILITY_REVIEW_REQUIRED`.
- Disable PayPal seller payment routing for Nigeria by default.
- Show a clear unavailable/pending-eligibility message; do not show a PayPal checkout action.
- Allow an alternative provider only after its country coverage, marketplace capability, recipient onboarding, settlement, refunds/disputes and legal terms are independently verified and contracted.
- Never bypass restrictions through false geography, borrowed accounts, VPNs or nominee accounts.

A PayPal representative must confirm the exact Payroost platform entity, seller type, country, checkout solution and settlement route before this rule is changed.

## 5. Payroost internal provider interface

The following is an internal application abstraction, not a PayPal SDK interface. Its method names are illustrative domain operations; map them to documented PayPal APIs only after checking the exact API references.

```ts
interface MarketplacePaymentProvider {
  createSellerOnboardingLink(input: SellerOnboardingInput): Promise<OnboardingLink>;
  getSellerStatus(providerSellerId: string): Promise<SellerStatus>;
  createMilestoneOrder(input: CreateMilestoneOrderInput): Promise<PaymentAttempt>;
  captureMilestoneOrder(input: CaptureMilestoneOrderInput): Promise<PaymentResult>;
  refundCapture?(input: RefundInput): Promise<RefundResult>;
  verifyWebhook(input: WebhookInput): Promise<VerifiedWebhook>;
  reconcilePayment(providerReference: string): Promise<PaymentReconciliation>;
}
```

Optional methods must be capability-gated. A provider adapter must not advertise a feature that the selected provider/account configuration does not support.

## 6. Internal payment data and controls

Payroost's internal architecture uses the entities specified in `DATA_MODEL.md`: provider seller accounts, onboarding events, payment intents/attempts, provider transactions, allocations, webhook events, refunds/disputes, payout records and ledger entries.

These are Payroost's data-model decisions, not PayPal-mandated table names.

- Store money as integer minor units and currency as ISO 4217.
- Use application idempotency for create/capture/refund operations and the exact PayPal idempotency mechanism/header where documented for the endpoint.
- Verify webhook signatures using PayPal's official verification process.
- Enforce unique provider event identifiers and process each event idempotently.
- Treat webhooks as asynchronous notifications; handle retries and out-of-order events.
- Keep capture, refund, dispute and payout states distinct.
- A provider capture is not proof of seller payout.
- Record provider references and reconcile internal records against provider data where the selected product exposes the required information.
- Keep secrets server-side; redact sensitive data from logs.

## 7. Environment configuration

Use `.env.example` as the list of application variables. Keep all secret values server-only. The exact credentials and identifiers required depend on the CCPP Sandbox setup and webhook registration. Do not add undocumented variables or assume a partner attribution/merchant identifier is required unless the current PayPal setup instructions for the account say so.

At minimum, configure separate Sandbox values for the API base URL, REST client ID, REST client secret and webhook ID where a webhook is registered. The PayPal JavaScript SDK client ID may be exposed to the browser only as the public Sandbox client ID required by that SDK. Never expose a client secret or access token.

## 8. Implementation acceptance checks

- Platform Sandbox app and required test accounts are configured using PayPal's current guide.
- Seller onboarding link is created through the documented flow.
- Seller completion and required capability are verified server-side.
- Ineligible or unresolved seller country is blocked before checkout.
- Order creation and capture use the documented CCPP multiparty flow and seller/payee context.
- Amount and currency are loaded from trusted database records.
- Server verifies provider response details before marking capture confirmed.
- Webhook signature verification and event deduplication are tested.
- Duplicate, failed, pending, cancelled, delayed and out-of-order outcomes are handled.
- No UI claims escrow, guaranteed release or seller payout without provider-confirmed support.
- Sandbox functionality is labelled as Sandbox; production approval is not implied.

## 9. Official PayPal references

See `SOURCES_AND_ASSUMPTIONS.md` for the source register. Start with:
- https://developer.paypal.com/platforms/overview
- https://developer.paypal.com/platforms/get-started/
- https://developer.paypal.com/platforms/seller-onboarding
- https://developer.paypal.com/api/rest/webhooks/rest/
- https://developer.paypal.com/api/orders/v2/
