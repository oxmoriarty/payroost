import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { POST } from "./route";
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

describe("POST /api/public/portal/[token]/payments/capture", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTrustProxy = process.env.TRUST_PROXY;

  const validToken = "valid-portal-token-for-client-capture-test-12345";
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

  // Valid GET order response: Status APPROVED
  const validApprovedPayPalOrder = {
    id: validOrderId,
    status: "APPROVED",
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
      },
    ],
  };

  // Valid POST capture response: Status COMPLETED
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
    body?: unknown;
    csrfToken?: string;
    cookieValue?: string;
    ip?: string;
  }): Request {
    const headers = new Headers();
    if (options.csrfToken !== undefined) {
      if (options.csrfToken !== null) {
        headers.set("x-csrf-token", options.csrfToken);
      }
    } else {
      headers.set("x-csrf-token", validCsrfSecret);
    }

    if (options.ip) headers.set("x-forwarded-for", options.ip);

    if (options.cookieValue !== undefined) {
      mockCookieStore.get.mockImplementation((name: string) => {
        if (name === PORTAL_SESSION_COOKIE_NAME_DEV) {
          return { name, value: options.cookieValue };
        }
        return undefined;
      });
    } else {
      mockCookieStore.get.mockImplementation((name: string) => {
        if (name === PORTAL_SESSION_COOKIE_NAME_DEV) {
          return { name, value: validRawSessionToken };
        }
        return undefined;
      });
    }

    const init: RequestInit = {
      method: "POST",
      headers,
    };

    if (options.body !== undefined) {
      init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    } else {
      init.body = JSON.stringify({ orderId: validOrderId });
    }

    return new Request(`https://payroost.test/api/public/portal/${validToken}/payments/capture`, init);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    delete process.env.TRUST_PROXY;

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
      if (fnName === "release_order_capture_lease") {
        return Promise.resolve({
          data: {
            success: true,
            released: true,
            status: "ORDER_CREATED",
          },
          error: null,
        });
      }
      if (fnName === "record_paypal_order_captured") {
        return Promise.resolve({
          data: {
            success: true,
            payment_intent_id: validIntentId,
            status: "COMPLETED",
            capture_id: validCaptureId,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    mockPayPalGet.mockResolvedValue({ data: validApprovedPayPalOrder });
    mockPayPalPost.mockResolvedValue({ data: validPayPalCaptureResponse });
  });

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    if (originalTrustProxy !== undefined) {
      process.env.TRUST_PROXY = originalTrustProxy;
    } else {
      delete process.env.TRUST_PROXY;
    }
  });

  // ==========================================================================
  // SECTION 1: AUTHENTICATION AND REQUEST VALIDATION
  // [Classification: Mocked unit test]
  // ==========================================================================
  describe("1. Authentication and Request Validation", () => {
    it("rejects request when CSRF token is missing", async () => {
      const req = createRequest({ csrfToken: "" });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("INVALID_CSRF_TOKEN");
    });

    it("rejects request when portal session is expired or revoked", async () => {
      mockRpc.mockImplementation((fnName: string) => {
        if (fnName === "validate_portal_session") {
          return Promise.resolve({
            data: { valid: false, reason: "ABSOLUTE_EXPIRY" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("SESSION_EXPIRED");
    });

    it("rejects request when token format is invalid", async () => {
      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: "short" }) });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("INVITATION_NOT_FOUND");
    });

    it("rejects request with missing orderId in body", async () => {
      const req = createRequest({ csrfToken: validCsrfSecret, body: {} });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
    });

    it("rejects request with extraneous fields (e.g. amount, status) in body", async () => {
      const req = createRequest({
        csrfToken: validCsrfSecret,
        body: { orderId: validOrderId, amount: "1500.00", status: "COMPLETED" },
      });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
    });

    it("rejects request when rate limited", async () => {
      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
        allowed: false,
        current: 11,
        limit: 10,
        resetAt: Date.now() + 900_000,
        status: "rate_limited",
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error).toBe("RATE_LIMITED");
    });
  });

  // ==========================================================================
  // SECTION 2: SERVER-SIDE APPROVAL VERIFICATION
  // [Classification: Mocked unit test]
  // ==========================================================================
  describe("2. Server-Side Approval Verification (GET /v2/checkout/orders/{id})", () => {
    it("proceeds to capture when PayPal order is strictly APPROVED", async () => {
      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(200);
      expect(mockPayPalGet).toHaveBeenCalledWith(
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}`
      );
      expect(mockPayPalPost).toHaveBeenCalledWith(
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}/capture`,
        {},
        expect.objectContaining({ paypalRequestId: validCaptureIdempotencyKey })
      );
    });

    it("rejects capture when PayPal order is in CREATED status (not yet approved)", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validApprovedPayPalOrder,
          status: "CREATED",
        },
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("ORDER_NOT_APPROVED");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects capture when PayPal order is in PAYER_ACTION_REQUIRED status", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validApprovedPayPalOrder,
          status: "PAYER_ACTION_REQUIRED",
        },
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("ORDER_NOT_APPROVED");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("recovers and returns completed payment when PayPal order is already COMPLETED", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
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
        },
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
        return Promise.resolve({ data: null, error: null });
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe("COMPLETED");
      expect(json.captureId).toBe(validCaptureId);
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects capture when purchase unit custom_id does not match payment intent UUID", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validApprovedPayPalOrder,
          purchase_units: [
            {
              ...validApprovedPayPalOrder.purchase_units[0],
              custom_id: "d0000000-0000-4000-a000-000000000999", // Wrong intent
            },
          ],
        },
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("ORDER_BINDING_MISMATCH");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects capture when purchase unit reference_id does not match milestone UUID", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validApprovedPayPalOrder,
          purchase_units: [
            {
              ...validApprovedPayPalOrder.purchase_units[0],
              reference_id: "b0000000-0000-4000-a000-000000000999", // Wrong milestone
            },
          ],
        },
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("ORDER_BINDING_MISMATCH");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects capture when PayPal amount value does not match expected canonical amount", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validApprovedPayPalOrder,
          purchase_units: [
            {
              ...validApprovedPayPalOrder.purchase_units[0],
              amount: { currency_code: "USD", value: "999.00" }, // Mismatched amount
            },
          ],
        },
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("AMOUNT_MISMATCH");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects capture when payee merchant ID does not match expected merchant", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validApprovedPayPalOrder,
          purchase_units: [
            {
              ...validApprovedPayPalOrder.purchase_units[0],
              payee: { merchant_id: "ROGUE_MERCHANT_999" },
            },
          ],
        },
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(502);
      const json = await res.json();
      expect(json.error).toBe("MERCHANT_MISMATCH");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects capture when order has multiple purchase units", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validApprovedPayPalOrder,
          purchase_units: [
            validApprovedPayPalOrder.purchase_units[0],
            validApprovedPayPalOrder.purchase_units[0],
          ],
        },
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("INVALID_PURCHASE_UNITS");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SECTION 3: CAPTURE LEASE & CONCURRENCY
  // [Classification: Mocked unit test]
  // ==========================================================================
  describe("3. Capture Lease and Concurrency Fencing", () => {
    it("returns 409 CAPTURE_IN_PROGRESS with Retry-After when an active lease is held", async () => {
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

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(409);
      expect(res.headers.get("Retry-After")).toBe("3");
      const json = await res.json();
      expect(json.error).toBe("CAPTURE_IN_PROGRESS");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("returns completed payment result immediately if order was already completed (idempotency)", async () => {
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

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("COMPLETED");
      expect(json.captureId).toBe(validCaptureId);
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SECTION 4: CAPTURE REQUEST & RESPONSE VALIDATION
  // [Classification: Mocked unit test]
  // ==========================================================================
  describe("4. Capture Request & Response Validation", () => {
    it("handles INSTRUMENT_DECLINED by releasing lease and returning 400 PAYMENT_DECLINED", async () => {
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({
          message: "Payment instrument declined",
          status: 422,
          details: [{ issue: "INSTRUMENT_DECLINED" }],
        })
      );

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PAYMENT_DECLINED");
      expect(mockRpc).toHaveBeenCalledWith("release_order_capture_lease", {
        p_session_token_hash: expect.any(String),
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
        p_target_status: "ORDER_CREATED",
      });
    });

    it("handles capture timeout by querying order and marking RECONCILIATION_REQUIRED if inconclusive", async () => {
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({
          message: "Gateway timeout",
          status: 408,
          errorName: "REQUEST_TIMEOUT",
        })
      );

      // Subsequent GET returns error as well
      mockPayPalGet
        .mockResolvedValueOnce({ data: validApprovedPayPalOrder }) // First GET for approval
        .mockRejectedValueOnce(new Error("Network failed")); // Recovery GET fails

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(504);
      expect(mockRpc).toHaveBeenCalledWith("mark_intent_capture_reconciliation_required", {
        p_session_token_hash: expect.any(String),
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
        p_reason_code: "PAYPAL_CAPTURE_TIMEOUT",
      });
    });

    it("handles database persistence failure after successful PayPal capture", async () => {
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
            data: { success: true, claimed: true, lease_token: validLeaseToken },
            error: null,
          });
        }
        if (fnName === "record_paypal_order_captured") {
          return Promise.resolve({
            data: null,
            error: { message: "Disk full / deadlock" },
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const req = createRequest({ csrfToken: validCsrfSecret });
      const res = await POST(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("DATABASE_PERSISTENCE_FAILED");
    });
  });
});
