# Primary Codex Build Prompt — Payroost

You are the senior full-stack engineer implementing **Payroost**, a polished, working hackathon MVP. Work inside the current repository. Read `AGENTS.md` and every document in `/docs` before making architectural decisions. If a requirement is ambiguous, report it and choose the safest minimal implementation; do not invent business or payment behaviour.

## Mission

Build a complete web application that lets a freelancer:
1. Create a project from a client brief.
2. Generate an editable structured agreement using AI.
3. Send a secure review link to a client.
4. Let the client approve the exact agreement version or request changes.
5. Manage project milestones.
6. Onboard as a seller through the PayPal Multiparty Sandbox flow when the Sandbox setup supports the seller's country/account type.
7. Collect a milestone payment through PayPal Complete Payments Platform (Multiparty) Sandbox with the freelancer as the intended seller/payee.
8. Update payment state only after server-side verification and webhook processing.
9. Inspect authorized transaction records in the AG Grid Payment Operations table.
10. Submit a new request and compare it against the approved scope using AI.
11. Convert a reviewed scope change into a client-approved change request and additional milestone.

The application must not claim escrow, custody, conditional release, guaranteed payout, legal advice or binding dispute resolution unless a specific approved provider product and legal/commercial review support the exact claim.

## Required behaviour before coding

1. Inspect the repository and current files.
2. Read `AGENTS.md` and `/docs/*.md`.
3. Report the current repository state, missing prerequisites and implementation phases.
4. Identify required environment variables and external accounts.
5. Verify every PayPal endpoint, request/response field, capability, onboarding requirement and webhook event against current official PayPal documentation.
6. Verify AG Grid package setup, module registration, feature edition and licence requirements against current official AG Grid documentation.
7. Then implement in small, testable phases. Do not generate the entire application in one unreviewable code dump.

## Technical defaults

- Next.js App Router
- TypeScript strict mode
- Tailwind CSS
- shadcn/ui or equivalent accessible primitives
- Supabase Auth + PostgreSQL + RLS
- Gemini API via a server-only module
- PayPal Complete Payments Platform (Multiparty) Sandbox
- AG Grid React Community for Payment Operations
- Vercel deployment
- Zod validation
- Lucide icons

Preserve an existing compatible setup rather than replacing it without reason. Do not pin package versions from this document; use the current official installation guidance and keep AG Grid package versions aligned.

## Engineering rules

- Keep components modular and domain-oriented.
- Keep all secrets server-side.
- Use integer minor units for money.
- Validate every external input on the server.
- Enforce ownership checks server-side and with RLS.
- Use immutable agreement version snapshots.
- Use hashed, high-entropy public review tokens with expiry.
- Treat AI content as untrusted and unapproved.
- Use schema-constrained AI output and validate with Zod.
- The server loads the approved agreement for scope analysis; never trust a client-supplied agreement as the source of truth.
- AI cannot approve, reject, charge, refund or mutate state.
- PayPal amount, currency, seller identity and any permitted platform fee must come from trusted database records.
- Follow the approved PayPal multiparty onboarding and order/capture flow. Do not guess field names or payload shape.
- Verify webhook signatures and deduplicate event IDs.
- Browser callbacks never independently mark a payment complete.
- Never simulate successful PayPal payment in the real payment UI. A clearly labelled local mock may be used for UI development only and must be disabled in deployed demo.
- Use AG Grid Community features only unless a valid Enterprise production licence is explicitly supplied and approved. Do not use Enterprise Integrated Charts or Server-Side Row Model as if they were Community features.
- The AG Grid Payment Operations table is read-only. It must not mutate ledger entries or trigger financial operations directly.
- Load only records the signed-in user is authorized to see. Do not send secrets or unnecessary personal data to the browser.
- Add meaningful loading, empty, validation, error and success states.
- No dead buttons, placeholder charts, lorem ipsum or fake balances.
- Use accessible labels, focus states, semantic markup and responsive layouts.
- Do not commit `.env.local` or secrets.

## Implementation order

### Phase 0 — repository and foundation
- Inspect repository, dependencies and scripts.
- Establish app shell, design tokens, typography and navigation.
- Add Supabase browser/server clients, auth and middleware if appropriate.
- Create migrations, enums, tables, indexes and RLS policies.
- Add `.env.example`.
- Add AG Grid React Community dependency using the official React installation and module-registration documentation.
- Build the Payment Operations page shell and a typed grid using clearly identified seed data only until real authorized records are available.
- Make an initial deploy.

### Phase 1 — project workflow
- Dashboard, create project and project details.
- Agreement draft schema and Gemini generation.
- Agreement editor and immutable version snapshots.
- Secure client review link.
- Client approve/request-changes actions.
- Milestone management and activity timeline.

### Phase 2 — PayPal Multiparty Sandbox
- Configure the Sandbox platform REST app and the seller/buyer Sandbox accounts required by the current PayPal integration guide.
- Implement seller onboarding using the Partner Referrals process where applicable to the approved Sandbox configuration.
- Persist onboarding state and retrieve/verify seller capabilities using documented PayPal APIs.
- Block seller/payment routes that fail country, account-type or capability checks.
- Implement server-side order creation and capture using the exact PayPal multiparty integration instructions for the selected checkout solution.
- Verify seller/payee, amount, currency, capture status and provider references using the documented response fields.
- Implement webhook subscription, signature verification, deduplication and event handling using current PayPal documentation.
- Add idempotency, ambiguous-state recovery and payment disclosures.
- Do not assume partner fees or delayed disbursement are enabled; use them only if PayPal's approved configuration explicitly supports them.

### Phase 3 — payment operations and ledger
- Implement provider-neutral payment records and append-only ledger tables.
- Populate AG Grid from an authorized server endpoint using actual persisted payment records.
- Add useful columns, sorting, filters, pagination, formatted currency/status cells and row-to-detail navigation.
- Keep the grid read-only; actions such as refunds must use separate permission-checked server workflows and only if implemented.
- Add reconciliation and audit records.

### Phase 4 — AI scope intelligence
- Server retrieves the approved agreement.
- Gemini scope comparison with structured output.
- Zod validation and evidence references.
- Result UI with confidence/uncertainty.
- Human-reviewed change request.
- Client approve/reject.
- Create new version and additional milestone.

### Phase 5 — quality and submission
- Seed demo scenario.
- Test core flow.
- Responsive/accessibility pass.
- Security review.
- README and docs.
- Public repository license.
- Deployment.
- Demo recording preparation.

## UI direction

Create a credible early-stage SaaS product:
- Deep navy/ink primary text and navigation.
- Clean off-white background.
- White surfaces with subtle borders.
- Restrained teal or blue accent.
- Consistent spacing and typography.
- Calm fintech/productivity aesthetic.
- Clear hierarchy and generous whitespace.
- Responsive navigation.
- Real project/payment data and purposeful empty states.

Do not copy PayPal branding or imply PayPal endorses Payroost. Use official PayPal checkout assets only as directed by the applicable PayPal integration documentation.

## Definition of done

A clean browser session can complete the demonstrated flow supported by the Sandbox configuration:
- Sign in.
- Create project.
- Generate/edit agreement.
- Send review link.
- Approve as client in another browser.
- Complete seller onboarding for an eligible Sandbox seller.
- Pay a milestone through the PayPal Multiparty Sandbox flow.
- See server-verified payment state.
- Inspect the corresponding persisted transaction in AG Grid.
- Submit an additional feature request.
- See AI scope classification grounded in the approved agreement.
- Create and approve a change request.

Before declaring a phase complete:
1. Run lint.
2. Run TypeScript check.
3. Run relevant tests.
4. Run production build when appropriate.
5. Summarise files changed, decisions made, commands run, test results and remaining blockers.
6. Do not claim tests passed unless they were actually run.

## First response

Do not start by writing all code. First inspect the repository, read the specifications, identify missing credentials/services and give a concise implementation plan. Wait for approval before broad implementation.
