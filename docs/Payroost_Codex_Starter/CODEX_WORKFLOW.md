# Codex Workflow

## First inspection prompt

```text
Read AGENTS.md, README.md, and every document in docs/. Inspect the current repository without changing files. Report the existing stack, missing prerequisites, required environment variables, implementation phases, and all specification conflicts or unsupported assumptions. Verify the PayPal Complete Payments Platform (Multiparty) Sandbox flow against current official PayPal documentation. Verify AG Grid React installation, module registration, feature edition and licence requirements against current official AG Grid documentation. Do not code yet. Wait for approval before Phase 0.
```

## Implementation loop

1. Ask Codex to implement one named phase from `BUILD_PLAN.md`.
2. Require it to list the files it intends to change before a broad refactor.
3. Require exact source documentation links for every PayPal endpoint, field, capability and webhook event it implements.
4. Require exact AG Grid documentation links for package setup, modules and any grid feature used.
5. Review the diff, then run lint, typecheck, tests and build.
6. Do not accept mock payment success in the deployed demo. Any local mock must be isolated, labelled and disabled in deployed environments.
7. Keep the payment UI and operational grid read-only with respect to financial state; financial changes must use authorized server workflows.

## Review prompt

```text
Review the changes against AGENTS.md and all relevant docs. Identify security issues, unsupported PayPal assumptions, incorrect AG Grid edition usage, authorization gaps, money precision issues, missing tests and discrepancies between code and documentation. Do not modify files yet. Cite the exact official documentation page supporting each PayPal or AG Grid integration claim.
```
