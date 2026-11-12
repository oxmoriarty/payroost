# PayRoost Documentation

This directory organizes PayRoost's living system documentation alongside the preserved starter specifications used at project inception.

## Directory Layout

### 1. Updated System Documentation ([`system_architecture/`](system_architecture/))
Up-to-date documentation reflecting the live PayRoost codebase, architecture, security invariants, database schema, UI system, and deployment setup:

- [`system_architecture/MODEL_AND_ARCHITECTURE_CHANGES.md`](system_architecture/MODEL_AND_ARCHITECTURE_CHANGES.md) — Summary of how PayRoost evolved from the original starter pack (payment model, Gmail SMTP migration, AI upgrades, portal & email verification, UI/typography redesign, and schema expansion).
- [`system_architecture/ARCHITECTURE.md`](system_architecture/ARCHITECTURE.md) — Live Next.js App Router architecture, all 47 API routes, domain modules (`src/features/`), and infrastructure (`src/lib/`).
- [`system_architecture/DATA_MODEL.md`](system_architecture/DATA_MODEL.md) — Current PostgreSQL schema across 35 migrations, 20 tables, triggers, invariants, and core RPC groups.
- [`system_architecture/SECURITY_PRIVACY.md`](system_architecture/SECURITY_PRIVACY.md) — Secrets handling, fail-closed checks, CSRF/OTP/portal sessions, rate limiting, and AI/payment security controls.
- [`system_architecture/UX_UI_SPEC.md`](system_architecture/UX_UI_SPEC.md) — Current design tokens, self-hosted variable typography, custom UI primitives, micro-interactions, brand SVGs, and landing showcase assets.
- [`system_architecture/DEPLOYMENT_AND_SANDBOX_CHECKLIST.md`](system_architecture/DEPLOYMENT_AND_SANDBOX_CHECKLIST.md) — Environment configuration, Supabase migrations, Gmail SMTP setup, Gemini AI, PayPal Multiparty Sandbox setup, and verification commands.

### 2. Original Starter Pack & Proof of Work ([`Payroost_Codex_Starter/`](Payroost_Codex_Starter/))
The original `Payroost_Codex_Starter/` folder and its `reports_and_history/` archive preserved intact as proof of work and historical baseline.
