import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { POST, CAPTURE_RECONCILIATION_REASONS } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as paypalEnvModule from "@/lib/paypal/env";
import { PORTAL_SESSION_COOKIE_NAME_DEV } from "@/lib/security/portal-session";
import { PayPalError } from "@/lib/paypal/types";

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

describe("POST /api/public/portal/[token]/payments/orders/[orderId]/capture", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTrustProxy = process.env.TRUST_PROXY;

  const validToken = "valid-portal-token-for-client-order-test-12345";
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
  let mockExistingCaptureResult: { data: unknown; error: unknown };

  const validPayPalCaptureResponse = {
    id: validOrderId,
    status: "COMPLETED",
    purchase_units: [
      {
        reference_id: validMilestoneId,
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
              payee: {
                merchant_id: validExpectedMerchantId,
              },
              custom_id: validIntentId,
            },
          ],
        },
      },
    ],
  };

  function createRequest(options: {
    token?: string;
    orderId?: string;
    body?: unknown;
    csrfToken?: string | null;
    headers?: Record<string, string>;
  }) {
    const routeToken = options.token ?? validToken;
    const routeOrderId = options.orderId ?? validOrderId;
    const bodyContent =
      options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : JSON.stringify({
            paymentIntentId: validIntentId,
          });

    const reqHeaders = new Headers(options.headers || {});
    reqHeaders.set("Content-Type", "application/json");

    if (options.csrfToken !== null) {
      reqHeaders.set("x-csrf-token", options.csrfToken ?? validCsrfSecret);
    }

    const request = new Request(
      `https://payroost.com/api/public/portal/${routeToken}/payments/orders/${routeOrderId}/capture`,
      {
        method: "POST",
        headers: reqHeaders,
        body: bodyContent,
      }
    );

    const context = {
      params: Promise.resolve({ token: routeToken, orderId: routeOrderId }),
    };

    return { request, context };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.TRUST_PROXY = "false";

    // Default cookie store setup: valid development session cookie
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === PORTAL_SESSION_COOKIE_NAME_DEV) {
        return { name, value: validRawSessionToken };
      }
      return undefined;
    });

    // Default rate limit check: allowed
    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 10,
      resetAt: Date.now() + 60000,
      status: "allowed",
    });

    // Default PayPal environment configuration
    vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
      environment: "sandbox",
      baseUrl: "https://api-m.sandbox.paypal.com",
      clientId: "CLIENT_ID_123",
      clientSecret: "CLIENT_SECRET_123",
      expectedMerchantId: validExpectedMerchantId,
    });

    // Default table results
    mockPortalTokenResult = {
      data: {
        project_id: validProjectId,
        revoked_at: null,
      },
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
      },
      error: null,
    };

    mockExistingCaptureResult = {
      data: {
        provider_reference_id: validCaptureId,
        status: "COMPLETED",
      },
      error: null,
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === "client_portal_tokens") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(mockPortalTokenResult),
            }),
          }),
        };
      }
      if (table === "payment_intents") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(mockPaymentIntentResult),
            }),
          }),
        };
      }
      if (table === "milestones") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(mockMilestoneResult),
            }),
          }),
        };
      }
      if (table === "payment_transactions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve(mockExistingCaptureResult),
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      };
    });

    // Default RPC mock dispatch
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "validate_portal_session") {
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
      if (rpcName === "claim_order_capture_lease") {
        return Promise.resolve({
          data: {
            success: true,
            claimed: true,
            lease_token: validLeaseToken,
            already_completed: false,
          },
          error: null,
        });
      }
      if (rpcName === "record_paypal_order_captured") {
        return Promise.resolve({
          data: {
            success: true,
            already_recorded: false,
            status: "COMPLETED",
            capture_id: validCaptureId,
          },
          error: null,
        });
      }
      if (rpcName === "release_order_capture_lease") {
        return Promise.resolve({
          data: { success: true, released: true },
          error: null,
        });
      }
      if (rpcName === "mark_intent_capture_reconciliation_required") {
        return Promise.resolve({
          data: {
            success: true,
            status: "RECONCILIATION_REQUIRED",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    // Default PayPal capture response: 200 OK with valid capture
    mockPayPalPost.mockResolvedValue({
      data: validPayPalCaptureResponse,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
    });

    mockPayPalGet.mockResolvedValue({
      data: validPayPalCaptureResponse,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
    });
  });

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    process.env.TRUST_PROXY = originalTrustProxy;
  });

  // ==========================================================================
  // 1. INPUT VALIDATION & AUTHENTICATION
  // ==========================================================================
  describe("1. Input Validation and Portal Authentication", () => {
    it("rejects malformed portal token with 404", async () => {
      const { request, context } = createRequest({ token: "bad" });
      const res = await POST(request, context);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("INVITATION_NOT_FOUND");
    });

    it("rejects invalid PayPal order ID format with 400", async () => {
      const { request, context } = createRequest({ orderId: "invalid/order/id/with/slashes!" });
      const res = await POST(request, context);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
    });

    it("rejects missing CSRF token header with 403", async () => {
      const { request, context } = createRequest({ csrfToken: null });
      const res = await POST(request, context);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("INVALID_CSRF_TOKEN");
    });

    it("rejects missing session cookie with 401", async () => {
      mockCookieStore.get.mockReturnValue(undefined);
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("UNAUTHORIZED");
    });

    it("rejects revoked portal invitation token with 404", async () => {
      mockPortalTokenResult = {
        data: { project_id: validProjectId, revoked_at: new Date().toISOString() },
        error: null,
      };
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("INVITATION_NOT_FOUND");
    });

    it("enforces token rate limiting with 429", async () => {
      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue({
        allowed: false,
        current: 11,
        limit: 10,
        resetAt: Date.now() + 60000,
        status: "rate_limited",
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error).toBe("RATE_LIMITED");
    });
  });

  // ==========================================================================
  // 2. CONTEXTUAL RESOLUTION & MULTI-TENANT ISOLATION
  // ==========================================================================
  describe("2. Contextual Resolution and Isolation", () => {
    it("returns 404 if payment intent not found for provider order ID", async () => {
      mockPaymentIntentResult = { data: null, error: null };
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("PAYMENT_INTENT_NOT_FOUND");
    });

    it("enforces multi-tenant isolation: rejects order belonging to different project with 403", async () => {
      mockPaymentIntentResult = {
        data: {
          ...(mockPaymentIntentResult.data as object),
          project_id: "c9999999-0000-4000-a000-000000000009",
        },
        error: null,
      };
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");
    });

    it("rejects optional body paymentIntentId mismatch with 400", async () => {
      const { request, context } = createRequest({
        body: { paymentIntentId: "d9999999-0000-4000-a000-000000000009" },
      });
      const res = await POST(request, context);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PAYMENT_INTENT_MISMATCH");
    });

    it("rejects unpayable milestone status with 400", async () => {
      mockMilestoneResult = {
        data: {
          ...(mockMilestoneResult.data as object),
          status: "DRAFT",
        },
        error: null,
      };
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("MILESTONE_NOT_PAYABLE");
    });

    it("rejects unsupported milestone currency with 400", async () => {
      mockMilestoneResult = {
        data: {
          ...(mockMilestoneResult.data as object),
          currency: "EUR",
        },
        error: null,
      };
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("UNSUPPORTED_CURRENCY");
    });
  });

  // ==========================================================================
  // 3. STATE INVARIANTS & LEASE CONCURRENCY
  // ==========================================================================
  describe("3. State Invariants and Lease Concurrency", () => {
    it("returns 200 idempotent fast-path if intent is already COMPLETED", async () => {
      mockPaymentIntentResult = {
        data: {
          ...(mockPaymentIntentResult.data as object),
          status: "COMPLETED",
        },
        error: null,
      };

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
      expect(json.captureId).toBe(validCaptureId);
      // Ensure PayPal client was NOT called
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects capture attempt from RECONCILIATION_REQUIRED with 409", async () => {
      mockPaymentIntentResult = {
        data: {
          ...(mockPaymentIntentResult.data as object),
          status: "RECONCILIATION_REQUIRED",
        },
        error: null,
      };
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("RECONCILIATION_REQUIRED");
    });

    it("rejects capture attempt from FAILED with 409", async () => {
      mockPaymentIntentResult = {
        data: {
          ...(mockPaymentIntentResult.data as object),
          status: "FAILED",
        },
        error: null,
      };
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("INELIGIBLE_PAYMENT_INTENT");
    });

    it("returns 409 Retry-After when concurrent worker holds active capture lease", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
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
        if (rpcName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: {
              success: false,
              error: "LEASE_ACTIVE",
              lease_expires_at: new Date(Date.now() + 30000).toISOString(),
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(409);
      expect(res.headers.get("Retry-After")).toBe("3");
      const json = await res.json();
      expect(json.error).toBe("CAPTURE_IN_PROGRESS");
    });
  });

  // ==========================================================================
  // 4. SUCCESSFUL CAPTURE & PROVIDER DISPATCH
  // ==========================================================================
  describe("4. PayPal Capture Execution and Verification", () => {
    it("successfully captures from ORDER_CREATED with Prefer: return=representation and records in ledger", async () => {
      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
      expect(json.captureId).toBe(validCaptureId);

      // Verify PayPal capture request
      expect(mockPayPalPost).toHaveBeenCalledWith(
        `/v2/checkout/orders/${validOrderId}/capture`,
        {},
        expect.objectContaining({
          paypalRequestId: validCaptureIdempotencyKey,
          headers: { Prefer: "return=representation" },
        })
      );

      // Verify DB persistence RPC called with lease token
      expect(mockRpc).toHaveBeenCalledWith(
        "record_paypal_order_captured",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_lease_token: validLeaseToken,
          p_provider_capture_id: validCaptureId,
          p_capture_status: "COMPLETED",
          p_amount_cents: 150000,
          p_payee_merchant_id: validExpectedMerchantId,
        })
      );
    });

    it("successfully captures from BUYER_APPROVED", async () => {
      mockPaymentIntentResult = {
        data: {
          ...(mockPaymentIntentResult.data as object),
          status: "BUYER_APPROVED",
        },
        error: null,
      };

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
    });

    it("falls back to GET /v2/checkout/orders/{id} when capture response is minimal", async () => {
      mockPayPalPost.mockResolvedValueOnce({
        data: { id: validOrderId, status: "COMPLETED" }, // minimal, no purchase_units
        status: 200,
        headers: new Headers(),
      });

      mockPayPalGet.mockResolvedValueOnce({
        data: validPayPalCaptureResponse, // full details on GET
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(200);
      expect(mockPayPalGet).toHaveBeenCalledWith(`/v2/checkout/orders/${validOrderId}`);
    });
  });

  // ==========================================================================
  // 5. AMBIGUOUS PROVIDER OUTCOMES & RECOVERY
  // ==========================================================================
  describe("5. Ambiguous Provider Outcomes Handling", () => {
    it("recovers completed capture when POST times out but GET confirms capture succeeded", async () => {
      // POST times out with 408
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({
          message: "Request timed out",
          status: 408,
          errorName: "REQUEST_TIMEOUT",
        })
      );

      // Subsequent GET confirms order has completed capture
      mockPayPalGet.mockResolvedValueOnce({
        data: validPayPalCaptureResponse,
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
      expect(mockRpc).toHaveBeenCalledWith(
        "record_paypal_order_captured",
        expect.anything()
      );
    });

    it("safely releases lease when POST times out and GET confirms order was NOT captured", async () => {
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({
          message: "Request timed out",
          status: 408,
          errorName: "REQUEST_TIMEOUT",
        })
      );

      // GET reveals order is still in APPROVED status without captures
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          id: validOrderId,
          status: "APPROVED",
          purchase_units: [{ reference_id: validMilestoneId }],
        },
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(504);
      const json = await res.json();
      expect(json.error).toBe("PROVIDER_TIMEOUT");

      // Verify lease was safely released
      expect(mockRpc).toHaveBeenCalledWith(
        "release_order_capture_lease",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_lease_token: validLeaseToken,
          p_target_status: "ORDER_CREATED",
        })
      );
    });

    it("escalates to RECONCILIATION_REQUIRED when POST times out and GET inquiry also fails", async () => {
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({
          message: "Request timed out",
          status: 408,
          errorName: "REQUEST_TIMEOUT",
        })
      );

      // GET also fails
      mockPayPalGet.mockRejectedValueOnce(new Error("Network connection reset"));

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(504);
      const json = await res.json();
      expect(json.error).toBe("PROVIDER_TIMEOUT");

      // Verify intent transitioned to RECONCILIATION_REQUIRED with lease token
      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_lease_token: validLeaseToken,
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_TIMEOUT,
        })
      );
    });

    it("escalates to RECONCILIATION_REQUIRED on PayPal 500 error when GET inquiry fails", async () => {
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({
          message: "Internal Server Error",
          status: 500,
          errorName: "INTERNAL_SERVER_ERROR",
        })
      );

      mockPayPalGet.mockRejectedValueOnce(new Error("Network error"));

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(502);

      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_lease_token: validLeaseToken,
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_PROVIDER_ERROR,
        })
      );
    });

    it("recovers completed capture when PayPal returns 422 ORDER_ALREADY_CAPTURED", async () => {
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({
          message: "Order already captured",
          status: 422,
          details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
        })
      );

      mockPayPalGet.mockResolvedValueOnce({
        data: validPayPalCaptureResponse,
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
    });

    it("handles INSTRUMENT_DECLINED by releasing lease and returning 400 PAYMENT_DECLINED", async () => {
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({
          message: "Payment method declined",
          status: 422,
          details: [{ issue: "INSTRUMENT_DECLINED" }],
        })
      );

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PAYMENT_DECLINED");

      expect(mockRpc).toHaveBeenCalledWith(
        "release_order_capture_lease",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_lease_token: validLeaseToken,
          p_target_status: "ORDER_CREATED",
        })
      );
    });
  });

  // ==========================================================================
  // 6. CONTRACT DISCREPANCIES & FINANCIAL INTEGRITY
  // ==========================================================================
  describe("6. Contract Discrepancies and Verification", () => {
    it("escalates to RECONCILIATION_REQUIRED when capture amount mismatches intent", async () => {
      const mismatchedCapture = JSON.parse(JSON.stringify(validPayPalCaptureResponse));
      mismatchedCapture.purchase_units[0].payments.captures[0].amount.value = "1400.00"; // expected 1500.00

      mockPayPalPost.mockResolvedValueOnce({
        data: mismatchedCapture,
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(502);

      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_AMOUNT_MISMATCH,
        })
      );
    });

    it("escalates to RECONCILIATION_REQUIRED when capture currency is not USD", async () => {
      const mismatchedCapture = JSON.parse(JSON.stringify(validPayPalCaptureResponse));
      mismatchedCapture.purchase_units[0].payments.captures[0].amount.currency_code = "EUR";

      mockPayPalPost.mockResolvedValueOnce({
        data: mismatchedCapture,
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(502);

      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_CURRENCY_MISMATCH,
        })
      );
    });

    it("escalates to RECONCILIATION_REQUIRED when payee merchant ID does not match", async () => {
      const mismatchedCapture = JSON.parse(JSON.stringify(validPayPalCaptureResponse));
      mismatchedCapture.purchase_units[0].payments.captures[0].payee.merchant_id = "ROGUE_MERCHANT";
      mismatchedCapture.purchase_units[0].payee.merchant_id = "ROGUE_MERCHANT";

      mockPayPalPost.mockResolvedValueOnce({
        data: mismatchedCapture,
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(502);

      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_MERCHANT_MISMATCH,
        })
      );
    });

    it("escalates to RECONCILIATION_REQUIRED when purchase_unit reference_id does not match milestone ID", async () => {
      const mismatchedCapture = JSON.parse(JSON.stringify(validPayPalCaptureResponse));
      mismatchedCapture.purchase_units[0].reference_id = "b9999999-0000-4000-a000-000000000009";

      mockPayPalPost.mockResolvedValueOnce({
        data: mismatchedCapture,
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(502);

      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_REFERENCE_ID_MISMATCH,
        })
      );
    });

    it("handles PENDING capture status with 202 and moves intent to RECONCILIATION_REQUIRED", async () => {
      const pendingCapture = JSON.parse(JSON.stringify(validPayPalCaptureResponse));
      pendingCapture.purchase_units[0].payments.captures[0].status = "PENDING";

      mockPayPalPost.mockResolvedValueOnce({
        data: pendingCapture,
        status: 200,
        headers: new Headers(),
      });

      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
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
        if (rpcName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: {
              success: true,
              claimed: true,
              lease_token: validLeaseToken,
              already_completed: false,
            },
            error: null,
          });
        }
        if (rpcName === "record_paypal_order_captured") {
          return Promise.resolve({
            data: {
              success: true,
              status: "PENDING",
              capture_id: validCaptureId,
              reconciliation_required: true,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.status).toBe("PENDING");
      expect(json.captureId).toBe(validCaptureId);

      expect(mockRpc).toHaveBeenCalledWith(
        "record_paypal_order_captured",
        expect.objectContaining({
          p_capture_status: "PENDING",
        })
      );
    });

    it("returns 409 when database returns STALE_LEASE_TOKEN during persistence", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
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
        if (rpcName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: {
              success: true,
              claimed: true,
              lease_token: validLeaseToken,
              already_completed: false,
            },
            error: null,
          });
        }
        if (rpcName === "record_paypal_order_captured") {
          return Promise.resolve({
            data: {
              success: false,
              error: "STALE_LEASE_TOKEN",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("CAPTURE_CLAIM_FAILED");
    });

    // ========================================================================
    // FINDING F-03: TOP-LEVEL PAYPAL ORDER ID VALIDATION
    // ========================================================================
    it("escalates to RECONCILIATION_REQUIRED when PayPal capture response is missing order.id", async () => {
      mockPayPalPost.mockResolvedValueOnce({
        status: 201,
        data: {
          ...validPayPalCaptureResponse,
          id: undefined,
        },
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(502);

      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_ORDER_ID_MISMATCH,
        })
      );
    });

    it("escalates to RECONCILIATION_REQUIRED when PayPal capture response has empty order.id", async () => {
      mockPayPalPost.mockResolvedValueOnce({
        status: 201,
        data: {
          ...validPayPalCaptureResponse,
          id: "   ",
        },
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(502);

      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_ORDER_ID_MISMATCH,
        })
      );
    });

    it("escalates to RECONCILIATION_REQUIRED when PayPal capture response order.id mismatches cleanOrderId", async () => {
      mockPayPalPost.mockResolvedValueOnce({
        status: 201,
        data: {
          ...validPayPalCaptureResponse,
          id: "DIFFERENT_ORDER_ID_99999",
        },
      });

      const { request, context } = createRequest({});
      const res = await POST(request, context);
      expect(res.status).toBe(502);

      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_ORDER_ID_MISMATCH,
        })
      );
    });
  });
});
