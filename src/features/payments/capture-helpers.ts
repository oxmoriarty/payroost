import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PayPalClient } from "@/lib/paypal/client";
import { PayPalError, type PayPalConfig, type PayPalPaymentMode } from "@/lib/paypal/types";
import { apiError } from "@/lib/http";
import {
  isValidDistinctSellerIdentifier,
  parseIntentPaymentMetadata,
  validatePayPalServerModeConfig,
} from "@/lib/paypal/payment-mode";
import { verifyProjectSellerReadiness } from "@/features/payments/seller-verification";

export interface PayPalLinkShape {
  rel?: string;
  href?: string;
  method?: string;
}

export interface PayPalCaptureEntryShape {
  id?: string;
  status?: string;
  amount?: {
    currency_code?: string;
    value?: string;
  };
  payee?: {
    merchant_id?: string;
  };
  custom_id?: string;
  seller_receivable_breakdown?: unknown;
}

export interface PayPalPurchaseUnitShape {
  reference_id?: string;
  custom_id?: string;
  amount?: {
    currency_code?: string;
    value?: string;
  };
  payee?: {
    merchant_id?: string;
  };
  payments?: {
    captures?: PayPalCaptureEntryShape[];
  };
}

export interface PayPalOrderShape {
  id?: string;
  status?: string;
  intent?: string;
  links?: PayPalLinkShape[];
  purchase_units?: PayPalPurchaseUnitShape[];
}

export interface CaptureIntentRecord {
  id: string;
  project_id: string;
  milestone_id: string;
  expected_amount_cents: number;
  expected_currency: string;
  expected_merchant_id: string | null;
  canonical_payload_json: unknown;
}

export interface CapturePaymentContext {
  mode: PayPalPaymentMode;
  authoritativeExpectedMerchantId: string;
  sellerPayerId?: string;
  partnerAttributionId?: string;
}

export type ResolveCaptureContextResult =
  | { ok: true; context: CapturePaymentContext }
  | { ok: false; error: string; httpStatus: number; message: string };

/**
 * Formats integer cents to canonical PayPal 2-decimal USD string.
 */
export function formatCentsToUsd(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

/**
 * Extracts the HATEOAS buyer approval link from a PayPal order payload.
 */
export function extractApprovalUrl(order: PayPalOrderShape | null | undefined): string | null {
  if (!order || !Array.isArray(order.links)) return null;
  const link = order.links.find(
    (entry) =>
      (entry.rel === "payer-action" || entry.rel === "approve") &&
      typeof entry.href === "string" &&
      entry.href.trim().length > 0
  );
  return link?.href?.trim() ?? null;
}

/**
 * Resolves authoritative server + intent payment mode and seller verification context.
 * Enforces explicit mode parity (fail-closed on MERCHANT/PLATFORM mismatch) and zero
 * silent fallback from seller_payer_id to expected_merchant_id.
 */
export async function resolveCapturePaymentContext(params: {
  intent: CaptureIntentRecord;
  paypalEnv: PayPalConfig;
  serviceClient: SupabaseClient;
  requireLiveSellerReady?: boolean;
}): Promise<ResolveCaptureContextResult> {
  const { intent, paypalEnv, serviceClient, requireLiveSellerReady = true } = params;

  const serverValidation = validatePayPalServerModeConfig(paypalEnv);
  if (!serverValidation.valid) {
    return {
      ok: false,
      error: "CONFIGURATION_ERROR",
      httpStatus: 500,
      message: serverValidation.reason,
    };
  }

  const parsedMeta = parseIntentPaymentMetadata(intent.canonical_payload_json);
  if (!parsedMeta.valid) {
    return {
      ok: false,
      error: "CORRUPTED_PAYMENT_INTENT",
      httpStatus: 409,
      message: "Payment intent canonical metadata is invalid or corrupted.",
    };
  }

  if (parsedMeta.mode !== serverValidation.mode) {
    return {
      ok: false,
      error: "PAYMENT_MODE_MISMATCH",
      httpStatus: 409,
      message: `Payment intent uses ${parsedMeta.mode} mode while server is configured for ${serverValidation.mode} mode.`,
    };
  }

  if (serverValidation.mode === "MERCHANT") {
    const serverMerchant = paypalEnv.expectedMerchantId?.trim();
    if (!serverMerchant || serverMerchant.length < 3 || serverMerchant.length > 64) {
      return {
        ok: false,
        error: "CONFIGURATION_ERROR",
        httpStatus: 500,
        message: "Server merchant ID is not properly configured.",
      };
    }

    if (intent.expected_merchant_id && intent.expected_merchant_id.trim() !== serverMerchant) {
      return {
        ok: false,
        error: "MERCHANT_MISMATCH",
        httpStatus: 409,
        message: "Payment intent merchant ID does not match active server Merchant configuration.",
      };
    }

    return {
      ok: true,
      context: {
        mode: "MERCHANT",
        authoritativeExpectedMerchantId: serverMerchant,
      },
    };
  }

  // PLATFORM MODE: strict seller verification without fallbacks
  const intentMerchantId = intent.expected_merchant_id?.trim();
  if (!intentMerchantId || !isValidDistinctSellerIdentifier(intentMerchantId, paypalEnv)) {
    return {
      ok: false,
      error: "SELLER_IDENTITY_MISMATCH",
      httpStatus: 409,
      message: "Payment intent expected_merchant_id is invalid or conflicts with Platform credentials.",
    };
  }

  const sellerPayerId = parsedMeta.sellerPayerId?.trim();
  if (!sellerPayerId) {
    return {
      ok: false,
      error: "SELLER_PAYER_ID_MISSING",
      httpStatus: 409,
      message: "Platform payment intent is missing required seller_payer_id for PayPal-Auth-Assertion.",
    };
  }

  if (!isValidDistinctSellerIdentifier(sellerPayerId, paypalEnv)) {
    return {
      ok: false,
      error: "SELLER_IDENTITY_MISMATCH",
      httpStatus: 409,
      message: "Platform payment intent seller_payer_id is invalid or conflicts with Platform credentials.",
    };
  }

  if (parsedMeta.sellerMerchantId && parsedMeta.sellerMerchantId !== intentMerchantId) {
    return {
      ok: false,
      error: "SELLER_IDENTITY_MISMATCH",
      httpStatus: 409,
      message: "Payment intent seller_merchant_id conflicts with expected_merchant_id.",
    };
  }

  if (
    parsedMeta.purchaseUnitPayeeMerchantId &&
    parsedMeta.purchaseUnitPayeeMerchantId !== intentMerchantId
  ) {
    return {
      ok: false,
      error: "SELLER_IDENTITY_MISMATCH",
      httpStatus: 409,
      message: "Canonical purchase unit payee does not match intent expected_merchant_id.",
    };
  }

  if (requireLiveSellerReady) {
    const sellerCheck = await verifyProjectSellerReadiness(serviceClient, intent.project_id);
    if (!sellerCheck.success) {
      if (sellerCheck.error === "DATABASE_UNAVAILABLE") {
        return {
          ok: false,
          error: "INTERNAL_SERVER_ERROR",
          httpStatus: 500,
          message: "Failed to verify project seller readiness.",
        };
      }

      return {
        ok: false,
        error: sellerCheck.error || "SELLER_NOT_PAYABLE",
        httpStatus: 403,
        message: "Freelancer PayPal account is not currently eligible to receive payments.",
      };
    }

    if (
      !sellerCheck.sellerPayerId ||
      !isValidDistinctSellerIdentifier(sellerCheck.sellerPayerId, paypalEnv)
    ) {
      return {
        ok: false,
        error: "SELLER_PAYER_ID_MISSING",
        httpStatus: 409,
        message: "Verified seller record does not have a valid PayPal payer ID.",
      };
    }

    if (
      sellerCheck.sellerMerchantId !== intentMerchantId ||
      sellerCheck.sellerPayerId !== sellerPayerId
    ) {
      return {
        ok: false,
        error: "SELLER_IDENTITY_MISMATCH",
        httpStatus: 409,
        message: "Seller identity changed after payment intent creation.",
      };
    }
  }

  return {
    ok: true,
    context: {
      mode: "PLATFORM",
      authoritativeExpectedMerchantId: intentMerchantId,
      sellerPayerId,
      ...(serverValidation.partnerAttributionId
        ? { partnerAttributionId: serverValidation.partnerAttributionId }
        : {}),
    },
  };
}

/**
 * Builds request options scoped explicitly to the resolved payment mode.
 * Never injects Auth Assertions into MERCHANT calls; never omits them in PLATFORM calls.
 */
export function buildPayPalCaptureRequestOptions(
  ctx: CapturePaymentContext,
  extra?: { paypalRequestId?: string; preferRepresentation?: boolean }
): {
  paypalRequestId?: string;
  headers?: Record<string, string>;
  authAssertion?: { payerId: string };
  partnerAttributionId?: string;
} {
  const options: {
    paypalRequestId?: string;
    headers?: Record<string, string>;
    authAssertion?: { payerId: string };
    partnerAttributionId?: string;
  } = {};

  if (extra?.paypalRequestId) {
    options.paypalRequestId = extra.paypalRequestId;
  }

  if (extra?.preferRepresentation) {
    options.headers = { Prefer: "return=representation" };
  }

  if (ctx.mode === "PLATFORM") {
    if (!ctx.sellerPayerId || ctx.sellerPayerId.trim().length < 3) {
      throw new Error("SELLER_PAYER_ID_MISSING: Cannot construct PayPal-Auth-Assertion without sellerPayerId.");
    }
    options.authAssertion = { payerId: ctx.sellerPayerId };
    if (ctx.partnerAttributionId && ctx.partnerAttributionId.trim().length > 0) {
      options.partnerAttributionId = ctx.partnerAttributionId;
    }
  }

  return options;
}

/**
 * Executes GET /v2/checkout/orders/{orderId} using mode-scoped headers.
 * Uses 1-arg get(path) in MERCHANT mode to avoid attaching Platform options.
 */
export async function executePayPalOrderGet(
  paypalClient: Pick<PayPalClient, "get">,
  orderId: string,
  ctx: CapturePaymentContext
): Promise<{ data: PayPalOrderShape; status: number; headers: Headers }> {
  const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
  if (ctx.mode === "PLATFORM") {
    const opts = buildPayPalCaptureRequestOptions(ctx);
    return paypalClient.get<PayPalOrderShape>(path, opts);
  }
  return paypalClient.get<PayPalOrderShape>(path);
}

/**
 * Executes GET /v2/payments/captures/{captureId} using mode-scoped headers.
 * Uses 1-arg get(path) in MERCHANT mode to avoid attaching Platform options.
 */
export async function executePayPalCaptureGet(
  paypalClient: Pick<PayPalClient, "get">,
  captureId: string,
  ctx: CapturePaymentContext
): Promise<{ data: PayPalCaptureEntryShape & { supplementary_data?: { related_ids?: { order_id?: string } } }; status: number; headers: Headers }> {
  const path = `/v2/payments/captures/${encodeURIComponent(captureId)}`;
  if (ctx.mode === "PLATFORM") {
    const opts = buildPayPalCaptureRequestOptions(ctx);
    return paypalClient.get<PayPalCaptureEntryShape & { supplementary_data?: { related_ids?: { order_id?: string } } }>(
      path,
      opts
    );
  }
  return paypalClient.get<PayPalCaptureEntryShape & { supplementary_data?: { related_ids?: { order_id?: string } } }>(
    path
  );
}

/**
 * Executes POST /v2/checkout/orders/{orderId}/capture using mode-scoped headers and idempotency key.
 */
export async function executePayPalOrderPostCapture(
  paypalClient: Pick<PayPalClient, "post">,
  orderId: string,
  captureIdempotencyKey: string,
  ctx: CapturePaymentContext,
  preferRepresentation = false
): Promise<{ data: PayPalOrderShape; status: number; headers: Headers }> {
  const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`;
  const opts = buildPayPalCaptureRequestOptions(ctx, {
    paypalRequestId: captureIdempotencyKey,
    preferRepresentation,
  });
  return paypalClient.post<PayPalOrderShape>(path, {}, opts);
}

/**
 * Replays POST /v2/checkout/orders idempotently during reconciliation using mode-scoped headers.
 */
export async function executePayPalCreateOrderReplay(
  paypalClient: Pick<PayPalClient, "post">,
  payload: unknown,
  idempotencyKey: string,
  ctx: CapturePaymentContext
): Promise<{ data: PayPalOrderShape; status: number; headers: Headers }> {
  const opts = buildPayPalCaptureRequestOptions(ctx, {
    paypalRequestId: idempotencyKey,
    preferRepresentation: true,
  });
  return paypalClient.post<PayPalOrderShape>("/v2/checkout/orders", payload, opts);
}

/**
 * Normalizes a decimal amount string for exact comparison without floating-point rounding.
 */
export function normalizeDecimalAmount(val: unknown): string {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return "";
  const integerPart = match[1];
  const decimalPart = (match[2] || "").padEnd(2, "0").slice(0, 2);
  return `${integerPart}.${decimalPart}`;
}

export type PreCaptureValidationResult =
  | { ok: true; approvalUrl: string | null }
  | { ok: false; error: string; httpStatus: number; message: string };

/**
 * Validates purchase unit bindings, amount, currency, and authoritative payee merchant ID
 * on a fetched PayPal order before capture or during completed-order recovery.
 */
export function validateOrderPurchaseUnitsBeforeCapture(params: {
  orderDetails: PayPalOrderShape;
  expectedOrderId: string;
  milestoneId: string;
  intentId: string;
  expectedAmountCents: number;
  expectedAmountCanonical?: string;
  expectedCurrency?: string;
  authoritativeExpectedMerchantId: string;
}): PreCaptureValidationResult {
  const {
    orderDetails,
    expectedOrderId,
    milestoneId,
    intentId,
    expectedAmountCents,
    expectedAmountCanonical,
    expectedCurrency = "USD",
    authoritativeExpectedMerchantId,
  } = params;

  if (!orderDetails.id || orderDetails.id.trim() !== expectedOrderId) {
    return {
      ok: false,
      error: "ORDER_ID_MISMATCH",
      httpStatus: 400,
      message: "PayPal order ID mismatch.",
    };
  }

  if (!Array.isArray(orderDetails.purchase_units) || orderDetails.purchase_units.length !== 1) {
    return {
      ok: false,
      error: "INVALID_PURCHASE_UNITS",
      httpStatus: 400,
      message: "PayPal order must contain exactly one purchase unit.",
    };
  }

  const pu = orderDetails.purchase_units[0];

  if (!pu.reference_id || pu.reference_id !== milestoneId || !pu.custom_id || pu.custom_id !== intentId) {
    return {
      ok: false,
      error: "ORDER_BINDING_MISMATCH",
      httpStatus: 400,
      message: "PayPal order binding mismatch with payment intent or milestone.",
    };
  }

  if (!pu.amount?.currency_code || pu.amount.currency_code !== expectedCurrency) {
    return {
      ok: false,
      error: "CURRENCY_MISMATCH",
      httpStatus: 400,
      message: "PayPal order currency mismatch.",
    };
  }

  const normExpectedAmount = normalizeDecimalAmount(
    expectedAmountCanonical ?? formatCentsToUsd(expectedAmountCents)
  );
  const normPuAmount = normalizeDecimalAmount(pu.amount?.value);
  if (!normPuAmount || normPuAmount !== normExpectedAmount) {
    return {
      ok: false,
      error: "AMOUNT_MISMATCH",
      httpStatus: 400,
      message: "PayPal order amount mismatch.",
    };
  }

  if (
    !pu.payee?.merchant_id ||
    pu.payee.merchant_id.trim() !== authoritativeExpectedMerchantId
  ) {
    return {
      ok: false,
      error: "MERCHANT_MISMATCH",
      httpStatus: 502,
      message: "PayPal order payee merchant mismatch.",
    };
  }

  return {
    ok: true,
    approvalUrl: extractApprovalUrl(orderDetails),
  };
}

/**
 * Fetches GET /v2/checkout/orders/{orderId} using mode-scoped headers, validates order bindings
 * and authoritative payee, executes fenced recovery if the order is already COMPLETED on PayPal,
 * and ensures order status === APPROVED before returning control for POST /capture.
 */
export async function verifyPreCaptureOrderAndRecoverIfCompleted(params: {
  paypalClient: Pick<PayPalClient, "get">;
  serviceClient: SupabaseClient;
  cleanOrderId: string;
  sessionTokenHash: string;
  intent: {
    id: string;
    milestone_id: string;
    expected_currency: string;
    expected_amount_canonical: string;
    expected_amount_cents: number;
  };
  captureCtx: CapturePaymentContext;
}): Promise<
  | { proceedToCapture: true; orderDetails: PayPalOrderShape }
  | { proceedToCapture: false; response: NextResponse }
> {
  const { paypalClient, serviceClient, cleanOrderId, sessionTokenHash, intent, captureCtx } =
    params;

  let orderDetails: PayPalOrderShape;
  try {
    const getRes = await executePayPalOrderGet(paypalClient, cleanOrderId, captureCtx);
    if (!getRes || !getRes.data) {
      throw new Error("Empty GET order response");
    }
    orderDetails = getRes.data;
  } catch (err: unknown) {
    if (err instanceof PayPalError && err.status === 404) {
      return {
        proceedToCapture: false,
        response: apiError("ORDER_NOT_FOUND", 404, { "Cache-Control": "no-store" }),
      };
    }
    return {
      proceedToCapture: false,
      response: apiError("PROVIDER_ERROR", 502, { "Cache-Control": "no-store" }),
    };
  }

  const puValidation = validateOrderPurchaseUnitsBeforeCapture({
    orderDetails,
    expectedOrderId: cleanOrderId,
    milestoneId: intent.milestone_id,
    intentId: intent.id,
    expectedAmountCents: intent.expected_amount_cents,
    expectedAmountCanonical: intent.expected_amount_canonical,
    expectedCurrency: intent.expected_currency,
    authoritativeExpectedMerchantId: captureCtx.authoritativeExpectedMerchantId,
  });

  if (!puValidation.ok) {
    return {
      proceedToCapture: false,
      response: apiError(puValidation.error, puValidation.httpStatus, {
        "Cache-Control": "no-store",
      }),
    };
  }

  const pu = orderDetails.purchase_units![0];

  // Handle Already-Completed Order on PayPal (Safe Fenced Recovery Path)
  if (orderDetails.status === "COMPLETED") {
    const captures = pu.payments?.captures;
    if (!captures || !Array.isArray(captures) || captures.length !== 1) {
      return {
        proceedToCapture: false,
        response: apiError("INVALID_PURCHASE_UNITS", 400, { "Cache-Control": "no-store" }),
      };
    }

    const capture = captures[0];
    if (!capture.id || typeof capture.id !== "string" || capture.id.trim().length === 0) {
      return {
        proceedToCapture: false,
        response: apiError("ORDER_BINDING_MISMATCH", 400, { "Cache-Control": "no-store" }),
      };
    }

    if (capture.amount?.currency_code && capture.amount.currency_code !== intent.expected_currency) {
      return {
        proceedToCapture: false,
        response: apiError("CURRENCY_MISMATCH", 400, { "Cache-Control": "no-store" }),
      };
    }

    const normExpectedAmount = normalizeDecimalAmount(intent.expected_amount_canonical);
    if (capture.amount?.value) {
      const normCaptureAmount = normalizeDecimalAmount(capture.amount.value);
      if (!normCaptureAmount || normCaptureAmount !== normExpectedAmount) {
        return {
          proceedToCapture: false,
          response: apiError("AMOUNT_MISMATCH", 400, { "Cache-Control": "no-store" }),
        };
      }
    }

    if (capture.custom_id && capture.custom_id !== intent.id) {
      return {
        proceedToCapture: false,
        response: apiError("ORDER_BINDING_MISMATCH", 400, { "Cache-Control": "no-store" }),
      };
    }

    if (
      capture.payee?.merchant_id &&
      capture.payee.merchant_id.trim() !== captureCtx.authoritativeExpectedMerchantId
    ) {
      return {
        proceedToCapture: false,
        response: apiError("MERCHANT_MISMATCH", 502, { "Cache-Control": "no-store" }),
      };
    }

    const captureCleanStatus = capture.status?.toUpperCase();

    const { data: claimData, error: claimError } = await serviceClient.rpc(
      "claim_order_capture_lease",
      {
        p_session_token_hash: sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_provider_order_id: cleanOrderId,
        p_lease_seconds: 45,
      }
    );

    if (claimError) {
      return {
        proceedToCapture: false,
        response: apiError("DATABASE_UNAVAILABLE", 503, { "Cache-Control": "no-store" }),
      };
    }

    const claimResult = claimData as {
      success?: boolean;
      claimed?: boolean;
      already_completed?: boolean;
      provider_capture_id?: string;
      lease_token?: string;
      error?: string;
    };

    if (claimResult.already_completed) {
      return {
        proceedToCapture: false,
        response: NextResponse.json(
          {
            success: true,
            paymentIntentId: intent.id,
            orderId: cleanOrderId,
            captureId: claimResult.provider_capture_id ?? capture.id.trim(),
            status: "COMPLETED",
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        ),
      };
    }

    if (claimResult.error === "LEASE_ACTIVE") {
      return {
        proceedToCapture: false,
        response: NextResponse.json(
          {
            error: "CAPTURE_IN_PROGRESS",
            message: "Payment capture is already in progress. Please retry in a few seconds.",
          },
          {
            status: 409,
            headers: { "Cache-Control": "no-store", "Retry-After": "3" },
          }
        ),
      };
    }

    if (claimResult.error === "RECONCILIATION_REQUIRED") {
      return {
        proceedToCapture: false,
        response: apiError("RECONCILIATION_REQUIRED", 409, { "Cache-Control": "no-store" }),
      };
    }

    if (claimResult.error === "MILESTONE_NOT_PAYABLE") {
      return {
        proceedToCapture: false,
        response: apiError("MILESTONE_NOT_PAYABLE", 400, { "Cache-Control": "no-store" }),
      };
    }

    if (!claimResult.success || !claimResult.claimed || !claimResult.lease_token) {
      if (claimResult.error === "FORBIDDEN_PROJECT_MISMATCH") {
        return {
          proceedToCapture: false,
          response: apiError("FORBIDDEN", 403, { "Cache-Control": "no-store" }),
        };
      }
      if (claimResult.error === "SESSION_EXPIRED") {
        return {
          proceedToCapture: false,
          response: apiError("SESSION_EXPIRED", 401, { "Cache-Control": "no-store" }),
        };
      }
      return {
        proceedToCapture: false,
        response: apiError("CAPTURE_CLAIM_FAILED", 409, { "Cache-Control": "no-store" }),
      };
    }

    const recoveryLeaseToken = claimResult.lease_token;

    if (captureCleanStatus === "COMPLETED") {
      const { data: completeSuccess, error: completeError } = await serviceClient.rpc(
        "reconcile_and_complete_payment_intent",
        {
          p_intent_id: intent.id,
          p_provider_capture_id: capture.id.trim(),
          p_raw_capture_response: capture,
          p_raw_order_response: orderDetails,
          p_resolution_notes: "Authoritative capture recovered from PayPal order status COMPLETED",
          p_amount_cents: intent.expected_amount_cents,
          p_payee_merchant_id: captureCtx.authoritativeExpectedMerchantId,
          p_lease_token: recoveryLeaseToken,
        }
      );

      if (!completeError && completeSuccess) {
        return {
          proceedToCapture: false,
          response: NextResponse.json(
            {
              success: true,
              paymentIntentId: intent.id,
              orderId: cleanOrderId,
              captureId: capture.id.trim(),
              status: "COMPLETED",
            },
            { status: 200, headers: { "Cache-Control": "no-store" } }
          ),
        };
      }

      await serviceClient.rpc("mark_intent_capture_reconciliation_required", {
        p_session_token_hash: sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: recoveryLeaseToken,
        p_reason_code: "PAYPAL_CAPTURE_PERSISTENCE_FAILED",
      });
      return {
        proceedToCapture: false,
        response: apiError("RECONCILIATION_REQUIRED", 409, { "Cache-Control": "no-store" }),
      };
    }

    if (captureCleanStatus === "PENDING") {
      await serviceClient.rpc("mark_intent_capture_reconciliation_required", {
        p_session_token_hash: sessionTokenHash,
        p_payment_intent_id: intent.id,
        p_lease_token: recoveryLeaseToken,
        p_reason_code: "PAYPAL_CAPTURE_PENDING",
      });

      return {
        proceedToCapture: false,
        response: NextResponse.json(
          {
            success: true,
            paymentIntentId: intent.id,
            orderId: cleanOrderId,
            captureId: capture.id.trim(),
            status: "PENDING",
            message: "Payment capture is pending provider settlement",
          },
          { status: 202, headers: { "Cache-Control": "no-store" } }
        ),
      };
    }

    await serviceClient.rpc("mark_intent_capture_reconciliation_required", {
      p_session_token_hash: sessionTokenHash,
      p_payment_intent_id: intent.id,
      p_lease_token: recoveryLeaseToken,
      p_reason_code: `PAYPAL_CAPTURE_${captureCleanStatus || "FAILED"}`,
    });

    return {
      proceedToCapture: false,
      response: NextResponse.json(
        {
          error: "PAYMENT_DECLINED",
          message: "Payment was declined by PayPal.",
          paymentIntentId: intent.id,
          orderId: cleanOrderId,
          captureId: capture.id.trim(),
          status: "FAILED",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
    };
  }

  if (orderDetails.status !== "APPROVED") {
    return {
      proceedToCapture: false,
      response: NextResponse.json(
        {
          error: "ORDER_NOT_APPROVED",
          message: "Order is not yet approved by the payer on PayPal.",
          status: orderDetails.status ?? "CREATED",
          ...(puValidation.approvalUrl ? { approvalUrl: puValidation.approvalUrl } : {}),
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      ),
    };
  }

  return { proceedToCapture: true, orderDetails };
}

