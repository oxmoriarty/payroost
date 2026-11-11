import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/service";
import { hashPortalToken } from "@/lib/security/tokens";
import { authenticatePortalSession } from "@/lib/security/portal-session";
import { checkRateLimit } from "@/lib/security/rate-limit";
import {
  getClientIp,
  getPortalTokenRateLimitKey,
  getPortalIpRateLimitKey,
} from "@/lib/security/client-ip";
import { getPayPalServerEnv } from "@/lib/paypal/env";
import { PayPalClient } from "@/lib/paypal/client";
import { PayPalError } from "@/lib/paypal/types";
import { verifyProjectSellerReadiness } from "@/features/payments/seller-verification";
import { apiError } from "@/lib/http";

const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * PayPal Orders v2 default idempotency retention is 6 hours.
 * PayRoost enforces an internal conservative 5-hour cutoff (18,000,000 ms) for automated retries.
 * Beyond 5 hours, automated redispatch is halted and escalated to reconciliation required.
 */
export const PAYPAL_AUTOMATED_RETRY_CUTOFF_MS = 5 * 60 * 60 * 1000;

/**
 * Standardized, controlled reconciliation reason codes.
 * Raw exceptions, provider strings, and sensitive payloads are strictly forbidden from DB storage.
 */
export const RECONCILIATION_REASONS = {
  PAYPAL_CREATE_TIMEOUT: "PAYPAL_CREATE_TIMEOUT",
  PAYPAL_CREATE_PROVIDER_ERROR: "PAYPAL_CREATE_PROVIDER_ERROR",
  PAYPAL_GET_ORDER_FAILED: "PAYPAL_GET_ORDER_FAILED",
  PAYPAL_ORDER_ID_MISSING: "PAYPAL_ORDER_ID_MISSING",
  PAYPAL_ORDER_STATUS_INVALID: "PAYPAL_ORDER_STATUS_INVALID",
  PAYPAL_PURCHASE_UNIT_INVALID: "PAYPAL_PURCHASE_UNIT_INVALID",
  PAYPAL_MERCHANT_MISMATCH: "PAYPAL_MERCHANT_MISMATCH",
  PAYPAL_AMOUNT_MISMATCH: "PAYPAL_AMOUNT_MISMATCH",
  PAYPAL_CURRENCY_MISMATCH: "PAYPAL_CURRENCY_MISMATCH",
  PAYPAL_REFERENCE_ID_MISMATCH: "PAYPAL_REFERENCE_ID_MISMATCH",
  PAYPAL_CUSTOM_ID_MISMATCH: "PAYPAL_CUSTOM_ID_MISMATCH",
  PAYPAL_RETENTION_WINDOW_EXPIRED: "PAYPAL_RETENTION_WINDOW_EXPIRED",
  PAYMENT_ORDER_PERSISTENCE_FAILED: "PAYMENT_ORDER_PERSISTENCE_FAILED",
  PAYMENT_ORDER_LEASE_CONFLICT: "PAYMENT_ORDER_LEASE_CONFLICT",
} as const;

export type ReconciliationReasonCode =
  (typeof RECONCILIATION_REASONS)[keyof typeof RECONCILIATION_REASONS];

/**
 * Strict request payload schema:
 * paymentIntentId (UUID format) is mandatory.
 * milestoneId (UUID format) is optional for contextual cross-verification.
 * Extraneous properties (amount, currency, merchantId, purchase_units, etc.) are strictly forbidden.
 */
const createOrderSchema = z
  .object({
    paymentIntentId: z.string().uuid("Invalid payment intent ID format"),
    milestoneId: z.string().uuid("Invalid milestone ID format").optional(),
  })
  .strict();

export interface PayPalOrderResponse {
  id: string;
  status: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: {
      currency_code?: string;
      value?: string;
    };
    payee?: {
      merchant_id?: string;
    };
  }>;
  links?: Array<{ href: string; rel: string; method?: string }>;
}

/**
 * Validates the full representation of a PayPal order response against authoritative DB state.
 */
function validateOrderPayload(
  order: PayPalOrderResponse,
  expected: {
    intentId: string;
    milestoneId: string;
    expectedMerchantId: string;
    expectedAmountCanonical: string;
  }
): { valid: true } | { valid: false; reasonCode: ReconciliationReasonCode; isMerchantMismatch: boolean } {
  if (!order.status || order.status !== "CREATED") {
    return {
      valid: false,
      reasonCode: RECONCILIATION_REASONS.PAYPAL_ORDER_STATUS_INVALID,
      isMerchantMismatch: false,
    };
  }

  if (!order.purchase_units || !Array.isArray(order.purchase_units) || order.purchase_units.length !== 1) {
    return {
      valid: false,
      reasonCode: RECONCILIATION_REASONS.PAYPAL_PURCHASE_UNIT_INVALID,
      isMerchantMismatch: false,
    };
  }

  const pu = order.purchase_units[0];

  if (!pu.reference_id || pu.reference_id !== expected.milestoneId) {
    return {
      valid: false,
      reasonCode: RECONCILIATION_REASONS.PAYPAL_REFERENCE_ID_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  if (!pu.custom_id || pu.custom_id !== expected.intentId) {
    return {
      valid: false,
      reasonCode: RECONCILIATION_REASONS.PAYPAL_CUSTOM_ID_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  if (!pu.amount?.currency_code || pu.amount.currency_code !== "USD") {
    return {
      valid: false,
      reasonCode: RECONCILIATION_REASONS.PAYPAL_CURRENCY_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  if (!pu.amount?.value || pu.amount.value !== expected.expectedAmountCanonical) {
    return {
      valid: false,
      reasonCode: RECONCILIATION_REASONS.PAYPAL_AMOUNT_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  if (!pu.payee?.merchant_id || pu.payee.merchant_id.trim() !== expected.expectedMerchantId) {
    return {
      valid: false,
      reasonCode: RECONCILIATION_REASONS.PAYPAL_MERCHANT_MISMATCH,
      isMerchantMismatch: true,
    };
  }

  return { valid: true };
}

/**
 * POST /api/public/portal/[token]/payments/orders
 *
 * Authenticated client endpoint to create a PayPal order for an existing payment intent.
 *
 * Security & Financial Invariants:
 * 1. Authenticates client session via HttpOnly cookie and validates CSRF token in constant time.
 * 2. Enforces project and portal token cryptographic binding.
 * 3. Never trusts client input for amounts, currency, merchant, or purchase-unit payloads.
 * 4. Loads canonical payment intent, idempotency key, and purchase-unit payload from authoritative database.
 * 5. Verifies agreement version status is APPROVED and milestone belongs to that agreement version.
 * 6. Enforces PayPal Orders conservative 5-hour idempotency recovery retention cutoff.
 * 7. Atomically claims order-creation lease with cryptographically secure UUID fencing token and row locks.
 * 8. Requests `Prefer: return=representation` header from PayPal Orders v2 API.
 * 9. Falls back to GET /v2/checkout/orders/{id} if initial provider response contains minimal representation.
 * 10. Enforces strict validation of returned order status, single purchase unit, IDs, USD currency, canonical amount, and payee merchant ID.
 * 11. Employs fenced release, fenced order recording, and fenced reconciliation transition, preventing stale workers from clearing or overwriting newer leases.
 * 12. Persists standardized, controlled reason codes, never raw exception text or secrets.
 * 13. Does not initiate capture, buyer approval, or webhooks (reserved for subsequent phases).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;

  // 1. Validate portal invitation token format
  if (!token || !TOKEN_REGEX.test(token)) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // 2. Hash portal invitation token
  const tokenHash = hashPortalToken(token);

  // 3. Mandatory primary rate limit: Token-based
  const tokenLimitKey = getPortalTokenRateLimitKey("portal-payment-order", tokenHash);
  const tokenLimit = await checkRateLimit(tokenLimitKey, 10, 900_000, {
    failClosedInProduction: true,
  });

  if (!tokenLimit.allowed) {
    if (tokenLimit.status === "service_unavailable") {
      return apiError("RATE_LIMITER_UNAVAILABLE", 503, {
        "Cache-Control": "no-store",
      });
    }
    return apiError("RATE_LIMITED", 429, {
      "Cache-Control": "no-store",
    });
  }

  // 4. Optional secondary rate limit: IP-based (only when proxy trust is enabled)
  const clientIp = getClientIp(request);
  if (clientIp) {
    const ipLimitKey = getPortalIpRateLimitKey("portal-payment-order", clientIp);
    const ipLimit = await checkRateLimit(ipLimitKey, 10, 900_000, {
      failClosedInProduction: true,
    });

    if (!ipLimit.allowed) {
      if (ipLimit.status === "service_unavailable") {
        return apiError("RATE_LIMITER_UNAVAILABLE", 503, {
          "Cache-Control": "no-store",
        });
      }
      return apiError("RATE_LIMITED", 429, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 5. Validate CSRF header presence
  const csrfToken = request.headers.get("x-csrf-token");
  if (!csrfToken) {
    return apiError("INVALID_CSRF_TOKEN", 403, {
      "Cache-Control": "no-store",
    });
  }

  // 6. Strict request body validation
  let payload: z.infer<typeof createOrderSchema>;
  try {
    const bodyText = await request.text();
    if (!bodyText || bodyText.trim().length === 0) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    const rawJson = JSON.parse(bodyText);
    const parseResult = createOrderSchema.safeParse(rawJson);
    if (!parseResult.success) {
      return apiError("VALIDATION_ERROR", 400, {
        "Cache-Control": "no-store",
      });
    }

    payload = parseResult.data;
  } catch {
    return apiError("VALIDATION_ERROR", 400, {
      "Cache-Control": "no-store",
    });
  }

  // 7. Initialize service-role database client
  let serviceClient: ReturnType<typeof createServiceClient>;
  try {
    serviceClient = createServiceClient();
  } catch {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 8. Resolve portal token and bound project context
  const { data: portalToken, error: tokenError } = await serviceClient
    .from("client_portal_tokens")
    .select("project_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  if (!portalToken || portalToken.revoked_at !== null) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // 9. Authenticate portal session with timing-safe CSRF and project binding
  const authResult = await authenticatePortalSession({
    csrfToken,
    requireCsrf: true,
    expectedProjectId: portalToken.project_id,
    supabaseClient: serviceClient,
  });

  if (!authResult.success) {
    return apiError(authResult.error, authResult.status, {
      "Cache-Control": "no-store",
    });
  }

  // 10. Retrieve trusted PayPal environment configuration
  let paypalEnv: ReturnType<typeof getPayPalServerEnv>;
  try {
    paypalEnv = getPayPalServerEnv();
  } catch {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  if (
    !paypalEnv.expectedMerchantId ||
    paypalEnv.expectedMerchantId.length < 3 ||
    paypalEnv.expectedMerchantId.length > 64
  ) {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 11. Load payment intent from database
  const { data: intent, error: intentError } = await serviceClient
    .from("payment_intents")
    .select(
      "id, project_id, milestone_id, agreement_version_id, status, expected_merchant_id, expected_currency, expected_amount_canonical, order_idempotency_key, canonical_payload_json, provider_order_id, order_creation_lease_expires_at, created_at"
    )
    .eq("id", payload.paymentIntentId)
    .maybeSingle();

  if (intentError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  if (!intent) {
    return apiError("PAYMENT_INTENT_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // Multi-tenant project isolation
  if (intent.project_id !== authResult.projectId) {
    return apiError("FORBIDDEN", 403, {
      "Cache-Control": "no-store",
    });
  }

  // Milestone contextual matching (if provided)
  if (payload.milestoneId && intent.milestone_id !== payload.milestoneId) {
    return apiError("MILESTONE_MISMATCH", 400, {
      "Cache-Control": "no-store",
    });
  }

  // 12. State Invariants & Ineligibility Checks
  if (intent.status === "COMPLETED") {
    return apiError("MILESTONE_ALREADY_COMPLETED", 409, {
      "Cache-Control": "no-store",
    });
  }

  if (intent.status === "RECONCILIATION_REQUIRED") {
    return apiError("RECONCILIATION_REQUIRED", 409, {
      "Cache-Control": "no-store",
    });
  }

  if (["FAILED", "CANCELLED"].includes(intent.status)) {
    return apiError("INELIGIBLE_PAYMENT_INTENT", 409, {
      "Cache-Control": "no-store",
    });
  }

  // 13. Verify Milestone Status Server-Side
  const { data: milestone, error: milestoneError } = await serviceClient
    .from("milestones")
    .select("id, project_id, agreement_version_id, status, currency")
    .eq("id", intent.milestone_id)
    .maybeSingle();

  if (milestoneError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  if (!milestone || milestone.project_id !== authResult.projectId) {
    return apiError("MILESTONE_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  if (!["APPROVED", "IN_PROGRESS", "SUBMITTED"].includes(milestone.status)) {
    return apiError("MILESTONE_NOT_PAYABLE", 400, {
      "Cache-Control": "no-store",
    });
  }

  if (milestone.currency !== "USD") {
    return apiError("UNSUPPORTED_CURRENCY", 400, {
      "Cache-Control": "no-store",
    });
  }

  // Milestone must match the agreement version referenced by the intent
  if (milestone.agreement_version_id !== intent.agreement_version_id) {
    return apiError("AGREEMENT_VERSION_MISMATCH", 400, {
      "Cache-Control": "no-store",
    });
  }

  // 14. Verify Agreement Version Status & Project Binding
  const { data: agreementVersion, error: avError } = await serviceClient
    .from("agreement_versions")
    .select("id, agreement_id, status")
    .eq("id", intent.agreement_version_id)
    .maybeSingle();

  if (avError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  if (!agreementVersion) {
    return apiError("AGREEMENT_VERSION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  if (agreementVersion.status !== "APPROVED") {
    return apiError("AGREEMENT_NOT_APPROVED", 400, {
      "Cache-Control": "no-store",
    });
  }

  // Verify parent agreement project binding
  const { data: agreement, error: agError } = await serviceClient
    .from("agreements")
    .select("id, project_id")
    .eq("id", agreementVersion.agreement_id)
    .maybeSingle();

  if (agError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  if (!agreement || agreement.project_id !== authResult.projectId) {
    return apiError("FORBIDDEN", 403, {
      "Cache-Control": "no-store",
    });
  }

  // 15. Idempotent Fast-Path: If already ORDER_CREATED, return existing provider_order_id immediately
  if (intent.status === "ORDER_CREATED" && intent.provider_order_id) {
    return NextResponse.json(
      {
        success: true,
        paymentIntentId: intent.id,
        orderId: intent.provider_order_id,
        status: "ORDER_CREATED",
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  // Intent must be in ORDER_CREATING to proceed
  if (intent.status !== "ORDER_CREATING") {
    return apiError("INELIGIBLE_PAYMENT_INTENT", 409, {
      "Cache-Control": "no-store",
    });
  }

  // 16. Atomically Claim Order-Creation Lease with Fencing Token and Database Row Locks
  const { data: claimData, error: claimError } = await serviceClient.rpc(
    "claim_order_creation_lease",
    {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_seconds: 45,
    }
  );

  if (claimError) {
    return apiError("DATABASE_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  const claimResult = claimData as {
    success?: boolean;
    claimed?: boolean;
    already_created?: boolean;
    provider_order_id?: string;
    lease_token?: string;
    error?: string;
    status?: string;
    milestone_status?: string;
  };

  // Safe idempotency: if another worker completed order creation concurrently
  if (claimResult.already_created && claimResult.provider_order_id) {
    return NextResponse.json(
      {
        success: true,
        paymentIntentId: intent.id,
        orderId: claimResult.provider_order_id,
        status: "ORDER_CREATED",
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  if (claimResult.error === "LEASE_ACTIVE") {
    return NextResponse.json(
      {
        error: "ORDER_CREATION_IN_PROGRESS",
        message: "Order creation is already in progress for this payment intent. Please retry in a few seconds.",
      },
      {
        status: 409,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "3",
        },
      }
    );
  }

  if (claimResult.error === "MILESTONE_NOT_PAYABLE") {
    return apiError("MILESTONE_NOT_PAYABLE", 400, { "Cache-Control": "no-store" });
  }

  if (!claimResult.success || !claimResult.claimed || !claimResult.lease_token) {
    if (claimResult.error === "FORBIDDEN_PROJECT_MISMATCH") {
      return apiError("FORBIDDEN", 403, { "Cache-Control": "no-store" });
    }
    if (claimResult.error === "SESSION_EXPIRED") {
      return apiError("SESSION_EXPIRED", 401, { "Cache-Control": "no-store" });
    }
    return apiError("ORDER_CLAIM_FAILED", 409, { "Cache-Control": "no-store" });
  }

  const leaseToken = claimResult.lease_token;

  // 17. Enforce PayPal Conservative 5-Hour Idempotency Retention Cutoff
  const intentCreatedAtMs = intent.created_at ? new Date(intent.created_at).getTime() : Date.now();
  const intentAgeMs = Date.now() - intentCreatedAtMs;

  if (intentAgeMs >= PAYPAL_AUTOMATED_RETRY_CUTOFF_MS) {
    await serviceClient.rpc("mark_intent_reconciliation_required", {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_token: leaseToken,
      p_reason_code: RECONCILIATION_REASONS.PAYPAL_RETENTION_WINDOW_EXPIRED,
    });
    return apiError("RECONCILIATION_REQUIRED", 409, {
      "Cache-Control": "no-store",
    });
  }

  // 18. Prepare PayPal Orders API v2 Request
  const canonicalPayload = (intent.canonical_payload_json as {
    purchase_units?: Array<unknown>;
  }) || {};

  if (
    !canonicalPayload.purchase_units ||
    !Array.isArray(canonicalPayload.purchase_units) ||
    canonicalPayload.purchase_units.length !== 1
  ) {
    await serviceClient.rpc("release_order_creation_lease", {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_token: leaseToken,
    });
    return apiError("CORRUPTED_CANONICAL_PAYLOAD", 500, {
      "Cache-Control": "no-store",
    });
  }

  const serverPaymentMode = paypalEnv.paymentMode ?? "PLATFORM";
  const intentPayload = (intent.canonical_payload_json as Record<string, unknown>) || {};
  const intentPaymentMode =
    typeof intentPayload.payment_mode === "string"
      ? intentPayload.payment_mode
      : intentPayload.platform === true
        ? "PLATFORM"
        : undefined;

  // Reject mode mismatch:
  // - Never execute an explicit MERCHANT-mode intent when server runs in PLATFORM mode.
  // - Never downgrade a PLATFORM-mode intent into legacy MERCHANT checkout.
  if (
    (serverPaymentMode === "PLATFORM" && intentPaymentMode === "MERCHANT") ||
    (serverPaymentMode === "MERCHANT" && intentPaymentMode === "PLATFORM")
  ) {
    await serviceClient.rpc("release_order_creation_lease", {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_token: leaseToken,
    });
    return apiError("PAYMENT_MODE_MISMATCH", 409, {
      "Cache-Control": "no-store",
    });
  }

  const isPlatformOrder =
    serverPaymentMode === "PLATFORM" || intentPaymentMode === "PLATFORM";

  const paypalClient = new PayPalClient(paypalEnv);

  let approvalUrl: string | null = null;
  let paypalResponse: PayPalOrderResponse;
  let sellerPayerId: string | undefined;

  if (isPlatformOrder) {
    // SEC-R21-01: In Platform mode, incomplete Platform Partner configuration MUST fail closed.
    // Zero silent fallback to legacy Merchant mode.
    const partnerMerchantId = paypalEnv.partnerMerchantId?.trim();
    if (!partnerMerchantId || partnerMerchantId.length < 3 || partnerMerchantId.length > 64) {
      await serviceClient.rpc("release_order_creation_lease", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
      });
      return apiError("CONFIGURATION_ERROR", 500, {
        "Cache-Control": "no-store",
      });
    }

    // Re-verify seller readiness server-side before initiating multi-party order
    const sellerCheck = await verifyProjectSellerReadiness(serviceClient, authResult.projectId);
    if (sellerCheck.error === "DATABASE_UNAVAILABLE") {
      await serviceClient.rpc("release_order_creation_lease", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
      });
      return apiError("DATABASE_UNAVAILABLE", 503, {
        "Cache-Control": "no-store",
      });
    }

    if (!sellerCheck.success || !sellerCheck.sellerMerchantId) {
      await serviceClient.rpc("release_order_creation_lease", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
      });
      const errorCode = sellerCheck.error || "SELLER_NOT_PAYABLE";
      return apiError(errorCode, 400, {
        "Cache-Control": "no-store",
      });
    }

    if (
      sellerCheck.sellerMerchantId !== intent.expected_merchant_id ||
      (typeof intentPayload.seller_merchant_id === "string" &&
        intentPayload.seller_merchant_id !== sellerCheck.sellerMerchantId)
    ) {
      await serviceClient.rpc("release_order_creation_lease", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
      });
      return apiError("SELLER_MISMATCH", 400, {
        "Cache-Control": "no-store",
      });
    }

    const intentSellerPayerId =
      typeof intentPayload.seller_payer_id === "string"
        ? intentPayload.seller_payer_id
        : undefined;
    sellerPayerId =
      intentSellerPayerId ??
      sellerCheck.sellerPayerId ??
      sellerCheck.sellerMerchantId;

    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "payroost.com";
    const proto = request.headers.get("x-forwarded-proto") || "https";
    const origin = request.headers.get("origin") || `${proto}://${host}`;

    const returnUrl = `${origin}/portal/${encodeURIComponent(token)}?payment_intent_id=${encodeURIComponent(intent.id)}&payment_status=approved`;
    const cancelUrl = `${origin}/portal/${encodeURIComponent(token)}?payment_intent_id=${encodeURIComponent(intent.id)}&payment_status=cancelled`;

    try {
      const platformResult = await paypalClient.createPlatformOrder({
        sellerMerchantId: intent.expected_merchant_id,
        sellerPayerId,
        milestoneId: intent.milestone_id,
        paymentIntentId: intent.id,
        amountCanonical: intent.expected_amount_canonical,
        currency: "USD",
        idempotencyKey: intent.order_idempotency_key,
        returnUrl,
        cancelUrl,
      });

      approvalUrl = platformResult.approvalUrl;
      paypalResponse = (platformResult.rawResponse as PayPalOrderResponse) || {
        id: platformResult.orderId,
        status: platformResult.status,
      };
    } catch (err: unknown) {
      await serviceClient.rpc("release_order_creation_lease", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
      });

      if (err instanceof PayPalError) {
        if (err.errorName === "CONFIGURATION_ERROR") {
          return apiError("CONFIGURATION_ERROR", 500, {
            "Cache-Control": "no-store",
          });
        }
        if (
          err.errorName === "INVALID_SELLER_PAYER_ID" ||
          err.errorName === "INVALID_SELLER_MERCHANT_ID"
        ) {
          return apiError(err.errorName, 400, {
            "Cache-Control": "no-store",
          });
        }
        if (err.status === 408 || err.errorName === "REQUEST_TIMEOUT") {
          return apiError("PROVIDER_TIMEOUT", 504, {
            "Cache-Control": "no-store",
          });
        }
        return apiError("PROVIDER_ERROR", 502, {
          "Cache-Control": "no-store",
        });
      }

      if (err instanceof Error && err.name === "AbortError") {
        return apiError("PROVIDER_TIMEOUT", 504, {
          "Cache-Control": "no-store",
        });
      }

      return apiError("PROVIDER_UNAVAILABLE", 502, {
        "Cache-Control": "no-store",
      });
    }
  } else {
    // Standard single-merchant order creation
    const paypalOrderPayload = {
      intent: "CAPTURE",
      purchase_units: canonicalPayload.purchase_units,
    };

    try {
      const res = await paypalClient.post<PayPalOrderResponse>(
        "/v2/checkout/orders",
        paypalOrderPayload,
        {
          paypalRequestId: intent.order_idempotency_key,
          headers: {
            Prefer: "return=representation",
          },
        }
      );
      paypalResponse = res.data;
      const approvalLink = paypalResponse.links?.find(
        (l) => l.rel === "payer-action" || l.rel === "approve"
      );
      approvalUrl = approvalLink?.href ?? null;
    } catch (err: unknown) {
      // Release the lease immediately using the fencing token
      await serviceClient.rpc("release_order_creation_lease", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
      });

      if (err instanceof PayPalError) {
        if (err.status === 408 || err.errorName === "REQUEST_TIMEOUT") {
          return apiError("PROVIDER_TIMEOUT", 504, {
            "Cache-Control": "no-store",
          });
        }
        return apiError("PROVIDER_ERROR", 502, {
          "Cache-Control": "no-store",
        });
      }

      if (err instanceof Error && err.name === "AbortError") {
        return apiError("PROVIDER_TIMEOUT", 504, {
          "Cache-Control": "no-store",
        });
      }

      return apiError("PROVIDER_UNAVAILABLE", 502, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 20. Validate Initial PayPal Response Structure
  if (!paypalResponse || typeof paypalResponse.id !== "string" || paypalResponse.id.trim().length === 0) {
    await serviceClient.rpc("release_order_creation_lease", {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_token: leaseToken,
    });
    return apiError("MALFORMED_PROVIDER_RESPONSE", 502, {
      "Cache-Control": "no-store",
    });
  }

  const orderId = paypalResponse.id.trim();

  // 21. Check if Response Contains Minimal Representation; Fall Back to GET if Minimal
  const isMinimalRepresentation =
    !paypalResponse.purchase_units ||
    paypalResponse.purchase_units.length === 0 ||
    !paypalResponse.purchase_units[0]?.payee?.merchant_id;

  if (isMinimalRepresentation) {
    try {
      const getRes = isPlatformOrder
        ? await paypalClient.get<PayPalOrderResponse>(
            `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
            {
              authAssertion: { payerId: sellerPayerId || intent.expected_merchant_id },
              ...(paypalEnv.partnerAttributionId
                ? { partnerAttributionId: paypalEnv.partnerAttributionId }
                : {}),
            }
          )
        : await paypalClient.get<PayPalOrderResponse>(
            `/v2/checkout/orders/${encodeURIComponent(orderId)}`
          );
      if (!getRes || !getRes.data) {
        throw new Error("Empty response from PayPal order details");
      }
      paypalResponse = getRes.data;
      if (!approvalUrl) {
        const approvalLink = paypalResponse.links?.find(
          (l) => l.rel === "payer-action" || l.rel === "approve"
        );
        approvalUrl = approvalLink?.href ?? null;
      }
    } catch {
      await serviceClient.rpc("mark_intent_reconciliation_required", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
        p_reason_code: RECONCILIATION_REASONS.PAYPAL_GET_ORDER_FAILED,
      });
      return apiError("PROVIDER_UNAVAILABLE", 502, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 22. Strict Verification of Provider Order Resource
  const validation = validateOrderPayload(paypalResponse, {
    intentId: intent.id,
    milestoneId: intent.milestone_id,
    expectedMerchantId: intent.expected_merchant_id,
    expectedAmountCanonical: intent.expected_amount_canonical,
  });

  if (!validation.valid) {
    await serviceClient.rpc("mark_intent_reconciliation_required", {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_token: leaseToken,
      p_reason_code: validation.reasonCode,
    });

    if (validation.isMerchantMismatch) {
      return apiError("MERCHANT_MISMATCH", 502, {
        "Cache-Control": "no-store",
      });
    }

    return apiError("PROVIDER_ERROR", 502, {
      "Cache-Control": "no-store",
    });
  }

  // 23. Atomically Record Created Order in Database with Fencing Token
  const { data: recordData, error: recordError } = await serviceClient.rpc(
    "record_paypal_order_created",
    {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_token: leaseToken,
      p_provider_order_id: orderId,
      p_expected_merchant_id: intent.expected_merchant_id,
    }
  );

  if (recordError) {
    return apiError("DATABASE_PERSISTENCE_FAILED", 500, {
      "Cache-Control": "no-store",
    });
  }

  const recordResult = recordData as {
    success?: boolean;
    already_recorded?: boolean;
    provider_order_id?: string;
    error?: string;
  };

  if (!recordResult.success) {
    if (recordResult.error === "STALE_LEASE_TOKEN") {
      return apiError("ORDER_CLAIM_FAILED", 409, {
        "Cache-Control": "no-store",
      });
    }
    return apiError("ORDER_PERSISTENCE_FAILED", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 24. Return Safe Response (201 Created or 200 OK)
  const isNewlyCreated = !recordResult.already_recorded;
  return NextResponse.json(
    {
      success: true,
      paymentIntentId: intent.id,
      orderId,
      approvalUrl: approvalUrl ?? null,
      status: "ORDER_CREATED",
    },
    {
      status: isNewlyCreated ? 201 : 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
