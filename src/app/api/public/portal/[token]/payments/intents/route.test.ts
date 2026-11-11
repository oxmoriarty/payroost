import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  POST,
  formatMinorToCanonicalUsd,
  ACTIVE_PAYMENT_INTENT_STATUSES,
} from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as clientIpModule from "@/lib/security/client-ip";
import * as paypalEnvModule from "@/lib/paypal/env";
import { hashSessionToken } from "@/lib/security/tokens";
import { PORTAL_SESSION_COOKIE_NAME_DEV } from "@/lib/security/portal-session";

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

describe("POST /api/public/portal/[token]/payments/intents", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTrustProxy = process.env.TRUST_PROXY;

  const validToken = "valid-portal-token-for-client-intent-test-12345";
  const validRawSessionToken = "valid-test-portal-session-token-43-chars___";
  const validSessionTokenHash = hashSessionToken(validRawSessionToken);
  const validCsrfSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  const validProjectId = "c0000000-0000-4000-a000-000000000001";
  const validMilestoneId = "b0000000-0000-4000-a000-000000000001";
  const validSessionId = "e0000000-0000-4000-a000-000000000001";
  const validClientEmail = "client@acme-corp.com";
  const validExpectedMerchantId = "MERCHANT_ACME_12345";

  function createRequest(options: {
    token?: string;
    body?: unknown;
    csrfToken?: string | null;
    cookieToken?: string | null;
    headers?: Record<string, string>;
  }) {
    const routeToken = options.token ?? validToken;
    const bodyContent =
      options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : JSON.stringify({ milestoneId: validMilestoneId });

    const reqHeaders = new Headers(options.headers || {});
    reqHeaders.set("Content-Type", "application/json");

    if (options.csrfToken !== null) {
      reqHeaders.set("x-csrf-token", options.csrfToken ?? validCsrfSecret);
    }

    const request = new Request(
      `https://payroost.com/api/public/portal/${routeToken}/payments/intents`,
      {
        method: "POST",
        headers: reqHeaders,
        body: bodyContent,
      }
    );

    const context = {
      params: Promise.resolve({ token: routeToken }),
    };

    return { request, context };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.TRUST_PROXY = "false";

    // Default cookie setup: valid development session cookie
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

    // Default PayPal configuration (Explicit isolated legacy Merchant mode for 3B.3 unit suite)
    vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
      environment: "sandbox",
      baseUrl: "https://api-m.sandbox.paypal.com",
      clientId: "CLIENT_ID_123",
      clientSecret: "CLIENT_SECRET_123",
      expectedMerchantId: validExpectedMerchantId,
      paymentMode: "MERCHANT",
    });

    // Default database tables mock
    mockFrom.mockImplementation((table: string) => {
      if (table === "client_portal_tokens") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    project_id: validProjectId,
                    revoked_at: null,
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "milestones") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: validMilestoneId,
                    project_id: validProjectId,
                    agreement_version_id: "a0000000-0000-4000-a000-000000000001",
                    title: "Phase 1 Deliverables",
                    amount_minor: 150000, // $1,500.00
                    currency: "USD",
                    status: "APPROVED",
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "payment_intents") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            in: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      };
    });

    // Default RPC mock: validate_portal_session and create_client_payment_intent
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
      if (rpcName === "create_client_payment_intent") {
        return Promise.resolve({
          data: "intent-uuid-0000-0000-0000-000000000001",
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    process.env.TRUST_PROXY = originalTrustProxy;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Success Path & RPC Contract Assertions
  // ==========================================================================
  it("1. successfully creates payment intent and returns 201 with intent ID and ORDER_CREATING status", async () => {
    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.json();
    expect(body).toEqual({
      success: true,
      paymentIntentId: "intent-uuid-0000-0000-0000-000000000001",
      status: "ORDER_CREATING",
    });

    // Verify create_client_payment_intent RPC invocation
    expect(mockRpc).toHaveBeenCalledWith("create_client_payment_intent", expect.any(Object));

    const rpcCall = mockRpc.mock.calls.find((c) => c[0] === "create_client_payment_intent");
    expect(rpcCall).toBeDefined();

    const args = rpcCall![1] as {
      p_session_token_hash: string;
      p_milestone_id: string;
      p_expected_merchant_id: string;
      p_order_idempotency_key: string;
      p_capture_idempotency_key: string;
      p_canonical_payload: {
        purchase_units: Array<{
          reference_id: string;
          custom_id: string;
          amount: { currency_code: string; value: string };
          payee: { merchant_id: string };
        }>;
      };
    };

    expect(args.p_session_token_hash).toBe(validSessionTokenHash);
    expect(args.p_milestone_id).toBe(validMilestoneId);
    expect(args.p_expected_merchant_id).toBe(validExpectedMerchantId);
    expect(args.p_order_idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.p_capture_idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.p_order_idempotency_key).not.toBe(args.p_capture_idempotency_key);

    // Canonical purchase unit validations
    expect(args.p_canonical_payload.purchase_units).toHaveLength(1);
    const pu = args.p_canonical_payload.purchase_units[0];
    expect(pu.reference_id).toBe(validMilestoneId);
    expect(pu.custom_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(pu.amount.currency_code).toBe("USD");
    expect(pu.amount.value).toBe("1500.00");
    expect(pu.payee.merchant_id).toBe(validExpectedMerchantId);
  });

  // ==========================================================================
  // 2. BigInt Monetary Formatting & Financial Integrity
  // ==========================================================================
  describe("BigInt formatMinorToCanonicalUsd", () => {
    it("converts 1 minor unit to '0.01'", () => {
      expect(formatMinorToCanonicalUsd(1)).toBe("0.01");
      expect(formatMinorToCanonicalUsd(1n)).toBe("0.01");
      expect(formatMinorToCanonicalUsd("1")).toBe("0.01");
    });

    it("converts 10 minor units to '0.10'", () => {
      expect(formatMinorToCanonicalUsd(10)).toBe("0.10");
      expect(formatMinorToCanonicalUsd(10n)).toBe("0.10");
      expect(formatMinorToCanonicalUsd("10")).toBe("0.10");
    });

    it("converts 99 minor units to '0.99'", () => {
      expect(formatMinorToCanonicalUsd(99)).toBe("0.99");
      expect(formatMinorToCanonicalUsd(99n)).toBe("0.99");
    });

    it("converts 100 minor units to '1.00'", () => {
      expect(formatMinorToCanonicalUsd(100)).toBe("1.00");
      expect(formatMinorToCanonicalUsd(100n)).toBe("1.00");
    });

    it("converts 101 minor units to '1.01'", () => {
      expect(formatMinorToCanonicalUsd(101)).toBe("1.01");
      expect(formatMinorToCanonicalUsd(101n)).toBe("1.01");
    });

    it("converts 999999 minor units to '9999.99'", () => {
      expect(formatMinorToCanonicalUsd(999999)).toBe("9999.99");
      expect(formatMinorToCanonicalUsd(999999n)).toBe("9999.99");
    });

    it("converts large valid safe database integers without precision loss", () => {
      expect(formatMinorToCanonicalUsd(100000000000n)).toBe("1000000000.00");
      expect(formatMinorToCanonicalUsd("9007199254740991")).toBe("90071992547409.91");
    });

    it("strictly rejects zero and negative amounts", () => {
      expect(() => formatMinorToCanonicalUsd(0)).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd(0n)).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd(-1)).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd(-15000n)).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd("-50")).toThrow("INVALID_MILESTONE_AMOUNT");
    });

    it("strictly rejects non-integers, floats, and malformed inputs", () => {
      expect(() => formatMinorToCanonicalUsd(100.5)).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd("100.50")).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd("invalid")).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd(NaN)).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd(Infinity)).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd(null)).toThrow("INVALID_MILESTONE_AMOUNT");
      expect(() => formatMinorToCanonicalUsd(undefined)).toThrow("INVALID_MILESTONE_AMOUNT");
    });

    it("returns 400 INVALID_MILESTONE_AMOUNT in route when milestone amount_minor is invalid", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: -500, // Invalid negative
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("INVALID_MILESTONE_AMOUNT");
    });
  });

  // ==========================================================================
  // 3. Idempotency & Safe Retry Resolution
  // ==========================================================================
  describe("Idempotency and Safe Retry Resolution", () => {
    it("defines the exact active payment intent statuses matching database index", () => {
      expect(ACTIVE_PAYMENT_INTENT_STATUSES).toEqual([
        "ORDER_CREATING",
        "ORDER_CREATED",
        "BUYER_APPROVED",
        "CAPTURING",
        "RECONCILING",
      ]);
    });

    it("repeated request returns existing active intent (200 OK) without calling create RPC", async () => {
      const existingIntentId = "intent-existing-0000-0000-000000000001";

      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "payment_intents") {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: existingIntentId,
                        project_id: validProjectId,
                        milestone_id: validMilestoneId,
                        status: "ORDER_CREATING",
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        success: true,
        paymentIntentId: existingIntentId,
        status: "ORDER_CREATING",
      });

      // Assert create_client_payment_intent RPC was NOT called
      expect(mockRpc).not.toHaveBeenCalledWith("create_client_payment_intent", expect.any(Object));
    });

    it("returns existing eligible intent when in ORDER_CREATED or BUYER_APPROVED status (200 OK)", async () => {
      for (const status of ["ORDER_CREATED", "BUYER_APPROVED"] as const) {
        mockFrom.mockImplementation((table: string) => {
          if (table === "client_portal_tokens") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
                }),
              }),
            };
          }
          if (table === "milestones") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: validMilestoneId,
                        project_id: validProjectId,
                        amount_minor: 150000,
                        currency: "USD",
                        status: "APPROVED",
                      },
                      error: null,
                    }),
                }),
              }),
            };
          }
          if (table === "payment_intents") {
            return {
              select: () => ({
                eq: () => ({
                  in: () => ({
                    maybeSingle: () =>
                      Promise.resolve({
                        data: {
                          id: "intent-active-status-test",
                          project_id: validProjectId,
                          milestone_id: validMilestoneId,
                          status,
                        },
                        error: null,
                      }),
                  }),
                }),
              }),
            };
          }
          return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
        });

        const { request, context } = createRequest({});
        const response = await POST(request, context);

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
          success: true,
          paymentIntentId: "intent-active-status-test",
          status,
        });
      }
    });

    it("recovers original payment intent after simulated lost response / network retry", async () => {
      // First attempt: succeeds and returns 201
      const { request: req1, context: ctx1 } = createRequest({});
      const resp1 = await POST(req1, ctx1);
      expect(resp1.status).toBe(201);
      const body1 = await resp1.json();
      const generatedIntentId = body1.paymentIntentId;

      // Second attempt (retry after network drop): preflight detects the intent created by attempt 1
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "payment_intents") {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: generatedIntentId,
                        project_id: validProjectId,
                        milestone_id: validMilestoneId,
                        status: "ORDER_CREATING",
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      });

      const { request: req2, context: ctx2 } = createRequest({});
      const resp2 = await POST(req2, ctx2);

      expect(resp2.status).toBe(200);
      const body2 = await resp2.json();
      expect(body2.paymentIntentId).toBe(generatedIntentId);
      expect(body2.status).toBe("ORDER_CREATING");
    });

    it("concurrent race condition: losing request resolves unique-index conflict to winning intent (200 OK)", async () => {
      const winningIntentId = "winning-concurrent-intent-uuid-1234";

      // Preflight returns null (both requests started at the exact same time)
      // RPC returns unique constraint error 23505 (payment_intents_one_active_per_milestone_idx)
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
        if (rpcName === "create_client_payment_intent") {
          return Promise.resolve({
            data: null,
            error: {
              code: "23505",
              message: 'duplicate key value violates unique constraint "payment_intents_one_active_per_milestone_idx"',
            },
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      let lookupCallCount = 0;
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "payment_intents") {
          lookupCallCount++;
          // First call (preflight) returns null; Second call (after 23505 conflict) returns winning intent
          const resultData =
            lookupCallCount === 1
              ? null
              : {
                  id: winningIntentId,
                  project_id: validProjectId,
                  milestone_id: validMilestoneId,
                  status: "ORDER_CREATING",
                };

          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  maybeSingle: () => Promise.resolve({ data: resultData, error: null }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        success: true,
        paymentIntentId: winningIntentId,
        status: "ORDER_CREATING",
      });
    });

    it("falls back to 409 PAYMENT_INTENT_CONFLICT if concurrent winning intent lookup fails", async () => {
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
        if (rpcName === "create_client_payment_intent") {
          return Promise.resolve({
            data: null,
            error: {
              code: "23505",
              message: 'duplicate key value violates unique constraint "payment_intents_one_active_per_milestone_idx"',
            },
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        // payment_intents always returns null
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("PAYMENT_INTENT_CONFLICT");
    });

    it("returns 403 FORBIDDEN if existing intent belongs to a different project", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "payment_intents") {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: "intent-wrong-project-uuid",
                        project_id: "other-project-uuid-9999", // Mismatch
                        milestone_id: validMilestoneId,
                        status: "ORDER_CREATING",
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("returns 409 MILESTONE_ALREADY_COMPLETED when preflight finds COMPLETED intent", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "payment_intents") {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: "completed-intent-uuid",
                        project_id: validProjectId,
                        milestone_id: validMilestoneId,
                        status: "COMPLETED",
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("MILESTONE_ALREADY_COMPLETED");
    });

    it("returns 409 RECONCILIATION_REQUIRED when preflight finds RECONCILIATION_REQUIRED intent", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "payment_intents") {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: "reconciliation-intent-uuid",
                        project_id: validProjectId,
                        milestone_id: validMilestoneId,
                        status: "RECONCILIATION_REQUIRED",
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("RECONCILIATION_REQUIRED");
    });

    it("allows creating a new intent when earlier intents were FAILED or CANCELLED (not active)", async () => {
      // Inactive statuses are filtered out by the .in('status', [...]) query, returning null
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === "payment_intents") {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  // No active row found (previous failed/cancelled intent ignored)
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.status).toBe("ORDER_CREATING");
      expect(mockRpc).toHaveBeenCalledWith("create_client_payment_intent", expect.any(Object));
    });
  });

  // ==========================================================================
  // 4. Token Format & Invitation Validation
  // ==========================================================================
  describe("Token Format & Invitation Validation", () => {
    it("returns 404 INVITATION_NOT_FOUND when URL token format is invalid", async () => {
      const { request, context } = createRequest({ token: "too-short" });
      const response = await POST(request, context);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("INVITATION_NOT_FOUND");
    });

    it("returns 404 INVITATION_NOT_FOUND when portal token does not exist in database", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("INVITATION_NOT_FOUND");
    });

    it("returns 404 INVITATION_NOT_FOUND when portal token has been revoked", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: { project_id: validProjectId, revoked_at: new Date().toISOString() },
                    error: null,
                  }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("INVITATION_NOT_FOUND");
    });
  });

  // ==========================================================================
  // 5. Rate Limiting
  // ==========================================================================
  describe("Rate Limiting", () => {
    it("returns 429 RATE_LIMITED when primary token rate limit is exhausted", async () => {
      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
        allowed: false,
        current: 11,
        limit: 10,
        resetAt: Date.now() + 60000,
        status: "rate_limited",
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error).toBe("RATE_LIMITED");
    });

    it("returns 503 RATE_LIMITER_UNAVAILABLE when database rate limiter fails closed", async () => {
      vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValueOnce({
        allowed: false,
        current: 0,
        limit: 10,
        resetAt: Date.now() + 60000,
        status: "service_unavailable",
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("RATE_LIMITER_UNAVAILABLE");
    });

    it("enforces secondary IP rate limiting when TRUST_PROXY is true", async () => {
      process.env.TRUST_PROXY = "true";
      vi.spyOn(clientIpModule, "getClientIp").mockReturnValue("203.0.113.195");

      vi.spyOn(rateLimitModule, "checkRateLimit")
        .mockResolvedValueOnce({
          allowed: true,
          current: 1,
          limit: 10,
          resetAt: Date.now() + 60000,
          status: "allowed",
        })
        .mockResolvedValueOnce({
          allowed: false,
          current: 11,
          limit: 10,
          resetAt: Date.now() + 60000,
          status: "rate_limited",
        });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error).toBe("RATE_LIMITED");
    });
  });

  // ==========================================================================
  // 6. CSRF Protection
  // ==========================================================================
  describe("CSRF Protection", () => {
    it("returns 403 INVALID_CSRF_TOKEN when x-csrf-token header is missing", async () => {
      const { request, context } = createRequest({ csrfToken: null });
      const response = await POST(request, context);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("INVALID_CSRF_TOKEN");
    });

    it("returns 403 INVALID_CSRF_TOKEN when x-csrf-token does not match database secret", async () => {
      const wrongSecret = "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1";
      const { request, context } = createRequest({ csrfToken: wrongSecret });
      const response = await POST(request, context);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("INVALID_CSRF_TOKEN");
    });
  });

  // ==========================================================================
  // 7. Request Body Validation & Prohibited Financial Overrides
  // ==========================================================================
  describe("Request Body Validation", () => {
    it("returns 400 VALIDATION_ERROR when request body is empty or malformed JSON", async () => {
      const { request, context } = createRequest({ body: "not-json" });
      const response = await POST(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 VALIDATION_ERROR when milestoneId is not a valid UUID", async () => {
      const { request, context } = createRequest({ body: { milestoneId: "not-a-uuid" } });
      const response = await POST(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("strictly rejects client attempts to supply amount, currency, or merchant ID", async () => {
      const { request, context } = createRequest({
        body: {
          milestoneId: validMilestoneId,
          amount: "1.00",
          currency: "EUR",
          merchantId: "ATTACKER_MERCHANT",
        },
      });
      const response = await POST(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });
  });

  // ==========================================================================
  // 8. Session Authentication & Contextual Project Binding
  // ==========================================================================
  describe("Session Authentication & Contextual Project Binding", () => {
    it("returns 401 UNAUTHORIZED when session cookie is missing", async () => {
      mockCookieStore.get.mockReturnValue(undefined);

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("returns 403 FORBIDDEN when session belongs to a different project", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: validSessionId,
              projectId: "different-project-id-9999",
              clientEmail: validClientEmail,
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("returns 401 SESSION_EXPIRED when session has reached absolute timeout", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: false,
              reason: "ABSOLUTE_EXPIRY",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("SESSION_EXPIRED");
    });

    it("returns 401 SESSION_IDLE_TIMEOUT when session has reached idle timeout", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: false,
              reason: "IDLE_TIMEOUT",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("SESSION_IDLE_TIMEOUT");
    });
  });

  // ==========================================================================
  // 9. Milestone Eligibility & Server-Side Integrity
  // ==========================================================================
  describe("Milestone Eligibility", () => {
    it("returns 404 MILESTONE_NOT_FOUND when milestone does not exist", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("MILESTONE_NOT_FOUND");
    });

    it("returns 404 MILESTONE_NOT_FOUND when milestone belongs to a different project", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: "other-project-uuid",
                      amount_minor: 150000,
                      currency: "USD",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("MILESTONE_NOT_FOUND");
    });

    it("returns 400 MILESTONE_NOT_PAYABLE when milestone is in DRAFT status", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "USD",
                      status: "DRAFT",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("MILESTONE_NOT_PAYABLE");
    });

    it("returns 400 UNSUPPORTED_CURRENCY when milestone currency is not USD", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "client_portal_tokens") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { project_id: validProjectId, revoked_at: null }, error: null }),
              }),
            }),
          };
        }
        if (table === "milestones") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: validMilestoneId,
                      project_id: validProjectId,
                      amount_minor: 150000,
                      currency: "EUR",
                      status: "APPROVED",
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("UNSUPPORTED_CURRENCY");
    });
  });

  // ==========================================================================
  // 10. Missing Merchant Configuration
  // ==========================================================================
  describe("Merchant Configuration", () => {
    it("returns 500 CONFIGURATION_ERROR when PayPal server environment is missing merchant ID", async () => {
      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockImplementationOnce(() => {
        throw new Error("Invalid PayPal configuration: PAYPAL_EXPECTED_MERCHANT_ID is required");
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("CONFIGURATION_ERROR");
    });
  });

  // ==========================================================================
  // 11. Database RPC Error Sanitization
  // ==========================================================================
  describe("Database RPC Error Sanitization", () => {
    it("returns 403 CLIENT_EMAIL_UNVERIFIED when RPC raises client email is not verified", async () => {
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
        if (rpcName === "create_client_payment_intent") {
          return Promise.resolve({
            data: null,
            error: {
              message: "Forbidden: Project client email is not verified",
            },
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("CLIENT_EMAIL_UNVERIFIED");
    });

    it("returns sanitized 500 SERVER_ERROR on unknown database RPC failure", async () => {
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
        if (rpcName === "create_client_payment_intent") {
          return Promise.resolve({
            data: null,
            error: {
              message: "fatal internal error in plpgsql execution",
            },
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createRequest({});
      const response = await POST(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("SERVER_ERROR");
    });
  });
});
