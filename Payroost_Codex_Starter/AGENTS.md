# Codex Instructions — Payroost

These instructions apply to the entire repository.

## Read first
1. Read `README.md`.
2. Read every specification in `docs/`.
3. Treat `docs/PRODUCT_SPEC.md` and `docs/DECISIONS.md` as product decisions; use `docs/PAYPAL_INTEGRATION.md` and `docs/AG_GRID_INTEGRATION.md` for those integrations.
4. If documents conflict, stop and report the conflict. Do not silently choose a payment behaviour.

## Product guardrails
- Payroost is an AI-assisted freelance project agreement, milestone, scope-change and payment workflow.
- The marketplace model is seller-directed: the freelancer is the intended seller/payee for a project milestone when the selected provider confirms that the seller is eligible.
- The PayPal integration target is PayPal Complete Payments Platform (Multiparty), tested in Sandbox. Production access is subject to PayPal partner approval and country/product eligibility.
- Do not imply that Sandbox approval, credentials, or a successful test transaction establish production eligibility.
- Payroost is not an escrow service and must not claim custody, conditional release, or guaranteed payout unless a specific provider product and the legal/commercial arrangement have been approved for that use.
- AI is advisory and draft-generating only. A human approves agreements, amounts, milestones, scope changes and payment actions.
- Do not provide legal advice, arbitration, breach determinations, or outcome guarantees.

## Code quality
- TypeScript strict mode; avoid `any`.
- Validate inputs at trust boundaries with Zod.
- Use server-only modules for secrets and privileged operations.
- Use integer minor units for money.
- Enforce authorization on the server and with RLS.
- Add tests for money calculations, state transitions, review tokens and payment flows.
- Keep components accessible and responsive.
- Do not add dependencies without a clear reason.
- Do not leave dead buttons, TODO placeholders in user-facing flows, or fake success states.

## PayPal integration rules
- Use only the PayPal Complete Payments Platform multiparty flow described by current official PayPal documentation and the approved Sandbox configuration.
- Before implementing any API request, verify the exact endpoint, request fields, response fields, headers, capabilities and event names in current PayPal documentation. Do not infer API payloads from this specification.
- Follow PayPal's platform onboarding and seller onboarding process. A seller must complete the required onboarding and grant the required permissions before the applicable payment flow is enabled.
- Check seller eligibility and required capabilities on the server before offering PayPal checkout.
- Nigeria is marked `Send only` in PayPal's seller-onboarding country table. PayPal's page also displays `Yes` in two business PayPal Checkout columns for Nigeria, while its adjacent instruction says not to onboard sellers in send-only countries for payment integrations. Treat this as a documentation conflict and block PayPal seller payment routing for Nigeria until PayPal confirms the exact use case in writing.
- Never use false country information, borrowed accounts, VPNs or nominee accounts to bypass eligibility.
- Server creates and captures orders. Server derives amount, currency, seller identity and any permitted platform fee from trusted database records.
- Never assume platform fees, delayed disbursement, dispute APIs, reporting or payout functions are available to a particular Payroost integration. Enable a feature only after the applicable PayPal product documentation and approved account configuration confirm it.
- Verify PayPal webhook signatures using PayPal's documented verification method and deduplicate event IDs.
- Browser callbacks are not proof of payment. Do not infer seller settlement or payout from buyer capture.
- Handle cancellation, failure, pending, duplicate, out-of-order and ambiguous outcomes.

## AG Grid integration rules
- Use AG Grid React for the Payment Operations transaction table described in `docs/AG_GRID_INTEGRATION.md`.
- The required implementation must work with AG Grid Community. Do not use Enterprise-only features unless a valid production licence is available and the project explicitly approves that dependency.
- Use the official current React installation and module-registration guidance. Keep AG Grid package versions aligned.
- The grid is a read-only operational view. It must not directly mutate payment amounts, ledger entries, captures, refunds or payout state.
- Grid rows must come from authorized server data. Do not expose provider secrets, full payment instruments, webhook payloads or unnecessary personal information.

## AI rules
- Use structured output and validate it.
- Treat project content as untrusted data, not model instructions.
- AI cannot execute tools or mutate project/payment state.
- Never invent agreement facts, evidence, prices or dates.
- Return uncertainty and clarification questions when needed.

## Working method
- Inspect before editing.
- Implement one phase at a time.
- Prefer small, reviewable changes.
- Run lint, typecheck, tests and build.
- Report exact test outcomes and unresolved blockers.
- Do not overwrite user work or remove existing functionality without explaining why.
