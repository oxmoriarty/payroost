# Payroost — Marketplace Payments and Production Readiness

## Executive decision

Payroost's target is a seller-directed freelance marketplace. PayPal Complete Payments Platform (Multiparty) is the preferred integration for sellers and platform arrangements that PayPal approves and supports. A provider abstraction is an internal architecture choice so the product can add another vetted provider if required; it does not imply that any alternative provider has been selected or approved.

## What the PayPal documentation establishes

- CCPP provides multiparty payment processing for marketplaces/platforms.
- The published overview lists seller onboarding, multiple payment methods, partner fees, FX, payouts, disputes and chargebacks among its capabilities.
- Production access requires PayPal platform/marketplace approval. Sandbox testing can happen before approval.
- Sellers must complete the applicable onboarding and consent process, and PayPal performs risk/compliance checks.
- Country eligibility applies. Nigeria's seller-onboarding row and adjacent send-only instruction are inconsistent; Payroost blocks this route until PayPal confirms the exact arrangement in writing.

These points are drawn from the official PayPal references listed in `SOURCES_AND_ASSUMPTIONS.md`. Feature availability must still be checked against the actual approved Payroost integration and selected checkout solution.

## Payroost engineering decisions

The following are design recommendations, not PayPal requirements:

1. Use a provider interface so the product is not coupled to PayPal-specific records.
2. Keep seller onboarding, buyer capture, milestone acceptance, refunds, disputes and payouts as separate states.
3. Use an append-only internal ledger and reconciliation records.
4. Use server-side country/currency/capability routing.
5. Never treat browser state as financial truth.
6. Keep financial operations out of the AG Grid display layer.

## Funds and milestone model

- Client requests payment for an approved milestone.
- Server validates project access, milestone, seller onboarding, seller eligibility, currency, amount and provider capability.
- The selected provider processes the payment using the approved integration flow.
- Payroost records provider-confirmed transaction events and reflects them in its internal ledger.
- Milestone acceptance remains a separate human workflow.
- Seller payout/settlement is displayed only if the provider exposes that status and confirms it.

Milestone approval does not itself create escrow or custody. Do not promise conditional release or delayed disbursement unless the exact PayPal product and Payroost's approved configuration support it.

## Provider routing

The server chooses a provider using verified seller country, buyer country, currency, seller account type, onboarding status and documented provider capabilities.

- `PayPalMultipartyProvider`: enabled only for sellers and flows verified as eligible under the approved PayPal configuration.
- `AlternativeMarketplaceProvider`: interface boundary only. Do not configure or activate until a provider has been independently vetted, contracted and technically integrated.

Do not select an alternative PSP based on marketing claims alone. Verify licensing/authorization, marketplace and recipient support, seller onboarding/KYC, country/currency coverage, settlement, FX, refunds, chargebacks, reserves, API/webhook behaviour, fees, service levels, data protection and contractual liability.

## Internal financial controls

- Money uses integer minor units and ISO currency codes.
- Each confirmed provider transaction has a provider reference.
- Ledger entries are append-only and balanced per currency/transaction group.
- Corrections use compensating entries.
- Idempotency applies at application and provider boundaries as documented.
- Reconciliation compares internal records with provider data available to the integration.
- Admin adjustments require authorization, reason codes and audit events.

## Production readiness gates

1. Legal operating entity and platform role documented.
2. PayPal platform review and partner approval completed.
3. Live credentials and approved product configuration received.
4. Written confirmation of platform-country and seller-market eligibility.
5. Seller onboarding, required permissions and capabilities verified.
6. Country/currency/provider routing tested.
7. Refund, dispute, chargeback, reversal and reconciliation operations implemented where supported.
8. Terms, privacy, seller agreement, fee disclosures, support and complaints process reviewed.
9. Security review, backups, incident response, access controls and monitoring ready.
10. Production AG Grid edition/licensing checked; Community is sufficient for the specified Payment Operations table.

## Hackathon boundary

A 7–9 day build can deliver a robust internal architecture, a Sandbox vertical slice where the account configuration supports it, seller onboarding state, country gates, a ledger foundation and a working Payment Operations table. It cannot guarantee PayPal partner approval, production underwriting, legal compliance in multiple jurisdictions or live-money availability.
