import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POST } from "@/app/api/public/portal/[token]/payments/capture/route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as paypalEnvModule from "@/lib/paypal/env";
import { PORTAL_SESSION_COOKIE_NAME_DEV } from "@/lib/security/portal-session";

// Mock PayPal Client
const mockPayPalPost = vi.fn();
const mockPayPalGet = vi.fn();

vi.mock("@/lib/paypal/client", () => {
  class MockPayPalClient {
    public post = (...args: unknown[]) => mockPayPalPost(...args);
    public get = (...args: unknown[]) => mockPayPalGet(...args);
  }
  return {
    PayPalClient: MockPayPalClient,
  };
});

// Mock Supabase service client
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockServiceClient = {
  rpc: mockRpc,
  from: mockFrom,
};

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => mockServiceClient),
  getSupabaseServiceEnv: vi.fn(),
}));

// Mock Next.js cookies()
const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

describe("PayRoost Phase 3B.4.3.1: Completed-Order Recovery & Evidence Hardening", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611090004_completed_order_recovery_hardening.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC SQL DDL & FENCING AUDIT (AUDIT-3B43-01 & AUDIT-3B43-03)
  // [Classification: Static SQL inspection]
  // ==========================================================================
  describe("1. Static SQL Audit: Migration 202611090004 Hardening", () => {
    it("drops obsolete 7-parameter signature of reconcile_and_complete_payment_intent", () => {
      expect(migrationSql).toMatch(
        /drop\s+function\s+if\s+exists\s+public\.reconcile_and_complete_payment_intent\s*\(\s*uuid,\s*text,\s*jsonb,\s*jsonb,\s*text,\s*bigint,\s*text\s*\)\s*;/i
      );
    });

    it("defines 8-parameter reconcile_and_complete_payment_intent with p_lease_token", () => {
      expect(migrationSql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.reconcile_and_complete_payment_intent\s*\(\s*p_intent_id\s+uuid,\s*p_provider_capture_id\s+text,\s*p_raw_capture_response\s+jsonb,\s*p_raw_order_response\s+jsonb,\s*p_resolution_notes\s+text\s+default\s+null,\s*p_amount_cents\s+bigint\s+default\s+null,\s*p_payee_merchant_id\s+text\s+default\s+null,\s*p_lease_token\s+uuid\s+default\s+null\s*\)/i
      );
    });

    it("sets empty search_path across all redefined functions to prevent search_path hijacking", () => {
      const functions = [
        "reconcile_and_complete_payment_intent(",
        "record_paypal_order_captured(",
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

    it("validates p_lease_token when reconciling an intent in CAPTURING status", () => {
      expect(migrationSql).toMatch(
        /if\s+v_intent\.status\s*=\s*'CAPTURING'\s+and\s+v_intent\.capture_lease_expires_at\s+is\s+not\s+null\s+and\s+v_intent\.capture_lease_expires_at\s*>\s*clock_timestamp\(\)\s+then/i
      );
      expect(migrationSql).toMatch(
        /if\s+p_lease_token\s+is\s+null\s+or\s+v_intent\.capture_lease_token\s+is\s+distinct\s+from\s+p_lease_token\s+then/i
      );
      expect(migrationSql).toMatch(/'Cannot reconcile CAPTURING intent while an active worker lease is held'/);
    });

    it("authoritatively resolves payee merchant from matched purchase unit without requiring payee on capture", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.reconcile_and_complete_payment_intent(");
      const snippet = migrationSql.slice(rpcIdx);

      // Does not unconditionally raise exception if payee is missing on capture
      expect(snippet).not.toMatch(/if\s+not\s*\(p_raw_capture_response\s*\?\s*'payee'\)\s+then\s+raise\s+exception/i);

      // Verifies payee is mandatory on matched purchase unit
      expect(snippet).toMatch(/if\s+not\s*\(v_target_pu\s*\?\s*'payee'\)\s+or\s+not\s*\(v_target_pu->'payee'\s*\?\s*'merchant_id'\)\s+then/i);
      expect(snippet).toMatch(/'Matched purchase unit missing payee\.merchant_id'/);
    });

    it("strengthens record_paypal_order_captured for defense-in-depth raw evidence validation", () => {
      const rpcIdx = migrationSql.indexOf("create or replace function public.record_paypal_order_captured(");
      const snippet = migrationSql.slice(rpcIdx);

      expect(snippet).toMatch(/RAW_MERCHANT_MISMATCH/);
      expect(snippet).toMatch(/RAW_CURRENCY_MISMATCH/);
      expect(snippet).toMatch(/RAW_AMOUNT_MISMATCH/);
    });

    it("restricts execute grants strictly to service_role", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.reconcile_and_complete_payment_intent\(uuid,\s*text,\s*jsonb,\s*jsonb,\s*text,\s*bigint,\s*text,\s*uuid\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.reconcile_and_complete_payment_intent\(uuid,\s*text,\s*jsonb,\s*jsonb,\s*text,\s*bigint,\s*text,\s*uuid\)\s+to\s+service_role;/i
      );
    });
  });

  // ==========================================================================
  // SECTION 2: TARGETED RECOVERY ROUTE TESTS (AUDIT-3B43-01)
  // [Classification: Mocked route test]
  // ==========================================================================
  describe("2. Targeted Recovery Route Tests: Already-Completed PayPal Orders", () => {
    const validToken = "valid-portal-token-for-recovery-test-12345";
    const validOrderId = "5O190127TN364715T";
    const validCaptureId = "7XX1234567890123A";
    const validRawSessionToken = "valid-test-portal-session-token-43-chars___";
    const validCsrfSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    const validProjectId = "c0000000-0000-4000-a000-000000000001";
    const validMilestoneId = "b0000000-0000-4000-a000-000000000001";
    const validIntentId = "d0000000-0000-4000-a000-000000000001";
    const validSessionId = "e0000000-0000-4000-a000-000000000001";
    const validAgreementVersionId = "a0000000-0000-4000-a000-000000000001";
    const validClientEmail = "client@acme-corp.com";
    const validExpectedMerchantId = "MERCHANT_ACME_12345";
    const validCaptureIdempotencyKey = "f0000000-0000-4000-a000-000000000002";
    const validLeaseToken = "99999999-0000-4000-a000-000000000001";

    let mockPortalTokenResult: { data: unknown; error: unknown };
    let mockPaymentIntentResult: { data: unknown; error: unknown };
    let mockMilestoneResult: { data: unknown; error: unknown };
    let mockAgreementResult: { data: unknown; error: unknown };
    let mockExistingCaptureResult: { data: unknown; error: unknown };

    // Standard valid COMPLETED PayPal Order response
    const validCompletedOrder = {
      id: validOrderId,
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: validMilestoneId,
          custom_id: validIntentId,
          amount: {
            currency_code: "USD",
            value: "1500.00",
          },
          payee: {
            merchant_id: validExpectedMerchantId,
          },
          payments: {
            captures: [
              {
                id: validCaptureId,
                status: "COMPLETED",
                amount: {
                  currency_code: "USD",
                  value: "1500.00",
                },
              },
            ],
          },
        },
      ],
    };

    function createRequest(body?: unknown) {
      return new Request(`https://payroost.test/api/public/portal/${validToken}/payments/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": validCsrfSecret,
        },
        body: JSON.stringify(body ?? { orderId: validOrderId }),
      });
    }

    beforeEach(() => {
      vi.restoreAllMocks();
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";

      mockCookieStore.get.mockImplementation((name: string) => {
        if (name === PORTAL_SESSION_COOKIE_NAME_DEV) {
          return { name, value: validRawSessionToken };
        }
        return undefined;
      });

      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue({
        allowed: true,
        current: 1,
        limit: 10,
        resetAt: Date.now() + 900_000,
        status: "allowed",
      });

      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
        environment: "sandbox",
        baseUrl: "https://api-m.sandbox.paypal.com",
        clientId: "CLIENT_ID_TEST",
        clientSecret: "CLIENT_SECRET_TEST",
        expectedMerchantId: validExpectedMerchantId,
        timeoutMs: 15_000,
        paymentMode: "MERCHANT",
      });

      mockPortalTokenResult = {
        data: { project_id: validProjectId, revoked_at: null },
        error: null,
      };

      mockPaymentIntentResult = {
        data: {
          id: validIntentId,
          project_id: validProjectId,
          milestone_id: validMilestoneId,
          agreement_version_id: validAgreementVersionId,
          status: "ORDER_CREATED",
          expected_merchant_id: validExpectedMerchantId,
          expected_currency: "USD",
          expected_amount_canonical: "1500.00",
          expected_amount_cents: 150000,
          capture_idempotency_key: validCaptureIdempotencyKey,
          provider_order_id: validOrderId,
          capture_lease_expires_at: null,
          created_at: new Date().toISOString(),
        },
        error: null,
      };

      mockMilestoneResult = {
        data: {
          id: validMilestoneId,
          project_id: validProjectId,
          agreement_version_id: validAgreementVersionId,
          status: "APPROVED",
          currency: "USD",
          amount_minor: 150000,
        },
        error: null,
      };

      mockAgreementResult = {
        data: {
          id: validAgreementVersionId,
          project_id: validProjectId,
          status: "APPROVED",
        },
        error: null,
      };

      mockExistingCaptureResult = {
        data: null,
        error: null,
      };

      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue(mockPortalTokenResult),
              }),
            }),
          };
        }
        if (table === "payment_intents") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue(mockPaymentIntentResult),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue(mockMilestoneResult),
              }),
            }),
          };
        }
        if (table === "agreement_versions") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue(mockAgreementResult),
              }),
            }),
          };
        }
        if (table === "payment_transactions") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue(mockExistingCaptureResult),
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      });

      mockRpc.mockImplementation((fnName: string) => {
        if (fnName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: validSessionId,
              projectId: validProjectId,
              clientEmail: validClientEmail,
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        if (fnName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: {
              success: true,
              claimed: true,
              lease_token: validLeaseToken,
              payment_intent_id: validIntentId,
              provider_order_id: validOrderId,
              status: "CAPTURING",
            },
            error: null,
          });
        }
        if (fnName === "reconcile_and_complete_payment_intent") {
          return Promise.resolve({ data: true, error: null });
        }
        if (fnName === "mark_intent_capture_reconciliation_required") {
          return Promise.resolve({ data: { success: true, status: "RECONCILIATION_REQUIRED" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
    });

    it("recovers completed payment when PayPal order is COMPLETED while intent is ORDER_CREATED", async () => {
      mockPayPalGet.mockResolvedValueOnce({ data: validCompletedOrder });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
      expect(json.captureId).toBe(validCaptureId);

      // Verifies lease was claimed
      expect(mockRpc).toHaveBeenCalledWith("claim_order_capture_lease", expect.objectContaining({
        p_payment_intent_id: validIntentId,
        p_provider_order_id: validOrderId,
      }));

      // Verifies reconciliation RPC was invoked with lease token and raw order evidence
      expect(mockRpc).toHaveBeenCalledWith("reconcile_and_complete_payment_intent", expect.objectContaining({
        p_intent_id: validIntentId,
        p_provider_capture_id: validCaptureId,
        p_lease_token: validLeaseToken,
        p_raw_capture_response: expect.objectContaining({ id: validCaptureId }),
        p_raw_order_response: expect.objectContaining({ id: validOrderId, status: "COMPLETED" }),
      }));

      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("recovers completed payment when PayPal order is COMPLETED while intent is BUYER_APPROVED", async () => {
      (mockPaymentIntentResult.data as Record<string, unknown>).status = "BUYER_APPROVED";
      mockPayPalGet.mockResolvedValueOnce({ data: validCompletedOrder });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
      expect(json.captureId).toBe(validCaptureId);
    });

    it("rejects COMPLETED order when purchase unit payments.captures is empty", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              payments: { captures: [] },
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("INVALID_PURCHASE_UNITS");
    });

    it("handles PENDING capture on COMPLETED order by marking RECONCILIATION_REQUIRED and returning 202", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              payments: {
                captures: [
                  {
                    id: validCaptureId,
                    status: "PENDING",
                    amount: { currency_code: "USD", value: "1500.00" },
                  },
                ],
              },
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("PENDING");

      // Verify escalation under lease fencing
      expect(mockRpc).toHaveBeenCalledWith("mark_intent_capture_reconciliation_required", expect.objectContaining({
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
        p_reason_code: "PAYPAL_CAPTURE_PENDING",
      }));
    });

    it("handles FAILED capture on COMPLETED order by marking RECONCILIATION_REQUIRED and returning 400", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              payments: {
                captures: [
                  {
                    id: validCaptureId,
                    status: "DECLINED",
                    amount: { currency_code: "USD", value: "1500.00" },
                  },
                ],
              },
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PAYMENT_DECLINED");

      expect(mockRpc).toHaveBeenCalledWith("mark_intent_capture_reconciliation_required", expect.objectContaining({
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
        p_reason_code: "PAYPAL_CAPTURE_DECLINED",
      }));
    });

    it("rejects COMPLETED order when capture ID is empty", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              payments: {
                captures: [{ id: "   ", status: "COMPLETED" }],
              },
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("ORDER_BINDING_MISMATCH");
    });

    it("rejects COMPLETED order when returned order ID does not match expected", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          id: "DIFFERENT_ORDER_ID_999",
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("ORDER_ID_MISMATCH");
    });

    it("rejects COMPLETED order when purchase unit custom_id does not match payment intent ID", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              custom_id: "00000000-0000-4000-a000-999999999999",
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("ORDER_BINDING_MISMATCH");
    });

    it("rejects COMPLETED order when purchase unit reference_id does not match milestone ID", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              reference_id: "00000000-0000-4000-a000-888888888888",
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("ORDER_BINDING_MISMATCH");
    });

    it("rejects COMPLETED order when purchase unit amount does not match expected amount", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              amount: { currency_code: "USD", value: "999.00" },
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("AMOUNT_MISMATCH");
    });

    it("rejects COMPLETED order when purchase unit currency is not USD", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              amount: { currency_code: "EUR", value: "1500.00" },
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("CURRENCY_MISMATCH");
    });

    it("rejects COMPLETED order when payee merchant ID does not match expected merchant", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              payee: { merchant_id: "WRONG_MERCHANT_XYZ" },
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe("MERCHANT_MISMATCH");
    });

    it("rejects COMPLETED order when purchase-unit payee is missing", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validCompletedOrder,
          purchase_units: [
            {
              ...validCompletedOrder.purchase_units[0],
              payee: undefined,
            },
          ],
        },
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });
      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe("MERCHANT_MISMATCH");
    });

    it("returns 200 COMPLETED idempotently when payment intent was already COMPLETED in database", async () => {
      (mockPaymentIntentResult.data as Record<string, unknown>).status = "COMPLETED";
      mockExistingCaptureResult = {
        data: { provider_reference_id: validCaptureId, status: "COMPLETED" },
        error: null,
      };

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
      expect(json.captureId).toBe(validCaptureId);

      // Did not query PayPal or claim lease
      expect(mockPayPalGet).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalledWith("claim_order_capture_lease", expect.anything());
    });

    it("returns 409 CAPTURE_IN_PROGRESS with Retry-After when an active lease is held during recovery", async () => {
      mockPayPalGet.mockResolvedValueOnce({ data: validCompletedOrder });
      mockRpc.mockImplementation((fnName: string) => {
        if (fnName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: validSessionId,
              projectId: validProjectId,
              clientEmail: validClientEmail,
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        if (fnName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: { success: false, error: "LEASE_ACTIVE" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(409);
      expect(res.headers.get("Retry-After")).toBe("3");
      const json = await res.json();
      expect(json.error).toBe("CAPTURE_IN_PROGRESS");
    });

    it("handles existing completed ledger entry returned from claim_order_capture_lease", async () => {
      mockPayPalGet.mockResolvedValueOnce({ data: validCompletedOrder });
      mockRpc.mockImplementation((fnName: string) => {
        if (fnName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: validSessionId,
              projectId: validProjectId,
              clientEmail: validClientEmail,
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        if (fnName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: {
              success: true,
              already_completed: true,
              provider_capture_id: validCaptureId,
              status: "COMPLETED",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
      expect(json.captureId).toBe(validCaptureId);
    });

    it("handles database failure during reconciliation RPC by escalating to RECONCILIATION_REQUIRED under lease fencing", async () => {
      mockPayPalGet.mockResolvedValueOnce({ data: validCompletedOrder });
      mockRpc.mockImplementation((fnName: string) => {
        if (fnName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: validSessionId,
              projectId: validProjectId,
              clientEmail: validClientEmail,
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        if (fnName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: {
              success: true,
              claimed: true,
              lease_token: validLeaseToken,
              payment_intent_id: validIntentId,
              provider_order_id: validOrderId,
              status: "CAPTURING",
            },
            error: null,
          });
        }
        if (fnName === "reconcile_and_complete_payment_intent") {
          return Promise.resolve({ data: null, error: { message: "Internal lock error" } });
        }
        if (fnName === "mark_intent_capture_reconciliation_required") {
          return Promise.resolve({ data: { success: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("RECONCILIATION_REQUIRED");

      // Verify that mark_intent_capture_reconciliation_required was called with fencing token
      expect(mockRpc).toHaveBeenCalledWith("mark_intent_capture_reconciliation_required", {
        p_session_token_hash: expect.any(String),
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
        p_reason_code: "PAYPAL_CAPTURE_PERSISTENCE_FAILED",
      });
    });

    it("rejects recovery when claim_order_capture_lease fails due to stale lease token or session error", async () => {
      mockPayPalGet.mockResolvedValueOnce({ data: validCompletedOrder });
      mockRpc.mockImplementation((fnName: string) => {
        if (fnName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: validSessionId,
              projectId: validProjectId,
              clientEmail: validClientEmail,
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        if (fnName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: { success: false, error: "STALE_LEASE_TOKEN" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const res = await POST(createRequest(), { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("CAPTURE_CLAIM_FAILED");
    });
  });
});
