import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { POST as createOrderPost } from "@/app/api/public/portal/[token]/payments/orders/route";
import { POST as createIntentPost } from "@/app/api/public/portal/[token]/payments/intents/route";
import { PayPalClient } from "@/lib/paypal/client";
import { PayPalAuthManager } from "@/lib/paypal/auth";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as paypalEnvModule from "@/lib/paypal/env";
import { hashSessionToken } from "@/lib/security/tokens";
import { PORTAL_SESSION_COOKIE_NAME_DEV } from "@/lib/security/portal-session";
import { PayPalError, type PayPalConfig } from "@/lib/paypal/types";

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

describe("Phase 3B.R2: PayPal Platform Multi-Party Order Creation", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTrustProxy = process.env.TRUST_PROXY;

  const validToken = "valid-portal-token-for-platform-orders-12345";
  const validRawSessionToken = "valid-test-portal-session-token-43-chars___";
  const validSessionTokenHash = hashSessionToken(validRawSessionToken);
  const validCsrfSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  const validProjectId = "c0000000-0000-4000-a000-000000000001";
  const validOwnerId = "u0000000-0000-4000-a000-000000000001";
  const validMilestoneId = "b0000000-0000-4000-a000-000000000001";
  const validIntentId = "d0000000-0000-4000-a000-000000000001";
  const validAgreementId = "f0000000-0000-4000-a000-000000000001";
  const validAgreementVersionId = "a0000000-0000-4000-a000-000000000001";
  const validLeaseToken = "e0000000-0000-4000-a000-000000000001";

  const validSellerMerchantId = "SELLER_SANDBOX_MERCHANT_123";
  const validPlatformPartnerId = "PARTNER_PLATFORM_MERCHANT_999";
  const validPartnerBnCode = "TEST_PAYPAL_ISSUED_BN_CODE";
  const validPlatformClientId = "PLATFORM_CLIENT_ID_XYZ";

  const validPlatformConfig: PayPalConfig = {
    environment: "sandbox",
    baseUrl: "https://api-m.sandbox.paypal.com",
    clientId: "CLIENT_ID_123",
    clientSecret: "CLIENT_SECRET_123",
    expectedMerchantId: "DEFAULT_MERCHANT_123",
    platformClientId: validPlatformClientId,
    partnerMerchantId: validPlatformPartnerId,
    partnerAttributionId: validPartnerBnCode,
    paymentMode: "PLATFORM",
  };

  const mockPayPalPost = vi.fn();
  const mockPayPalGet = vi.fn();

  function createOrderRequest(options: {
    token?: string;
    body?: unknown;
    csrfToken?: string | null;
    headers?: Record<string, string>;
  }) {
    const routeToken = options.token ?? validToken;
    const bodyContent =
      options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : JSON.stringify({
            paymentIntentId: validIntentId,
            milestoneId: validMilestoneId,
          });

    const reqHeaders = new Headers(options.headers || {});
    reqHeaders.set("Content-Type", "application/json");

    if (options.csrfToken !== null) {
      reqHeaders.set("x-csrf-token", options.csrfToken ?? validCsrfSecret);
    }

    const request = new Request(
      `https://payroost.com/api/public/portal/${routeToken}/payments/orders`,
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

  function createIntentRequest(options: {
    token?: string;
    body?: unknown;
    csrfToken?: string | null;
    headers?: Record<string, string>;
  }) {
    const routeToken = options.token ?? validToken;
    const bodyContent =
      options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : JSON.stringify({
            milestoneId: validMilestoneId,
          });

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

  let mockPortalTokenResult: unknown;
  let mockProjectResult: unknown;
  let mockFreelancerSellerResult: unknown;
  let mockPaymentIntentResult: unknown;
  let mockMilestoneResult: unknown;
  let mockAgreementVersionResult: unknown;
  let mockAgreementResult: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.TRUST_PROXY = "false";

    // Default cookie setup
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

    // Default PayPal configuration (Platform Marketplace)
    vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue(validPlatformConfig);

    // Mock PayPalClient methods
    vi.spyOn(PayPalClient.prototype, "post").mockImplementation(mockPayPalPost);
    vi.spyOn(PayPalClient.prototype, "get").mockImplementation(mockPayPalGet);

    // Default database tables setup
    mockPortalTokenResult = {
      data: { project_id: validProjectId, revoked_at: null },
      error: null,
    };

    mockProjectResult = {
      data: { id: validProjectId, owner_id: validOwnerId },
      error: null,
    };

    mockFreelancerSellerResult = {
      data: {
        id: "s0000000-0000-4000-a000-000000000001",
        user_id: validOwnerId,
        paypal_merchant_id: validSellerMerchantId,
        onboarding_status: "COMPLETED",
        payments_receivable: true,
        primary_email_confirmed: true,
        seller_email: "freelancer@sandbox.paypal.com",
      },
      error: null,
    };

    mockPaymentIntentResult = {
      data: {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        agreement_version_id: validAgreementVersionId,
        status: "ORDER_CREATING",
        expected_merchant_id: validSellerMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: "k0000000-0000-4000-a000-000000000001",
        provider_order_id: null,
        canonical_payload_json: {
          purchase_units: [
            {
              reference_id: validMilestoneId,
              custom_id: validIntentId,
              amount: { currency_code: "USD", value: "1500.00" },
              payee: { merchant_id: validSellerMerchantId },
            },
          ],
          payment_mode: "PLATFORM",
          seller_merchant_id: validSellerMerchantId,
          seller_payer_id: validSellerMerchantId,
        },
        order_creation_lease_expires_at: null,
        created_at: new Date().toISOString(),
      },
      error: null,
    };

    mockMilestoneResult = {
      data: {
        id: validMilestoneId,
        project_id: validProjectId,
        agreement_version_id: validAgreementVersionId,
        title: "Platform Milestone Deliverable",
        amount_minor: 150000,
        currency: "USD",
        status: "APPROVED",
      },
      error: null,
    };

    mockAgreementVersionResult = {
      data: {
        id: validAgreementVersionId,
        agreement_id: validAgreementId,
        status: "APPROVED",
      },
      error: null,
    };

    mockAgreementResult = {
      data: {
        id: validAgreementId,
        project_id: validProjectId,
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
      if (table === "projects") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(mockProjectResult),
            }),
          }),
        };
      }
      if (table === "freelancer_paypal_accounts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(mockFreelancerSellerResult),
            }),
          }),
        };
      }
      if (table === "payment_intents") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(mockPaymentIntentResult),
              in: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
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
      if (table === "agreement_versions") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(mockAgreementVersionResult),
            }),
          }),
        };
      }
      if (table === "agreements") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(mockAgreementResult),
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

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "validate_portal_session") {
        return Promise.resolve({
          data: {
            valid: true,
            sessionId: "session-123",
            projectId: validProjectId,
            clientEmail: "client@example.com",
            csrfSecret: validCsrfSecret,
          },
          error: null,
        });
      }
      if (rpcName === "claim_order_creation_lease") {
        return Promise.resolve({
          data: {
            success: true,
            claimed: true,
            lease_token: validLeaseToken,
            already_created: false,
          },
          error: null,
        });
      }
      if (rpcName === "release_order_creation_lease") {
        return Promise.resolve({
          data: { success: true, released: true },
          error: null,
        });
      }
      if (rpcName === "record_paypal_order_created") {
        return Promise.resolve({
          data: {
            success: true,
            already_recorded: false,
            provider_order_id: "PLATFORM-ORDER-001",
          },
          error: null,
        });
      }
      if (rpcName === "create_client_payment_intent") {
        return Promise.resolve({
          data: validIntentId,
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    // Default PayPal order creation response
    mockPayPalPost.mockResolvedValue({
      data: {
        id: "PLATFORM-ORDER-001",
        status: "CREATED",
        purchase_units: [
          {
            reference_id: validMilestoneId,
            custom_id: validIntentId,
            amount: { currency_code: "USD", value: "1500.00" },
            payee: { merchant_id: validSellerMerchantId },
          },
        ],
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PLATFORM-ORDER-001",
            rel: "approve",
            method: "GET",
          },
          {
            href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/PLATFORM-ORDER-001",
            rel: "self",
            method: "GET",
          },
        ],
      },
      status: 201,
      headers: new Headers(),
    });
  });

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    process.env.TRUST_PROXY = originalTrustProxy;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Seller Readiness & Validation Checks
  // ==========================================================================
  describe("Seller Readiness Validation", () => {
    it("rejects order creation when freelancer has no connected PayPal seller account", async () => {
      mockFreelancerSellerResult = { data: null, error: null };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("SELLER_NOT_CONNECTED");

      // Verify order creation lease was released
      expect(mockRpc).toHaveBeenCalledWith("release_order_creation_lease", expect.objectContaining({
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
      }));
      // Verify PayPal order was NEVER called
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects intent creation when freelancer has no connected seller account under Platform mode", async () => {
      mockFreelancerSellerResult = { data: null, error: null };

      const { request, context } = createIntentRequest({});
      const response = await createIntentPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("SELLER_NOT_CONNECTED");
    });

    it("rejects order creation when freelancer onboarding is incomplete (e.g. INITIATED)", async () => {
      mockFreelancerSellerResult = {
        data: {
          id: "s-123",
          user_id: validOwnerId,
          paypal_merchant_id: validSellerMerchantId,
          onboarding_status: "INITIATED",
          payments_receivable: false,
          primary_email_confirmed: false,
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("SELLER_ONBOARDING_INCOMPLETE");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects order creation when seller account is not payment receivable", async () => {
      mockFreelancerSellerResult = {
        data: {
          id: "s-123",
          user_id: validOwnerId,
          paypal_merchant_id: validSellerMerchantId,
          onboarding_status: "COMPLETED",
          payments_receivable: false,
          primary_email_confirmed: true,
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("SELLER_NOT_RECEIVABLE");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects order creation when seller primary email is unconfirmed", async () => {
      mockFreelancerSellerResult = {
        data: {
          id: "s-123",
          user_id: validOwnerId,
          paypal_merchant_id: validSellerMerchantId,
          onboarding_status: "COMPLETED",
          payments_receivable: true,
          primary_email_confirmed: false,
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("SELLER_EMAIL_UNCONFIRMED");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects order creation when seller merchant ID is malformed or missing", async () => {
      mockFreelancerSellerResult = {
        data: {
          id: "s-123",
          user_id: validOwnerId,
          paypal_merchant_id: "X", // too short (<3 chars)
          onboarding_status: "COMPLETED",
          payments_receivable: true,
          primary_email_confirmed: true,
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("SELLER_MERCHANT_ID_INVALID");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects order creation when seller account belongs to a different freelancer", async () => {
      mockFreelancerSellerResult = {
        data: {
          id: "s-123",
          user_id: "rogue-freelancer-user-uuid-999",
          paypal_merchant_id: validSellerMerchantId,
          onboarding_status: "COMPLETED",
          payments_receivable: true,
          primary_email_confirmed: true,
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("SELLER_MISMATCH");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects client attempts to supply arbitrary merchant ID in request body (strict schema)", async () => {
      const { request, context } = createOrderRequest({
        body: {
          paymentIntentId: validIntentId,
          milestoneId: validMilestoneId,
          sellerMerchantId: "ATTACKER_MERCHANT_ID",
          merchantId: "ATTACKER_MERCHANT_ID",
        },
      });
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 2. Client Authorization & Agreement Checks
  // ==========================================================================
  describe("Client Authorization and Workflow Invariants", () => {
    it("rejects unauthenticated request with 401 UNAUTHORIZED", async () => {
      mockCookieStore.get.mockReturnValue(undefined);

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("UNAUTHORIZED");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects cross-project order creation with 403 FORBIDDEN", async () => {
      mockPaymentIntentResult = {
        data: {
          ...((mockPaymentIntentResult as { data: Record<string, unknown> }).data),
          project_id: "other-project-uuid-999",
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects order creation when agreement version is not APPROVED", async () => {
      mockAgreementVersionResult = {
        data: {
          id: validAgreementVersionId,
          agreement_id: validAgreementId,
          status: "DRAFT",
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("AGREEMENT_NOT_APPROVED");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("rejects order creation when milestone is in a non-payable status", async () => {
      mockMilestoneResult = {
        data: {
          ...((mockMilestoneResult as { data: Record<string, unknown> }).data),
          status: "DRAFT",
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("MILESTONE_NOT_PAYABLE");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 3. Platform Provider Contract & Multi-Party Headers
  // ==========================================================================
  describe("PayPal Platform Provider Contract & Headers", () => {
    it("successfully creates multi-party PayPal platform order with direct seller payee and platform headers", async () => {
      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.orderId).toBe("PLATFORM-ORDER-001");
      expect(body.approvalUrl).toBe(
        "https://www.sandbox.paypal.com/checkoutnow?token=PLATFORM-ORDER-001"
      );
      expect(body.status).toBe("ORDER_CREATED");

      // Verify PayPal Orders v2 request
      expect(mockPayPalPost).toHaveBeenCalledTimes(1);
      const [path, payload, options] = mockPayPalPost.mock.calls[0];

      expect(path).toBe("/v2/checkout/orders");

      // Verify direct payee settlement
      expect(payload.intent).toBe("CAPTURE");
      expect(payload.purchase_units).toHaveLength(1);
      expect(payload.purchase_units[0].payee.merchant_id).toBe(validSellerMerchantId);
      expect(payload.purchase_units[0].reference_id).toBe(validMilestoneId);
      expect(payload.purchase_units[0].custom_id).toBe(validIntentId);
      expect(payload.purchase_units[0].amount).toEqual({
        currency_code: "USD",
        value: "1500.00",
      });

      // Verify experience context
      expect(payload.payment_source?.paypal?.experience_context).toEqual(
        expect.objectContaining({
          brand_name: "PayRoost",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: expect.stringContaining("payment_status=approved"),
          cancel_url: expect.stringContaining("payment_status=cancelled"),
        })
      );

      // Verify Multi-Party Platform Headers
      expect(options.paypalRequestId).toBe("k0000000-0000-4000-a000-000000000001");
      expect(options.partnerAttributionId).toBe(validPartnerBnCode);
      expect(options.authAssertion).toEqual({ payerId: validSellerMerchantId });
      expect(options.headers).toEqual(
        expect.objectContaining({
          Prefer: "return=representation",
        })
      );

      // Verify order recorded in database with seller merchant ID
      expect(mockRpc).toHaveBeenCalledWith("record_paypal_order_created", {
        p_session_token_hash: validSessionTokenHash,
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
        p_provider_order_id: "PLATFORM-ORDER-001",
        p_expected_merchant_id: validSellerMerchantId,
      });
    });

    it("constructs valid unencrypted JWT for PayPal-Auth-Assertion header with alg=none and seller payer_id", async () => {
      const client = new PayPalClient(validPlatformConfig);
      const params = {
        sellerMerchantId: validSellerMerchantId,
        milestoneId: validMilestoneId,
        paymentIntentId: validIntentId,
        amountCanonical: "1500.00",
        idempotencyKey: "k0000000-0000-4000-a000-000000000001",
        returnUrl: "https://payroost.com/return",
        cancelUrl: "https://payroost.com/cancel",
      };

      await client.createPlatformOrder(params);

      expect(mockPayPalPost).toHaveBeenCalledTimes(1);
      const [, , options] = mockPayPalPost.mock.calls[0];
      expect(options.authAssertion).toEqual({ payerId: validSellerMerchantId });
    });

    it("falls back to GET /v2/checkout/orders/{id} with auth assertion when create response has minimal representation", async () => {
      mockPayPalPost.mockResolvedValueOnce({
        data: {
          id: "PLATFORM-ORDER-MINIMAL",
          status: "CREATED",
          links: [
            {
              href: "https://www.sandbox.paypal.com/checkoutnow?token=PLATFORM-ORDER-MINIMAL",
              rel: "approve",
              method: "GET",
            },
          ],
        },
        status: 201,
        headers: new Headers(),
      });

      mockPayPalGet.mockResolvedValueOnce({
        data: {
          id: "PLATFORM-ORDER-MINIMAL",
          status: "CREATED",
          purchase_units: [
            {
              reference_id: validMilestoneId,
              custom_id: validIntentId,
              amount: { currency_code: "USD", value: "1500.00" },
              payee: { merchant_id: validSellerMerchantId },
            },
          ],
        },
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.orderId).toBe("PLATFORM-ORDER-MINIMAL");

      // Verify GET fallback was called with platform auth assertion and partner BN code
      expect(mockPayPalGet).toHaveBeenCalledWith(
        "/v2/checkout/orders/PLATFORM-ORDER-MINIMAL",
        expect.objectContaining({
          authAssertion: { payerId: validSellerMerchantId },
          partnerAttributionId: validPartnerBnCode,
        })
      );
    });

    it("releases lease and returns 504 PROVIDER_TIMEOUT when PayPal API times out", async () => {
      const timeoutError = new Error("Request timeout");
      timeoutError.name = "AbortError";
      mockPayPalPost.mockRejectedValueOnce(timeoutError);

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.error).toBe("PROVIDER_TIMEOUT");

      // Verify lease released
      expect(mockRpc).toHaveBeenCalledWith("release_order_creation_lease", expect.objectContaining({
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
      }));
    });
  });

  // ==========================================================================
  // 4. Payment Consistency, Idempotency & Concurrency
  // ==========================================================================
  describe("Payment Consistency and Idempotency", () => {
    it("returns existing order immediately without calling PayPal if status is ORDER_CREATED (fast-path)", async () => {
      mockPaymentIntentResult = {
        data: {
          ...((mockPaymentIntentResult as { data: Record<string, unknown> }).data),
          status: "ORDER_CREATED",
          provider_order_id: "ALREADY-CREATED-ORDER-999",
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orderId).toBe("ALREADY-CREATED-ORDER-999");
      expect(body.status).toBe("ORDER_CREATED");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("returns 409 ORDER_CREATION_IN_PROGRESS with Retry-After when concurrent worker holds active lease", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: "session-123",
              projectId: validProjectId,
              clientEmail: "client@example.com",
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        if (rpcName === "claim_order_creation_lease") {
          return Promise.resolve({
            data: {
              success: false,
              claimed: false,
              error: "LEASE_ACTIVE",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(409);
      expect(response.headers.get("Retry-After")).toBe("3");
      const body = await response.json();
      expect(body.error).toBe("ORDER_CREATION_IN_PROGRESS");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("transitions intent to RECONCILIATION_REQUIRED when intent exceeds conservative 5-hour cutoff", async () => {
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      mockPaymentIntentResult = {
        data: {
          ...((mockPaymentIntentResult as { data: Record<string, unknown> }).data),
          created_at: sixHoursAgo,
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("RECONCILIATION_REQUIRED");

      // Verify reconciliation escalation RPC called with fencing token
      expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
        p_session_token_hash: validSessionTokenHash,
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
        p_reason_code: "PAYPAL_RETENTION_WINDOW_EXPIRED",
      });
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("triggers reconciliation when PayPal returns payee merchant mismatch", async () => {
      mockPayPalPost.mockResolvedValueOnce({
        data: {
          id: "PLATFORM-ORDER-ROGUE",
          status: "CREATED",
          purchase_units: [
            {
              reference_id: validMilestoneId,
              custom_id: validIntentId,
              amount: { currency_code: "USD", value: "1500.00" },
              payee: { merchant_id: "ROGUE_MERCHANT_999" }, // does not match verified seller
            },
          ],
        },
        status: 201,
        headers: new Headers(),
      });

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).toBe("MERCHANT_MISMATCH");

      expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
        p_session_token_hash: validSessionTokenHash,
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
        p_reason_code: "PAYPAL_MERCHANT_MISMATCH",
      });
    });

    it("returns 500 DATABASE_PERSISTENCE_FAILED when database persistence fails after PayPal order creation", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: "session-123",
              projectId: validProjectId,
              clientEmail: "client@example.com",
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        if (rpcName === "claim_order_creation_lease") {
          return Promise.resolve({
            data: {
              success: true,
              claimed: true,
              lease_token: validLeaseToken,
              already_created: false,
            },
            error: null,
          });
        }
        if (rpcName === "record_paypal_order_created") {
          return Promise.resolve({
            data: null,
            error: { message: "Database connection lost" },
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("DATABASE_PERSISTENCE_FAILED");
    });

    it("returns 409 ORDER_CLAIM_FAILED when stale worker lease token fails record_paypal_order_created fencing", async () => {
      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "validate_portal_session") {
          return Promise.resolve({
            data: {
              valid: true,
              sessionId: "session-123",
              projectId: validProjectId,
              clientEmail: "client@example.com",
              csrfSecret: validCsrfSecret,
            },
            error: null,
          });
        }
        if (rpcName === "claim_order_creation_lease") {
          return Promise.resolve({
            data: {
              success: true,
              claimed: true,
              lease_token: validLeaseToken,
              already_created: false,
            },
            error: null,
          });
        }
        if (rpcName === "record_paypal_order_created") {
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

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("ORDER_CLAIM_FAILED");
    });
  });

  // ==========================================================================
  // 5. Phase 3B.R2.1: Platform Routing Hardening, BN Attribution & Mode Isolation
  // ==========================================================================
  describe("Phase 3B.R2.1: Order Routing Hardening & API-Contract Invariants", () => {
    it("fails closed with 500 CONFIGURATION_ERROR on intent creation when partnerMerchantId is missing in Platform mode (no Merchant fallback)", async () => {
      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
        ...validPlatformConfig,
        partnerMerchantId: undefined,
        paymentMode: "PLATFORM",
      });

      const { request, context } = createIntentRequest({});
      const response = await createIntentPost(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("CONFIGURATION_ERROR");
      expect(mockRpc).not.toHaveBeenCalledWith("create_client_payment_intent", expect.anything());
    });

    it("fails closed with 500 CONFIGURATION_ERROR and releases lease on order creation when partnerMerchantId is missing", async () => {
      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
        ...validPlatformConfig,
        partnerMerchantId: undefined,
        paymentMode: "PLATFORM",
      });

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("CONFIGURATION_ERROR");
      expect(mockPayPalPost).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledWith("release_order_creation_lease", {
        p_session_token_hash: validSessionTokenHash,
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
      });
    });

    it("never falls back to Merchant mode when paymentMode is omitted in incomplete config", async () => {
      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
        environment: "sandbox",
        baseUrl: "https://api-m.sandbox.paypal.com",
        clientId: "CLIENT_ID_123",
        clientSecret: "CLIENT_SECRET_123",
        expectedMerchantId: "PAYROOST_MERCHANT_123",
      });

      const { request: intentReq, context: intentCtx } = createIntentRequest({});
      const intentRes = await createIntentPost(intentReq, intentCtx);
      expect(intentRes.status).toBe(500);
      expect((await intentRes.json()).error).toBe("CONFIGURATION_ERROR");

      const { request: orderReq, context: orderCtx } = createOrderRequest({});
      const orderRes = await createOrderPost(orderReq, orderCtx);
      expect(orderRes.status).toBe(500);
      expect((await orderRes.json()).error).toBe("CONFIGURATION_ERROR");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("omits PayPal-Partner-Attribution-Id header completely when BN code is not configured and still succeeds", async () => {
      vi.restoreAllMocks();
      const configWithoutBn: PayPalConfig = {
        ...validPlatformConfig,
        partnerAttributionId: undefined,
      };
      const mockAuth = { getAccessToken: vi.fn().mockResolvedValue("mock_platform_token") };
      const client = new PayPalClient(configWithoutBn, mockAuth as unknown as PayPalAuthManager);

      let capturedHeaders: Headers | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
          capturedHeaders = new Headers(init?.headers);
          return new Response(
            JSON.stringify({
              id: "PLATFORM-ORDER-NO-BN",
              status: "CREATED",
              purchase_units: [
                {
                  reference_id: validMilestoneId,
                  custom_id: validIntentId,
                  amount: { currency_code: "USD", value: "1500.00" },
                  payee: { merchant_id: validSellerMerchantId },
                },
              ],
              links: [
                {
                  href: "https://www.sandbox.paypal.com/checkoutnow?token=PLATFORM-ORDER-NO-BN",
                  rel: "approve",
                  method: "GET",
                },
              ],
            }),
            { status: 201 }
          );
        })
      );

      const result = await client.createPlatformOrder({
        sellerMerchantId: validSellerMerchantId,
        sellerPayerId: validSellerMerchantId,
        milestoneId: validMilestoneId,
        paymentIntentId: validIntentId,
        amountCanonical: "1500.00",
        idempotencyKey: "k0000000-0000-4000-a000-000000000002",
        returnUrl: "https://payroost.com/return",
        cancelUrl: "https://payroost.com/cancel",
      });

      expect(result.orderId).toBe("PLATFORM-ORDER-NO-BN");
      expect(capturedHeaders?.get("PayPal-Partner-Attribution-Id")).toBeNull();
      expect(capturedHeaders?.get("PayPal-Auth-Assertion")).toBeTruthy();

      vi.unstubAllGlobals();
    });

    it("sends exact configured PayPal-Partner-Attribution-Id and verified JWT Auth Assertion on HTTP request", async () => {
      vi.restoreAllMocks();
      const mockAuth = { getAccessToken: vi.fn().mockResolvedValue("mock_platform_token") };
      const client = new PayPalClient(validPlatformConfig, mockAuth as unknown as PayPalAuthManager);

      let capturedHeaders: Headers | undefined;
      let capturedBody: Record<string, unknown> | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
          capturedHeaders = new Headers(init?.headers);
          capturedBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              id: "PLATFORM-ORDER-WITH-BN",
              status: "CREATED",
              links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=X", rel: "approve" }],
            }),
            { status: 201 }
          );
        })
      );

      await client.createPlatformOrder({
        sellerMerchantId: "SELLER_MERCHANT_AAA111",
        sellerPayerId: "SELLER_PAYER_BBB222",
        milestoneId: validMilestoneId,
        paymentIntentId: validIntentId,
        amountCanonical: "1500.00",
        idempotencyKey: "k0000000-0000-4000-a000-000000000003",
        returnUrl: "https://payroost.com/return",
        cancelUrl: "https://payroost.com/cancel",
      });

      // Exact BN code header
      expect(capturedHeaders?.get("PayPal-Partner-Attribution-Id")).toBe(validPartnerBnCode);

      // Seller Merchant ID goes to purchase_units[0].payee.merchant_id
      const purchaseUnits = capturedBody?.purchase_units as Array<{ payee?: { merchant_id?: string } }>;
      expect(purchaseUnits[0]?.payee?.merchant_id).toBe("SELLER_MERCHANT_AAA111");

      // Seller Payer ID goes to PayPal-Auth-Assertion JWT payload
      const rawAssertion = capturedHeaders?.get("PayPal-Auth-Assertion");
      expect(rawAssertion).toBeTruthy();
      const parts = rawAssertion!.split(".");
      expect(parts).toHaveLength(3);
      expect(parts[2]).toBe("");
      const jwtHeader = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      const jwtPayload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      expect(jwtHeader).toEqual({ alg: "none" });
      expect(jwtPayload).toEqual({
        iss: validPlatformClientId,
        payer_id: "SELLER_PAYER_BBB222",
      });

      vi.unstubAllGlobals();
    });

    it("uses distinct OAuth platform credentials when PAYPAL_PLATFORM_CLIENT_ID and SECRET are configured", async () => {
      vi.restoreAllMocks();
      const platformCredConfig: PayPalConfig = {
        ...validPlatformConfig,
        clientId: "LEGACY_CLIENT_ID",
        clientSecret: "LEGACY_CLIENT_SECRET",
        platformClientId: "DEDICATED_PLATFORM_CLIENT",
        platformClientSecret: "DEDICATED_PLATFORM_SECRET",
        paymentMode: "PLATFORM",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "platform-oauth-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const auth = new PayPalAuthManager(platformCredConfig);
      const token = await auth.getAccessToken();

      expect(token).toBe("platform-oauth-token");
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.Authorization).toBe(
        `Basic ${Buffer.from("DEDICATED_PLATFORM_CLIENT:DEDICATED_PLATFORM_SECRET").toString("base64")}`
      );
      vi.unstubAllGlobals();
    });

    it("rejects empty, malformed, platformClientId, or partnerMerchantId as seller payer_id in PayPalClient", async () => {
      vi.restoreAllMocks();
      const mockAuth = { getAccessToken: vi.fn().mockResolvedValue("mock_token") };
      const client = new PayPalClient(validPlatformConfig, mockAuth as unknown as PayPalAuthManager);

      const invalidPayerIds = ["", "   ", "AB", validPlatformClientId, validPlatformPartnerId];

      for (const badId of invalidPayerIds) {
        await expect(
          client.createPlatformOrder({
            sellerMerchantId: validSellerMerchantId,
            sellerPayerId: badId,
            milestoneId: validMilestoneId,
            paymentIntentId: validIntentId,
            amountCanonical: "1500.00",
            idempotencyKey: "k0000000-0000-4000-a000-000000000004",
            returnUrl: "https://payroost.com/return",
            cancelUrl: "https://payroost.com/cancel",
          })
        ).rejects.toMatchObject({
          errorName: "INVALID_SELLER_PAYER_ID",
          status: 400,
        });
      }

      // Direct request() with empty authAssertion payerId must also fail closed instead of stripping header
      await expect(
        client.get("/v2/checkout/orders/TEST", {
          authAssertion: { payerId: "" },
        })
      ).rejects.toBeInstanceOf(PayPalError);
    });

    it("does NOT inject PayPal-Auth-Assertion globally into ordinary Merchant requests", async () => {
      vi.restoreAllMocks();
      const merchantConfig: PayPalConfig = {
        ...validPlatformConfig,
        paymentMode: "MERCHANT",
      };
      const mockAuth = { getAccessToken: vi.fn().mockResolvedValue("mock_merchant_token") };
      const client = new PayPalClient(merchantConfig, mockAuth as unknown as PayPalAuthManager);

      let capturedHeaders: Headers | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
          capturedHeaders = new Headers(init?.headers);
          return new Response(JSON.stringify({ id: "MERCHANT-ORDER-1", status: "CREATED" }), {
            status: 201,
          });
        })
      );

      await client.post("/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "100.00" } }],
      });

      expect(capturedHeaders?.get("PayPal-Auth-Assertion")).toBeNull();
      vi.unstubAllGlobals();
    });

    it("explicitly selects Platform mode even when sellerMerchantId equals paypalEnv.expectedMerchantId (no fragile ID comparison)", async () => {
      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
        ...validPlatformConfig,
        expectedMerchantId: validSellerMerchantId, // Deliberately equal to test explicit mode
        paymentMode: "PLATFORM",
      });

      const { request: intentReq, context: intentCtx } = createIntentRequest({});
      const intentRes = await createIntentPost(intentReq, intentCtx);
      expect(intentRes.status).toBe(201);

      const rpcCall = mockRpc.mock.calls.find((c) => c[0] === "create_client_payment_intent");
      expect(rpcCall?.[1].p_canonical_payload).toEqual(
        expect.objectContaining({
          payment_mode: "PLATFORM",
          seller_merchant_id: validSellerMerchantId,
          seller_payer_id: validSellerMerchantId,
        })
      );

      const { request: orderReq, context: orderCtx } = createOrderRequest({});
      const orderRes = await createOrderPost(orderReq, orderCtx);
      expect(orderRes.status).toBe(201);
      expect(mockPayPalPost).toHaveBeenCalledWith(
        "/v2/checkout/orders",
        expect.anything(),
        expect.objectContaining({
          authAssertion: { payerId: validSellerMerchantId },
        })
      );
    });

    it("rejects browser attempts to supply paymentMode or seller overrides in intent request body", async () => {
      const { request, context } = createIntentRequest({
        body: {
          milestoneId: validMilestoneId,
          paymentMode: "MERCHANT",
          payment_mode: "MERCHANT",
          sellerPayerId: "ATTACKER_PAYER",
        },
      });
      const response = await createIntentPost(request, context);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("VALIDATION_ERROR");
      expect(mockRpc).not.toHaveBeenCalledWith("create_client_payment_intent", expect.anything());
    });

    it("fails closed when seller changes after intent creation (seller mismatch between intent and DB)", async () => {
      mockFreelancerSellerResult = {
        data: {
          id: "s-new-999",
          user_id: validOwnerId,
          paypal_merchant_id: "NEW_DIFFERENT_SELLER_999",
          onboarding_status: "COMPLETED",
          payments_receivable: true,
          primary_email_confirmed: true,
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("SELLER_MISMATCH");
      expect(mockPayPalPost).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledWith("release_order_creation_lease", {
        p_session_token_hash: validSessionTokenHash,
        p_payment_intent_id: validIntentId,
        p_lease_token: validLeaseToken,
      });
    });

    it("rejects incompatible MERCHANT-mode intent when server is running in PLATFORM mode (409 PAYMENT_MODE_MISMATCH)", async () => {
      mockPaymentIntentResult = {
        data: {
          ...((mockPaymentIntentResult as { data: Record<string, unknown> }).data),
          expected_merchant_id: "DEFAULT_MERCHANT_123",
          canonical_payload_json: {
            purchase_units: [
              {
                reference_id: validMilestoneId,
                custom_id: validIntentId,
                amount: { currency_code: "USD", value: "1500.00" },
                payee: { merchant_id: "DEFAULT_MERCHANT_123" },
              },
            ],
            payment_mode: "MERCHANT",
          },
        },
        error: null,
      };

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("PAYMENT_MODE_MISMATCH");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("preserves isolated legacy MERCHANT flow only when server and intent are both explicit MERCHANT", async () => {
      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
        environment: "sandbox",
        baseUrl: "https://api-m.sandbox.paypal.com",
        clientId: "CLIENT_ID_123",
        clientSecret: "CLIENT_SECRET_123",
        expectedMerchantId: "DEFAULT_MERCHANT_123",
        paymentMode: "MERCHANT",
      });

      mockPaymentIntentResult = {
        data: {
          ...((mockPaymentIntentResult as { data: Record<string, unknown> }).data),
          expected_merchant_id: "DEFAULT_MERCHANT_123",
          canonical_payload_json: {
            purchase_units: [
              {
                reference_id: validMilestoneId,
                custom_id: validIntentId,
                amount: { currency_code: "USD", value: "1500.00" },
                payee: { merchant_id: "DEFAULT_MERCHANT_123" },
              },
            ],
            payment_mode: "MERCHANT",
          },
        },
        error: null,
      };

      mockPayPalPost.mockResolvedValueOnce({
        data: {
          id: "LEGACY-MERCHANT-ORDER-1",
          status: "CREATED",
          purchase_units: [
            {
              reference_id: validMilestoneId,
              custom_id: validIntentId,
              amount: { currency_code: "USD", value: "1500.00" },
              payee: { merchant_id: "DEFAULT_MERCHANT_123" },
            },
          ],
        },
        status: 201,
        headers: new Headers(),
      });

      const { request, context } = createOrderRequest({});
      const response = await createOrderPost(request, context);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.orderId).toBe("LEGACY-MERCHANT-ORDER-1");

      // Must NOT include Platform headers in isolated Merchant mode
      const [, , options] = mockPayPalPost.mock.calls[0];
      expect(options.authAssertion).toBeUndefined();
      expect(options.partnerAttributionId).toBeUndefined();
    });
  });
});
