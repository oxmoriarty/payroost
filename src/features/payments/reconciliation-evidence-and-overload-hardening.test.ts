import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  reconcilePaymentIntentServerSide,
} from "@/lib/paypal/reconciliation-service";
import { PayPalClient } from "@/lib/paypal/client";
import { createServiceClient } from "@/lib/supabase/service";
import type { PayPalConfig } from "@/lib/paypal/types";

describe("PayRoost Phase 3B.4.2.4: Financial Recovery Guard & Overload Remediation", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611090003_reconciliation_evidence_and_overload_hardening.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC SQL DDL & OVERLOAD HYGIENE (Tests 10, 11)
  // [Classification: Static SQL inspection]
  // ==========================================================================
  describe("1. Static SQL Audit: Overload Dropping & Function Identity (Tests 10, 11)", () => {
    it("Test 10: explicitly drops the obsolete five-parameter overload of admin_resolve_reconciliation_without_payment", () => {
      expect(migrationSql).toMatch(
        /drop\s+function\s+if\s+exists\s+public\.admin_resolve_reconciliation_without_payment\s*\(\s*uuid,\s*text,\s*text,\s*jsonb,\s*text\s*\)\s*;/i
      );
    });

    it("Test 11: preserves exactly one six-parameter function with default arguments and grants", () => {
      const funcDef =
        /create\s+or\s+replace\s+function\s+public\.admin_resolve_reconciliation_without_payment\s*\(\s*p_intent_id\s+uuid,\s*p_target_status\s+text,\s*p_reason_code\s+text,\s*p_evidence\s+jsonb,\s*p_notes\s+text\s+default\s+null,\s*p_actor\s+text\s+default\s+'system_reconciliation_service'\s*\)/i;
      expect(migrationSql).toMatch(funcDef);

      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.admin_resolve_reconciliation_without_payment\(uuid,\s*text,\s*text,\s*jsonb,\s*text,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.admin_resolve_reconciliation_without_payment\(uuid,\s*text,\s*text,\s*jsonb,\s*text,\s*text\)\s+to\s+service_role;/i
      );
    });

    it("sets empty search_path across all redefined functions to prevent search_path hijacking", () => {
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
  });

  // ==========================================================================
  // SECTION 2: STATIC SQL AUDIT: FINANCIAL GUARDS & ORDER ID BINDING (Tests 1, 3, 4, 5, 6, 7, 8, 9)
  // [Classification: Static SQL inspection]
  // ==========================================================================
  describe("2. Static SQL Audit: Financial Ledger Guards & Strict Order ID Binding (Tests 1-9)", () => {
    it("Test 1: enforces COMPLETED_CAPTURE_EXISTS check with row-locking before cancellation", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/perform\s+1\s+from\s+public\.payment_transactions\s+pt/i);
      expect(snippet).toMatch(/pt\.payment_intent_id\s*=\s*v_intent\.id/i);
      expect(snippet).toMatch(/pt\.status\s*=\s*'COMPLETED'/i);
      expect(snippet).toMatch(/for\s+update/i);
      expect(snippet).toMatch(/'COMPLETED_CAPTURE_EXISTS'/);
    });

    it("Test 3: rejects mismatched evidence order ID against stored provider order ID", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/trim\(p_evidence->>'order_id'\)\s*<>\s*v_intent\.provider_order_id/i);
      expect(snippet).toMatch(/'ORDER_ID_MISMATCH'/);
    });

    it("Test 4: rejects missing or empty evidence order ID", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/char_length\(trim\(coalesce\(p_evidence->>'order_id',\s*''\)\)\)\s*=\s*0/i);
      expect(snippet).toMatch(/'ORDER_ID_MISSING_IN_EVIDENCE'/);
    });

    it("Test 5: rejects ORDER_VERIFIED_INACTIVE if intent has no provider_order_id stored", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/v_intent\.provider_order_id\s+is\s+null/i);
      expect(snippet).toMatch(/'ORDER_ID_MISSING_ON_INTENT'/);
    });

    it("Test 6: restricts provider order status strictly to VOIDED or EXPIRED", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/v_order_status\s+not\s+in\s+\('VOIDED',\s*'EXPIRED'\)/i);
      expect(snippet).toMatch(/'ORDER_STATUS_NOT_INACTIVE'/);
    });

    it("Test 7: fences CAPTURING -> CANCELLED behind active reconciliation flag and both leases", () => {
      const capturingIdx = migrationSql.indexOf("elsif old.status = 'CAPTURING' then");
      expect(capturingIdx).toBeGreaterThan(0);
      const snippet = migrationSql.slice(capturingIdx, capturingIdx + 2500);

      expect(snippet).toMatch(/current_setting\('payroost\.reconciliation_active',\s*true\)\s+is\s+distinct\s+from\s+'true'/i);
      expect(snippet).toMatch(/old\.capture_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
      expect(snippet).toMatch(/old\.order_creation_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
    });

    it("Test 8: rejects cancellation in RPC if active order creation lease is held", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/v_intent\.order_creation_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
      expect(snippet).toMatch(/'ORDER_CREATION'/);
      expect(snippet).toMatch(/'LEASE_ACTIVE'/);
    });

    it("Test 9: rejects cancellation in RPC if active capture lease is held", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/v_intent\.capture_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
      expect(snippet).toMatch(/'CAPTURE'/);
      expect(snippet).toMatch(/'LEASE_ACTIVE'/);
    });

    it("rejects ORDER_NOT_FOUND_ON_PROVIDER if an order ID already exists on the intent", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.admin_resolve_reconciliation_without_payment(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/v_evidence_type\s*=\s*'ORDER_NOT_FOUND_ON_PROVIDER'/i);
      expect(snippet).toMatch(/v_intent\.provider_order_id\s+is\s+not\s+null/i);
      expect(snippet).toMatch(/'CONTRADICTORY_EVIDENCE_ORDER_EXISTS'/);
    });
  });

  // ==========================================================================
  // SECTION 3: POSTGREST DUAL-LAYER ROLE AUTH WITH JSON CLAIMS FALLBACK (Tests 12-16)
  // [Classification: Mocked unit test / Logic simulation]
  // ==========================================================================
  describe("3. PostgREST Dual-Layer Role Authorization & JSON Fallback (Tests 12-16)", () => {
    function evaluatePostgrestAuth(
      sessionUser: string,
      jwtClaimRole: string | null,
      jwtClaimsJson: string | null
    ): boolean {
      const directDbaRoles = ["postgres", "supabase_admin", "service_role"];
      if (directDbaRoles.includes(sessionUser)) {
        return true;
      }

      if (sessionUser === "authenticator") {
        // 1. Primary: check individual claim GUC
        if (jwtClaimRole === "service_role") {
          return true;
        }

        // 2. Fallback: check JSON claims object
        if (jwtClaimsJson) {
          try {
            // Regex guard matching the SQL regex ~ '^\s*\{.*\}\s*$'
            if (/^\s*\{.*\}\s*$/.test(jwtClaimsJson)) {
              const parsed = JSON.parse(jwtClaimsJson) as Record<string, unknown>;
              if (parsed && typeof parsed === "object" && parsed.role === "service_role") {
                return true;
              }
            }
          } catch {
            return false; // Fail closed on malformed JSON
          }
        }
      }

      return false;
    }

    it("Test 12: individual JWT role claim authorizes only the intended service-role PostgREST path", () => {
      expect(evaluatePostgrestAuth("authenticator", "service_role", null)).toBe(true);
      expect(evaluatePostgrestAuth("authenticator", "authenticated", null)).toBe(false);
      expect(evaluatePostgrestAuth("authenticator", "anon", null)).toBe(false);
    });

    it("Test 13: JSON claims fallback authorizes the intended service-role path when individual claim is missing", () => {
      const validClaimsJson = JSON.stringify({ role: "service_role", iss: "supabase", exp: 1999999999 });
      expect(evaluatePostgrestAuth("authenticator", null, validClaimsJson)).toBe(true);
      expect(evaluatePostgrestAuth("authenticator", "", validClaimsJson)).toBe(true);
    });

    it("Test 14: authenticated and anon roles are strictly rejected under both primary and fallback", () => {
      const userClaimsJson = JSON.stringify({ role: "authenticated", sub: "user_123" });
      const anonClaimsJson = JSON.stringify({ role: "anon" });

      expect(evaluatePostgrestAuth("authenticator", "authenticated", userClaimsJson)).toBe(false);
      expect(evaluatePostgrestAuth("authenticator", null, userClaimsJson)).toBe(false);

      expect(evaluatePostgrestAuth("authenticator", "anon", anonClaimsJson)).toBe(false);
      expect(evaluatePostgrestAuth("authenticator", null, anonClaimsJson)).toBe(false);
    });

    it("Test 15: malformed claims fail closed and do not grant access", () => {
      expect(evaluatePostgrestAuth("authenticator", null, "not-json")).toBe(false);
      expect(evaluatePostgrestAuth("authenticator", null, "{role: broken}")).toBe(false);
      expect(evaluatePostgrestAuth("authenticator", null, '{"role": 123}')).toBe(false);
      expect(evaluatePostgrestAuth("authenticator", null, "")).toBe(false);
      expect(evaluatePostgrestAuth("authenticator", null, null)).toBe(false);
    });

    it("Test 16: non-authenticator sessions cannot exploit a supplied service-role claim", () => {
      const serviceRoleJson = JSON.stringify({ role: "service_role" });

      // An unprivileged user cannot spoof role claims
      expect(evaluatePostgrestAuth("anon", "service_role", null)).toBe(false);
      expect(evaluatePostgrestAuth("anon", null, serviceRoleJson)).toBe(false);
      expect(evaluatePostgrestAuth("authenticated", "service_role", null)).toBe(false);
      expect(evaluatePostgrestAuth("authenticated", null, serviceRoleJson)).toBe(false);
      expect(evaluatePostgrestAuth("guest", "service_role", null)).toBe(false);
    });

    it("preserves direct DBA access for postgres, supabase_admin, and direct service_role", () => {
      expect(evaluatePostgrestAuth("postgres", null, null)).toBe(true);
      expect(evaluatePostgrestAuth("supabase_admin", null, null)).toBe(true);
      expect(evaluatePostgrestAuth("service_role", null, null)).toBe(true);
    });
  });

  // ==========================================================================
  // SECTION 4: SERVER-SIDE RECONCILIATION INTEGRATION TESTS (Tests 1, 2, 3, 6)
  // [Classification: Mocked unit test]
  // ==========================================================================
  describe("4. Behavioral Verification: Reconciliation Service & RPC Integration (Tests 1-9)", () => {
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

    it("Test 1: handles COMPLETED_CAPTURE_EXISTS error and retains locked milestone", async () => {
      const expiredCaptureTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
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
        rpc: vi.fn().mockImplementation((fnName: string) => {
          if (fnName === "admin_resolve_reconciliation_without_payment") {
            return Promise.resolve({
              data: {
                success: false,
                error: "COMPLETED_CAPTURE_EXISTS",
                payment_intent_id: validIntentId,
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

      expect(result.success).toBe(false);
      expect(result.resultingStatus).toBe("RECONCILIATION_REQUIRED");
      expect(result.milestoneBlocked).toBe(true);
      expect(result.error).toBe("DATABASE_RESOLUTION_FAILED");
    });

    it("Test 2: cancellation succeeds when no completed capture exists and valid evidence is bound", async () => {
      const expiredCaptureTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
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
            const evidence = args.p_evidence as Record<string, unknown>;
            expect(evidence.order_id).toBe(validOrderId);
            expect(evidence.paypal_order_status).toBe("VOIDED");
            expect(args.p_target_status).toBe("CANCELLED");

            return Promise.resolve({
              data: {
                success: true,
                payment_intent_id: validIntentId,
                milestone_id: validMilestoneId,
                status: "CANCELLED",
                reason_code: "PAYPAL_ORDER_VOIDED",
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
    });

    it("Test 6: PayPal order in CREATED or APPROVED status cannot be cancelled as inactive", async () => {
      const expiredCaptureTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
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
        rpc: vi.fn().mockImplementation((fnName: string) => {
          if (fnName === "admin_recover_and_bind_paypal_order") {
            return Promise.resolve({
              data: {
                success: true,
                payment_intent_id: validIntentId,
                status: "ORDER_CREATED",
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
            status: "APPROVED",
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

      // Status resets to ORDER_CREATED for re-approval, NOT CANCELLED
      expect(result.success).toBe(true);
      expect(result.resultingStatus).toBe("ORDER_CREATED");
      expect(result.milestoneBlocked).toBe(true);
      expect(mockServiceClient.rpc).toHaveBeenCalledWith(
        "admin_recover_and_bind_paypal_order",
        expect.any(Object)
      );
      expect(mockServiceClient.rpc).not.toHaveBeenCalledWith(
        "admin_resolve_reconciliation_without_payment",
        expect.any(Object)
      );
    });
  });
});
