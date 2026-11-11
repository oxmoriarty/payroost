import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  POST,
  PAYPAL_AUTOMATED_RETRY_CUTOFF_MS,
  RECONCILIATION_REASONS,
} from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as paypalEnvModule from "@/lib/paypal/env";
import { hashSessionToken } from "@/lib/security/tokens";
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

describe("POST /api/public/portal/[token]/payments/orders", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTrustProxy = process.env.TRUST_PROXY;

  const validToken = "valid-portal-token-for-client-order-test-12345";
  const validRawSessionToken = "valid-test-portal-session-token-43-chars___";
  const validSessionTokenHash = hashSessionToken(validRawSessionToken);
  const validCsrfSecret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  const validProjectId = "c0000000-0000-4000-a000-000000000001";
  const validMilestoneId = "b0000000-0000-4000-a000-000000000001";
  const validIntentId = "d0000000-0000-4000-a000-000000000001";
  const validSessionId = "e0000000-0000-4000-a000-000000000001";
  const validAgreementId = "f1111111-0000-4000-a000-000000000001";
  const validAgreementVersionId = "a0000000-0000-4000-a000-000000000001";
  const validClientEmail = "client@acme-corp.com";
  const validExpectedMerchantId = "MERCHANT_ACME_12345";
  const validOrderIdempotencyKey = "f0000000-0000-4000-a000-000000000001";
  const validLeaseToken = "99999999-0000-4000-a000-000000000001";

  const validCanonicalPayload = {
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

  let mockPortalTokenResult: { data: unknown; error: unknown };
  let mockPaymentIntentResult: { data: unknown; error: unknown };
  let mockMilestoneResult: { data: unknown; error: unknown };
  let mockAgreementVersionResult: { data: unknown; error: unknown };
  let mockAgreementResult: { data: unknown; error: unknown };

  function createRequest(options: {
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

    // Default PayPal environment configuration (Explicit isolated legacy Merchant mode for 3B.4 unit suite)
    vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
      environment: "sandbox",
      baseUrl: "https://api-m.sandbox.paypal.com",
      clientId: "CLIENT_ID_123",
      clientSecret: "CLIENT_SECRET_123",
      expectedMerchantId: validExpectedMerchantId,
      paymentMode: "MERCHANT",
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
        status: "ORDER_CREATING",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: validOrderIdempotencyKey,
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: null,
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
        status: "APPROVED",
        currency: "USD",
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
          data: {
            success: true,
            released: true,
          },
          error: null,
        });
      }
      if (rpcName === "record_paypal_order_created") {
        return Promise.resolve({
          data: {
            success: true,
            already_recorded: false,
            provider_order_id: "PAYPAL-ORDER-12345",
          },
          error: null,
        });
      }
      if (rpcName === "mark_intent_reconciliation_required") {
        return Promise.resolve({
          data: {
            success: true,
            reconciled: true,
            status: "RECONCILIATION_REQUIRED",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    // Default PayPal REST API mock response (full representation)
    mockPayPalPost.mockResolvedValue({
      data: {
        id: "PAYPAL-ORDER-12345",
        status: "CREATED",
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
        links: [
          {
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-12345",
            rel: "approve",
            method: "GET",
          },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    mockPayPalGet.mockResolvedValue({
      data: {
        id: "PAYPAL-ORDER-12345",
        status: "CREATED",
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
      },
      status: 200,
      headers: new Headers(),
    });
  });

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    process.env.TRUST_PROXY = originalTrustProxy;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Section 1: Complete Lease Fencing for Reconciliation
  // ==========================================================================
  it("1. passes current lease token to mark_intent_reconciliation_required on verification failure", async () => {
    // Return order with wrong payee
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-ORDER-WRONG-PAYEE",
        status: "CREATED",
        purchase_units: [
          {
            reference_id: validMilestoneId,
            custom_id: validIntentId,
            amount: { currency_code: "USD", value: "1500.00" },
            payee: { merchant_id: "ROGUE_MERCHANT_999" },
          },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(502);
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_MERCHANT_MISMATCH,
    });
  });

  it("2. fails safe if mark_intent_reconciliation_required returns STALE_LEASE_TOKEN", async () => {
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-ORDER-STALE",
        status: "CREATED",
        purchase_units: [
          {
            reference_id: validMilestoneId,
            custom_id: validIntentId,
            amount: { currency_code: "USD", value: "1500.00" },
            payee: { merchant_id: "ROGUE_MERCHANT_999" },
          },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "validate_portal_session") {
        return Promise.resolve({
          data: { valid: true, sessionId: validSessionId, projectId: validProjectId, clientEmail: validClientEmail, csrfSecret: validCsrfSecret },
          error: null,
        });
      }
      if (rpcName === "claim_order_creation_lease") {
        return Promise.resolve({
          data: { success: true, claimed: true, lease_token: validLeaseToken },
          error: null,
        });
      }
      if (rpcName === "mark_intent_reconciliation_required") {
        // Newer worker has claimed the lease; stale worker's reconciliation attempt is rejected
        return Promise.resolve({
          data: { success: false, error: "STALE_LEASE_TOKEN" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    // Stale worker is rejected without recording or succeeding
    expect(response.status).toBe(502);
    expect(mockRpc).not.toHaveBeenCalledWith("record_paypal_order_created", expect.any(Object));
  });

  it("3. passes worker lease fencing token to release_order_creation_lease preventing stale lease wipes", async () => {
    mockPayPalPost.mockRejectedValueOnce(
      new PayPalError({ message: "Timeout", status: 408, errorName: "REQUEST_TIMEOUT" })
    );

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(504);
    expect(mockRpc).toHaveBeenCalledWith("release_order_creation_lease", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
    });
  });

  it("4. passes worker lease fencing token to record_paypal_order_created", async () => {
    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith("record_paypal_order_created", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_provider_order_id: "PAYPAL-ORDER-12345",
      p_expected_merchant_id: validExpectedMerchantId,
    });
  });

  // ==========================================================================
  // Section 2: Milestone & Agreement Integrity
  // ==========================================================================
  it("5. rejects order creation when milestone is in a non-payable status", async () => {
    mockMilestoneResult = {
      data: {
        id: validMilestoneId,
        project_id: validProjectId,
        agreement_version_id: validAgreementVersionId,
        status: "CANCELLED", // Non-payable
        currency: "USD",
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("MILESTONE_NOT_PAYABLE");
    expect(mockPayPalPost).not.toHaveBeenCalled();
  });

  it("6. rejects order creation when claim RPC reports MILESTONE_NOT_PAYABLE under row lock", async () => {
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "validate_portal_session") {
        return Promise.resolve({
          data: { valid: true, sessionId: validSessionId, projectId: validProjectId, clientEmail: validClientEmail, csrfSecret: validCsrfSecret },
          error: null,
        });
      }
      if (rpcName === "claim_order_creation_lease") {
        return Promise.resolve({
          data: { success: false, error: "MILESTONE_NOT_PAYABLE", milestone_status: "CANCELLED" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("MILESTONE_NOT_PAYABLE");
    expect(mockPayPalPost).not.toHaveBeenCalled();
  });

  it("7. rejects order creation when agreement version is not APPROVED", async () => {
    mockAgreementVersionResult = {
      data: {
        id: validAgreementVersionId,
        agreement_id: validAgreementId,
        status: "DRAFT", // Not APPROVED
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("AGREEMENT_NOT_APPROVED");
    expect(mockPayPalPost).not.toHaveBeenCalled();
  });

  it("8. rejects order creation when milestone references a different agreement version than the intent", async () => {
    mockMilestoneResult = {
      data: {
        id: validMilestoneId,
        project_id: validProjectId,
        agreement_version_id: "a9999999-9999-4999-a999-999999999999", // Divergent
        status: "APPROVED",
        currency: "USD",
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("AGREEMENT_VERSION_MISMATCH");
    expect(mockPayPalPost).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Section 3: Conservative 5-Hour Idempotency Cutoff
  // ==========================================================================
  it("9. permits automated retry before 5 hours reusing original request ID and payload", async () => {
    // Created 4 hours ago (within 5h cutoff)
    mockPaymentIntentResult = {
      data: {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        agreement_version_id: validAgreementVersionId,
        status: "ORDER_CREATING",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: validOrderIdempotencyKey,
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: null,
        order_creation_lease_expires_at: null,
        created_at: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(201);
    expect(mockPayPalPost).toHaveBeenCalledTimes(1);
    const [, , opt] = mockPayPalPost.mock.calls[0];
    expect(opt.paypalRequestId).toBe(validOrderIdempotencyKey);
  });

  it("10. rejects automated dispatch and transitions to RECONCILIATION_REQUIRED at or beyond 5 hours", async () => {
    // Created exactly 5 hours ago (cutoff reached)
    mockPaymentIntentResult = {
      data: {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        agreement_version_id: validAgreementVersionId,
        status: "ORDER_CREATING",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: validOrderIdempotencyKey,
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: null,
        order_creation_lease_expires_at: null,
        created_at: new Date(Date.now() - PAYPAL_AUTOMATED_RETRY_CUTOFF_MS).toISOString(),
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("RECONCILIATION_REQUIRED");

    // Must NOT call PayPal
    expect(mockPayPalPost).not.toHaveBeenCalled();

    // Must call fenced mark_intent_reconciliation_required with leaseToken and controlled reason code
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_RETENTION_WINDOW_EXPIRED,
    });
  });

  // ==========================================================================
  // Section 4: Structured Reconciliation Reasons (No Raw Error Text)
  // ==========================================================================
  it("11. persists structured reason code PAYPAL_GET_ORDER_FAILED when GET fallback fails", async () => {
    // Initial POST returns minimal response
    mockPayPalPost.mockResolvedValueOnce({
      data: { id: "PAYPAL-ORDER-GET-FAIL", status: "CREATED" },
      status: 201,
      headers: new Headers(),
    });

    // GET fails with internal error
    mockPayPalGet.mockRejectedValueOnce(new Error("socket hang up: ECONNRESET"));

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(502);
    // Verifies controlled reason code is used, NOT raw error string
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_GET_ORDER_FAILED,
    });
  });

  it("12. persists structured reason code PAYPAL_ORDER_STATUS_INVALID when status is not CREATED", async () => {
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-ORDER-SAVED",
        status: "SAVED", // Invalid status
        purchase_units: [
          { reference_id: validMilestoneId, custom_id: validIntentId, amount: { currency_code: "USD", value: "1500.00" }, payee: { merchant_id: validExpectedMerchantId } },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(502);
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_ORDER_STATUS_INVALID,
    });
  });

  it("13. persists structured reason code PAYPAL_AMOUNT_MISMATCH when canonical amount differs", async () => {
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-ORDER-BAD-AMOUNT",
        status: "CREATED",
        purchase_units: [
          { reference_id: validMilestoneId, custom_id: validIntentId, amount: { currency_code: "USD", value: "99.00" }, payee: { merchant_id: validExpectedMerchantId } },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(502);
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_AMOUNT_MISMATCH,
    });
  });

  it("14. persists structured reason code PAYPAL_CURRENCY_MISMATCH when currency is not USD", async () => {
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-ORDER-EUR",
        status: "CREATED",
        purchase_units: [
          { reference_id: validMilestoneId, custom_id: validIntentId, amount: { currency_code: "EUR", value: "1500.00" }, payee: { merchant_id: validExpectedMerchantId } },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(502);
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_CURRENCY_MISMATCH,
    });
  });

  it("15. persists structured reason code PAYPAL_REFERENCE_ID_MISMATCH when reference_id differs from milestone ID", async () => {
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-ORDER-BAD-REF",
        status: "CREATED",
        purchase_units: [
          { reference_id: "b9999999-9999-4999-a999-999999999999", custom_id: validIntentId, amount: { currency_code: "USD", value: "1500.00" }, payee: { merchant_id: validExpectedMerchantId } },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(502);
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_REFERENCE_ID_MISMATCH,
    });
  });

  it("16. persists structured reason code PAYPAL_CUSTOM_ID_MISMATCH when custom_id differs from intent ID", async () => {
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-ORDER-BAD-CUSTOM",
        status: "CREATED",
        purchase_units: [
          { reference_id: validMilestoneId, custom_id: "d9999999-9999-4999-a999-999999999999", amount: { currency_code: "USD", value: "1500.00" }, payee: { merchant_id: validExpectedMerchantId } },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(502);
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_CUSTOM_ID_MISMATCH,
    });
  });

  // ==========================================================================
  // Section 5: Provider Response Verification & Representation
  // ==========================================================================
  it("17. explicitly sends Prefer: return=representation header in PayPal order creation request", async () => {
    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(201);
    expect(mockPayPalPost).toHaveBeenCalledTimes(1);

    const [, , options] = mockPayPalPost.mock.calls[0];
    expect(options.headers).toEqual({
      Prefer: "return=representation",
    });
  });

  it("18. falls back to GET order details when create response is minimal, succeeding when GET returns full representation", async () => {
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-MINIMAL-ORDER-999",
        status: "CREATED",
        links: [{ href: "https://paypal.com/approve", rel: "approve" }],
      },
      status: 201,
      headers: new Headers(),
    });

    mockPayPalGet.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-MINIMAL-ORDER-999",
        status: "CREATED",
        purchase_units: [
          {
            reference_id: validMilestoneId,
            custom_id: validIntentId,
            amount: { currency_code: "USD", value: "1500.00" },
            payee: { merchant_id: validExpectedMerchantId },
          },
        ],
      },
      status: 200,
      headers: new Headers(),
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(201);
    expect(mockPayPalGet).toHaveBeenCalledWith("/v2/checkout/orders/PAYPAL-MINIMAL-ORDER-999");
    const body = await response.json();
    expect(body.orderId).toBe("PAYPAL-MINIMAL-ORDER-999");
  });

  it("19. rejects when PayPal response has multiple purchase units", async () => {
    mockPayPalPost.mockResolvedValueOnce({
      data: {
        id: "PAYPAL-ORDER-MULTI-PU",
        status: "CREATED",
        purchase_units: [
          { reference_id: validMilestoneId, custom_id: validIntentId, payee: { merchant_id: validExpectedMerchantId }, amount: { currency_code: "USD", value: "1500.00" } },
          { reference_id: "extra-unit", amount: { currency_code: "USD", value: "10.00" } },
        ],
      },
      status: 201,
      headers: new Headers(),
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(502);
    expect(mockRpc).toHaveBeenCalledWith("mark_intent_reconciliation_required", {
      p_session_token_hash: validSessionTokenHash,
      p_payment_intent_id: validIntentId,
      p_lease_token: validLeaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_PURCHASE_UNIT_INVALID,
    });
  });

  // ==========================================================================
  // Section 6: Baseline Invariants & Defensive Guards
  // ==========================================================================
  it("20. returns existing order (200 OK) immediately without calling PayPal if status is ORDER_CREATED", async () => {
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
        order_idempotency_key: validOrderIdempotencyKey,
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: "EXISTING-ORDER-12345",
        order_creation_lease_expires_at: null,
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orderId).toBe("EXISTING-ORDER-12345");
    expect(mockPayPalPost).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith("claim_order_creation_lease", expect.any(Object));
  });

  it("21. rejects completed intent with 409 MILESTONE_ALREADY_COMPLETED", async () => {
    mockPaymentIntentResult = {
      data: {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        agreement_version_id: validAgreementVersionId,
        status: "COMPLETED",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: validOrderIdempotencyKey,
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: "COMPLETED-ORDER-ID",
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("MILESTONE_ALREADY_COMPLETED");
  });

  it("22. rejects reconciliation-required intent with 409 RECONCILIATION_REQUIRED", async () => {
    mockPaymentIntentResult = {
      data: {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        agreement_version_id: validAgreementVersionId,
        status: "RECONCILIATION_REQUIRED",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: validOrderIdempotencyKey,
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: null,
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("RECONCILIATION_REQUIRED");
  });

  it("23. rejects cross-project intent with 403 FORBIDDEN", async () => {
    mockPaymentIntentResult = {
      data: {
        id: validIntentId,
        project_id: "c9999999-9999-4999-a999-999999999999", // Different project
        milestone_id: validMilestoneId,
        agreement_version_id: validAgreementVersionId,
        status: "ORDER_CREATING",
        expected_merchant_id: validExpectedMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        order_idempotency_key: validOrderIdempotencyKey,
        canonical_payload_json: validCanonicalPayload,
        provider_order_id: null,
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("FORBIDDEN");
  });

  it("24. rejects missing CSRF token with 403 INVALID_CSRF_TOKEN", async () => {
    const { request, context } = createRequest({ csrfToken: null });
    const response = await POST(request, context);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("INVALID_CSRF_TOKEN");
  });

  it("25. rejects missing session cookie with 401 UNAUTHORIZED", async () => {
    mockCookieStore.get.mockReturnValue(undefined);

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("26. rejects client-supplied financial fields with 400 VALIDATION_ERROR (strict schema)", async () => {
    const { request, context } = createRequest({
      body: {
        paymentIntentId: validIntentId,
        amount: "5000.00", // Forbidden browser input
      },
    });
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("27. rejects invalid URL invitation token with 404 INVITATION_NOT_FOUND", async () => {
    const { request, context } = createRequest({ token: "short" });
    const response = await POST(request, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("INVITATION_NOT_FOUND");
  });

  it("28. rejects revoked invitation token with 404 INVITATION_NOT_FOUND", async () => {
    mockPortalTokenResult = {
      data: {
        project_id: validProjectId,
        revoked_at: "2026-11-06T10:00:00Z",
      },
      error: null,
    };

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("INVITATION_NOT_FOUND");
  });

  it("29. rejects non-UUID payment intent ID with 400 VALIDATION_ERROR", async () => {
    const { request, context } = createRequest({
      body: { paymentIntentId: "not-a-valid-uuid" },
    });
    const response = await POST(request, context);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("30. rejects when rate limit is exceeded with 429 RATE_LIMITED", async () => {
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

  it("31. returns 409 ORDER_CREATION_IN_PROGRESS with Retry-After when lease is active on another worker", async () => {
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "validate_portal_session") {
        return Promise.resolve({
          data: { valid: true, sessionId: validSessionId, projectId: validProjectId, clientEmail: validClientEmail, csrfSecret: validCsrfSecret },
          error: null,
        });
      }
      if (rpcName === "claim_order_creation_lease") {
        return Promise.resolve({
          data: { success: false, claimed: false, error: "LEASE_ACTIVE" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("3");
    const body = await response.json();
    expect(body.error).toBe("ORDER_CREATION_IN_PROGRESS");
    expect(mockPayPalPost).not.toHaveBeenCalled();
  });

  it("32. explicitly ensures no capture endpoints are called and intent is never marked CAPTURED", async () => {
    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(201);
    for (const call of mockPayPalPost.mock.calls) {
      const [path] = call;
      expect(path).not.toContain("capture");
      expect(path).toBe("/v2/checkout/orders");
    }

    const rpcNames = mockRpc.mock.calls.map((c) => c[0]);
    expect(rpcNames).not.toContain("capture_paypal_order");
    expect(rpcNames).not.toContain("record_paypal_order_captured");
  });

  it("33. preserves request ID when database persistence fails after provider success", async () => {
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "validate_portal_session") {
        return Promise.resolve({
          data: { valid: true, sessionId: validSessionId, projectId: validProjectId, clientEmail: validClientEmail, csrfSecret: validCsrfSecret },
          error: null,
        });
      }
      if (rpcName === "claim_order_creation_lease") {
        return Promise.resolve({
          data: { success: true, claimed: true, lease_token: validLeaseToken },
          error: null,
        });
      }
      if (rpcName === "record_paypal_order_created") {
        return Promise.resolve({
          data: null,
          error: { message: "database transient error" },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("DATABASE_PERSISTENCE_FAILED");

    // PayPal was called with original idempotency key; key was not changed or regenerated
    const [, , opt] = mockPayPalPost.mock.calls[0];
    expect(opt.paypalRequestId).toBe(validOrderIdempotencyKey);
  });

  it("34. rejects with 409 ORDER_CLAIM_FAILED if record_paypal_order_created returns STALE_LEASE_TOKEN", async () => {
    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "validate_portal_session") {
        return Promise.resolve({
          data: { valid: true, sessionId: validSessionId, projectId: validProjectId, clientEmail: validClientEmail, csrfSecret: validCsrfSecret },
          error: null,
        });
      }
      if (rpcName === "claim_order_creation_lease") {
        return Promise.resolve({
          data: { success: true, claimed: true, lease_token: validLeaseToken },
          error: null,
        });
      }
      if (rpcName === "record_paypal_order_created") {
        return Promise.resolve({
          data: { success: false, error: "STALE_LEASE_TOKEN" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const { request, context } = createRequest({});
    const response = await POST(request, context);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("ORDER_CLAIM_FAILED");
  });
});
