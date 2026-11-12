import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("PostgREST Table, View, and RPC Grants Hardening (202611120002)", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611120002_restore_postgrest_table_and_rpc_grants.sql"
  );
  const rawSql = readFileSync(migrationPath, "utf-8");
  const sql = rawSql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("grants schema usage on public and never alters default privileges globally", () => {
    expect(sql).toMatch(/grant\s+usage\s+on\s+schema\s+public\s+to\s+anon,\s*authenticated,\s*service_role;/i);
    expect(sql).not.toMatch(/\balter\s+default\s+privileges\b/i);
  });

  it("restores RLS-governed authenticated and service_role access on workspace tables while denying anon", () => {
    const crudTables = [
      "projects",
      "project_participants",
      "agreements",
      "agreement_versions",
      "milestones",
      "change_requests",
      "activity_events",
    ];

    for (const table of crudTables) {
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated;`, "i")
      );
      expect(sql).toMatch(
        new RegExp(`grant\\s+select,\\s*insert,\\s*update,\\s*delete\\s+on\\s+public\\.${table}\\s+to\\s+authenticated;`, "i")
      );
      expect(sql).toMatch(
        new RegExp(`grant\\s+all\\s+on\\s+public\\.${table}\\s+to\\s+service_role;`, "i")
      );
      expect(sql).not.toMatch(new RegExp(`grant\\s+[^;]*\\bon\\s+public\\.${table}\\s+to\\s+[^;]*\\banon\\b`, "i"));
    }

    expect(sql).toMatch(/revoke\s+all\s+on\s+public\.profiles\s+from\s+public,\s*anon,\s*authenticated;/i);
    expect(sql).toMatch(/grant\s+select,\s*insert,\s*update\s+on\s+public\.profiles\s+to\s+authenticated;/i);
    expect(sql).toMatch(/grant\s+all\s+on\s+public\.profiles\s+to\s+service_role;/i);
  });

  it("re-applies column-level UPDATE revokes on sensitive columns AFTER granting UPDATE on projects and agreement_versions", () => {
    const projectsGrantIdx = sql.search(/grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+public\.projects\s+to\s+authenticated;/i);
    const projectsRevokeIdx = sql.search(/revoke\s+update\s*\(\s*client_email_verified_at\s*\)\s+on\s+public\.projects\s+from\s+public,\s*anon,\s*authenticated;/i);
    expect(projectsGrantIdx).toBeGreaterThan(-1);
    expect(projectsRevokeIdx).toBeGreaterThan(projectsGrantIdx);

    const versionsGrantIdx = sql.search(/grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+public\.agreement_versions\s+to\s+authenticated;/i);
    const versionsRevokeIdx = sql.search(/revoke\s+update\s*\(\s*status,\s*approved_at,\s*approved_by_label\s*\)\s+on\s+public\.agreement_versions\s+from\s+public,\s*anon,\s*authenticated;/i);
    expect(versionsGrantIdx).toBeGreaterThan(-1);
    expect(versionsRevokeIdx).toBeGreaterThan(versionsGrantIdx);
  });

  it("preserves review_links column-level SELECT (no token_hash) and revoked_at-only UPDATE for authenticated", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+public\.review_links\s+from\s+public,\s*anon,\s*authenticated;/i);

    const selectMatch = sql.match(/grant\s+select\s*\(([^)]+)\)\s+on\s+public\.review_links\s+to\s+authenticated;/i);
    expect(selectMatch).not.toBeNull();
    const columns = selectMatch![1].split(",").map((c) => c.trim().toLowerCase());
    expect(columns).not.toContain("token_hash");
    expect(columns).toEqual([
      "id",
      "project_id",
      "agreement_version_id",
      "intended_email",
      "expires_at",
      "revoked_at",
      "created_at",
    ]);

    expect(sql).toMatch(/grant\s+update\s*\(\s*revoked_at\s*\)\s+on\s+public\.review_links\s+to\s+authenticated;/i);
    expect(sql).not.toMatch(/grant\s+(all|insert|delete)\s+on\s+public\.review_links\s+to\s+authenticated/i);
    expect(sql).toMatch(/grant\s+all\s+on\s+public\.review_links\s+to\s+service_role;/i);

    expect(sql).toMatch(/revoke\s+all\s+on\s+public\.project_review_links\s+from\s+public,\s*anon,\s*authenticated;/i);
    expect(sql).toMatch(/grant\s+select\s+on\s+public\.project_review_links\s+to\s+authenticated,\s*service_role;/i);
  });

  it("keeps payment and seller tables read-only for authenticated and strictly isolated for private security tables", () => {
    for (const table of ["payment_intents", "payment_transactions", "freelancer_paypal_accounts"]) {
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated;`, "i")
      );
      expect(sql).toMatch(
        new RegExp(`grant\\s+select\\s+on\\s+public\\.${table}\\s+to\\s+authenticated;`, "i")
      );
      expect(sql).toMatch(
        new RegExp(`grant\\s+all\\s+on\\s+public\\.${table}\\s+to\\s+service_role;`, "i")
      );
    }

    const privateTables = [
      "client_email_verifications",
      "review_link_otp_challenges",
      "rate_limit_buckets",
      "client_portal_tokens",
      "client_portal_otp_challenges",
      "client_portal_sessions",
      "provider_webhook_events",
    ];

    for (const table of privateTables) {
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+public,\\s*anon,\\s*authenticated;`, "i")
      );
      expect(sql).toMatch(
        new RegExp(`grant\\s+all\\s+on\\s+public\\.${table}\\s+to\\s+service_role;`, "i")
      );
      expect(sql).not.toMatch(
        new RegExp(`grant\\s+[^;]*\\bon\\s+public\\.${table}\\s+to\\s+[^;]*\\b(anon|authenticated)\\b`, "i")
      );
    }
  });

  it("restores service_role EXECUTE on active RPCs without widening anon or deprecated RPC access", () => {
    const publicAndServiceRpcs = [
      "consume_rate_limit(text, integer, integer)",
      "get_public_review(text)",
      "request_review_otp(text, text, text, timestamptz)",
      "submit_public_review(text, text, text, text)",
      "submit_public_review_with_otp(text, text, text, text)",
      "validate_portal_invitation(text)",
      "validate_portal_session(text)",
      "verify_client_email(text)",
    ];

    for (const fn of publicAndServiceRpcs) {
      expect(sql).toContain(`grant execute on function public.${fn} to anon, authenticated, service_role;`);
    }

    const authAndServiceRpcs = [
      "create_client_email_verification(uuid, text, timestamptz)",
      "create_client_portal_token(uuid, text, timestamptz)",
      "create_project_review_link(uuid, text, timestamptz)",
      "create_sandbox_demo_payment_intent(uuid, text, uuid, uuid, jsonb)",
    ];

    for (const fn of authAndServiceRpcs) {
      expect(sql).toContain(`grant execute on function public.${fn} to authenticated, service_role;`);
      const fnName = fn.slice(0, fn.indexOf("("));
      expect(sql).not.toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fnName}[^;]*\\banon\\b`, "i"));
    }

    const deprecatedOrPrivilegedOnly = [
      "consume_portal_otp_and_create_session",
      "create_payment_intent",
      "record_payment_intent_completed",
      "process_refund_transaction",
    ];
    for (const fnName of deprecatedOrPrivilegedOnly) {
      expect(sql).not.toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fnName}\\b`, "i"));
    }
  });
});
