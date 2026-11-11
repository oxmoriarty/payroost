import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleIncomingPayPalWebhook } from "@/lib/paypal/webhook-processor";
import type { PayPalConfig } from "@/lib/paypal/types";

const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const MILESTONE_ID = "22222222-2222-4222-8222-222222222222";
const AGREEMENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_TOKEN = "55555555-5555-4555-8555-555555555555";
const SESSION_HASH = "a".repeat(64);
const SELLER_MERCHANT_ID = "SELLERMERC123";
const SELLER_PAYER_ID = "SELLERPAYER123";
const ORDER_ID = "O-PLATFORM-ORDER-9001";
const CAPTURE_ID = "CAP-PLATFORM-9001";
const EVENT_ID = "WH-ALIGN-9001";

function extractFunctionBlock(sql: string, signaturePrefix: string): string {
  const start = sql.indexOf(signaturePrefix);
  expect(start).toBeGreaterThan(-1);
  const bodyEnd = sql.indexOf("$$;", start);
  expect(bodyEnd).toBeGreaterThan(start);
  return sql.slice(start, bodyEnd + 3);
}

describe("PayRoost Phase R Corrective Migration (202611110004): PostgREST Capture, Webhook Alignment & Profile Backfill", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611110004_postgrest_capture_and_webhook_alignment.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  const r3MigrationSql = readFileSync(
    resolve(
      process.cwd(),
      "supabase/migrations/202611110001_platform_capture_and_reconciliation_hardening.sql"
    ),
    "utf-8"
  );
  const r4MigrationSql = readFileSync(
    resolve(
      process.cwd(),
      "supabase/migrations/202611110003_paypal_platform_webhooks.sql"
    ),
    "utf-8"
  );

  // ==========================================================================
  // 1. STATIC SQL CONTRACT AUDIT
  // ==========================================================================
  describe("1. Static SQL Audit: PostgREST Role Checks, Triggers, Grants & Constraints", () => {
    const postgrestDualLayerRegex =
      /session_user\s+in\s+\('postgres',\s*'supabase_admin',\s*'service_role'\)\s*or\s*\(\s*session_user\s*=\s*'authenticator'\s+and\s+\(\s*coalesce\(current_setting\('request\.jwt\.claim\.role',\s*true\),\s*''\)\s*=\s*'service_role'\s+or\s+\(\s*current_setting\('request\.jwt\.claims',\s*true\)\s+is\s+not\s+null/i;

    it("restores PostgREST dual-layer role check (with JSON fallback) across all privileged functions", () => {
      const blocks = [
        extractFunctionBlock(
          migrationSql,
          "create or replace function public.record_paypal_order_captured("
        ),
        extractFunctionBlock(
          migrationSql,
          "create or replace function public.reconcile_and_complete_payment_intent("
        ),
        extractFunctionBlock(
          migrationSql,
          "create or replace function public.validate_payment_transaction_insert()"
        ),
        extractFunctionBlock(
          migrationSql,
          "create or replace function public.prevent_payment_transactions_mutation()"
        ),
        extractFunctionBlock(
          migrationSql,
          "create or replace function public.record_paypal_webhook_capture_state("
        ),
        extractFunctionBlock(
          migrationSql,
          "create or replace function public.claim_paypal_webhook_event("
        ),
      ];

      for (const block of blocks) {
        expect(block).toMatch(postgrestDualLayerRegex);
        expect(block).toMatch(
          /\(current_setting\('request\.jwt\.claims',\s*true\)::jsonb\s*->>\s*'role'\)\s*=\s*'service_role'/i
        );
      }
    });

    it("does not reintroduce bare session_user or current_user checks and pins search_path = ''", () => {
      const sqlNoComments = migrationSql
        .replace(/--.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      expect(sqlNoComments).not.toMatch(/session_user\s+not\s+in/i);
      expect(sqlNoComments).not.toMatch(/\bcurrent_user\b/i);

      const fnNames = [
        "public.record_paypal_order_captured(",
        "public.reconcile_and_complete_payment_intent(",
        "public.validate_payment_transaction_insert()",
        "public.prevent_payment_transactions_mutation()",
        "public.record_paypal_webhook_capture_state(",
        "public.claim_paypal_webhook_event(",
      ];

      for (const fnName of fnNames) {
        const idx = migrationSql.indexOf(`create or replace function ${fnName}`);
        expect(idx).toBeGreaterThan(-1);
        const headerEnd = migrationSql.indexOf("as $$", idx);
        const header = migrationSql.slice(idx, headerEnd);
        expect(header).toMatch(/set\s+search_path\s*=\s*''/i);
      }
    });

    it("preserves exact RPC signatures and locks EXECUTE strictly to service_role", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.record_paypal_order_captured\(text,\s*uuid,\s*uuid,\s*text,\s*text,\s*bigint,\s*text,\s*jsonb\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.record_paypal_order_captured\(text,\s*uuid,\s*uuid,\s*text,\s*text,\s*bigint,\s*text,\s*jsonb\)\s+to\s+service_role;/i
      );

      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.reconcile_and_complete_payment_intent\(uuid,\s*text,\s*jsonb,\s*jsonb,\s*text,\s*bigint,\s*text,\s*uuid\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.reconcile_and_complete_payment_intent\(uuid,\s*text,\s*jsonb,\s*jsonb,\s*text,\s*bigint,\s*text,\s*uuid\)\s+to\s+service_role;/i
      );

      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.record_paypal_webhook_capture_state\(\s*uuid,\s*text,\s*text,\s*text,\s*text,\s*bigint,\s*text,\s*jsonb,\s*text\s*\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.record_paypal_webhook_capture_state\(\s*uuid,\s*text,\s*text,\s*text,\s*text,\s*bigint,\s*text,\s*jsonb,\s*text\s*\)\s+to\s+service_role;/i
      );

      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.claim_paypal_webhook_event\(\s*text,\s*text,\s*text,\s*text,\s*text,\s*jsonb,\s*jsonb,\s*timestamptz,\s*boolean,\s*integer,\s*integer,\s*boolean,\s*boolean\s*\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.claim_paypal_webhook_event\(\s*text,\s*text,\s*text,\s*text,\s*text,\s*jsonb,\s*jsonb,\s*timestamptz,\s*boolean,\s*integer,\s*integer,\s*boolean,\s*boolean\s*\)\s+to\s+service_role;/i
      );

      // Confirm prior migrations remain untouched and R3/R4 parameter defaults remain compatible
      expect(r3MigrationSql).toMatch(/if\s+session_user\s+not\s+in/i);
      expect(r4MigrationSql).toMatch(/nullif\(v_clean_resource_type,\s*''\)/i);
    });

    it("never mutates public.milestones and preserves Platform checks in capture & reconciliation RPCs", () => {
      expect(migrationSql).not.toMatch(/update\s+public\.milestones\b/i);

      const recordCaptureFn = extractFunctionBlock(
        migrationSql,
        "create or replace function public.record_paypal_order_captured("
      );
      expect(recordCaptureFn).toMatch(/SELLER_METADATA_MISMATCH/);
      expect(recordCaptureFn).toMatch(/SELLER_PAYER_ID_MISSING/);
      expect(recordCaptureFn).toMatch(/STALE_LEASE_TOKEN/);

      const reconcileFn = extractFunctionBlock(
        migrationSql,
        "create or replace function public.reconcile_and_complete_payment_intent("
      );
      expect(reconcileFn).toMatch(/Canonical seller_merchant_id/i);
      expect(reconcileFn).toMatch(/missing valid canonical seller_payer_id/i);
      expect(reconcileFn).toMatch(/set_config\('payroost\.reconciliation_active',\s*'true',\s*true\)/i);
    });

    it("orders intent state update before PENDING capture insert, aligns triggers for PENDING -> FAILED, and sets 'UNKNOWN' resource_type sentinel", () => {
      const webhookStateFn = extractFunctionBlock(
        migrationSql,
        "create or replace function public.record_paypal_webhook_capture_state("
      );
      const pendingBranchIdx = webhookStateFn.indexOf("if v_clean_status = 'PENDING' then");
      const updateIntentIdx = webhookStateFn.indexOf("update public.payment_intents", pendingBranchIdx);
      const insertPendingTxIdx = webhookStateFn.indexOf("insert into public.payment_transactions", pendingBranchIdx);
      expect(pendingBranchIdx).toBeGreaterThan(-1);
      expect(updateIntentIdx).toBeGreaterThan(pendingBranchIdx);
      expect(insertPendingTxIdx).toBeGreaterThan(updateIntentIdx);

      const mutationFn = extractFunctionBlock(
        migrationSql,
        "create or replace function public.prevent_payment_transactions_mutation()"
      );
      expect(mutationFn).toMatch(/old\.status\s*<>\s*'PENDING'\s+or\s+new\.status\s+not\s+in\s+\('COMPLETED',\s*'FAILED'\)/i);

      expect(migrationSql).toMatch(/alter\s+table\s+public\.provider_webhook_events\s+alter\s+column\s+resource_type\s+set\s+default\s+'UNKNOWN';/i);
      expect(migrationSql).not.toMatch(/drop\s+not\s+null/i);
    });

    it("backfills public.profiles idempotently using only auth.users id and display_name", () => {
      expect(migrationSql).toMatch(
        /insert\s+into\s+public\.profiles\s*\(\s*id,\s*display_name\s*\)\s+select\s+u\.id,\s*coalesce\(u\.raw_user_meta_data\s*->>\s*'display_name',\s*''\)\s+from\s+auth\.users\s+u\s+where\s+not\s+exists\s*\(/is
      );
      expect(migrationSql).toMatch(/on\s+conflict\s*\(\s*id\s*\)\s+do\s+nothing;/i);
    });
  });

  // ==========================================================================
  // 2. BEHAVIORAL SIMULATION OF ALIGNED POSTGRES TRIGGER & RPC CONTRACTS
  // ==========================================================================
  describe("2. Behavioral Verification: PostgREST Auth, Webhook Lifecycle, resource_type & Profile Backfill", () => {
    type SessionContext = {
      sessionUser: string;
      claimRole?: string;
      jwtClaimsJson?: string | null;
      reconciliationActive?: string;
      ledgerMutationAuthorized?: string;
      webhookCaptureEventId?: string;
    };

    function isPrivilegedServiceRole(ctx: SessionContext): boolean {
      if (["postgres", "supabase_admin", "service_role"].includes(ctx.sessionUser)) {
        return true;
      }
      if (ctx.sessionUser !== "authenticator") {
        return false;
      }
      if ((ctx.claimRole ?? "") === "service_role") {
        return true;
      }
      if (ctx.jwtClaimsJson && /^\s*\{.*\}\s*$/.test(ctx.jwtClaimsJson)) {
        try {
          const parsed = JSON.parse(ctx.jwtClaimsJson) as { role?: string };
          return parsed.role === "service_role";
        } catch {
          return false;
        }
      }
      return false;
    }

    interface SimIntent {
      id: string;
      project_id: string;
      milestone_id: string;
      agreement_version_id: string;
      status:
        | "ORDER_CREATING"
        | "ORDER_CREATED"
        | "BUYER_APPROVED"
        | "CAPTURING"
        | "RECONCILING"
        | "COMPLETED"
        | "FAILED"
        | "CANCELLED"
        | "RECONCILIATION_REQUIRED";
      expected_merchant_id: string;
      expected_currency: string;
      expected_amount_cents: number;
      expected_amount_canonical: string;
      provider: "PAYPAL";
      provider_order_id: string | null;
      capture_lease_token: string | null;
      capture_lease_expires_at: number | null;
      order_creation_lease_token: string | null;
      order_creation_lease_expires_at: number | null;
      reconciliation_reason: string | null;
      canonical_payload_json: Record<string, unknown>;
    }

    interface SimTx {
      id: string;
      payment_intent_id: string;
      parent_transaction_id: string | null;
      transaction_type: "CAPTURE" | "REFUND" | "REVERSAL";
      provider: "PAYPAL";
      provider_reference_id: string;
      status: "COMPLETED" | "PENDING" | "FAILED" | "REFUNDED";
      amount_cents: number;
      currency: "USD";
      payee_merchant_id: string;
      raw_response: Record<string, unknown>;
      captured_at: string;
    }

    interface SimWebhookEvent {
      id: string;
      provider: "PAYPAL";
      provider_event_id: string;
      event_type: string;
      resource_type: string;
      resource_id: string | null;
      payload_sha256: string;
      signature_verified: boolean;
      payment_intent_id: string | null;
      status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED" | "RETRY";
      processing_outcome: string;
      attempt_count: number;
      duplicate_delivery_count: number;
    }

    function createAlignedDbHarness(seed?: {
      intent?: Partial<SimIntent>;
      milestoneStatus?: string;
    }) {
      const milestone = {
        id: MILESTONE_ID,
        status: seed?.milestoneStatus ?? "SUBMITTED",
      };

      const intent: SimIntent = {
        id: INTENT_ID,
        project_id: PROJECT_ID,
        milestone_id: MILESTONE_ID,
        agreement_version_id: AGREEMENT_VERSION_ID,
        status: "ORDER_CREATED",
        expected_merchant_id: SELLER_MERCHANT_ID,
        expected_currency: "USD",
        expected_amount_cents: 10000,
        expected_amount_canonical: "100.00",
        provider: "PAYPAL",
        provider_order_id: ORDER_ID,
        capture_lease_token: null,
        capture_lease_expires_at: null,
        order_creation_lease_token: null,
        order_creation_lease_expires_at: null,
        reconciliation_reason: null,
        canonical_payload_json: {
          payment_mode: "PLATFORM",
          seller_merchant_id: SELLER_MERCHANT_ID,
          seller_payer_id: SELLER_PAYER_ID,
        },
        ...seed?.intent,
      };

      const transactions: SimTx[] = [];
      const webhookEvents: SimWebhookEvent[] = [];
      const activityEvents: Array<{ event_type: string; metadata: Record<string, unknown> }> = [];
      const sessions = [
        {
          id: "sess-1",
          session_token_hash: SESSION_HASH,
          project_id: PROJECT_ID,
          revoked_at: null as string | null,
        },
      ];

      function validateTxInsert(newTx: Omit<SimTx, "id" | "captured_at">, ctx: SessionContext) {
        if (newTx.transaction_type === "CAPTURE") {
          if (newTx.parent_transaction_id !== null) {
            throw new Error("Capture transaction must not have a parent transaction");
          }
          if (newTx.provider !== intent.provider) {
            throw new Error("Capture provider mismatch");
          }
          if (!["COMPLETED", "PENDING", "FAILED"].includes(newTx.status)) {
            throw new Error(`Invalid status ${newTx.status} for CAPTURE transaction`);
          }
          if (newTx.currency !== intent.expected_currency) {
            throw new Error("Capture currency mismatch");
          }
          if (newTx.amount_cents !== intent.expected_amount_cents) {
            throw new Error("Capture amount mismatch");
          }
          if (newTx.payee_merchant_id !== intent.expected_merchant_id) {
            throw new Error("Capture merchant ID mismatch");
          }

          if (["CAPTURING", "RECONCILING", "COMPLETED"].includes(intent.status)) {
            if (intent.status === "COMPLETED" && newTx.status !== "COMPLETED") {
              throw new Error(`Cannot record ${newTx.status} capture for already COMPLETED intent`);
            }
          } else if (intent.status === "RECONCILIATION_REQUIRED") {
            if (!(isPrivilegedServiceRole(ctx) && ctx.reconciliationActive === "true")) {
              throw new Error(`Cannot record capture for intent in status ${intent.status}`);
            }
          } else if (["ORDER_CREATED", "BUYER_APPROVED"].includes(intent.status)) {
            if (!(isPrivilegedServiceRole(ctx) && ctx.reconciliationActive === "true")) {
              throw new Error(`Cannot record capture for intent in status ${intent.status}`);
            }
            if (!intent.provider_order_id || intent.provider_order_id.trim() === "") {
              throw new Error(
                `Cannot record capture for ${intent.status} intent without a bound provider_order_id`
              );
            }
            if (
              transactions.some(
                (t) =>
                  t.payment_intent_id === intent.id &&
                  t.transaction_type === "CAPTURE" &&
                  t.status === "COMPLETED"
              )
            ) {
              throw new Error(`Intent ${intent.id} already has a COMPLETED capture transaction`);
            }

            const rawOrder = newTx.raw_response?.order as
              | { id?: string; status?: string }
              | undefined;
            const hasVerifiedOrderEvidence =
              Boolean(rawOrder) &&
              String(rawOrder?.status ?? "").trim().toUpperCase() === "COMPLETED" &&
              String(rawOrder?.id ?? "").trim() === intent.provider_order_id;

            const webhookId = (ctx.webhookCaptureEventId ?? "").trim();
            const hasVerifiedWebhook =
              webhookId !== "" &&
              webhookEvents.some(
                (w) =>
                  w.provider === "PAYPAL" &&
                  w.provider_event_id === webhookId &&
                  w.signature_verified === true &&
                  (w.payment_intent_id === null || w.payment_intent_id === intent.id)
              );

            if (newTx.status === "COMPLETED") {
              if (!hasVerifiedOrderEvidence && !hasVerifiedWebhook) {
                throw new Error(
                  `Cannot record COMPLETED capture for intent in status ${intent.status} without verified order or webhook evidence`
                );
              }
            } else if (!hasVerifiedWebhook) {
              throw new Error(
                `Cannot record ${newTx.status} capture for intent in status ${intent.status} without a verified webhook event context`
              );
            }
          } else {
            throw new Error(`Cannot record capture for intent in status ${intent.status}`);
          }

          if (
            ["COMPLETED", "PENDING"].includes(newTx.status) &&
            transactions.some(
              (t) =>
                t.payment_intent_id === intent.id &&
                t.transaction_type === "CAPTURE" &&
                ["COMPLETED", "PENDING"].includes(t.status)
            )
          ) {
            throw new Error("duplicate key value violates unique index payment_transactions_one_capture_per_intent_idx");
          }
        }
      }

      function insertTransaction(newTx: Omit<SimTx, "id" | "captured_at">, ctx: SessionContext): SimTx {
        validateTxInsert(newTx, ctx);
        const created: SimTx = {
          ...newTx,
          id: `tx-${transactions.length + 1}`,
          captured_at: "2026-11-11T15:00:00Z",
        };
        transactions.push(created);
        return created;
      }

      function updateTransactionStatus(
        tx: SimTx,
        nextStatus: "COMPLETED" | "FAILED",
        rawResponse: Record<string, unknown>,
        ctx: SessionContext
      ) {
        if (!isPrivilegedServiceRole(ctx)) {
          throw new Error("Unauthorized: Only service_role can update payment transactions");
        }
        if (ctx.ledgerMutationAuthorized !== "true") {
          throw new Error("Financial transaction ledger is strictly append-only; update not authorized");
        }
        if (tx.transaction_type !== "CAPTURE") {
          throw new Error("Only CAPTURE transactions can transition from PENDING to COMPLETED or FAILED");
        }
        if (tx.status !== "PENDING" || !["COMPLETED", "FAILED"].includes(nextStatus)) {
          throw new Error(
            `Invalid status transition on payment transaction: ${tx.status} to ${nextStatus}; only PENDING to COMPLETED or FAILED is permitted`
          );
        }
        if (nextStatus === "FAILED" && ctx.reconciliationActive !== "true") {
          throw new Error(
            "Transitioning PENDING capture transaction to FAILED requires active privileged reconciliation"
          );
        }
        tx.status = nextStatus;
        tx.raw_response = rawResponse;
        if (nextStatus === "COMPLETED") {
          tx.captured_at = "2026-11-11T15:05:00Z";
        }
      }

      function protectIntentTransition(
        nextStatus: SimIntent["status"],
        ctx: SessionContext
      ) {
        const oldStatus = intent.status;
        if (oldStatus === nextStatus) return;

        if (["COMPLETED", "FAILED", "CANCELLED"].includes(oldStatus)) {
          throw new Error(`Terminal payment intent state ${oldStatus} cannot transition to ${nextStatus}`);
        }
        const priv = isPrivilegedServiceRole(ctx);
        const rec = ctx.reconciliationActive === "true";

        if (oldStatus === "RECONCILIATION_REQUIRED") {
          if (!priv || !rec || !["COMPLETED", "FAILED", "CANCELLED", "ORDER_CREATED"].includes(nextStatus)) {
            throw new Error("Payment intent in RECONCILIATION_REQUIRED cannot transition");
          }
        } else if (oldStatus === "ORDER_CREATED") {
          if (["COMPLETED", "FAILED"].includes(nextStatus) && !(priv && rec)) {
            throw new Error(`Invalid transition from ORDER_CREATED to ${nextStatus}`);
          } else if (
            !["COMPLETED", "FAILED", "BUYER_APPROVED", "CAPTURING", "CANCELLED", "RECONCILIATION_REQUIRED"].includes(
              nextStatus
            )
          ) {
            throw new Error(`Invalid transition from ORDER_CREATED to ${nextStatus}`);
          }
        } else if (oldStatus === "BUYER_APPROVED") {
          if (["COMPLETED", "FAILED"].includes(nextStatus) && !(priv && rec)) {
            throw new Error(`Invalid transition from BUYER_APPROVED to ${nextStatus}`);
          } else if (
            !["COMPLETED", "FAILED", "CAPTURING", "CANCELLED", "RECONCILIATION_REQUIRED"].includes(nextStatus)
          ) {
            throw new Error(`Invalid transition from BUYER_APPROVED to ${nextStatus}`);
          }
        }

        if (
          nextStatus === "COMPLETED" &&
          !transactions.some(
            (t) =>
              t.payment_intent_id === intent.id &&
              t.transaction_type === "CAPTURE" &&
              t.status === "COMPLETED"
          )
        ) {
          throw new Error(
            "Payment intent cannot be marked COMPLETED without a verified capture record in payment_transactions"
          );
        }

        intent.status = nextStatus;
      }

      function claimPayPalWebhookEvent(
        params: {
          p_provider_event_id: string;
          p_event_type: string;
          p_resource_type: string | null | undefined;
          p_resource_id?: string | null;
          p_payload_sha256: string;
          p_sanitized_payload: Record<string, unknown>;
          p_signature_verified?: boolean;
          p_allow_reprocess?: boolean;
        },
        ctx: SessionContext
      ) {
        if (!isPrivilegedServiceRole(ctx)) {
          return { success: false, claimed: false, error: "PERMISSION_DENIED" };
        }
        if (params.p_signature_verified !== true) {
          return { success: false, claimed: false, error: "UNVERIFIED_WEBHOOK_EVENT" };
        }

        const rawResource = String(params.p_resource_type ?? "").trim().slice(0, 128);
        const cleanResourceType = rawResource.length > 0 ? rawResource : null;
        const effectiveResourceType = cleanResourceType ?? "UNKNOWN";

        // Enforce 202611030005 column constraint: NOT NULL + char_length(trim(resource_type)) > 0
        if (!effectiveResourceType || effectiveResourceType.trim().length === 0) {
          throw new Error('null value in column "resource_type" violates not-null constraint');
        }

        let row = webhookEvents.find((w) => w.provider_event_id === params.p_provider_event_id);
        if (!row) {
          row = {
            id: `wh-row-${webhookEvents.length + 1}`,
            provider: "PAYPAL",
            provider_event_id: params.p_provider_event_id,
            event_type: params.p_event_type,
            resource_type: effectiveResourceType,
            resource_id: params.p_resource_id ?? null,
            payload_sha256: params.p_payload_sha256,
            signature_verified: true,
            payment_intent_id: null,
            status: "RECEIVED",
            processing_outcome: "VERIFIED",
            attempt_count: 0,
            duplicate_delivery_count: 0,
          };
          webhookEvents.push(row);
        }

        if (row.payload_sha256 !== params.p_payload_sha256) {
          row.duplicate_delivery_count += 1;
          return { success: true, claimed: false, conflict: true, error: "PAYLOAD_HASH_MISMATCH" };
        }

        if (row.status === "PROCESSED" && !params.p_allow_reprocess) {
          row.duplicate_delivery_count += 1;
          return { success: true, claimed: false, duplicate: true };
        }

        row.status = "PROCESSING";
        row.processing_outcome = "PROCESSING";
        row.signature_verified = true;
        if (cleanResourceType !== null && cleanResourceType.toUpperCase() !== "UNKNOWN") {
          row.resource_type = cleanResourceType;
        } else if (row.resource_type.trim().length === 0) {
          row.resource_type = "UNKNOWN";
        }
        row.attempt_count += 1;

        return {
          success: true,
          claimed: true,
          event_row_id: row.id,
          attempt_count: row.attempt_count,
          resource_type: row.resource_type,
        };
      }

      function recordPayPalOrderCaptured(
        params: {
          p_session_token_hash: string;
          p_payment_intent_id: string;
          p_lease_token: string;
          p_provider_capture_id: string;
          p_capture_status: string;
          p_amount_cents: number;
          p_payee_merchant_id: string;
          p_raw_capture_response: Record<string, unknown>;
        },
        ctx: SessionContext
      ) {
        if (!isPrivilegedServiceRole(ctx)) {
          return { success: false, error: "PERMISSION_DENIED" };
        }
        if (params.p_payment_intent_id !== intent.id) {
          return { success: false, error: "INTENT_NOT_FOUND" };
        }
        const sess = sessions.find((s) => s.session_token_hash === params.p_session_token_hash);
        if (!sess || sess.revoked_at) {
          return { success: false, error: "UNAUTHORIZED_SESSION" };
        }
        if (intent.status !== "CAPTURING") {
          return { success: false, error: "INVALID_TRANSITION", status: intent.status };
        }
        if (intent.capture_lease_token !== params.p_lease_token) {
          return { success: false, error: "STALE_LEASE_TOKEN" };
        }

        const mode = String(intent.canonical_payload_json.payment_mode ?? "").trim().toUpperCase();
        if (mode === "PLATFORM") {
          if (
            String(intent.canonical_payload_json.seller_merchant_id ?? "").trim() !==
            intent.expected_merchant_id
          ) {
            return { success: false, error: "SELLER_METADATA_MISMATCH" };
          }
          const payerId = String(intent.canonical_payload_json.seller_payer_id ?? "").trim();
          if (payerId.length < 3 || payerId.length > 64) {
            return { success: false, error: "SELLER_PAYER_ID_MISSING" };
          }
        }

        if (params.p_payee_merchant_id.trim() !== intent.expected_merchant_id) {
          return { success: false, error: "MERCHANT_MISMATCH" };
        }
        if (params.p_amount_cents !== intent.expected_amount_cents) {
          return { success: false, error: "AMOUNT_MISMATCH" };
        }

        insertTransaction(
          {
            payment_intent_id: intent.id,
            parent_transaction_id: null,
            transaction_type: "CAPTURE",
            provider: "PAYPAL",
            provider_reference_id: params.p_provider_capture_id.trim(),
            status: "COMPLETED",
            amount_cents: intent.expected_amount_cents,
            currency: "USD",
            payee_merchant_id: intent.expected_merchant_id,
            raw_response: params.p_raw_capture_response,
          },
          ctx
        );
        protectIntentTransition("COMPLETED", ctx);

        return {
          success: true,
          already_recorded: false,
          payment_intent_id: intent.id,
          status: "COMPLETED",
          capture_id: params.p_provider_capture_id,
        };
      }

      function reconcileAndCompletePaymentIntent(
        params: {
          p_intent_id: string;
          p_provider_capture_id: string;
          p_raw_capture_response: Record<string, unknown>;
          p_raw_order_response: {
            id: string;
            status: string;
            purchase_units: Array<{
              reference_id: string;
              custom_id?: string;
              payee: { merchant_id: string };
              payments: {
                captures: Array<{
                  id: string;
                  status: string;
                  amount: { currency_code: string; value: string };
                  custom_id?: string;
                  payee?: { merchant_id?: string };
                }>;
              };
            }>;
          };
          p_lease_token?: string | null;
        },
        ctx: SessionContext
      ) {
        if (!isPrivilegedServiceRole(ctx)) {
          throw new Error(
            "Unauthorized: Only service_role can invoke reconcile_and_complete_payment_intent"
          );
        }

        const localCtx: SessionContext = { ...ctx, reconciliationActive: "true" };

        if (params.p_intent_id !== intent.id) {
          throw new Error(`Payment intent ${params.p_intent_id} not found`);
        }

        const mode = String(intent.canonical_payload_json.payment_mode ?? "").trim().toUpperCase();
        if (mode === "PLATFORM") {
          if (
            String(intent.canonical_payload_json.seller_merchant_id ?? "").trim() !==
            intent.expected_merchant_id
          ) {
            throw new Error("Canonical seller_merchant_id does not match expected_merchant_id");
          }
          const payerId = String(intent.canonical_payload_json.seller_payer_id ?? "").trim();
          if (payerId.length < 3 || payerId.length > 64) {
            throw new Error("Platform intent missing valid canonical seller_payer_id");
          }
        }

        if (
          intent.status === "CAPTURING" &&
          intent.capture_lease_expires_at !== null &&
          intent.capture_lease_expires_at > Date.now() &&
          params.p_lease_token !== intent.capture_lease_token
        ) {
          throw new Error("Cannot reconcile CAPTURING intent while an active worker lease is held");
        }

        if (
          !["ORDER_CREATED", "BUYER_APPROVED", "CAPTURING", "RECONCILING", "RECONCILIATION_REQUIRED"].includes(
            intent.status
          )
        ) {
          throw new Error(`Intent ${intent.id} in status ${intent.status} cannot be reconciled to COMPLETED`);
        }

        if (params.p_raw_order_response.status !== "COMPLETED") {
          throw new Error("Provider order status is not COMPLETED");
        }

        const pu = params.p_raw_order_response.purchase_units[0];
        const cap = pu.payments.captures.find((c) => c.id === params.p_provider_capture_id);
        if (!cap || cap.status !== "COMPLETED") {
          throw new Error("Expected capture not COMPLETED");
        }

        const parsedCents = Math.round(Number(cap.amount.value) * 100);
        if (parsedCents !== intent.expected_amount_cents) {
          throw new Error("Capture amount cents does not match expected");
        }

        const existing = transactions.find(
          (t) =>
            t.payment_intent_id === intent.id &&
            t.transaction_type === "CAPTURE" &&
            t.provider_reference_id === params.p_provider_capture_id
        );

        const rawBundle = {
          capture: params.p_raw_capture_response,
          order: params.p_raw_order_response,
        };

        if (existing) {
          if (existing.status === "PENDING") {
            updateTransactionStatus(existing, "COMPLETED", rawBundle, {
              ...localCtx,
              ledgerMutationAuthorized: "true",
            });
          } else if (existing.status !== "COMPLETED") {
            throw new Error("Existing transaction has unsupported status");
          }
        } else {
          insertTransaction(
            {
              payment_intent_id: intent.id,
              parent_transaction_id: null,
              transaction_type: "CAPTURE",
              provider: "PAYPAL",
              provider_reference_id: params.p_provider_capture_id,
              status: "COMPLETED",
              amount_cents: parsedCents,
              currency: "USD",
              payee_merchant_id: intent.expected_merchant_id,
              raw_response: rawBundle,
            },
            localCtx
          );
        }

        protectIntentTransition("COMPLETED", localCtx);
        intent.reconciliation_reason = null;
        return true;
      }

      function recordPayPalWebhookCaptureState(
        params: {
          p_payment_intent_id: string;
          p_provider_order_id: string;
          p_provider_capture_id: string;
          p_capture_status: string;
          p_payee_merchant_id: string;
          p_amount_cents: number;
          p_currency: string;
          p_sanitized_raw_capture: Record<string, unknown>;
          p_provider_event_id: string;
        },
        ctx: SessionContext
      ) {
        if (!isPrivilegedServiceRole(ctx)) {
          return { success: false, error: "PERMISSION_DENIED" };
        }

        const cleanStatus = params.p_capture_status.trim().toUpperCase();
        const cleanEventId = params.p_provider_event_id.trim();
        const webhookRow = webhookEvents.find(
          (w) => w.provider === "PAYPAL" && w.provider_event_id === cleanEventId
        );
        if (!webhookRow || webhookRow.signature_verified !== true) {
          return { success: false, error: "UNVERIFIED_WEBHOOK_EVENT" };
        }
        if (webhookRow.payment_intent_id && webhookRow.payment_intent_id !== params.p_payment_intent_id) {
          return { success: false, error: "WEBHOOK_INTENT_MISMATCH" };
        }
        if (params.p_payment_intent_id !== intent.id) {
          return { success: false, error: "INTENT_NOT_FOUND" };
        }
        if (
          intent.provider_order_id &&
          params.p_provider_order_id.trim() !== "" &&
          intent.provider_order_id !== params.p_provider_order_id.trim()
        ) {
          return { success: false, error: "ORDER_ID_MISMATCH" };
        }
        if (
          ["ORDER_CREATED", "BUYER_APPROVED"].includes(intent.status) &&
          (!intent.provider_order_id || intent.provider_order_id.trim() === "")
        ) {
          return { success: false, error: "ORDER_ID_MISSING" };
        }
        if (params.p_amount_cents !== intent.expected_amount_cents) {
          return { success: false, error: "AMOUNT_MISMATCH" };
        }
        if (params.p_currency.trim().toUpperCase() !== intent.expected_currency) {
          return { success: false, error: "CURRENCY_MISMATCH" };
        }
        if (params.p_payee_merchant_id.trim() !== intent.expected_merchant_id) {
          return { success: false, error: "MERCHANT_MISMATCH" };
        }

        const mode = String(intent.canonical_payload_json.payment_mode ?? "").trim().toUpperCase();
        if (mode === "PLATFORM") {
          if (
            String(intent.canonical_payload_json.seller_merchant_id ?? "").trim() !==
            intent.expected_merchant_id
          ) {
            return { success: false, error: "SELLER_METADATA_MISMATCH" };
          }
          const payerId = String(intent.canonical_payload_json.seller_payer_id ?? "").trim();
          if (payerId.length < 3 || payerId.length > 64) {
            return { success: false, error: "SELLER_PAYER_ID_MISSING" };
          }
        }

        if (
          intent.status === "CAPTURING" &&
          intent.capture_lease_expires_at !== null &&
          intent.capture_lease_expires_at > Date.now()
        ) {
          return { success: false, error: "LEASE_ACTIVE", current_status: intent.status };
        }

        const completedTx = transactions.find(
          (t) =>
            t.payment_intent_id === intent.id &&
            t.transaction_type === "CAPTURE" &&
            t.status === "COMPLETED"
        );
        if (intent.status === "COMPLETED" || completedTx) {
          return {
            success: true,
            transitioned: false,
            stale_event: true,
            current_status: intent.status,
            payment_transaction_id: completedTx?.id ?? null,
          };
        }

        const existingTx = transactions.find(
          (t) =>
            t.payment_intent_id === intent.id &&
            t.transaction_type === "CAPTURE" &&
            t.provider_reference_id === params.p_provider_capture_id.trim()
        );

        const localCtx: SessionContext = {
          ...ctx,
          reconciliationActive: "true",
          webhookCaptureEventId: cleanEventId,
        };

        if (cleanStatus === "PENDING") {
          if (["FAILED", "CANCELLED"].includes(intent.status)) {
            return { success: false, error: "TERMINAL_INTENT_CONFLICT", current_status: intent.status };
          }
          if (existingTx?.status === "FAILED") {
            return { success: false, error: "INVALID_EXISTING_TX_STATUS" };
          }
          if (
            !existingTx &&
            transactions.some(
              (t) =>
                t.payment_intent_id === intent.id &&
                t.transaction_type === "CAPTURE" &&
                t.status === "PENDING"
            )
          ) {
            return { success: false, error: "CAPTURE_ID_CONFLICT" };
          }

          protectIntentTransition("RECONCILIATION_REQUIRED", localCtx);
          intent.reconciliation_reason = "PAYPAL_CAPTURE_PENDING";

          let txId = existingTx?.id;
          if (!existingTx) {
            txId = insertTransaction(
              {
                payment_intent_id: intent.id,
                parent_transaction_id: null,
                transaction_type: "CAPTURE",
                provider: "PAYPAL",
                provider_reference_id: params.p_provider_capture_id.trim(),
                status: "PENDING",
                amount_cents: intent.expected_amount_cents,
                currency: "USD",
                payee_merchant_id: intent.expected_merchant_id,
                raw_response: params.p_sanitized_raw_capture,
              },
              localCtx
            ).id;
          }

          activityEvents.push({
            event_type: "payment.webhook_capture_pending",
            metadata: { providerCaptureId: params.p_provider_capture_id },
          });

          return {
            success: true,
            transitioned: true,
            current_status: "RECONCILIATION_REQUIRED",
            payment_transaction_id: txId,
          };
        }

        // DENIED / DECLINED / FAILED path
        if (intent.status === "CANCELLED") {
          return { success: false, error: "TERMINAL_INTENT_CONFLICT", current_status: intent.status };
        }
        if (intent.status === "FAILED") {
          if (existingTx?.status === "FAILED") {
            return {
              success: true,
              transitioned: false,
              stale_event: true,
              current_status: "FAILED",
              payment_transaction_id: existingTx.id,
            };
          }
          return { success: false, error: "TERMINAL_INTENT_CONFLICT", current_status: intent.status };
        }

        let txId: string;
        if (existingTx) {
          txId = existingTx.id;
          if (existingTx.status === "PENDING") {
            updateTransactionStatus(existingTx, "FAILED", params.p_sanitized_raw_capture, {
              ...localCtx,
              ledgerMutationAuthorized: "true",
            });
          }
        } else {
          txId = insertTransaction(
            {
              payment_intent_id: intent.id,
              parent_transaction_id: null,
              transaction_type: "CAPTURE",
              provider: "PAYPAL",
              provider_reference_id: params.p_provider_capture_id.trim(),
              status: "FAILED",
              amount_cents: intent.expected_amount_cents,
              currency: "USD",
              payee_merchant_id: intent.expected_merchant_id,
              raw_response: params.p_sanitized_raw_capture,
            },
            localCtx
          ).id;
        }

        protectIntentTransition("FAILED", localCtx);
        intent.reconciliation_reason = `PAYPAL_CAPTURE_${cleanStatus}`;

        activityEvents.push({
          event_type: "payment.webhook_capture_denied",
          metadata: { providerCaptureId: params.p_provider_capture_id },
        });

        return {
          success: true,
          transitioned: true,
          current_status: "FAILED",
          payment_transaction_id: txId,
        };
      }

      return {
        intent,
        milestone,
        transactions,
        webhookEvents,
        activityEvents,
        insertTransaction,
        updateTransactionStatus,
        claimPayPalWebhookEvent,
        recordPayPalOrderCaptured,
        reconcileAndCompletePaymentIntent,
        recordPayPalWebhookCaptureState,
      };
    }

    it("authorizes PostgREST authenticator with service_role JWT claims (claim.role & JSON fallback) and rejects unauthorized callers", () => {
      const postgrestClaimCtx: SessionContext = {
        sessionUser: "authenticator",
        claimRole: "service_role",
      };
      const postgrestJsonCtx: SessionContext = {
        sessionUser: "authenticator",
        claimRole: "",
        jwtClaimsJson: '  {"sub":"svc","role":"service_role"}  ',
      };
      const anonCtx: SessionContext = {
        sessionUser: "authenticator",
        claimRole: "authenticated",
        jwtClaimsJson: '{"role":"authenticated"}',
      };
      const malformedJsonCtx: SessionContext = {
        sessionUser: "authenticator",
        claimRole: "",
        jwtClaimsJson: "not-json",
      };

      const db1 = createAlignedDbHarness({
        intent: { status: "CAPTURING", capture_lease_token: LEASE_TOKEN },
      });

      // Rejected for anon / malformed claims
      expect(
        db1.recordPayPalOrderCaptured(
          {
            p_session_token_hash: SESSION_HASH,
            p_payment_intent_id: INTENT_ID,
            p_lease_token: LEASE_TOKEN,
            p_provider_capture_id: CAPTURE_ID,
            p_capture_status: "COMPLETED",
            p_amount_cents: 10000,
            p_payee_merchant_id: SELLER_MERCHANT_ID,
            p_raw_capture_response: { id: ORDER_ID },
          },
          anonCtx
        )
      ).toEqual({ success: false, error: "PERMISSION_DENIED" });

      expect(() =>
        db1.reconcileAndCompletePaymentIntent(
          {
            p_intent_id: INTENT_ID,
            p_provider_capture_id: CAPTURE_ID,
            p_raw_capture_response: { id: CAPTURE_ID, status: "COMPLETED" },
            p_raw_order_response: {
              id: ORDER_ID,
              status: "COMPLETED",
              purchase_units: [
                {
                  reference_id: MILESTONE_ID,
                  payee: { merchant_id: SELLER_MERCHANT_ID },
                  payments: {
                    captures: [
                      {
                        id: CAPTURE_ID,
                        status: "COMPLETED",
                        amount: { currency_code: "USD", value: "100.00" },
                      },
                    ],
                  },
                },
              ],
            },
            p_lease_token: LEASE_TOKEN,
          },
          malformedJsonCtx
        )
      ).toThrow(/Unauthorized/i);

      // Accepted under PostgREST request.jwt.claim.role = 'service_role'
      const capRes = db1.recordPayPalOrderCaptured(
        {
          p_session_token_hash: SESSION_HASH,
          p_payment_intent_id: INTENT_ID,
          p_lease_token: LEASE_TOKEN,
          p_provider_capture_id: CAPTURE_ID,
          p_capture_status: "COMPLETED",
          p_amount_cents: 10000,
          p_payee_merchant_id: SELLER_MERCHANT_ID,
          p_raw_capture_response: { id: ORDER_ID },
        },
        postgrestClaimCtx
      );
      expect(capRes.success).toBe(true);
      expect(db1.intent.status).toBe("COMPLETED");
      expect(db1.milestone.status).toBe("SUBMITTED");

      // Accepted under PostgREST JSON fallback request.jwt.claims
      const db2 = createAlignedDbHarness({
        intent: { status: "RECONCILIATION_REQUIRED" },
      });
      const recRes = db2.reconcileAndCompletePaymentIntent(
        {
          p_intent_id: INTENT_ID,
          p_provider_capture_id: CAPTURE_ID,
          p_raw_capture_response: { id: CAPTURE_ID, status: "COMPLETED" },
          p_raw_order_response: {
            id: ORDER_ID,
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: MILESTONE_ID,
                payee: { merchant_id: SELLER_MERCHANT_ID },
                payments: {
                  captures: [
                    {
                      id: CAPTURE_ID,
                      status: "COMPLETED",
                      amount: { currency_code: "USD", value: "100.00" },
                    },
                  ],
                },
              },
            ],
          },
        },
        postgrestJsonCtx
      );
      expect(recRes).toBe(true);
      expect(db2.intent.status).toBe("COMPLETED");
      expect(db2.milestone.status).toBe("SUBMITTED");
    });

    it("handles PENDING webhook arriving during ORDER_CREATED and BUYER_APPROVED, then delayed COMPLETED or DENIED settlement", () => {
      const ctx: SessionContext = { sessionUser: "authenticator", claimRole: "service_role" };

      // Flow A: ORDER_CREATED -> PENDING webhook -> COMPLETED webhook settlement
      const dbA = createAlignedDbHarness({ intent: { status: "ORDER_CREATED" } });
      dbA.claimPayPalWebhookEvent(
        {
          p_provider_event_id: `${EVENT_ID}-PEND`,
          p_event_type: "PAYMENT.CAPTURE.PENDING",
          p_resource_type: "capture",
          p_payload_sha256: "b".repeat(64),
          p_sanitized_payload: { id: `${EVENT_ID}-PEND` },
          p_signature_verified: true,
        },
        ctx
      );

      const pendingResA = dbA.recordPayPalWebhookCaptureState(
        {
          p_payment_intent_id: INTENT_ID,
          p_provider_order_id: ORDER_ID,
          p_provider_capture_id: CAPTURE_ID,
          p_capture_status: "PENDING",
          p_payee_merchant_id: SELLER_MERCHANT_ID,
          p_amount_cents: 10000,
          p_currency: "USD",
          p_sanitized_raw_capture: { id: CAPTURE_ID, status: "PENDING" },
          p_provider_event_id: `${EVENT_ID}-PEND`,
        },
        ctx
      );

      expect(pendingResA.success).toBe(true);
      expect(dbA.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(dbA.transactions).toHaveLength(1);
      expect(dbA.transactions[0]?.status).toBe("PENDING");
      expect(dbA.milestone.status).toBe("SUBMITTED");

      // Delayed PAYMENT.CAPTURE.COMPLETED upgrades PENDING -> COMPLETED
      expect(
        dbA.reconcileAndCompletePaymentIntent(
          {
            p_intent_id: INTENT_ID,
            p_provider_capture_id: CAPTURE_ID,
            p_raw_capture_response: { id: CAPTURE_ID, status: "COMPLETED" },
            p_raw_order_response: {
              id: ORDER_ID,
              status: "COMPLETED",
              purchase_units: [
                {
                  reference_id: MILESTONE_ID,
                  payee: { merchant_id: SELLER_MERCHANT_ID },
                  payments: {
                    captures: [
                      {
                        id: CAPTURE_ID,
                        status: "COMPLETED",
                        amount: { currency_code: "USD", value: "100.00" },
                      },
                    ],
                  },
                },
              ],
            },
          },
          ctx
        )
      ).toBe(true);
      expect(dbA.intent.status).toBe("COMPLETED");
      expect(dbA.transactions[0]?.status).toBe("COMPLETED");
      expect(dbA.milestone.status).toBe("SUBMITTED");

      // Flow B: BUYER_APPROVED -> PENDING webhook -> delayed DENIED webhook (PENDING -> FAILED)
      const dbB = createAlignedDbHarness({ intent: { status: "BUYER_APPROVED" } });
      dbB.claimPayPalWebhookEvent(
        {
          p_provider_event_id: `${EVENT_ID}-B1`,
          p_event_type: "PAYMENT.CAPTURE.PENDING",
          p_resource_type: "capture",
          p_payload_sha256: "c".repeat(64),
          p_sanitized_payload: { id: `${EVENT_ID}-B1` },
          p_signature_verified: true,
        },
        ctx
      );
      expect(
        dbB.recordPayPalWebhookCaptureState(
          {
            p_payment_intent_id: INTENT_ID,
            p_provider_order_id: ORDER_ID,
            p_provider_capture_id: CAPTURE_ID,
            p_capture_status: "PENDING",
            p_payee_merchant_id: SELLER_MERCHANT_ID,
            p_amount_cents: 10000,
            p_currency: "USD",
            p_sanitized_raw_capture: { id: CAPTURE_ID, status: "PENDING" },
            p_provider_event_id: `${EVENT_ID}-B1`,
          },
          ctx
        ).success
      ).toBe(true);

      dbB.claimPayPalWebhookEvent(
        {
          p_provider_event_id: `${EVENT_ID}-B2`,
          p_event_type: "PAYMENT.CAPTURE.DENIED",
          p_resource_type: "capture",
          p_payload_sha256: "d".repeat(64),
          p_sanitized_payload: { id: `${EVENT_ID}-B2` },
          p_signature_verified: true,
        },
        ctx
      );
      const deniedAfterPending = dbB.recordPayPalWebhookCaptureState(
        {
          p_payment_intent_id: INTENT_ID,
          p_provider_order_id: ORDER_ID,
          p_provider_capture_id: CAPTURE_ID,
          p_capture_status: "DENIED",
          p_payee_merchant_id: SELLER_MERCHANT_ID,
          p_amount_cents: 10000,
          p_currency: "USD",
          p_sanitized_raw_capture: { id: CAPTURE_ID, status: "DECLINED" },
          p_provider_event_id: `${EVENT_ID}-B2`,
        },
        ctx
      );

      expect(deniedAfterPending.success).toBe(true);
      expect(dbB.intent.status).toBe("FAILED");
      expect(dbB.transactions).toHaveLength(1);
      expect(dbB.transactions[0]?.status).toBe("FAILED");
      expect(dbB.milestone.status).toBe("SUBMITTED");
    });

    it("handles FAILED/DENIED arriving directly on ORDER_CREATED & BUYER_APPROVED and enforces unverified/terminal/direct-insert guards", () => {
      const ctx: SessionContext = { sessionUser: "authenticator", claimRole: "service_role" };
      const db = createAlignedDbHarness({ intent: { status: "ORDER_CREATED" } });

      // Unverified webhook event is rejected
      expect(
        db.recordPayPalWebhookCaptureState(
          {
            p_payment_intent_id: INTENT_ID,
            p_provider_order_id: ORDER_ID,
            p_provider_capture_id: CAPTURE_ID,
            p_capture_status: "DENIED",
            p_payee_merchant_id: SELLER_MERCHANT_ID,
            p_amount_cents: 10000,
            p_currency: "USD",
            p_sanitized_raw_capture: { id: CAPTURE_ID, status: "DECLINED" },
            p_provider_event_id: "WH-NOT-CLAIMED",
          },
          ctx
        )
      ).toEqual({ success: false, error: "UNVERIFIED_WEBHOOK_EVENT" });

      // Arbitrary direct capture insert on ORDER_CREATED without verified webhook context still fails closed
      expect(() =>
        db.insertTransaction(
          {
            payment_intent_id: INTENT_ID,
            parent_transaction_id: null,
            transaction_type: "CAPTURE",
            provider: "PAYPAL",
            provider_reference_id: "CAP-ROGUE",
            status: "FAILED",
            amount_cents: 10000,
            currency: "USD",
            payee_merchant_id: SELLER_MERCHANT_ID,
            raw_response: {},
          },
          { ...ctx, reconciliationActive: "true" }
        )
      ).toThrow(/without a verified webhook event context/i);

      // Verified DENIED webhook succeeds cleanly on ORDER_CREATED
      db.claimPayPalWebhookEvent(
        {
          p_provider_event_id: EVENT_ID,
          p_event_type: "PAYMENT.CAPTURE.DENIED",
          p_resource_type: "capture",
          p_payload_sha256: "e".repeat(64),
          p_sanitized_payload: { id: EVENT_ID },
          p_signature_verified: true,
        },
        ctx
      );

      const deniedRes = db.recordPayPalWebhookCaptureState(
        {
          p_payment_intent_id: INTENT_ID,
          p_provider_order_id: ORDER_ID,
          p_provider_capture_id: CAPTURE_ID,
          p_capture_status: "DENIED",
          p_payee_merchant_id: SELLER_MERCHANT_ID,
          p_amount_cents: 10000,
          p_currency: "USD",
          p_sanitized_raw_capture: { id: CAPTURE_ID, status: "DECLINED" },
          p_provider_event_id: EVENT_ID,
        },
        ctx
      );

      expect(deniedRes.success).toBe(true);
      expect(db.intent.status).toBe("FAILED");
      expect(db.transactions[0]?.status).toBe("FAILED");

      // Replaying the same DENIED capture ID is idempotently stale
      const replayRes = db.recordPayPalWebhookCaptureState(
        {
          p_payment_intent_id: INTENT_ID,
          p_provider_order_id: ORDER_ID,
          p_provider_capture_id: CAPTURE_ID,
          p_capture_status: "DENIED",
          p_payee_merchant_id: SELLER_MERCHANT_ID,
          p_amount_cents: 10000,
          p_currency: "USD",
          p_sanitized_raw_capture: { id: CAPTURE_ID, status: "DECLINED" },
          p_provider_event_id: EVENT_ID,
        },
        ctx
      );
      expect(replayRes).toMatchObject({ success: true, stale_event: true, transitioned: false });

      // A different capture ID on already-FAILED intent is rejected as terminal conflict
      expect(
        db.recordPayPalWebhookCaptureState(
          {
            p_payment_intent_id: INTENT_ID,
            p_provider_order_id: ORDER_ID,
            p_provider_capture_id: "CAP-OTHER-999",
            p_capture_status: "FAILED",
            p_payee_merchant_id: SELLER_MERCHANT_ID,
            p_amount_cents: 10000,
            p_currency: "USD",
            p_sanitized_raw_capture: { id: "CAP-OTHER-999", status: "FAILED" },
            p_provider_event_id: EVENT_ID,
          },
          ctx
        )
      ).toEqual({ success: false, error: "TERMINAL_INTENT_CONFLICT", current_status: "FAILED" });
    });

    it("normalizes missing/empty resource_type to 'UNKNOWN' without overwriting genuine PayPal types, and succeeds in webhook-processor", async () => {
      const ctx: SessionContext = { sessionUser: "authenticator", claimRole: "service_role" };
      const db = createAlignedDbHarness();

      // 1. Null / whitespace resource_type normalizes to 'UNKNOWN'
      const missingRes = db.claimPayPalWebhookEvent(
        {
          p_provider_event_id: "WH-NO-RESTYPE",
          p_event_type: "MERCHANT.ONBOARDING.COMPLETED",
          p_resource_type: "   ",
          p_payload_sha256: "1".repeat(64),
          p_sanitized_payload: { id: "WH-NO-RESTYPE" },
          p_signature_verified: true,
        },
        ctx
      );
      expect(missingRes.claimed).toBe(true);
      expect(missingRes.resource_type).toBe("UNKNOWN");

      // 2. Populated PayPal resource_type stays verbatim and recovery with null preserves it
      const popRes = db.claimPayPalWebhookEvent(
        {
          p_provider_event_id: "WH-WITH-RESTYPE",
          p_event_type: "PAYMENT.CAPTURE.COMPLETED",
          p_resource_type: "capture",
          p_payload_sha256: "2".repeat(64),
          p_sanitized_payload: { id: "WH-WITH-RESTYPE" },
          p_signature_verified: true,
        },
        ctx
      );
      expect(popRes.resource_type).toBe("capture");

      const retryMissingType = db.claimPayPalWebhookEvent(
        {
          p_provider_event_id: "WH-WITH-RESTYPE",
          p_event_type: "PAYMENT.CAPTURE.COMPLETED",
          p_resource_type: null,
          p_payload_sha256: "2".repeat(64),
          p_sanitized_payload: { id: "WH-WITH-RESTYPE" },
          p_signature_verified: true,
          p_allow_reprocess: true,
        },
        ctx
      );
      expect(retryMissingType.resource_type).toBe("capture");

      // 3. End-to-end handleIncomingPayPalWebhook call when envelope omits resource_type
      const claimCalls: Array<Record<string, unknown>> = [];
      const mockServiceClient = {
        rpc: vi.fn(async (fnName: string, args: Record<string, unknown>) => {
          if (fnName === "claim_paypal_webhook_event") {
            claimCalls.push(args);
            const simulated = db.claimPayPalWebhookEvent(
              {
                p_provider_event_id: String(args.p_provider_event_id),
                p_event_type: String(args.p_event_type),
                p_resource_type: (args.p_resource_type as string | null) ?? null,
                p_payload_sha256: String(args.p_payload_sha256),
                p_sanitized_payload: args.p_sanitized_payload as Record<string, unknown>,
                p_signature_verified: Boolean(args.p_signature_verified),
              },
              ctx
            );
            return { data: simulated, error: null };
          }
          if (fnName === "finalize_paypal_webhook_event") {
            return { data: { success: true }, error: null };
          }
          return { data: null, error: null };
        }),
      } as unknown as Parameters<typeof handleIncomingPayPalWebhook>[0]["injectedServiceClient"];

      const mockPayPal = {
        post: vi.fn().mockResolvedValue({
          data: { verification_status: "SUCCESS" },
          status: 200,
        }),
        get: vi.fn(),
      } as unknown as Parameters<typeof handleIncomingPayPalWebhook>[0]["injectedPayPalClient"];

      const env: PayPalConfig = {
        environment: "sandbox",
        clientId: "merchant-client-id",
        clientSecret: "merchant-client-secret",
        platformClientId: "platform-client-id",
        platformClientSecret: "platform-client-secret",
        partnerMerchantId: "PARTNER-1",
        expectedMerchantId: "PARTNER-1",
        partnerAttributionId: "PAYROOST_BN",
        webhookId: "WH-ALIGN-TEST-001",
        paymentMode: "PLATFORM",
        baseUrl: "https://api-m.sandbox.paypal.com",
      };

      const res = await handleIncomingPayPalWebhook({
        headers: new Headers({
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": "trans-1",
          "paypal-transmission-sig": "base64-sig-abc123==",
          "paypal-transmission-time": "2026-11-11T15:00:00Z",
        }),
        rawBody: JSON.stringify({
          id: "WH-UNSUPPORTED-OMIT-RT",
          event_type: "VAULT.PAYMENT-TOKEN.CREATED",
          create_time: "2026-11-11T15:00:00Z",
          resource: { id: "tok-1" },
        }),
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPal,
        injectedPayPalEnv: env,
      });

      expect(res.httpStatus).toBe(200);
      expect(claimCalls).toHaveLength(1);
      expect(claimCalls[0]?.p_resource_type).toBeNull();
      expect(
        db.webhookEvents.find((w) => w.provider_event_id === "WH-UNSUPPORTED-OMIT-RT")?.resource_type
      ).toBe("UNKNOWN");
    });

    it("models idempotent profiles backfill preserving existing rows without copying sensitive auth columns", () => {
      const authUsers = [
        {
          id: "user-1",
          email: "preexisting@example.com",
          encrypted_password: "secret",
          raw_user_meta_data: { display_name: "Preexisting Freelancer" },
        },
        {
          id: "user-2",
          email: "existing-profile@example.com",
          encrypted_password: "secret",
          raw_user_meta_data: { display_name: "Should Not Overwrite" },
        },
      ];
      const profiles = new Map<string, { id: string; display_name: string }>([
        ["user-2", { id: "user-2", display_name: "Custom Saved Name" }],
      ]);

      const runBackfill = () => {
        for (const u of authUsers) {
          if (!profiles.has(u.id)) {
            profiles.set(u.id, {
              id: u.id,
              display_name: u.raw_user_meta_data.display_name ?? "",
            });
          }
        }
      };

      runBackfill();
      expect(profiles.get("user-1")).toEqual({
        id: "user-1",
        display_name: "Preexisting Freelancer",
      });
      expect(profiles.get("user-2")).toEqual({
        id: "user-2",
        display_name: "Custom Saved Name",
      });

      // Second run is strictly idempotent
      runBackfill();
      expect(profiles.size).toBe(2);
    });
  });
});
