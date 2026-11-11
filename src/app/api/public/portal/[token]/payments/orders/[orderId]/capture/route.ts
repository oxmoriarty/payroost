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
import { validatePayPalServerModeConfig } from "@/lib/paypal/payment-mode";
import {
  resolveCapturePaymentContext,
  executePayPalOrderGet,
  executePayPalOrderPostCapture,
  verifyPreCaptureOrderAndRecoverIfCompleted,
} from "@/features/payments/capture-helpers";
import { apiError } from "@/lib/http";

const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,128}$/;
const ORDER_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Controlled reconciliation reason codes for order capture.
 */
export const CAPTURE_RECONCILIATION_REASONS = {
  PAYPAL_CAPTURE_TIMEOUT: "PAYPAL_CAPTURE_TIMEOUT",
  PAYPAL_CAPTURE_PROVIDER_ERROR: "PAYPAL_CAPTURE_PROVIDER_ERROR",
  PAYPAL_CAPTURE_STATUS_INVALID: "PAYPAL_CAPTURE_STATUS_INVALID",
  PAYPAL_CAPTURE_PENDING: "PAYPAL_CAPTURE_PENDING",
  PAYPAL_PURCHASE_UNIT_INVALID: "PAYPAL_PURCHASE_UNIT_INVALID",
  PAYPAL_CAPTURE_AMOUNT_MISMATCH: "PAYPAL_CAPTURE_AMOUNT_MISMATCH",
  PAYPAL_CAPTURE_CURRENCY_MISMATCH: "PAYPAL_CAPTURE_CURRENCY_MISMATCH",
  PAYPAL_CAPTURE_MERCHANT_MISMATCH: "PAYPAL_CAPTURE_MERCHANT_MISMATCH",
  PAYPAL_CAPTURE_REFERENCE_ID_MISMATCH: "PAYPAL_CAPTURE_REFERENCE_ID_MISMATCH",
  PAYPAL_CAPTURE_CUSTOM_ID_MISMATCH: "PAYPAL_CAPTURE_CUSTOM_ID_MISMATCH",
  PAYPAL_ORDER_ID_MISMATCH: "PAYPAL_ORDER_ID_MISMATCH",
  PAYPAL_GET_ORDER_FAILED: "PAYPAL_GET_ORDER_FAILED",
  PAYMENT_CAPTURE_PERSISTENCE_FAILED: "PAYMENT_CAPTURE_PERSISTENCE_FAILED",
} as const;

export type CaptureReconciliationReasonCode =
  (typeof CAPTURE_RECONCILIATION_REASONS)[keyof typeof CAPTURE_RECONCILIATION_REASONS];

/**
 * Optional request payload schema for capture endpoint.
 * Extraneous fields (amount, currency, merchantId, status, etc.) are strictly forbidden.
 */
const captureRequestSchema = z
  .object({
    paymentIntentId: z.string().uuid("Invalid payment intent ID format").optional(),
  })
  .strict();

export interface PayPalCaptureDetails {
  id: string;
  status: string; // COMPLETED, PENDING, DECLINED, FAILED
  amount?: {
    currency_code?: string;
    value?: string;
  };
  payee?: {
    merchant_id?: string;
  };
  custom_id?: string;
}

export interface PayPalOrderCaptureResponse {
  id: string;
  status: string; // e.g. COMPLETED
  purchase_units?: Array<{
    reference_id?: string;
    payee?: {
      merchant_id?: string;
    };
    payments?: {
      captures?: PayPalCaptureDetails[];
    };
  }>;
}

/**
 * Validates the full PayPal capture response representation against authoritative DB state.
 */
function validateCapturePayload(
  order: PayPalOrderCaptureResponse,
  expected: {
    intentId: string;
    milestoneId: string;
    expectedMerchantId: string;
    expectedAmountCanonical: string;
    orderId: string;
  }
): {
  valid: true;
  capture: PayPalCaptureDetails;
} | {
  valid: false;
  reasonCode: CaptureReconciliationReasonCode;
  isMerchantMismatch: boolean;
  captureStatus?: string;
} {
  // Validate top-level PayPal order ID matches expected order ID (Finding F-03)
  if (!order.id || typeof order.id !== "string" || order.id.trim() !== expected.orderId) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_ORDER_ID_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  if (!order.purchase_units || !Array.isArray(order.purchase_units) || order.purchase_units.length !== 1) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_PURCHASE_UNIT_INVALID,
      isMerchantMismatch: false,
    };
  }

  const pu = order.purchase_units[0];

  if (!pu.reference_id || pu.reference_id !== expected.milestoneId) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_REFERENCE_ID_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  const captures = pu.payments?.captures;
  if (!captures || !Array.isArray(captures) || captures.length !== 1) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_PURCHASE_UNIT_INVALID,
      isMerchantMismatch: false,
    };
  }

  const capture = captures[0];

  if (!capture.id || typeof capture.id !== "string" || capture.id.trim().length === 0) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_STATUS_INVALID,
      isMerchantMismatch: false,
    };
  }

  // Validate custom_id if present
  if (capture.custom_id && capture.custom_id !== expected.intentId) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_CUSTOM_ID_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  // Validate amount currency
  if (!capture.amount?.currency_code || capture.amount.currency_code !== "USD") {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_CURRENCY_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  // Validate amount value
  if (!capture.amount?.value || capture.amount.value !== expected.expectedAmountCanonical) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_AMOUNT_MISMATCH,
      isMerchantMismatch: false,
    };
  }

  // Validate payee merchant ID (on capture or purchase unit)
  const captureMerchantId = capture.payee?.merchant_id ?? pu.payee?.merchant_id;
  if (!captureMerchantId || captureMerchantId.trim() !== expected.expectedMerchantId) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_MERCHANT_MISMATCH,
      isMerchantMismatch: true,
    };
  }

  const cleanStatus = capture.status?.toUpperCase();
  if (!cleanStatus || !["COMPLETED", "PENDING", "DECLINED", "FAILED"].includes(cleanStatus)) {
    return {
      valid: false,
      reasonCode: CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_STATUS_INVALID,
      isMerchantMismatch: false,
      captureStatus: cleanStatus,
    };
  }

  return { valid: true, capture };
}

/**
 * POST /api/public/portal/[token]/payments/orders/[orderId]/capture
 *
 * Authenticated client endpoint to execute PayPal Orders v2 capture for an approved order.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string; orderId: string }> }
) {
  const { token, orderId } = await context.params;

  // 1. Validate portal invitation token format
  if (!token || !TOKEN_REGEX.test(token)) {
    return apiError("INVITATION_NOT_FOUND", 404, {
      "Cache-Control": "no-store",
    });
  }

  // 2. Validate PayPal order ID format
  if (!orderId || !ORDER_ID_REGEX.test(orderId)) {
    return apiError("VALIDATION_ERROR", 400, {
      "Cache-Control": "no-store",
    });
  }

  const cleanOrderId = orderId.trim();

  // 3. Hash portal invitation token
  const tokenHash = hashPortalToken(token);

  // 4. Rate limiting: Token-based
  const tokenLimitKey = getPortalTokenRateLimitKey("portal-payment-capture", tokenHash);
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

  // 5. Rate limiting: IP-based
  const clientIp = getClientIp(request);
  if (clientIp) {
    const ipLimitKey = getPortalIpRateLimitKey("portal-payment-capture", clientIp);
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

  // 6. Timing-safe CSRF token extraction
  const csrfToken = request.headers.get("x-csrf-token");
  if (!csrfToken) {
    return apiError("INVALID_CSRF_TOKEN", 403, {
      "Cache-Control": "no-store",
    });
  }

  // 7. Optional request body parsing (if present)
  let optionalIntentId: string | undefined;
  try {
    const bodyText = await request.text();
    if (bodyText && bodyText.trim().length > 0) {
      const rawJson = JSON.parse(bodyText);
      const parseResult = captureRequestSchema.safeParse(rawJson);
      if (!parseResult.success) {
        return apiError("VALIDATION_ERROR", 400, {
          "Cache-Control": "no-store",
        });
      }
      optionalIntentId = parseResult.data.paymentIntentId;
    }
  } catch {
    return apiError("VALIDATION_ERROR", 400, {
      "Cache-Control": "no-store",
    });
  }

  // 8. Initialize service client
  let serviceClient: ReturnType<typeof createServiceClient>;
  try {
    serviceClient = createServiceClient();
  } catch {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 9. Resolve portal token and bound project context
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

  // 10. Authenticate portal session
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

  // 11. Retrieve trusted PayPal environment configuration
  let paypalEnv: ReturnType<typeof getPayPalServerEnv>;
  try {
    paypalEnv = getPayPalServerEnv();
  } catch {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  const serverModeValidation = validatePayPalServerModeConfig(paypalEnv);
  if (!serverModeValidation.valid) {
    return apiError("CONFIGURATION_ERROR", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 12. Resolve payment intent associated with supplied PayPal order ID
  const { data: intent, error: intentError } = await serviceClient
    .from("payment_intents")
    .select(
      "id, project_id, milestone_id, agreement_version_id, status, expected_merchant_id, expected_currency, expected_amount_canonical, expected_amount_cents, capture_idempotency_key, canonical_payload_json, provider_order_id, capture_lease_expires_at, created_at"
    )
    .eq("provider_order_id", cleanOrderId)
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

  // Multi-tenant project isolation: order must belong to authenticated portal context
  if (intent.project_id !== authResult.projectId) {
    return apiError("FORBIDDEN", 403, {
      "Cache-Control": "no-store",
    });
  }

  // Optional contextual cross-verification
  if (optionalIntentId && intent.id !== optionalIntentId) {
    return apiError("PAYMENT_INTENT_MISMATCH", 400, {
      "Cache-Control": "no-store",
    });
  }

  // 13. State Invariants & Terminal State Protections
  if (intent.status === "COMPLETED") {
    // Idempotent fast-path: retrieve existing completed capture reference
    const { data: existingCapture } = await serviceClient
      .from("payment_transactions")
      .select("provider_reference_id, status")
      .eq("payment_intent_id", intent.id)
      .eq("transaction_type", "CAPTURE")
      .eq("status", "COMPLETED")
      .maybeSingle();

    return NextResponse.json(
      {
        success: true,
        paymentIntentId: intent.id,
        orderId: cleanOrderId,
        captureId: existingCapture?.provider_reference_id ?? null,
        status: "COMPLETED",
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
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

  if (!["ORDER_CREATED", "BUYER_APPROVED"].includes(intent.status)) {
    // If already in CAPTURING, check if current lease is still active
    if (intent.status === "CAPTURING" && intent.capture_lease_expires_at) {
      const leaseExpiry = new Date(intent.capture_lease_expires_at).getTime();
      if (leaseExpiry > Date.now()) {
        return NextResponse.json(
          {
            error: "CAPTURE_IN_PROGRESS",
            message: "Payment capture is already in progress. Please retry in a few seconds.",
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
    }

    if (intent.status !== "CAPTURING") {
      return apiError("INELIGIBLE_PAYMENT_INTENT", 409, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 14. Verify Milestone Status Server-Side
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

  // 14.5 Resolve Mode-Aware Capture Context & Seller Verification (Fail-Closed)
  const captureCtxResult = await resolveCapturePaymentContext({
    intent,
    paypalEnv,
    serviceClient,
    requireLiveSellerReady: true,
  });
  if (!captureCtxResult.ok) {
    return NextResponse.json(
      {
        error: captureCtxResult.error,
        message: captureCtxResult.message,
      },
      {
        status: captureCtxResult.httpStatus,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
  const captureCtx = captureCtxResult.context;

  // 14.6 Pre-Capture Approval Verification & Fenced Completed-Order Recovery (GET)
  const paypalClient = new PayPalClient(paypalEnv);
  const preCaptureCheck = await verifyPreCaptureOrderAndRecoverIfCompleted({
    paypalClient,
    serviceClient,
    cleanOrderId,
    sessionTokenHash: authResult.sessionTokenHash,
    intent: {
      id: intent.id,
      milestone_id: intent.milestone_id,
      expected_currency: intent.expected_currency,
      expected_amount_canonical: intent.expected_amount_canonical,
      expected_amount_cents: intent.expected_amount_cents,
    },
    captureCtx,
  });
  if (!preCaptureCheck.proceedToCapture) {
    return preCaptureCheck.response;
  }

  // 15. Atomically Claim Capture Lease with Row Lock and Fencing Token
  const { data: claimData, error: claimError } = await serviceClient.rpc(
    "claim_order_capture_lease",
    {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_provider_order_id: cleanOrderId,
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
    already_completed?: boolean;
    provider_capture_id?: string;
    lease_token?: string;
    error?: string;
    status?: string;
  };

  // Safe idempotency fast-path if completed concurrently
  if (claimResult.already_completed) {
    return NextResponse.json(
      {
        success: true,
        paymentIntentId: intent.id,
        orderId: cleanOrderId,
        captureId: claimResult.provider_capture_id ?? null,
        status: "COMPLETED",
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  if (claimResult.error === "LEASE_ACTIVE") {
    return NextResponse.json(
      {
        error: "CAPTURE_IN_PROGRESS",
        message: "Payment capture is already in progress. Please retry in a few seconds.",
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

  if (claimResult.error === "RECONCILIATION_REQUIRED") {
    return apiError("RECONCILIATION_REQUIRED", 409, { "Cache-Control": "no-store" });
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
    return apiError("CAPTURE_CLAIM_FAILED", 409, { "Cache-Control": "no-store" });
  }

  const leaseToken = claimResult.lease_token;

  // 16. Execute Official PayPal Orders v2 Capture Request
  let captureResponse: PayPalOrderCaptureResponse | null = null;
  let ambiguousOutcome = false;
  let ambiguousReason: CaptureReconciliationReasonCode =
    CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_TIMEOUT;

  try {
    const res = await executePayPalOrderPostCapture(
      paypalClient,
      cleanOrderId,
      intent.capture_idempotency_key,
      captureCtx,
      true
    );
    captureResponse = res.data as PayPalOrderCaptureResponse;
  } catch (err: unknown) {
    if (err instanceof PayPalError) {
      // 422 with ORDER_ALREADY_CAPTURED: another worker or retry captured the order earlier
      if (
        err.status === 422 &&
        err.details?.some((d) => d.issue === "ORDER_ALREADY_CAPTURED")
      ) {
        ambiguousOutcome = true;
        ambiguousReason = CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_PROVIDER_ERROR;
      } else if (err.status === 408 || err.errorName === "REQUEST_TIMEOUT") {
        ambiguousOutcome = true;
        ambiguousReason = CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_TIMEOUT;
      } else if (err.status >= 500) {
        ambiguousOutcome = true;
        ambiguousReason = CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_PROVIDER_ERROR;
      } else if (err.status === 422 && err.details?.some((d) => d.issue === "INSTRUMENT_DECLINED")) {
        // Capture denied by payment method
        await serviceClient.rpc("release_order_capture_lease", {
          p_session_token_hash: authResult.sessionTokenHash,
          p_payment_intent_id: intent.id,
          p_lease_token: leaseToken,
          p_target_status: "ORDER_CREATED",
        });
        return apiError("PAYMENT_DECLINED", 400, {
          "Cache-Control": "no-store",
        });
      } else {
        // Other 4xx error (e.g. 404, 400)
        await serviceClient.rpc("release_order_capture_lease", {
          p_session_token_hash: authResult.sessionTokenHash,
          p_payment_intent_id: intent.id,
          p_lease_token: leaseToken,
          p_target_status: "ORDER_CREATED",
        });
        return apiError("PROVIDER_ERROR", 502, {
          "Cache-Control": "no-store",
        });
      }
    } else if (err instanceof Error && err.name === "AbortError") {
      ambiguousOutcome = true;
      ambiguousReason = CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_TIMEOUT;
    } else {
      ambiguousOutcome = true;
      ambiguousReason = CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_PROVIDER_ERROR;
    }
  }

  // 17. Ambiguous Outcome Recovery: Query GET /v2/checkout/orders/{id}
  if (ambiguousOutcome || !captureResponse) {
    try {
      const getRes = await executePayPalOrderGet(paypalClient, cleanOrderId, captureCtx);

      const orderDetails = getRes.data as PayPalOrderCaptureResponse;
      const captures = orderDetails?.purchase_units?.[0]?.payments?.captures;

      if (orderDetails && captures && captures.length > 0) {
        // PayPal completed the capture! Recover capture representation
        captureResponse = orderDetails;
      } else if (orderDetails && ["CREATED", "APPROVED"].includes(orderDetails.status)) {
        // Order was NOT captured at PayPal. Safe to release lease back to ORDER_CREATED.
        await serviceClient.rpc("release_order_capture_lease", {
          p_session_token_hash: authResult.sessionTokenHash,
          p_payment_intent_id: intent.id,
          p_lease_token: leaseToken,
          p_target_status: "ORDER_CREATED",
        });

        const isTimeout = ambiguousReason === CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_TIMEOUT;
        return apiError(isTimeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR", isTimeout ? 504 : 502, {
          "Cache-Control": "no-store",
        });
      } else {
        // Outcome remains unresolved. Escalate to RECONCILIATION_REQUIRED.
        await serviceClient.rpc("mark_intent_capture_reconciliation_required", {
          p_session_token_hash: authResult.sessionTokenHash,
          p_payment_intent_id: intent.id,
          p_lease_token: leaseToken,
          p_reason_code: ambiguousReason,
        });
        return apiError("RECONCILIATION_REQUIRED", 409, {
          "Cache-Control": "no-store",
        });
      }
    } catch {
      // GET inquiry failed. Persist RECONCILIATION_REQUIRED with lease fencing. Milestone remains locked.
      await serviceClient.rpc("mark_intent_capture_reconciliation_required", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
        p_reason_code: ambiguousReason,
      });

      const isTimeout = ambiguousReason === CAPTURE_RECONCILIATION_REASONS.PAYPAL_CAPTURE_TIMEOUT;
      return apiError(isTimeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR", isTimeout ? 504 : 502, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 18. Fall back to GET if capture response is minimal
  const isMinimal =
    !captureResponse.purchase_units ||
    captureResponse.purchase_units.length === 0 ||
    !captureResponse.purchase_units[0]?.payments?.captures ||
    captureResponse.purchase_units[0].payments.captures.length === 0;

  if (isMinimal) {
    try {
      const getRes = await executePayPalOrderGet(paypalClient, cleanOrderId, captureCtx);
      if (!getRes || !getRes.data) {
        throw new Error("Empty GET order response");
      }
      captureResponse = getRes.data as PayPalOrderCaptureResponse;
    } catch {
      await serviceClient.rpc("mark_intent_capture_reconciliation_required", {
        p_session_token_hash: authResult.sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: leaseToken,
        p_reason_code: CAPTURE_RECONCILIATION_REASONS.PAYPAL_GET_ORDER_FAILED,
      });
      return apiError("RECONCILIATION_REQUIRED", 409, {
        "Cache-Control": "no-store",
      });
    }
  }

  // 19. Strict Validation of Capture Representation
  const validation = validateCapturePayload(captureResponse, {
    intentId: intent.id,
    milestoneId: intent.milestone_id,
    expectedMerchantId: captureCtx.authoritativeExpectedMerchantId,
    expectedAmountCanonical: intent.expected_amount_canonical,
    orderId: cleanOrderId,
  });

  if (!validation.valid) {
    await serviceClient.rpc("mark_intent_capture_reconciliation_required", {
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

  const { capture } = validation;

  // 20. Atomically Record Capture in Payment Ledger & Update State
  const { data: recordData, error: recordError } = await serviceClient.rpc(
    "record_paypal_order_captured",
    {
      p_session_token_hash: authResult.sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_token: leaseToken,
      p_provider_capture_id: capture.id.trim(),
      p_capture_status: capture.status.toUpperCase(),
      p_amount_cents: intent.expected_amount_cents,
      p_payee_merchant_id: captureCtx.authoritativeExpectedMerchantId,
      p_raw_capture_response: captureResponse,
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
    status?: string;
    capture_id?: string;
    error?: string;
    reconciliation_required?: boolean;
  };

  if (!recordResult.success) {
    if (recordResult.error === "STALE_LEASE_TOKEN") {
      return apiError("CAPTURE_CLAIM_FAILED", 409, {
        "Cache-Control": "no-store",
      });
    }
    if (recordResult.error === "DUPLICATE_CAPTURE_ID") {
      return apiError("DUPLICATE_CAPTURE_ID", 409, {
        "Cache-Control": "no-store",
      });
    }
    return apiError("CAPTURE_PERSISTENCE_FAILED", 500, {
      "Cache-Control": "no-store",
    });
  }

  // 21. Format Authoritative Response
  if (recordResult.status === "COMPLETED") {
    return NextResponse.json(
      {
        success: true,
        paymentIntentId: intent.id,
        orderId: cleanOrderId,
        captureId: recordResult.capture_id ?? capture.id.trim(),
        status: "COMPLETED",
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  if (recordResult.status === "PENDING") {
    return NextResponse.json(
      {
        success: true,
        paymentIntentId: intent.id,
        orderId: cleanOrderId,
        captureId: recordResult.capture_id ?? capture.id.trim(),
        status: "PENDING",
        message: "Payment capture is pending provider settlement",
      },
      {
        status: 202,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  // Declined or Failed
  return NextResponse.json(
    {
      error: "PAYMENT_DECLINED",
      message: "Payment was declined by PayPal.",
      paymentIntentId: intent.id,
      orderId: cleanOrderId,
      captureId: recordResult.capture_id ?? capture.id.trim(),
      status: "FAILED",
    },
    {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
