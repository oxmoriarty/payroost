import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as supabaseServiceModule from "@/lib/supabase/service";
import * as portalSessionModule from "@/lib/security/portal-session";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as paypalEnvModule from "@/lib/paypal/env";
import * as authModule from "@/lib/auth/require-user";
import * as operatorCsrfModule from "@/lib/security/operator-csrf";
import * as supabaseServerModule from "@/lib/supabase/server";
import { PayPalClient } from "@/lib/paypal/client";
import { PayPalAuthManager } from "@/lib/paypal/auth";
import { PayPalError, type PayPalConfig } from "@/lib/paypal/types";
import { reconcilePaymentIntentServerSide } from "@/lib/paypal/reconciliation-service";
import { POST as captureByOrderPost } from "@/app/api/public/portal/[token]/payments/orders/[orderId]/capture/route";
import { POST as captureLegacyRoutePost } from "@/app/api/public/portal/[token]/payments/capture/route";
import { POST as recoveryPost } from "@/app/api/app/payments/recovery/route";

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue({ value: "raw-portal-session-token-1234567890" }),
  }),
}));

const mockPayPalGet = vi.fn();
const mockPayPalPost = vi.fn();
let mockPayPalGetSpy: ReturnType<typeof vi.spyOn>;
let mockPayPalPostSpy: ReturnType<typeof vi.spyOn>;

describe("Phase 3B.R3: PayPal Platform Multi-Party Capture & Reconciliation", () => {
  const validToken = "portal-token-r3-valid-1234567890abcdef";
  const validCsrfSecret = "a".repeat(64);
  const validSessionId = "11111111-1111-4111-a111-111111111111";
  const validProjectId = "22222222-2222-4222-a222-222222222222";
  const validOwnerId = "33333333-3333-4333-a333-333333333333";
  const validMilestoneId = "44444444-4444-4444-a444-444444444444";
  const validAgreementVersionId = "55555555-5555-4555-a555-555555555555";
  const validIntentId = "66666666-6666-4666-a666-666666666666";
  const validOrderId = "PAYPAL_PLATFORM_ORDER_001";
  const validCaptureId = "PAYPAL_PLATFORM_CAP_001";
  const validOrderIdempotencyKey = "77777777-7777-4777-a777-777777777777";
  const validCaptureIdempotencyKey = "88888888-8888-4888-a888-888888888888";
  const validLeaseToken = "99999999-9999-4999-a999-999999999999";
  const validPlatformClientId = "PLATFORM_CLIENT_ABC";
  const validPartnerMerchantId = "PARTNER_PLATFORM_MERCHANT_999";
  const validPartnerBnCode = "PAYROOST_BN_CODE_R3";
  const validSellerMerchantId = "SELLER_FREELANCER_MERCHANT_123";
  const validSellerPayerId = "SELLER_FREELANCER_MERCHANT_123";

  const validPlatformConfig: PayPalConfig = {
    environment: "sandbox",
    baseUrl: "https://api-m.sandbox.paypal.com",
    clientId: validPlatformClientId,
    clientSecret: "PLATFORM_SECRET_ABC",
    expectedMerchantId: "",
    platformClientId: validPlatformClientId,
    platformClientSecret: "PLATFORM_SECRET_ABC",
    partnerMerchantId: validPartnerMerchantId,
    partnerAttributionId: validPartnerBnCode,
    paymentMode: "PLATFORM",
    timeoutMs: 15_000,
  };

  const validPlatformCanonicalPayload = {
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
    seller_payer_id: validSellerPayerId,
  };

  const validApprovedOrder = {
    id: validOrderId,
    status: "APPROVED",
    links: [
      {
        rel: "payer-action",
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${validOrderId}`,
        method: "GET",
      },
    ],
    purchase_units: [
      {
        reference_id: validMilestoneId,
        custom_id: validIntentId,
        amount: { currency_code: "USD", value: "1500.00" },
        payee: { merchant_id: validSellerMerchantId },
      },
    ],
  };

  const validCapturedOrder = {
    id: validOrderId,
    status: "COMPLETED",
    purchase_units: [
      {
        reference_id: validMilestoneId,
        custom_id: validIntentId,
        amount: { currency_code: "USD", value: "1500.00" },
        payee: { merchant_id: validSellerMerchantId },
        payments: {
          captures: [
            {
              id: validCaptureId,
              status: "COMPLETED",
              amount: { currency_code: "USD", value: "1500.00" },
              payee: { merchant_id: validSellerMerchantId },
              custom_id: validIntentId,
            },
          ],
        },
      },
    ],
  };

  let mockPortalTokenResult: unknown;
  let mockProjectResult: unknown;
  let mockFreelancerSellerResult: unknown;
  let mockIntentResult: unknown;
  let mockMilestoneResult: unknown;
  let mockAgreementResult: unknown;
  let mockCaptureTxResult: unknown;
  let mockRpc: ReturnType<typeof vi.fn>;
  let mockServiceClient: SupabaseClient;

  function buildOrderCaptureRequest(
    orderId = validOrderId,
    body: unknown = { paymentIntentId: validIntentId }
  ) {
    return {
      request: new Request(
        `https://payroost.com/api/public/portal/${validToken}/payments/orders/${orderId}/capture`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": validCsrfSecret,
          },
          body: JSON.stringify(body),
        }
      ),
      context: { params: Promise.resolve({ token: validToken, orderId }) },
    };
  }

  function buildLegacyCaptureRequest(orderId = validOrderId, paymentIntentId = validIntentId) {
    return {
      request: new Request(
        `https://payroost.com/api/public/portal/${validToken}/payments/capture`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": validCsrfSecret,
          },
          body: JSON.stringify({ orderId, paymentIntentId }),
        }
      ),
      context: { params: Promise.resolve({ token: validToken }) },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.TRUST_PROXY = "false";

    vi.spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue({
      allowed: true,
      current: 1,
      limit: 20,
      resetAt: Date.now() + 60_000,
      status: "allowed",
    });

    vi.spyOn(portalSessionModule, "authenticatePortalSession").mockResolvedValue({
      success: true,
      sessionId: validSessionId,
      projectId: validProjectId,
      clientEmail: "client@example.com",
      csrfSecret: validCsrfSecret,
      sessionTokenHash: "session-hash-1234567890",
    });

    vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue(validPlatformConfig);
    mockPayPalGetSpy = vi.spyOn(PayPalClient.prototype, "get").mockImplementation(mockPayPalGet);
    mockPayPalPostSpy = vi.spyOn(PayPalClient.prototype, "post").mockImplementation(mockPayPalPost);

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
        id: "seller-row-1",
        user_id: validOwnerId,
        paypal_merchant_id: validSellerMerchantId,
        onboarding_status: "COMPLETED",
        payments_receivable: true,
        primary_email_confirmed: true,
      },
      error: null,
    };
    mockIntentResult = {
      data: {
        id: validIntentId,
        project_id: validProjectId,
        milestone_id: validMilestoneId,
        agreement_version_id: validAgreementVersionId,
        status: "ORDER_CREATED",
        expected_merchant_id: validSellerMerchantId,
        expected_currency: "USD",
        expected_amount_canonical: "1500.00",
        expected_amount_cents: 150000,
        order_idempotency_key: validOrderIdempotencyKey,
        capture_idempotency_key: validCaptureIdempotencyKey,
        canonical_payload_json: validPlatformCanonicalPayload,
        provider_order_id: validOrderId,
        order_creation_lease_expires_at: null,
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
    mockCaptureTxResult = { data: null, error: null };

    mockRpc = vi.fn().mockImplementation((fnName: string) => {
      if (fnName === "claim_order_capture_lease") {
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
      if (fnName === "record_paypal_order_captured") {
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
      if (fnName === "reconcile_and_complete_payment_intent") {
        return Promise.resolve({ data: true, error: null });
      }
      if (
        fnName === "release_order_capture_lease" ||
        fnName === "mark_intent_capture_reconciliation_required" ||
        fnName === "admin_mark_intent_reconciliation_required"
      ) {
        return Promise.resolve({ data: { success: true }, error: null });
      }
      if (
        fnName === "admin_recover_and_bind_paypal_order" ||
        fnName === "admin_resolve_reconciliation_without_payment"
      ) {
        return Promise.resolve({ data: { success: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      const chainFor = (resultGetter: () => unknown) => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockImplementation(async () => resultGetter()),
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockImplementation(async () => resultGetter()),
              }),
            }),
          }),
        }),
      });

      if (table === "client_portal_tokens") return chainFor(() => mockPortalTokenResult);
      if (table === "projects") return chainFor(() => mockProjectResult);
      if (table === "freelancer_paypal_accounts") return chainFor(() => mockFreelancerSellerResult);
      if (table === "payment_intents") return chainFor(() => mockIntentResult);
      if (table === "milestones") return chainFor(() => mockMilestoneResult);
      if (table === "agreement_versions") return chainFor(() => mockAgreementResult);
      if (table === "payment_transactions") return chainFor(() => mockCaptureTxResult);
      return chainFor(() => ({ data: null, error: null }));
    });

    mockServiceClient = {
      from: mockFrom,
      rpc: mockRpc,
    } as unknown as SupabaseClient;

    vi.spyOn(supabaseServiceModule, "createServiceClient").mockReturnValue(mockServiceClient);

    mockPayPalGet.mockResolvedValue({
      data: validApprovedOrder,
      status: 200,
      headers: new Headers(),
    });
    mockPayPalPost.mockResolvedValue({
      data: validCapturedOrder,
      status: 200,
      headers: new Headers(),
    });
  });

  // ============================================================================
  // 1. MULTI-PARTY PLATFORM CAPTURE & HEADER CONTRACTS
  // ============================================================================
  describe("1. Multi-Party Platform Capture & Auth Assertion Contract", () => {
    it("captures Platform order via /orders/[orderId]/capture with Auth Assertion and seller payee persistence", async () => {
      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        paymentIntentId: validIntentId,
        orderId: validOrderId,
        captureId: validCaptureId,
        status: "COMPLETED",
      });

      expect(mockPayPalGet).toHaveBeenCalledWith(
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}`,
        expect.objectContaining({
          authAssertion: { payerId: validSellerPayerId },
          partnerAttributionId: validPartnerBnCode,
        })
      );

      expect(mockPayPalPost).toHaveBeenCalledWith(
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}/capture`,
        {},
        expect.objectContaining({
          paypalRequestId: validCaptureIdempotencyKey,
          headers: { Prefer: "return=representation" },
          authAssertion: { payerId: validSellerPayerId },
          partnerAttributionId: validPartnerBnCode,
        })
      );

      expect(mockRpc).toHaveBeenCalledWith(
        "record_paypal_order_captured",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_lease_token: validLeaseToken,
          p_provider_capture_id: validCaptureId,
          p_capture_status: "COMPLETED",
          p_amount_cents: 150000,
          p_payee_merchant_id: validSellerMerchantId,
        })
      );
    });

    it("captures Platform order via /payments/capture with identical Auth Assertion and BN headers", async () => {
      const { request, context } = buildLegacyCaptureRequest();
      const res = await captureLegacyRoutePost(request, context);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("COMPLETED");
      expect(body.captureId).toBe(validCaptureId);

      expect(mockPayPalGet).toHaveBeenCalledWith(
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}`,
        expect.objectContaining({
          authAssertion: { payerId: validSellerPayerId },
          partnerAttributionId: validPartnerBnCode,
        })
      );
      expect(mockPayPalPost).toHaveBeenCalledWith(
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}/capture`,
        {},
        expect.objectContaining({
          authAssertion: { payerId: validSellerPayerId },
          partnerAttributionId: validPartnerBnCode,
        })
      );
    });

    it("omits partnerAttributionId header cleanly when PAYPAL_PARTNER_ATTRIBUTION_ID is not configured", async () => {
      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
        ...validPlatformConfig,
        partnerAttributionId: undefined,
      });

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(200);

      const postOptions = mockPayPalPost.mock.calls[0]?.[2];
      expect(postOptions.authAssertion).toEqual({ payerId: validSellerPayerId });
      expect(postOptions.partnerAttributionId).toBeUndefined();
    });

    it("verifies PayPalClient wires exact unencrypted PayPal-Auth-Assertion JWT on capture HTTP requests", async () => {
      mockPayPalGetSpy.mockRestore();
      mockPayPalPostSpy.mockRestore();
      const mockAuth: PayPalAuthManager = {
        getAccessToken: vi.fn().mockResolvedValue("platform_bearer_token"),
      } as unknown as PayPalAuthManager;
      const realClient = new PayPalClient(validPlatformConfig, mockAuth);

      let capturedHeaders: Headers | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
          capturedHeaders = new Headers(init?.headers);
          return new Response(JSON.stringify(validCapturedOrder), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        })
      );

      await realClient.post(
        `/v2/checkout/orders/${validOrderId}/capture`,
        {},
        {
          paypalRequestId: validCaptureIdempotencyKey,
          headers: { Prefer: "return=representation" },
          authAssertion: { payerId: validSellerPayerId },
          partnerAttributionId: validPartnerBnCode,
        }
      );

      expect(capturedHeaders?.get("Authorization")).toBe("Bearer platform_bearer_token");
      expect(capturedHeaders?.get("PayPal-Request-Id")).toBe(validCaptureIdempotencyKey);
      expect(capturedHeaders?.get("PayPal-Partner-Attribution-Id")).toBe(validPartnerBnCode);
      expect(capturedHeaders?.get("Prefer")).toBe("return=representation");

      const assertionJwt = capturedHeaders?.get("PayPal-Auth-Assertion") ?? "";
      const [encodedHeader, encodedPayload, signature] = assertionJwt.split(".");
      expect(signature).toBe("");
      expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"))).toEqual({
        alg: "none",
      });
      expect(JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))).toEqual({
        iss: validPlatformClientId,
        payer_id: validSellerPayerId,
      });

      vi.unstubAllGlobals();
    });
  });

  // ============================================================================
  // 2. FAIL-CLOSED MODE & SELLER VERIFICATION (R2.1 CARRY-FORWARDS)
  // ============================================================================
  describe("2. Fail-Closed Payment Mode & Seller Payer Checks", () => {
    it("rejects MERCHANT-mode intent when server is in PLATFORM mode (409 PAYMENT_MODE_MISMATCH)", async () => {
      mockIntentResult = {
        data: {
          ...(mockIntentResult as { data: Record<string, unknown> }).data,
          expected_merchant_id: "LEGACY_MERCHANT_999",
          canonical_payload_json: {
            purchase_units: [
              {
                reference_id: validMilestoneId,
                custom_id: validIntentId,
                amount: { currency_code: "USD", value: "1500.00" },
                payee: { merchant_id: "LEGACY_MERCHANT_999" },
              },
            ],
            payment_mode: "MERCHANT",
          },
        },
        error: null,
      };

      const res1 = await captureByOrderPost(
        buildOrderCaptureRequest().request,
        buildOrderCaptureRequest().context
      );
      expect(res1.status).toBe(409);
      expect((await res1.json()).error).toBe("PAYMENT_MODE_MISMATCH");

      const res2 = await captureLegacyRoutePost(
        buildLegacyCaptureRequest().request,
        buildLegacyCaptureRequest().context
      );
      expect(res2.status).toBe(409);
      expect((await res2.json()).error).toBe("PAYMENT_MODE_MISMATCH");
      expect(mockPayPalGet).not.toHaveBeenCalled();
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("fails closed with 409 SELLER_PAYER_ID_MISSING when seller_payer_id is absent (no fallback to expected_merchant_id)", async () => {
      mockIntentResult = {
        data: {
          ...(mockIntentResult as { data: Record<string, unknown> }).data,
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
          },
        },
        error: null,
      };

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("SELLER_PAYER_ID_MISSING");
      expect(mockPayPalGet).not.toHaveBeenCalled();
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("fails closed with 409 SELLER_IDENTITY_MISMATCH when live seller account differs from intent payee", async () => {
      mockFreelancerSellerResult = {
        data: {
          id: "seller-row-swapped",
          user_id: validOwnerId,
          paypal_merchant_id: "DIFFERENT_SELLER_XYZ",
          onboarding_status: "COMPLETED",
          payments_receivable: true,
          primary_email_confirmed: true,
        },
        error: null,
      };

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("SELLER_IDENTITY_MISMATCH");
      expect(mockPayPalGet).not.toHaveBeenCalled();
    });

    it("fails closed with 403 when connected freelancer loses payment receivability prior to capture", async () => {
      mockFreelancerSellerResult = {
        data: {
          id: "seller-row-1",
          user_id: validOwnerId,
          paypal_merchant_id: validSellerMerchantId,
          onboarding_status: "COMPLETED",
          payments_receivable: false,
          primary_email_confirmed: true,
        },
        error: null,
      };

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("SELLER_NOT_RECEIVABLE");
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("preserves MERCHANT isolation without Auth Assertion when both server and intent are explicit MERCHANT", async () => {
      vi.spyOn(paypalEnvModule, "getPayPalServerEnv").mockReturnValue({
        environment: "sandbox",
        baseUrl: "https://api-m.sandbox.paypal.com",
        clientId: "MERCHANT_CLIENT_1",
        clientSecret: "MERCHANT_SECRET_1",
        expectedMerchantId: "OWN_MERCHANT_001",
        paymentMode: "MERCHANT",
        timeoutMs: 15_000,
      });

      mockIntentResult = {
        data: {
          ...(mockIntentResult as { data: Record<string, unknown> }).data,
          expected_merchant_id: "OWN_MERCHANT_001",
          canonical_payload_json: {
            purchase_units: [
              {
                reference_id: validMilestoneId,
                custom_id: validIntentId,
                amount: { currency_code: "USD", value: "1500.00" },
                payee: { merchant_id: "OWN_MERCHANT_001" },
              },
            ],
            payment_mode: "MERCHANT",
          },
        },
        error: null,
      };

      mockPayPalGet.mockResolvedValueOnce({
        data: {
          ...validApprovedOrder,
          purchase_units: [
            {
              reference_id: validMilestoneId,
              custom_id: validIntentId,
              amount: { currency_code: "USD", value: "1500.00" },
              payee: { merchant_id: "OWN_MERCHANT_001" },
            },
          ],
        },
      });
      mockPayPalPost.mockResolvedValueOnce({
        data: {
          ...validCapturedOrder,
          purchase_units: [
            {
              reference_id: validMilestoneId,
              custom_id: validIntentId,
              amount: { currency_code: "USD", value: "1500.00" },
              payee: { merchant_id: "OWN_MERCHANT_001" },
              payments: {
                captures: [
                  {
                    id: validCaptureId,
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "1500.00" },
                    payee: { merchant_id: "OWN_MERCHANT_001" },
                    custom_id: validIntentId,
                  },
                ],
              },
            },
          ],
        },
      });

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(200);

      expect(mockPayPalGet).toHaveBeenCalledWith(
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}`
      );
      const postOpts = mockPayPalPost.mock.calls[0]?.[2];
      expect(postOpts.authAssertion).toBeUndefined();
      expect(postOpts.partnerAttributionId).toBeUndefined();
    });
  });

  // ============================================================================
  // 3. PRE-CAPTURE ORDER STATE GATING, NON-COMPLETED & RECOVERY PATHS
  // ============================================================================
  describe("3. Pre-Capture Gating, Non-Completed Captures & Recovery", () => {
    it("rejects CREATED order in /orders/[orderId]/capture with 400 ORDER_NOT_APPROVED and surfaces approvalUrl", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: { ...validApprovedOrder, status: "CREATED" },
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("ORDER_NOT_APPROVED");
      expect(body.approvalUrl).toBe(
        `https://www.sandbox.paypal.com/checkoutnow?token=${validOrderId}`
      );
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("recovers already-COMPLETED order on pre-capture GET without issuing duplicate POST /capture", async () => {
      mockPayPalGet.mockResolvedValueOnce({
        data: validCapturedOrder,
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("COMPLETED");
      expect(body.captureId).toBe(validCaptureId);
      expect(mockPayPalPost).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledWith(
        "reconcile_and_complete_payment_intent",
        expect.objectContaining({
          p_intent_id: validIntentId,
          p_provider_capture_id: validCaptureId,
          p_payee_merchant_id: validSellerMerchantId,
          p_lease_token: validLeaseToken,
        })
      );
    });

    it("returns 202 and persists PENDING capture via RECONCILIATION_REQUIRED without reporting false completion", async () => {
      const pendingOrder = JSON.parse(JSON.stringify(validCapturedOrder));
      pendingOrder.purchase_units[0].payments.captures[0].status = "PENDING";
      mockPayPalPost.mockResolvedValueOnce({
        data: pendingOrder,
        status: 200,
        headers: new Headers(),
      });
      mockRpc.mockImplementation((fnName: string) => {
        if (fnName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: { success: true, claimed: true, lease_token: validLeaseToken },
            error: null,
          });
        }
        if (fnName === "record_paypal_order_captured") {
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

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe("PENDING");
      expect(mockRpc).toHaveBeenCalledWith(
        "record_paypal_order_captured",
        expect.objectContaining({
          p_capture_status: "PENDING",
          p_payee_merchant_id: validSellerMerchantId,
        })
      );
    });

    it("returns 400 PAYMENT_DECLINED when capture status is DECLINED without false success", async () => {
      const declinedOrder = JSON.parse(JSON.stringify(validCapturedOrder));
      declinedOrder.purchase_units[0].payments.captures[0].status = "DECLINED";
      mockPayPalPost.mockResolvedValueOnce({
        data: declinedOrder,
        status: 200,
        headers: new Headers(),
      });
      mockRpc.mockImplementation((fnName: string) => {
        if (fnName === "claim_order_capture_lease") {
          return Promise.resolve({
            data: { success: true, claimed: true, lease_token: validLeaseToken },
            error: null,
          });
        }
        if (fnName === "record_paypal_order_captured") {
          return Promise.resolve({
            data: { success: true, status: "FAILED", capture_id: validCaptureId },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("PAYMENT_DECLINED");
      expect(body.status).toBe("FAILED");
    });

    it("escalates to RECONCILIATION_REQUIRED with 502 MERCHANT_MISMATCH when capture payee differs from seller", async () => {
      const rogueOrder = JSON.parse(JSON.stringify(validCapturedOrder));
      rogueOrder.purchase_units[0].payee.merchant_id = "ROGUE_PAYEE_999";
      rogueOrder.purchase_units[0].payments.captures[0].payee.merchant_id = "ROGUE_PAYEE_999";

      mockPayPalPost.mockResolvedValueOnce({
        data: rogueOrder,
        status: 200,
        headers: new Headers(),
      });

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("MERCHANT_MISMATCH");
      expect(mockRpc).toHaveBeenCalledWith(
        "mark_intent_capture_reconciliation_required",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_lease_token: validLeaseToken,
        })
      );
    });

    it("recovers completed Platform capture via GET when POST /capture times out", async () => {
      mockPayPalPost.mockRejectedValueOnce(
        new PayPalError({ message: "Timeout", status: 408, errorName: "REQUEST_TIMEOUT" })
      );
      mockPayPalGet
        .mockResolvedValueOnce({ data: validApprovedOrder, status: 200, headers: new Headers() })
        .mockResolvedValueOnce({ data: validCapturedOrder, status: 200, headers: new Headers() });

      const { request, context } = buildOrderCaptureRequest();
      const res = await captureByOrderPost(request, context);
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("COMPLETED");
      expect(mockPayPalGet).toHaveBeenNthCalledWith(
        2,
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}`,
        expect.objectContaining({
          authAssertion: { payerId: validSellerPayerId },
        })
      );
    });
  });

  // ============================================================================
  // 4. RECONCILIATION SERVICE & OPERATOR RECOVERY ROUTE
  // ============================================================================
  describe("4. Reconciliation Service & Operator Recovery Platform Support", () => {
    it("replays ghost Platform order creation with Auth Assertion and verified seller payee", async () => {
      mockIntentResult = {
        data: {
          ...(mockIntentResult as { data: Record<string, unknown> }).data,
          status: "ORDER_CREATING",
          provider_order_id: null,
        },
        error: null,
      };
      mockPayPalPost.mockResolvedValueOnce({
        data: {
          id: "RECOVERED_PLATFORM_ORD_1",
          status: "CREATED",
          purchase_units: validPlatformCanonicalPayload.purchase_units,
        },
        status: 201,
        headers: new Headers(),
      });

      const res = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalEnv: validPlatformConfig,
      });

      expect(res.success).toBe(true);
      expect(res.resultingStatus).toBe("ORDER_CREATED");
      expect(res.providerOrderId).toBe("RECOVERED_PLATFORM_ORD_1");
      expect(mockPayPalPost).toHaveBeenCalledWith(
        "/v2/checkout/orders",
        expect.objectContaining({ intent: "CAPTURE" }),
        expect.objectContaining({
          paypalRequestId: validOrderIdempotencyKey,
          authAssertion: { payerId: validSellerPayerId },
          partnerAttributionId: validPartnerBnCode,
        })
      );
    });

    it("fails closed in reconcilePaymentIntentServerSide on mode mismatch without contacting PayPal", async () => {
      mockIntentResult = {
        data: {
          ...(mockIntentResult as { data: Record<string, unknown> }).data,
          status: "RECONCILIATION_REQUIRED",
          expected_merchant_id: "OWN_MERCHANT",
          canonical_payload_json: {
            purchase_units: validPlatformCanonicalPayload.purchase_units,
            payment_mode: "MERCHANT",
          },
        },
        error: null,
      };

      const res = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalEnv: validPlatformConfig,
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("PAYMENT_MODE_MISMATCH");
      expect(mockPayPalGet).not.toHaveBeenCalled();
      expect(mockPayPalPost).not.toHaveBeenCalled();
    });

    it("uses Platform Auth Assertion during manual CANCEL_INACTIVE operator verification", async () => {
      const mockServerClient = {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: validOwnerId } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockImplementation(async () => mockIntentResult),
            }),
          }),
        }),
      } as unknown as Awaited<ReturnType<typeof supabaseServerModule.createClient>>;

      vi.spyOn(authModule, "requireUser").mockResolvedValue({
        user: { id: validOwnerId } as unknown as NonNullable<Awaited<ReturnType<typeof authModule.requireUser>>["user"]>,
        supabase: mockServerClient,
      });
      vi.spyOn(operatorCsrfModule, "validateOperatorCsrf").mockResolvedValue({ valid: true });
      vi.spyOn(supabaseServerModule, "createClient").mockResolvedValue(mockServerClient);

      mockIntentResult = {
        data: {
          ...(mockIntentResult as { data: Record<string, unknown> }).data,
          status: "RECONCILIATION_REQUIRED",
          projects: { id: validProjectId, owner_id: validOwnerId },
        },
        error: null,
      };
      mockPayPalGet.mockResolvedValueOnce({
        data: { id: validOrderId, status: "VOIDED" },
        status: 200,
        headers: new Headers(),
      });

      const req = new Request("https://payroost.com/api/app/payments/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intentId: validIntentId, action: "CANCEL_INACTIVE" }),
      });
      const res = await recoveryPost(req);
      expect(res.status).toBe(200);
      expect(mockPayPalGet).toHaveBeenCalledWith(
        `/v2/checkout/orders/${encodeURIComponent(validOrderId)}`,
        expect.objectContaining({
          authAssertion: { payerId: validSellerPayerId },
          partnerAttributionId: validPartnerBnCode,
        })
      );
    });
  });

  // ============================================================================
  // 5. MILESTONE WORK-STATE VS PAYMENT SEPARATION (SQL + DOMAIN)
  // ============================================================================
  describe("5. Milestone Work-State & Payment Separation Verification", () => {
    it("verifies migration 202611110001 preserves milestone work state and enforces Platform payload checks", () => {
      const migrationPath = path.resolve(
        process.cwd(),
        "supabase/migrations/202611110001_platform_capture_and_reconciliation_hardening.sql"
      );
      const sql = fs.readFileSync(migrationPath, "utf8");

      expect(sql).toMatch(/create or replace function public\.record_paypal_order_captured/i);
      expect(sql).toMatch(/create or replace function public\.reconcile_and_complete_payment_intent/i);
      // Must NOT auto-accept or update milestones table on financial capture
      expect(sql).not.toMatch(/update\s+public\.milestones/i);
      // Must validate PLATFORM canonical payload seller_payer_id & seller_merchant_id
      expect(sql).toMatch(/seller_payer_id/);
      expect(sql).toMatch(/seller_merchant_id/);
      expect(sql).toMatch(/SELLER_PAYER_ID_MISSING/);
    });
  });
});
