# Payroost — Fixed Product Decisions

1. **Name:** Payroost.
2. **Product:** AI-assisted freelance agreements, milestone management, scope-change analysis and marketplace payment workflows.
3. **Primary user:** freelancer / independent professional.
4. **Secondary user:** client reviewing an agreement and paying milestones.
5. **Stack:** Next.js, TypeScript, Tailwind, Supabase, Gemini, PayPal Complete Payments Platform (Multiparty) Sandbox, AG Grid React Community, Vercel unless repository inspection justifies a compatible adjustment.
6. **Architecture:** modular monolith with a provider abstraction; no microservices for the hackathon build.
7. **Payment model:** seller-directed marketplace payments. The freelancer is the intended seller/payee for an eligible milestone transaction.
8. **PayPal target:** CCPP Multiparty with seller onboarding and seller consent, implemented only according to the current official guide and approved Sandbox configuration.
9. **Country eligibility:** provider availability is checked server-side by seller country, buyer country, currency, account type and provider capability.
10. **Nigeria:** PayPal's seller-onboarding table marks Nigeria `Send only`, while the same row shows `Yes` in two business PayPal Checkout columns. PayPal's adjacent text says send-only sellers cannot receive payments through these payment integrations. Disable PayPal seller routing for Nigeria pending written clarification from PayPal for the exact flow.
11. **Production gate:** PayPal partner approval, platform eligibility, seller-market eligibility and live credentials are external requirements; Sandbox success is not production approval.
12. **Funds handling:** Payroost does not claim to custody funds or provide escrow. Conditional release/delayed disbursement is not promised unless a provider-approved product and legal review support the exact implementation.
13. **Financial records:** internal append-only ledger, integer minor units, provider transaction references, idempotency and reconciliation. These are Payroost engineering decisions, not PayPal-mandated table names.
14. **AG Grid:** AG Grid React Community powers the read-only Payment Operations transaction table. Enterprise-only features are excluded unless a valid production licence is supplied and approved.
15. **AI features:** agreement drafting and scope-change comparison.
16. **Human control:** AI output is always a draft/recommendation; humans approve terms, prices, dates and changes.
17. **Agreement integrity:** immutable versions after sending; approval is bound to a version.
18. **No legal claims:** no legal advice, enforceability guarantee, arbitration or breach determination.
19. **Demo scenario:** fictional website project with milestone payments and a new-scope request. Use PayPal Sandbox accounts and clearly label the environment.
20. **Submission:** public repository with license, hosted demo or complete run instructions, documentation and required video.
