import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  reconcilePaymentIntentServerSide,
} from "@/lib/paypal/reconciliation-service";
import { PayPalClient } from "@/lib/paypal/client";
import { createServiceClient } from "@/lib/supabase/service";
import type { PayPalConfig } from "@/lib/paypal/types";

describe("PayRoost Phase 3B.4.2.3: PostgREST Authorization & Capture Recovery Remediation", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611090002_postgrest_auth_and_capture_recovery.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC SQL DDL & POSTGREST ROLE ASSERTION AUDIT (F-01)
  // ==========================================================================
  describe("1. Static SQL Audit: PostgREST-Compatible Authorization Pattern (F-01)", () => {
    const postgrestAuthPattern =
      /session_user\s+in\s+\('postgres',\s*'supabase_admin',\s*'service_role'\)\s*or\s*\(\s*session_user\s*=\s*'authenticator'\s+and\s+coalesce\(current_setting\('request\.jwt\.claim\.role',\s*true\),\s*''\)\s*=\s*'service_role'\s*\)/i;

    it("enforces PostgREST dual-layer role check in prevent_payment_transactions_mutation", () => {
      const funcIdx = migrationSql.indexOf("create or replace function public.prevent_payment_transactions_mutation()");
      expect(funcIdx).toBeGreaterThan(0);
      const nextFuncIdx = migrationSql.indexOf("create or replace function public.protect_payment_intent_immutability()", funcIdx);
      const snippet = migrationSql.slice(funcIdx, nextFuncIdx);

      expect(snippet).toMatch(postgrestAuthPattern);
      expect(snippet).toMatch(/Unauthorized:\s*Only service_role can update payment transactions/i);
    });

    it("enforces PostgREST dual-layer role check in protect_payment_intent_immutability for reconciliation", () => {
      const funcIdx = migrationSql.indexOf("create or replace function public.protect_payment_intent_immutability()");
      expect(funcIdx).toBeGreaterThan(0);
      const nextFuncIdx = migrationSql.indexOf("create or replace function public.admin_recover_and_bind_paypal_order(", funcIdx);
      const snippet = migrationSql.slice(funcIdx, nextFuncIdx);

      expect(snippet).toMatch(postgrestAuthPattern);
      expect(snippet).toMatch(/Unauthorized:\s*Only service_role can perform reconciliation transitions/i);
    });

    it("enforces PostgREST dual-layer role check in protect_payment_intent_immutability for CAPTURING -> CANCELLED", () => {
      const funcIdx = migrationSql.indexOf("create or replace function public.protect_payment_intent_immutability()");
      expect(funcIdx).toBeGreaterThan(0);
      const nextFuncIdx = migrationSql.indexOf("create or replace function public.admin_recover_and_bind_paypal_order(", funcIdx);
      const snippet = migrationSql.slice(funcIdx, nextFuncIdx);

      expect(snippet).toMatch(/Unauthorized:\s*Only service_role can perform CAPTURING to CANCELLED reconciliation/i);
    });

    it("enforces PostgREST dual-layer role check in admin_recover_and_bind_paypal_order", () => {
      const funcIdx = migrationSql.indexOf("create or replace function public.admin_recover_and_bind_paypal_order(");
      expect(funcIdx).toBeGreaterThan(0);
      const nextFuncIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(", funcIdx);
      const snippet = migrationSql.slice(funcIdx, nextFuncIdx);

      expect(snippet).toMatch(postgrestAuthPattern);
      expect(snippet).toMatch(/PERMISSION_DENIED/);
    });

    it("enforces PostgREST dual-layer role check in admin_resolve_reconciliation_without_payment", () => {
      const funcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      expect(funcIdx).toBeGreaterThan(0);
      const snippet = migrationSql.slice(funcIdx);

      expect(snippet).toMatch(postgrestAuthPattern);
      expect(snippet).toMatch(/PERMISSION_DENIED/);
    });

    it("does NOT rely on current_user = 'postgres' inside SECURITY DEFINER functions for authorization", () => {
      const sqlWithoutComments = migrationSql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(sqlWithoutComments).not.toMatch(/current_user/i);
    });

    it("sets empty search_path on all functions to defeat search_path hijacking", () => {
      const functions = [
        "prevent_payment_transactions_mutation()",
        "protect_payment_intent_immutability()",
        "admin_recover_and_bind_paypal_order(",
        "admin_resolve_reconciliation_without_payment(",
      ];

      for (const fn of functions) {
        const idx = migrationSql.indexOf(fn);
        expect(idx).toBeGreaterThan(0);
        const endOfSignature = migrationSql.indexOf("as $$", idx);
        expect(endOfSignature).toBeGreaterThan(idx);
        const snippet = migrationSql.slice(idx, endOfSignature);
        expect(snippet).toMatch(/set\s+search_path\s*=\s*''/i);
      }
    });

    it("revokes execute from public, anon, authenticated and grants strictly to service_role on RPCs", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.admin_recover_and_bind_paypal_order\(uuid,\s*text,\s*jsonb,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.admin_recover_and_bind_paypal_order\(uuid,\s*text,\s*jsonb,\s*text\)\s+to\s+service_role;/i
      );

      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.admin_resolve_reconciliation_without_payment\(uuid,\s*text,\s*text,\s*jsonb,\s*text,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.admin_resolve_reconciliation_without_payment\(uuid,\s*text,\s*text,\s*jsonb,\s*text,\s*text\)\s+to\s+service_role;/i
      );
    });
  });

  // ==========================================================================
  // SECTION 2: STATIC SQL AUDIT: CAPTURING -> CANCELLED TRANSITION (F-02)
  // ==========================================================================
  describe("2. Static SQL Audit: CAPTURING -> CANCELLED Transition & Lease Fencing (F-02)", () => {
    it("permits CAPTURING -> CANCELLED transition in protect_payment_intent_immutability", () => {
      expect(migrationSql).toMatch(/elsif\s+old\.status\s*=\s*'CAPTURING'\s+then/i);
      expect(migrationSql).toMatch(/if\s+new\.status\s*=\s*'CANCELLED'\s+then/i);
    });

    it("fences CAPTURING -> CANCELLED behind active reconciliation flag", () => {
      const capturingIdx = migrationSql.indexOf("elsif old.status = 'CAPTURING' then");
      expect(capturingIdx).toBeGreaterThan(0);
      const snippet = migrationSql.slice(capturingIdx, capturingIdx + 2000);

      expect(snippet).toMatch(/current_setting\('payroost\.reconciliation_active',\s*true\)\s+is\s+distinct\s+from\s+'true'/i);
      expect(snippet).toMatch(/Payment intent transition from CAPTURING to CANCELLED requires privileged reconciliation intervention/i);
    });

    it("fences CAPTURING -> CANCELLED behind capture lease expiration", () => {
      const capturingIdx = migrationSql.indexOf("elsif old.status = 'CAPTURING' then");
      const snippet = migrationSql.slice(capturingIdx, capturingIdx + 2000);

      expect(snippet).toMatch(/old\.capture_lease_expires_at\s+is\s+not\s+null\s+and\s+old\.capture_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
      expect(snippet).toMatch(/Payment intent in CAPTURING cannot transition to CANCELLED while an active capture lease is held/i);
    });

    it("fences CAPTURING -> CANCELLED behind order creation lease expiration", () => {
      const capturingIdx = migrationSql.indexOf("elsif old.status = 'CAPTURING' then");
      const snippet = migrationSql.slice(capturingIdx, capturingIdx + 2000);

      expect(snippet).toMatch(/old\.order_creation_lease_expires_at\s+is\s+not\s+null\s+and\s+old\.order_creation_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
      expect(snippet).toMatch(/Payment intent in CAPTURING cannot transition to CANCELLED while an active order creation lease is held/i);
    });

    it("admin_resolve_reconciliation_without_payment accepts both RECONCILIATION_REQUIRED and CAPTURING", () => {
      expect(migrationSql).toMatch(
        /if\s+v_intent\.status\s+not\s+in\s+\('RECONCILIATION_REQUIRED',\s*'CAPTURING'\)\s+then/i
      );
    });

    it("admin_resolve_reconciliation_without_payment rejects if capture lease or order lease is active", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/v_intent\.order_creation_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
      expect(snippet).toMatch(/v_intent\.capture_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
      expect(snippet).toMatch(/'LEASE_ACTIVE'/);
    });

    it("clears both capture and order creation leases on successful cancellation or failure", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/order_creation_lease_expires_at\s*=\s*null/i);
      expect(snippet).toMatch(/order_creation_lease_token\s*=\s*null/i);
      expect(snippet).toMatch(/capture_lease_expires_at\s*=\s*null/i);
      expect(snippet).toMatch(/capture_lease_token\s*=\s*null/i);
    });

    it("logs audit activity events for reconciliation resolution", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/insert\s+into\s+public\.activity_events/i);
      expect(snippet).toMatch(/payment\.reconciliation_cancelled/i);
      expect(snippet).toMatch(/payment\.reconciliation_failed/i);
    });
  });

  // ==========================================================================
  // SECTION 3: POSTGREST ROLE LOGIC SIMULATION
  // ==========================================================================
  describe("3. PostgREST Dual-Layer Role Authorization Logic Simulation", () => {
    function evaluatePostgrestAuth(sessionUser: string, jwtRoleClaim: string | null): boolean {
      const directDbaRoles = ["postgres", "supabase_admin", "service_role"];
      if (directDbaRoles.includes(sessionUser)) {
        return true;
      }
      if (sessionUser === "authenticator" && (jwtRoleClaim ?? "") === "service_role") {
        return true;
      }
      return false;
    }

    it("authorizes direct DBA connection with session_user = postgres", () => {
      expect(evaluatePostgrestAuth("postgres", null)).toBe(true);
      expect(evaluatePostgrestAuth("postgres", "authenticated")).toBe(true);
    });

    it("authorizes direct DBA connection with session_user = service_role", () => {
      expect(evaluatePostgrestAuth("service_role", null)).toBe(true);
    });

    it("authorizes direct DBA connection with session_user = supabase_admin", () => {
      expect(evaluatePostgrestAuth("supabase_admin", null)).toBe(true);
    });

    it("authorizes Supabase PostgREST connection with session_user = authenticator and claim role = service_role", () => {
      expect(evaluatePostgrestAuth("authenticator", "service_role")).toBe(true);
    });

    it("REJECTS PostgREST connection with session_user = authenticator and claim role = authenticated", () => {
      expect(evaluatePostgrestAuth("authenticator", "authenticated")).toBe(false);
    });

    it("REJECTS PostgREST connection with session_user = authenticator and claim role = anon", () => {
      expect(evaluatePostgrestAuth("authenticator", "anon")).toBe(false);
    });

    it("REJECTS PostgREST connection with session_user = authenticator and empty claim role", () => {
      expect(evaluatePostgrestAuth("authenticator", "")).toBe(false);
      expect(evaluatePostgrestAuth("authenticator", null)).toBe(false);
    });

    it("REJECTS spoofed role claim from non-authenticator role", () => {
      expect(evaluatePostgrestAuth("anon", "service_role")).toBe(false);
      expect(evaluatePostgrestAuth("authenticated", "service_role")).toBe(false);
    });

    it("REJECTS unprivileged session_user", () => {
      expect(evaluatePostgrestAuth("authenticated", null)).toBe(false);
      expect(evaluatePostgrestAuth("anon", null)).toBe(false);
      expect(evaluatePostgrestAuth("guest", null)).toBe(false);
    });
  });

  // ==========================================================================
  // SECTION 4: SERVER-SIDE RECONCILIATION FOR EXPIRED CAPTURING INTENTS
  // ==========================================================================
  describe("4. Behavioral Verification: Server-Side Reconciliation with PostgREST Auth", () => {
    const validIntentId = "d0000000-0000-4000-a000-000000000001";
    const validMilestoneId = "b0000000-0000-4000-a000-000000000001";
    const validProjectId = "c0000000-0000-4000-a000-000000000001";
    const validExpectedMerchantId = "MERCHANT_ACME_12345";
    const validOrderId = "PAYPAL_ORDER_EXPIRED_001";

    const mockPayPalEnv: PayPalConfig = {
      environment: "sandbox",
      baseUrl: "https://api-m.sandbox.paypal.com",
      clientId: "CLIENT_123",
      clientSecret: "SECRET_123",
      expectedMerchantId: validExpectedMerchantId,
      paymentMode: "MERCHANT",
    };

    const validCanonicalPayload = {
      purchase_units: [
        {
          reference_id: validMilestoneId,
          custom_id: validIntentId,
          amount: { currency_code: "USD", value: "1500.00" },
          payee: { merchant_id: validExpectedMerchantId },
        },
      ],
    };

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("cancels an expired CAPTURING intent when PayPal order is VOIDED", async () => {
      const expiredCaptureTime = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 mins ago
      const mockIntent = {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        status: "CAPTURING",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: "f0000000-0000-4000-a000-000000000001",
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: validOrderId,
        order_creation_lease_expires_at: null,
        capture_lease_expires_at: expiredCaptureTime,
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      };

      const mockServiceClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: mockIntent, error: null }),
            }),
          }),
        }),
        rpc: vi.fn().mockImplementation((fnName: string, args: Record<string, unknown>) => {
          if (fnName === "admin_resolve_reconciliation_without_payment") {
            expect(args.p_intent_id).toBe(validIntentId);
            expect(args.p_target_status).toBe("CANCELLED");
            expect(args.p_reason_code).toBe("PAYPAL_ORDER_VOIDED");
            const evidence = args.p_evidence as Record<string, unknown>;
            expect(evidence.evidence_type).toBe("ORDER_VERIFIED_INACTIVE");
            expect(evidence.paypal_order_status).toBe("VOIDED");
            expect(evidence.order_id).toBe(validOrderId);
            expect(evidence.verified_at).toBeDefined();

            return Promise.resolve({
              data: {
                success: true,
                payment_intent_id: validIntentId,
                status: "CANCELLED",
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      } as unknown as ReturnType<typeof createServiceClient>;

      const mockPayPalClient = {
        get: vi.fn().mockResolvedValue({
          data: {
            id: validOrderId,
            status: "VOIDED",
            purchase_units: [
              {
                reference_id: validMilestoneId,
                custom_id: validIntentId,
                amount: { currency_code: "USD", value: "1500.00" },
                payee: { merchant_id: validExpectedMerchantId },
              },
            ],
          },
        }),
      } as unknown as PayPalClient;

      const result = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPalClient,
        injectedPayPalEnv: mockPayPalEnv,
      });

      expect(result.success).toBe(true);
      expect(result.previousStatus).toBe("CAPTURING");
      expect(result.resultingStatus).toBe("CANCELLED");
      expect(result.milestoneBlocked).toBe(false);
      expect(mockServiceClient.rpc).toHaveBeenCalledWith(
        "admin_resolve_reconciliation_without_payment",
        expect.objectContaining({
          p_target_status: "CANCELLED",
          p_reason_code: "PAYPAL_ORDER_VOIDED",
        })
      );
    });

    it("cancels an expired CAPTURING intent when PayPal order is EXPIRED", async () => {
      const expiredCaptureTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const mockIntent = {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        status: "CAPTURING",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: "f0000000-0000-4000-a000-000000000001",
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: validOrderId,
        order_creation_lease_expires_at: null,
        capture_lease_expires_at: expiredCaptureTime,
        created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      };

      const mockServiceClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: mockIntent, error: null }),
            }),
          }),
        }),
        rpc: vi.fn().mockImplementation((fnName: string, args: Record<string, unknown>) => {
          if (fnName === "admin_resolve_reconciliation_without_payment") {
            expect(args.p_target_status).toBe("CANCELLED");
            expect(args.p_reason_code).toBe("PAYPAL_ORDER_EXPIRED");
            return Promise.resolve({
              data: {
                success: true,
                payment_intent_id: validIntentId,
                status: "CANCELLED",
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      } as unknown as ReturnType<typeof createServiceClient>;

      const mockPayPalClient = {
        get: vi.fn().mockResolvedValue({
          data: {
            id: validOrderId,
            status: "EXPIRED",
            purchase_units: [
              {
                reference_id: validMilestoneId,
                custom_id: validIntentId,
                amount: { currency_code: "USD", value: "1500.00" },
                payee: { merchant_id: validExpectedMerchantId },
              },
            ],
          },
        }),
      } as unknown as PayPalClient;

      const result = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPalClient,
        injectedPayPalEnv: mockPayPalEnv,
      });

      expect(result.success).toBe(true);
      expect(result.previousStatus).toBe("CAPTURING");
      expect(result.resultingStatus).toBe("CANCELLED");
      expect(result.milestoneBlocked).toBe(false);
    });

    it("rejects reconciliation if CAPTURING lease is currently active (worker concurrency safety)", async () => {
      const activeCaptureTime = new Date(Date.now() + 60 * 1000).toISOString(); // 1 min in the future
      const mockIntent = {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        status: "CAPTURING",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: "f0000000-0000-4000-a000-000000000001",
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: validOrderId,
        order_creation_lease_expires_at: null,
        capture_lease_expires_at: activeCaptureTime,
        created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      };

      const mockServiceClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: mockIntent, error: null }),
            }),
          }),
        }),
        rpc: vi.fn(),
      } as unknown as ReturnType<typeof createServiceClient>;

      const mockPayPalClient = {
        get: vi.fn(),
      } as unknown as PayPalClient;

      const result = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPalClient,
        injectedPayPalEnv: mockPayPalEnv,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("INELIGIBLE_PAYMENT_INTENT_STATUS");
      expect(result.milestoneBlocked).toBe(true);
      expect(mockPayPalClient.get).not.toHaveBeenCalled();
      expect(mockServiceClient.rpc).not.toHaveBeenCalled();
    });
  });
});
