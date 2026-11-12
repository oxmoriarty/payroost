# Payroost — Technical Architecture

## 1. Architecture overview

Use a modular monolith. One Next.js application serves the UI and server-side API routes. Supabase provides authentication and PostgreSQL. Gemini is called only from server code. Payment providers are called only from server code through provider adapters. PayPal Complete Payments Platform (Multiparty) is the preferred adapter for eligible seller markets. The browser uses only the client-side components required by the selected official PayPal checkout integration; order creation/capture and verification remain server-side. Seller onboarding, provider capability checks, ledger posting, refunds, disputes, payouts, and reconciliation are first-class modules.

```text
Browser
  ├── Next.js pages/components
  ├── Supabase Auth client (session only)
  └── PayPal JS SDK (public client ID)
          │
          ▼
Next.js server routes / server actions
  ├── Authentication + authorization
  ├── Project/agreement/milestone services
  ├── AI service (Gemini)
  ├── Payments domain + provider router
  ├── PayPal Multiparty adapter (documented seller onboarding, checkout, capture and supported operations)
  ├── Seller onboarding/capability service
  ├── Append-only ledger + reconciliation
  └── Provider webhook handlers (signature verification + idempotency)
          │
     ┌────┼───────────┐
     ▼    ▼           ▼
 Supabase Gemini   PayPal REST API
 Postgres API      Sandbox
```

## 2. Suggested repository structure

```text
payroost/
├── AGENTS.md
├── README.md
├── docs/
│   ├── PRODUCT_SPEC.md
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── PAYPAL_INTEGRATION.md
│   ├── AG_GRID_INTEGRATION.md
│   ├── PAYMENTS_MARKETPLACE_PRODUCTION.md
│   └── SOURCES_AND_ASSUMPTIONS.md
│   ├── AI_SPEC.md
│   ├── UX_UI_SPEC.md
│   ├── SECURITY_PRIVACY.md
│   ├── TEST_PLAN.md
│   ├── BUILD_PLAN.md
│   ├── DEPLOYMENT.md
│   ├── DEMO_SCRIPT.md
│   └── DECISIONS.md
├── public/
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   ├── (app)/
│   │   ├── review/[token]/
│   │   ├── pay/[token]/
│   │   └── api/
│   │       ├── ai/
│   │       ├── paypal/
│   │       └── webhooks/paypal/
│   ├── components/
│   ├── features/
│   │   ├── projects/
│   │   ├── agreements/
│   │   ├── milestones/
│   │   ├── change-requests/
│   │   └── payments/
│   ├── lib/
│   │   ├── supabase/
│   │   ├── payments/
│   │   │   ├── providers/
│   │   │   │   ├── paypal-multiparty/
│   │   │   │   └── provider-interface.ts
│   │   │   ├── routing/
│   │   │   └── ledger/
│   │   ├── ai/
│   │   ├── auth/
│   │   ├── validation/
│   │   └── utils/
│   └── types/
├── supabase/
│   └── migrations/
├── tests/
├── .env.example
└── package.json
```

Codex may adjust the structure if a simpler structure is justified, but must preserve module boundaries.

## 3. Server/client boundaries

**Client components**
- Form state and interactive UI.
- PayPal JS SDK button rendering.
- Calls to authenticated application endpoints.
- Never hold PayPal secret, Gemini key, service-role key, or privileged DB credentials.

**Server-only modules**
- Supabase admin operations (only when necessary).
- Ownership and client-token authorization.
- Gemini calls and output validation.
- PayPal OAuth token retrieval, order creation, capture, webhook verification.
- Monetary calculations and payment state transitions.

Mark secret-bearing modules with `server-only` where appropriate.

## 4. Key API contracts

Implement route handlers with Zod validation and consistent JSON envelopes.

### AI
- `POST /api/ai/generate-agreement`
  - Authenticated project owner.
  - Input: project brief and permitted project metadata.
  - Output: validated agreement draft; does not save as approved.
- `POST /api/ai/analyze-scope`
  - Authenticated project owner.
  - Input: project ID and proposed request.
  - Server loads approved agreement; do not trust client-supplied agreement text.
  - Output: validated assessment with evidence references.

### Client review
- `GET /api/public/review/[token]`
- `POST /api/public/review/[token]/approve`
- `POST /api/public/review/[token]/request-changes`

### PayPal
- `POST /api/paypal/create-order`
  - Input: milestone ID and client review/payment token.
  - Server loads authoritative milestone amount/currency and validates eligibility.
  - Returns PayPal order ID.
- `POST /api/paypal/capture-order`
  - Input: PayPal order ID and app payment intent identifier.
  - Server verifies order belongs to the expected internal payment intent, then captures.
  - Returns sanitized capture result.
- `POST /api/webhooks/paypal`
  - Verify signature before processing.
  - Persist event idempotently.
  - Return 2xx for successfully handled or safely deduplicated events.

## 5. Payment state authority

The database is the application's state store, but PayPal is the external source of truth for transaction outcomes. A payment becomes `COMPLETED` only after a successful server-side capture response or a verified PayPal event consistent with the order/capture. Never trust a client-supplied `status: COMPLETED`.

## 6. Error handling

Use stable application error codes, e.g.:
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `AGREEMENT_NOT_APPROVED`
- `PAYMENT_NOT_ELIGIBLE`
- `PAYPAL_UPSTREAM_ERROR`
- `PAYPAL_CAPTURE_AMBIGUOUS`
- `AI_OUTPUT_INVALID`
- `RATE_LIMITED`

Do not leak secrets, provider responses containing sensitive data, or stack traces to clients.

## 7. Observability

Log structured events with internal IDs:
- `project.created`
- `agreement.generated`
- `agreement.sent`
- `agreement.approved`
- `scope.analysis.completed`
- `change_request.approved`
- `paypal.order.created`
- `paypal.capture.completed`
- `paypal.webhook.received`

Do not log full client briefs, agreement text, tokens, access tokens, client secrets, or full webhook payloads unless there is a documented redaction strategy.

## 5. Marketplace payments architecture requirements

- Use `MarketplacePaymentProvider` interface; business logic must not call PayPal endpoints directly.
- Implement PayPal Multiparty seller onboarding and seller capability state.
- Route by seller country, buyer country, currency, and provider capabilities on the server.
- Block unsupported or unresolved sellers before checkout. Never silently route a payment through a provider or recipient that is not the approved seller/payee.
- Add append-only ledger entries for captures, fees, refunds, reversals, and provider-confirmed payouts.
- Separate payment capture, milestone acceptance, and seller payout into distinct state machines.
- Add provider reconciliation jobs and operational alerts.
- Do not implement escrow or custody unless a provider-approved product and legal review explicitly support it.
- Nigeria-based sellers must be blocked from PayPal seller payment routing pending written clarification of the conflicting country eligibility information on PayPal's official seller-onboarding page. Keep any alternative provider adapter disabled until a suitable provider is verified and contracted.


## Payment Operations and AG Grid

AG Grid React Community powers a read-only Payment Operations transaction table. The application server returns only payment records the current user is authorized to view. The grid uses the Client-Side Row Model over the bounded response and provides sorting, filtering, pagination, formatted values, accessible status rendering and row-to-detail navigation. It does not mutate payment, ledger, refund or payout state. See `AG_GRID_INTEGRATION.md` for the exact feature/licensing boundary.

## Payment domain boundaries

Keep seller onboarding, payment intent/attempt, provider capture, refund, dispute, ledger posting, milestone acceptance and seller payout as separate domain states. These are Payroost architecture choices. Map PayPal responses/events into the internal model only after checking the official API/event documentation for the selected CCPP integration.
