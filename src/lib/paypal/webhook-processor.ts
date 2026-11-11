import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { getPayPalServerEnv } from "@/lib/paypal/env";
import { PayPalClient } from "@/lib/paypal/client";
import { PayPalError, type PayPalConfig, type PayPalPaymentMode } from "@/lib/paypal/types";
import { validatePayPalWebhookServerConfig } from "@/lib/paypal/payment-mode";
import {
  resolveCapturePaymentContext,
  executePayPalOrderGet,
  executePayPalCaptureGet,
  validateOrderPurchaseUnitsBeforeCapture,
  normalizeDecimalAmount,
  formatCentsToUsd,
  type CapturePaymentContext,
  type PayPalCaptureEntryShape,
  type PayPalOrderShape,
} from "@/features/payments/capture-helpers";
import {
  extractPayPalWebhookHeaders,
  parsePayPalWebhookEnvelope,
  verifyPayPalWebhookSignature,
  isSupportedPayPalWebhookEventType,
  sanitizePayPalWebhookPayload,
  sanitizePayPalCaptureSnapshot,
  sanitizePayPalOrderSnapshot,
  extractWebhookCandidateIdentifiers,
  extractWebhookSanitizedMetadata,
  isValidUuid,
  type PayPalWebhookEnvelope,
} from "@/lib/paypal/webhooks";

const DEFAULT_WEBHOOK_LEASE_SECONDS = 60;
const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 5;

export interface WebhookHandleResult {
  httpStatus: number;
  body: {
    received: boolean;
    processed?: boolean;
    duplicate?: boolean;
    inProgress?: boolean;
    outcome?: string;
    eventId?: string;
    paymentIntentId?: string | null;
    paymentMode?: PayPalPaymentMode | null;
    error?: string;
    message?: string;
  };
  headers?: Record<string, string>;
}

interface IntentLookupRow {
  id: string;
  project_id: string;
  milestone_id: string;
  status: string;
  provider_order_id: string | null;
  expected_amount_cents: number;
  expected_amount_canonical: string;
  expected_currency: string;
  expected_merchant_id: string | null;
  canonical_payload_json: unknown;
}

function isTransientPayPalError(err: unknown): boolean {
  if (err instanceof PayPalError) {
    return (
      err.status === 429 ||
      err.status === 401 ||
      err.status === 403 ||
      err.status === 408 ||
      err.status >= 500 ||
      err.status === 0
    );
  }
  return true;
}

async function finalizeEventSafely(
  serviceClient: SupabaseClient,
  params: {
    eventRowId: string;
    status: "PROCESSED" | "RETRY" | "FAILED";
    processingOutcome:
      | "VERIFIED"
      | "PROCESSED"
      | "DUPLICATE"
      | "FAILED"
      | "REQUIRES_RECONCILIATION";
    paymentIntentId?: string | null;
    paymentTransactionId?: string | null;
    paymentMode?: PayPalPaymentMode | null;
    resourceId?: string | null;
    errorDetails?: string | null;
    retryDelaySeconds?: number;
    sanitizedMetadata?: Record<string, unknown> | null;
  }
): Promise<boolean> {
  try {
    const { data, error } = await serviceClient.rpc("finalize_paypal_webhook_event", {
      p_event_row_id: params.eventRowId,
      p_status: params.status,
      p_processing_outcome: params.processingOutcome,
      p_payment_intent_id: params.paymentIntentId ?? null,
      p_payment_transaction_id: params.paymentTransactionId ?? null,
      p_payment_mode: params.paymentMode ?? null,
      p_resource_id: params.resourceId ?? null,
      p_error_details: params.errorDetails ?? null,
      p_retry_delay_seconds: params.retryDelaySeconds ?? 60,
      p_sanitized_metadata: params.sanitizedMetadata ?? null,
    });
    return !error && Boolean((data as { success?: boolean } | null)?.success);
  } catch {
    return false;
  }
}

async function escalateNonTerminalIntentSafely(
  serviceClient: SupabaseClient,
  intent: IntentLookupRow,
  reasonCode: string
): Promise<void> {
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(intent.status)) {
    return;
  }
  try {
    await serviceClient.rpc("admin_mark_intent_reconciliation_required", {
      p_payment_intent_id: intent.id,
      p_reason_code: reasonCode,
      p_actor: "paypal_webhook_processor",
    });
  } catch {
    // Best-effort escalation; lease-active intents stay protected by DB RPC
  }
}

async function resolveIntentFromWebhookCandidates(
  serviceClient: SupabaseClient,
  candidates: ReturnType<typeof extractWebhookCandidateIdentifiers>
): Promise<
  | { ok: true; intent: IntentLookupRow | null }
  | { ok: false; transient: boolean; error: string; message: string }
> {
  const selectColumns =
    "id, project_id, milestone_id, status, provider_order_id, expected_amount_cents, expected_amount_canonical, expected_currency, expected_merchant_id, canonical_payload_json";

  const matchedIntents = new Map<string, IntentLookupRow>();

  if (candidates.orderId) {
    const { data, error } = await serviceClient
      .from("payment_intents")
      .select(selectColumns)
      .eq("provider_order_id", candidates.orderId)
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        transient: true,
        error: "DATABASE_UNAVAILABLE",
        message: "Failed to query payment intent by provider_order_id.",
      };
    }

    if (data) {
      const row = data as IntentLookupRow;
      matchedIntents.set(row.id, row);
    }
  }

  if (candidates.captureId) {
    const { data: txRow, error: txErr } = await serviceClient
      .from("payment_transactions")
      .select("payment_intent_id")
      .eq("provider", "PAYPAL")
      .eq("transaction_type", "CAPTURE")
      .eq("provider_reference_id", candidates.captureId)
      .maybeSingle();

    if (txErr) {
      return {
        ok: false,
        transient: true,
        error: "DATABASE_UNAVAILABLE",
        message: "Failed to query payment transaction by capture ID.",
      };
    }

    const txIntentId = (txRow as { payment_intent_id?: string } | null)?.payment_intent_id;
    if (txIntentId && !matchedIntents.has(txIntentId)) {
      const { data: intentRow, error: intentErr } = await serviceClient
        .from("payment_intents")
        .select(selectColumns)
        .eq("id", txIntentId)
        .maybeSingle();

      if (intentErr) {
        return {
          ok: false,
          transient: true,
          error: "DATABASE_UNAVAILABLE",
          message: "Failed to load payment intent from capture transaction.",
        };
      }
      if (intentRow) {
        const row = intentRow as IntentLookupRow;
        matchedIntents.set(row.id, row);
      }
    }
  }

  if (candidates.customId && isValidUuid(candidates.customId)) {
    const cleanCustomId = candidates.customId.trim();
    if (!matchedIntents.has(cleanCustomId)) {
      const { data, error } = await serviceClient
        .from("payment_intents")
        .select(selectColumns)
        .eq("id", cleanCustomId)
        .maybeSingle();

      if (error) {
        return {
          ok: false,
          transient: true,
          error: "DATABASE_UNAVAILABLE",
          message: "Failed to query payment intent by custom_id.",
        };
      }

      if (data) {
        const row = data as IntentLookupRow;
        matchedIntents.set(row.id, row);
      }
    }
  }

  if (matchedIntents.size > 1) {
    return {
      ok: false,
      transient: false,
      error: "CROSS_INTENT_REFERENCE_CONFLICT",
      message: "Webhook identifiers matched multiple distinct payment intents.",
    };
  }

  const singleIntent = matchedIntents.values().next().value ?? null;
  if (
    singleIntent &&
    candidates.orderId &&
    singleIntent.provider_order_id &&
    singleIntent.provider_order_id !== candidates.orderId
  ) {
    return {
      ok: false,
      transient: false,
      error: "ORDER_ID_MISMATCH",
      message: "Webhook order ID conflicts with intent provider_order_id.",
    };
  }

  return { ok: true, intent: singleIntent };
}

async function handleOrderApprovedEvent(params: {
  serviceClient: SupabaseClient;
  paypalClient: PayPalClient;
  envelope: PayPalWebhookEnvelope;
  eventRowId: string;
  eventCreatedAt: string | null;
  intent: IntentLookupRow;
  captureCtx: CapturePaymentContext;
  orderId: string | null;
}): Promise<WebhookHandleResult> {
  const {
    serviceClient,
    paypalClient,
    envelope,
    eventRowId,
    eventCreatedAt,
    intent,
    captureCtx,
    orderId,
  } = params;

  const targetOrderId = orderId || intent.provider_order_id;
  if (!targetOrderId) {
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      errorDetails: "MISSING_ORDER_ID",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        error: "MISSING_ORDER_ID",
      },
    };
  }

  let orderDetails: PayPalOrderShape;
  try {
    const orderRes = await executePayPalOrderGet(paypalClient, targetOrderId, captureCtx);
    if (!orderRes?.data) {
      throw new PayPalError({ message: "Empty order lookup response", status: 502 });
    }
    orderDetails = orderRes.data;
  } catch (err: unknown) {
    if (isTransientPayPalError(err)) {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "RETRY",
        processingOutcome: "VERIFIED",
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        errorDetails: "PROVIDER_INQUIRY_UNAVAILABLE",
      });
      return {
        httpStatus: 503,
        body: {
          received: true,
          processed: false,
          outcome: "RETRY",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          error: "PROVIDER_INQUIRY_UNAVAILABLE",
        },
        headers: { "Retry-After": "15" },
      };
    }

    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      errorDetails: "ORDER_LOOKUP_FAILED",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "ORDER_LOOKUP_FAILED",
      },
    };
  }

  const puValidation = validateOrderPurchaseUnitsBeforeCapture({
    orderDetails,
    expectedOrderId: targetOrderId,
    milestoneId: intent.milestone_id,
    intentId: intent.id,
    expectedAmountCents: intent.expected_amount_cents,
    expectedAmountCanonical: intent.expected_amount_canonical,
    expectedCurrency: intent.expected_currency,
    authoritativeExpectedMerchantId: captureCtx.authoritativeExpectedMerchantId,
  });

  if (!puValidation.ok) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, puValidation.error);
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: targetOrderId,
      errorDetails: puValidation.error,
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: puValidation.error,
      },
    };
  }

  const authOrderStatus = orderDetails.status?.toUpperCase();
  if (authOrderStatus === "COMPLETED") {
    // Out-of-order approval webhook arriving after PayPal already completed capture
    if (intent.status === "COMPLETED") {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "PROCESSED",
        processingOutcome: "DUPLICATE",
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        resourceId: targetOrderId,
        sanitizedMetadata: { staleAfterOrderCompleted: true },
      });
      return {
        httpStatus: 200,
        body: {
          received: true,
          processed: true,
          duplicate: true,
          outcome: "DUPLICATE",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          paymentMode: captureCtx.mode,
        },
      };
    }

    const captures = orderDetails.purchase_units?.[0]?.payments?.captures;
    const completedCap = captures?.find((c) => c.status?.toUpperCase() === "COMPLETED");
    if (completedCap?.id) {
      const { data: reconOk, error: reconErr } = await serviceClient.rpc(
        "reconcile_and_complete_payment_intent",
        {
          p_intent_id: intent.id,
          p_provider_capture_id: completedCap.id.trim(),
          p_raw_capture_response: sanitizePayPalCaptureSnapshot(completedCap),
          p_raw_order_response: sanitizePayPalOrderSnapshot(orderDetails),
          p_resolution_notes: `Order approved webhook ${envelope.id} observed completed capture`,
          p_amount_cents: intent.expected_amount_cents,
          p_payee_merchant_id: captureCtx.authoritativeExpectedMerchantId,
        }
      );

      if (!reconErr && reconOk) {
        await finalizeEventSafely(serviceClient, {
          eventRowId,
          status: "PROCESSED",
          processingOutcome: "PROCESSED",
          paymentIntentId: intent.id,
          paymentMode: captureCtx.mode,
          resourceId: targetOrderId,
        });
        return {
          httpStatus: 200,
          body: {
            received: true,
            processed: true,
            outcome: "PROCESSED",
            eventId: envelope.id,
            paymentIntentId: intent.id,
            paymentMode: captureCtx.mode,
          },
        };
      }
    }
  }

  if (authOrderStatus !== "APPROVED") {
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "FAILED",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: targetOrderId,
      errorDetails: `UNEXPECTED_PROVIDER_ORDER_STATUS:${authOrderStatus || "UNKNOWN"}`,
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "FAILED",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "UNEXPECTED_PROVIDER_ORDER_STATUS",
      },
    };
  }

  const { data: rpcData, error: rpcError } = await serviceClient.rpc(
    "record_paypal_webhook_order_approved",
    {
      p_payment_intent_id: intent.id,
      p_provider_order_id: targetOrderId,
      p_provider_event_id: envelope.id,
      p_event_created_at: eventCreatedAt,
    }
  );

  if (rpcError || !rpcData) {
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "RETRY",
      processingOutcome: "VERIFIED",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      errorDetails: "DATABASE_UNAVAILABLE",
    });
    return {
      httpStatus: 503,
      body: {
        received: true,
        processed: false,
        outcome: "RETRY",
        eventId: envelope.id,
        error: "DATABASE_UNAVAILABLE",
      },
      headers: { "Retry-After": "15" },
    };
  }

  const rpcRes = rpcData as {
    success?: boolean;
    transitioned?: boolean;
    stale_or_duplicate?: boolean;
    error?: string;
  };

  if (!rpcRes.success) {
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: targetOrderId,
      errorDetails: rpcRes.error || "ORDER_APPROVED_TRANSITION_FAILED",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: rpcRes.error,
      },
    };
  }

  const outcome = rpcRes.stale_or_duplicate ? "DUPLICATE" : "PROCESSED";
  await finalizeEventSafely(serviceClient, {
    eventRowId,
    status: "PROCESSED",
    processingOutcome: outcome,
    paymentIntentId: intent.id,
    paymentMode: captureCtx.mode,
    resourceId: targetOrderId,
  });

  return {
    httpStatus: 200,
    body: {
      received: true,
      processed: true,
      duplicate: Boolean(rpcRes.stale_or_duplicate),
      outcome,
      eventId: envelope.id,
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
    },
  };
}

async function handleCaptureLifecycleEvent(params: {
  serviceClient: SupabaseClient;
  paypalClient: PayPalClient;
  envelope: PayPalWebhookEnvelope;
  eventRowId: string;
  intent: IntentLookupRow;
  captureCtx: CapturePaymentContext;
  captureId: string | null;
  webhookOrderId: string | null;
}): Promise<WebhookHandleResult> {
  const {
    serviceClient,
    paypalClient,
    envelope,
    eventRowId,
    intent,
    captureCtx,
    captureId,
    webhookOrderId,
  } = params;

  if (!captureId) {
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      errorDetails: "MISSING_CAPTURE_ID",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "MISSING_CAPTURE_ID",
      },
    };
  }

  // 1. Authoritative PayPal Capture GET using explicit mode-scoped headers
  let captureDetails: PayPalCaptureEntryShape & {
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
  try {
    const capRes = await executePayPalCaptureGet(paypalClient, captureId, captureCtx);
    if (!capRes?.data) {
      throw new PayPalError({ message: "Empty capture lookup response", status: 502 });
    }
    captureDetails = capRes.data;
  } catch (err: unknown) {
    if (isTransientPayPalError(err)) {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "RETRY",
        processingOutcome: "VERIFIED",
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
        errorDetails: "PROVIDER_INQUIRY_UNAVAILABLE",
      });
      return {
        httpStatus: 503,
        body: {
          received: true,
          processed: false,
          outcome: "RETRY",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          error: "PROVIDER_INQUIRY_UNAVAILABLE",
        },
        headers: { "Retry-After": "15" },
      };
    }

    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "CAPTURE_LOOKUP_FAILED",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "CAPTURE_LOOKUP_FAILED",
      },
    };
  }

  // 2. Verify capture identity, related order, amount, currency, custom_id, and payee
  if (!captureDetails.id || captureDetails.id.trim() !== captureId) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, "PAYPAL_CAPTURE_ID_MISMATCH");
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "CAPTURE_ID_MISMATCH",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "CAPTURE_ID_MISMATCH",
      },
    };
  }

  const relatedOrderId =
    captureDetails.supplementary_data?.related_ids?.order_id?.trim() || null;

  if (webhookOrderId && relatedOrderId && webhookOrderId !== relatedOrderId) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, "PAYPAL_ORDER_ID_MISMATCH");
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "ORDER_ID_MISMATCH",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "ORDER_ID_MISMATCH",
      },
    };
  }

  const authoritativeOrderId =
    relatedOrderId || webhookOrderId || intent.provider_order_id;

  if (
    !authoritativeOrderId ||
    (intent.provider_order_id && authoritativeOrderId !== intent.provider_order_id)
  ) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, "PAYPAL_ORDER_ID_MISMATCH");
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "ORDER_ID_MISMATCH",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "ORDER_ID_MISMATCH",
      },
    };
  }

  const expectedAmountCanonical =
    intent.expected_amount_canonical || formatCentsToUsd(intent.expected_amount_cents);
  const normExpectedAmount = normalizeDecimalAmount(expectedAmountCanonical);
  const normCaptureAmount = normalizeDecimalAmount(captureDetails.amount?.value);

  if (
    !captureDetails.amount?.currency_code ||
    captureDetails.amount.currency_code.trim().toUpperCase() !== intent.expected_currency
  ) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, "PAYPAL_CAPTURE_CURRENCY_MISMATCH");
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "CURRENCY_MISMATCH",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "CURRENCY_MISMATCH",
      },
    };
  }

  if (!normCaptureAmount || normCaptureAmount !== normExpectedAmount) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, "PAYPAL_CAPTURE_AMOUNT_MISMATCH");
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "AMOUNT_MISMATCH",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "AMOUNT_MISMATCH",
      },
    };
  }

  if (captureDetails.custom_id && captureDetails.custom_id.trim() !== intent.id) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, "PAYPAL_CAPTURE_CUSTOM_ID_MISMATCH");
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "CUSTOM_ID_MISMATCH",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "CUSTOM_ID_MISMATCH",
      },
    };
  }

  if (
    captureDetails.payee?.merchant_id &&
    captureDetails.payee.merchant_id.trim() !== captureCtx.authoritativeExpectedMerchantId
  ) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, "PAYPAL_CAPTURE_MERCHANT_MISMATCH");
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "MERCHANT_MISMATCH",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "MERCHANT_MISMATCH",
      },
    };
  }

  // 3. Authoritative PayPal Order GET to verify purchase unit bindings & seller payee
  let orderDetails: PayPalOrderShape;
  try {
    const orderRes = await executePayPalOrderGet(
      paypalClient,
      authoritativeOrderId,
      captureCtx
    );
    if (!orderRes?.data) {
      throw new PayPalError({ message: "Empty order lookup response", status: 502 });
    }
    orderDetails = orderRes.data;
  } catch (err: unknown) {
    if (isTransientPayPalError(err)) {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "RETRY",
        processingOutcome: "VERIFIED",
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
        errorDetails: "PROVIDER_ORDER_INQUIRY_UNAVAILABLE",
      });
      return {
        httpStatus: 503,
        body: {
          received: true,
          processed: false,
          outcome: "RETRY",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          error: "PROVIDER_INQUIRY_UNAVAILABLE",
        },
        headers: { "Retry-After": "15" },
      };
    }

    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: "ORDER_LOOKUP_FAILED",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: "ORDER_LOOKUP_FAILED",
      },
    };
  }

  const puValidation = validateOrderPurchaseUnitsBeforeCapture({
    orderDetails,
    expectedOrderId: authoritativeOrderId,
    milestoneId: intent.milestone_id,
    intentId: intent.id,
    expectedAmountCents: intent.expected_amount_cents,
    expectedAmountCanonical: expectedAmountCanonical,
    expectedCurrency: intent.expected_currency,
    authoritativeExpectedMerchantId: captureCtx.authoritativeExpectedMerchantId,
  });

  if (!puValidation.ok) {
    await escalateNonTerminalIntentSafely(serviceClient, intent, puValidation.error);
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
      errorDetails: puValidation.error,
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: puValidation.error,
      },
    };
  }

  // 4. Inspect authoritative capture status (never blindly trust webhook claim)
  const authCaptureStatus = captureDetails.status?.trim().toUpperCase();
  const sanitizedCapture = sanitizePayPalCaptureSnapshot(captureDetails);
  const sanitizedOrder = sanitizePayPalOrderSnapshot(orderDetails);

  if (authCaptureStatus === "COMPLETED") {
    const orderCaptures = orderDetails.purchase_units?.[0]?.payments?.captures;
    const matchedOrderCapture = Array.isArray(orderCaptures)
      ? orderCaptures.find((c) => c.id?.trim() === captureId)
      : undefined;

    if (
      orderDetails.status?.toUpperCase() !== "COMPLETED" ||
      !matchedOrderCapture ||
      matchedOrderCapture.status?.toUpperCase() !== "COMPLETED"
    ) {
      await escalateNonTerminalIntentSafely(
        serviceClient,
        intent,
        "PAYPAL_ORDER_CAPTURE_STATE_INCONSISTENT"
      );
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "FAILED",
        processingOutcome: "REQUIRES_RECONCILIATION",
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
        errorDetails: "ORDER_CAPTURE_STATE_INCONSISTENT",
      });
      return {
        httpStatus: 200,
        body: {
          received: true,
          processed: false,
          outcome: "REQUIRES_RECONCILIATION",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          error: "ORDER_CAPTURE_STATE_INCONSISTENT",
        },
      };
    }

    const { data: existingCompletedTx } = await serviceClient
      .from("payment_transactions")
      .select("id, provider_reference_id, status")
      .eq("payment_intent_id", intent.id)
      .eq("transaction_type", "CAPTURE")
      .eq("status", "COMPLETED")
      .maybeSingle();

    const completedTxRow = existingCompletedTx as {
      id: string;
      provider_reference_id: string;
      status: string;
    } | null;

    if (completedTxRow && completedTxRow.provider_reference_id !== captureId) {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "FAILED",
        processingOutcome: "REQUIRES_RECONCILIATION",
        paymentIntentId: intent.id,
        paymentTransactionId: completedTxRow.id,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
        errorDetails: "CAPTURE_ID_CONFLICT",
      });
      return {
        httpStatus: 200,
        body: {
          received: true,
          processed: false,
          outcome: "REQUIRES_RECONCILIATION",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          error: "CAPTURE_ID_CONFLICT",
        },
      };
    }

    if (intent.status === "COMPLETED" && completedTxRow?.provider_reference_id === captureId) {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "PROCESSED",
        processingOutcome: "DUPLICATE",
        paymentIntentId: intent.id,
        paymentTransactionId: completedTxRow.id,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
      });
      return {
        httpStatus: 200,
        body: {
          received: true,
          processed: true,
          duplicate: true,
          outcome: "DUPLICATE",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          paymentMode: captureCtx.mode,
        },
      };
    }

    const { data: completeData, error: completeError } = await serviceClient.rpc(
      "reconcile_and_complete_payment_intent",
      {
        p_intent_id: intent.id,
        p_provider_capture_id: captureId,
        p_raw_capture_response: sanitizedCapture,
        p_raw_order_response: sanitizedOrder,
        p_resolution_notes: `Authoritative capture completed via PayPal webhook ${envelope.id}`,
        p_amount_cents: intent.expected_amount_cents,
        p_payee_merchant_id: captureCtx.authoritativeExpectedMerchantId,
      }
    );

    if (completeError || !completeData) {
      const errMsg = completeError?.message || "RECONCILIATION_RPC_FAILED";
      const isLeaseCollision =
        /active worker lease/i.test(errMsg) || /LEASE_ACTIVE/i.test(errMsg);
      const isPermanentConflict =
        /already bound|mismatch|cannot be reconciled|Invalid|missing valid/i.test(errMsg);

      if (isLeaseCollision || !isPermanentConflict) {
        await finalizeEventSafely(serviceClient, {
          eventRowId,
          status: "RETRY",
          processingOutcome: "VERIFIED",
          paymentIntentId: intent.id,
          paymentMode: captureCtx.mode,
          resourceId: captureId,
          errorDetails: isLeaseCollision ? "CAPTURE_LEASE_ACTIVE" : "DATABASE_UNAVAILABLE",
          retryDelaySeconds: isLeaseCollision ? 10 : 60,
        });
        return {
          httpStatus: 503,
          body: {
            received: true,
            processed: false,
            outcome: "RETRY",
            eventId: envelope.id,
            paymentIntentId: intent.id,
            error: isLeaseCollision ? "CAPTURE_LEASE_ACTIVE" : "DATABASE_UNAVAILABLE",
          },
          headers: { "Retry-After": isLeaseCollision ? "10" : "15" },
        };
      }

      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "FAILED",
        processingOutcome: "REQUIRES_RECONCILIATION",
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
        errorDetails: errMsg,
      });
      return {
        httpStatus: 200,
        body: {
          received: true,
          processed: false,
          outcome: "REQUIRES_RECONCILIATION",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          error: "RECONCILIATION_CONFLICT",
        },
      };
    }

    const { data: persistedTx } = await serviceClient
      .from("payment_transactions")
      .select("id")
      .eq("payment_intent_id", intent.id)
      .eq("transaction_type", "CAPTURE")
      .eq("provider_reference_id", captureId)
      .maybeSingle();

    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "PROCESSED",
      processingOutcome: "PROCESSED",
      paymentIntentId: intent.id,
      paymentTransactionId: (persistedTx as { id?: string } | null)?.id ?? null,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
    });

    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: true,
        outcome: "PROCESSED",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
      },
    };
  }

  if (
    authCaptureStatus === "PENDING" ||
    authCaptureStatus === "DENIED" ||
    authCaptureStatus === "DECLINED" ||
    authCaptureStatus === "FAILED"
  ) {
    const rpcStatusArg = authCaptureStatus === "PENDING" ? "PENDING" : "DENIED";
    const { data: stateData, error: stateError } = await serviceClient.rpc(
      "record_paypal_webhook_capture_state",
      {
        p_payment_intent_id: intent.id,
        p_provider_order_id: authoritativeOrderId,
        p_provider_capture_id: captureId,
        p_capture_status: rpcStatusArg,
        p_payee_merchant_id: captureCtx.authoritativeExpectedMerchantId,
        p_amount_cents: intent.expected_amount_cents,
        p_currency: intent.expected_currency,
        p_sanitized_raw_capture: sanitizedCapture,
        p_provider_event_id: envelope.id,
      }
    );

    if (stateError || !stateData) {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "RETRY",
        processingOutcome: "VERIFIED",
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
        errorDetails: "DATABASE_UNAVAILABLE",
      });
      return {
        httpStatus: 503,
        body: {
          received: true,
          processed: false,
          outcome: "RETRY",
          eventId: envelope.id,
          error: "DATABASE_UNAVAILABLE",
        },
        headers: { "Retry-After": "15" },
      };
    }

    const stateRes = stateData as {
      success?: boolean;
      stale_event?: boolean;
      payment_transaction_id?: string | null;
      error?: string;
    };

    if (!stateRes.success) {
      if (stateRes.error === "LEASE_ACTIVE") {
        await finalizeEventSafely(serviceClient, {
          eventRowId,
          status: "RETRY",
          processingOutcome: "VERIFIED",
          paymentIntentId: intent.id,
          paymentMode: captureCtx.mode,
          resourceId: captureId,
          errorDetails: "CAPTURE_LEASE_ACTIVE",
          retryDelaySeconds: 10,
        });
        return {
          httpStatus: 503,
          body: {
            received: true,
            processed: false,
            outcome: "RETRY",
            eventId: envelope.id,
            error: "CAPTURE_LEASE_ACTIVE",
          },
          headers: { "Retry-After": "10" },
        };
      }

      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "FAILED",
        processingOutcome: "REQUIRES_RECONCILIATION",
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
        errorDetails: stateRes.error || "CAPTURE_STATE_UPDATE_FAILED",
      });
      return {
        httpStatus: 200,
        body: {
          received: true,
          processed: false,
          outcome: "REQUIRES_RECONCILIATION",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          error: stateRes.error,
        },
      };
    }

    if (stateRes.stale_event) {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "PROCESSED",
        processingOutcome: "DUPLICATE",
        paymentIntentId: intent.id,
        paymentTransactionId: stateRes.payment_transaction_id ?? null,
        paymentMode: captureCtx.mode,
        resourceId: captureId,
        sanitizedMetadata: { staleAfterCompleted: true },
      });
      return {
        httpStatus: 200,
        body: {
          received: true,
          processed: true,
          duplicate: true,
          outcome: "DUPLICATE",
          eventId: envelope.id,
          paymentIntentId: intent.id,
          paymentMode: captureCtx.mode,
        },
      };
    }

    const finalOutcome =
      rpcStatusArg === "PENDING" ? "REQUIRES_RECONCILIATION" : "PROCESSED";
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "PROCESSED",
      processingOutcome: finalOutcome,
      paymentIntentId: intent.id,
      paymentTransactionId: stateRes.payment_transaction_id ?? null,
      paymentMode: captureCtx.mode,
      resourceId: captureId,
    });

    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: true,
        outcome: finalOutcome,
        eventId: envelope.id,
        paymentIntentId: intent.id,
        paymentMode: captureCtx.mode,
      },
    };
  }

  await escalateNonTerminalIntentSafely(
    serviceClient,
    intent,
    `PAYPAL_CAPTURE_UNEXPECTED_${authCaptureStatus || "UNKNOWN"}`
  );
  await finalizeEventSafely(serviceClient, {
    eventRowId,
    status: "FAILED",
    processingOutcome: "REQUIRES_RECONCILIATION",
    paymentIntentId: intent.id,
    paymentMode: captureCtx.mode,
    resourceId: captureId,
    errorDetails: `UNEXPECTED_CAPTURE_STATUS:${authCaptureStatus || "UNKNOWN"}`,
  });
  return {
    httpStatus: 200,
    body: {
      received: true,
      processed: false,
      outcome: "REQUIRES_RECONCILIATION",
      eventId: envelope.id,
      paymentIntentId: intent.id,
      error: "UNEXPECTED_CAPTURE_STATUS",
    },
  };
}

/**
 * Processes an already-verified and leased PayPal webhook event end-to-end.
 * Shared by live webhook ingestion and safe recovery/reprocessing flows.
 */
export async function processVerifiedPayPalWebhookEvent(params: {
  serviceClient: SupabaseClient;
  paypalClient: PayPalClient;
  paypalEnv: PayPalConfig;
  envelope: PayPalWebhookEnvelope;
  eventRowId: string;
  eventCreatedAt: string | null;
}): Promise<WebhookHandleResult> {
  const { serviceClient, paypalClient, paypalEnv, envelope, eventRowId, eventCreatedAt } =
    params;

  const candidates = extractWebhookCandidateIdentifiers(envelope);

  if (!isSupportedPayPalWebhookEventType(envelope.event_type)) {
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "PROCESSED",
      processingOutcome: "PROCESSED",
      resourceId: candidates.resourceId,
      sanitizedMetadata: { unsupportedEvent: true },
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "PROCESSED",
        eventId: envelope.id,
        message: "Unsupported PayPal event type acknowledged safely.",
      },
    };
  }

  const resolvedIntent = await resolveIntentFromWebhookCandidates(serviceClient, candidates);
  if (!resolvedIntent.ok) {
    if (resolvedIntent.transient) {
      await finalizeEventSafely(serviceClient, {
        eventRowId,
        status: "RETRY",
        processingOutcome: "VERIFIED",
        resourceId: candidates.resourceId,
        errorDetails: resolvedIntent.error,
      });
      return {
        httpStatus: 503,
        body: {
          received: true,
          processed: false,
          outcome: "RETRY",
          eventId: envelope.id,
          error: resolvedIntent.error,
        },
        headers: { "Retry-After": "15" },
      };
    }

    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      resourceId: candidates.resourceId,
      errorDetails: resolvedIntent.error,
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        error: resolvedIntent.error,
      },
    };
  }

  const intent = resolvedIntent.intent;
  if (!intent) {
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "FAILED",
      resourceId: candidates.resourceId,
      errorDetails: "PAYMENT_INTENT_NOT_FOUND",
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "FAILED",
        eventId: envelope.id,
        error: "PAYMENT_INTENT_NOT_FOUND",
      },
    };
  }

  const captureCtxResult = await resolveCapturePaymentContext({
    intent: {
      id: intent.id,
      project_id: intent.project_id,
      milestone_id: intent.milestone_id,
      expected_amount_cents: intent.expected_amount_cents,
      expected_currency: intent.expected_currency,
      expected_merchant_id: intent.expected_merchant_id,
      canonical_payload_json: intent.canonical_payload_json,
    },
    paypalEnv,
    serviceClient,
    requireLiveSellerReady: false,
  });

  if (!captureCtxResult.ok) {
    await finalizeEventSafely(serviceClient, {
      eventRowId,
      status: "FAILED",
      processingOutcome: "REQUIRES_RECONCILIATION",
      paymentIntentId: intent.id,
      resourceId: candidates.resourceId,
      errorDetails: captureCtxResult.error,
    });
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelope.id,
        paymentIntentId: intent.id,
        error: captureCtxResult.error,
      },
    };
  }

  if (envelope.event_type === "CHECKOUT.ORDER.APPROVED") {
    return handleOrderApprovedEvent({
      serviceClient,
      paypalClient,
      envelope,
      eventRowId,
      eventCreatedAt,
      intent,
      captureCtx: captureCtxResult.context,
      orderId: candidates.orderId,
    });
  }

  return handleCaptureLifecycleEvent({
    serviceClient,
    paypalClient,
    envelope,
    eventRowId,
    intent,
    captureCtx: captureCtxResult.context,
    captureId: candidates.captureId,
    webhookOrderId: candidates.orderId,
  });
}

/**
 * Full public webhook entrypoint orchestrator:
 * 1. Fail-closed config & header & raw-body envelope checks
 * 2. Authoritative PayPal webhook signature verification
 * 3. Atomic DB claim & deduplication
 * 4. Verified provider-state lookup & monotonic payment ledger/intent update
 */
export async function handleIncomingPayPalWebhook(params: {
  headers: Headers;
  rawBody: string;
  allowReprocess?: boolean;
  respectBackoff?: boolean;
  injectedServiceClient?: SupabaseClient;
  injectedPayPalClient?: PayPalClient;
  injectedPayPalEnv?: PayPalConfig;
}): Promise<WebhookHandleResult> {
  let paypalEnv: PayPalConfig;
  try {
    paypalEnv = params.injectedPayPalEnv ?? getPayPalServerEnv();
  } catch {
    return {
      httpStatus: 500,
      body: {
        received: false,
        error: "CONFIGURATION_ERROR",
        message: "Server PayPal configuration is incomplete.",
      },
    };
  }

  const webhookConfig = validatePayPalWebhookServerConfig(paypalEnv);
  if (!webhookConfig.valid) {
    return {
      httpStatus: 500,
      body: {
        received: false,
        error: "CONFIGURATION_ERROR",
        message: `PayPal webhook endpoint is not properly configured (${webhookConfig.reason}).`,
      },
    };
  }

  const headerResult = extractPayPalWebhookHeaders(params.headers);
  if (!headerResult.ok) {
    return {
      httpStatus: 400,
      body: {
        received: false,
        error: headerResult.error,
        message: headerResult.message,
      },
    };
  }

  const envelopeResult = parsePayPalWebhookEnvelope(params.rawBody);
  if (!envelopeResult.ok) {
    return {
      httpStatus: envelopeResult.httpStatus,
      body: {
        received: false,
        error: envelopeResult.error,
        message: envelopeResult.message,
      },
    };
  }

  const paypalClient = params.injectedPayPalClient ?? new PayPalClient(paypalEnv);
  const sigResult = await verifyPayPalWebhookSignature({
    paypalClient,
    config: paypalEnv,
    webhookId: webhookConfig.webhookId,
    headers: headerResult.headers,
    rawEnvelope: envelopeResult.envelope,
  });

  if (!sigResult.verified) {
    return {
      httpStatus: sigResult.transient ? 503 : 401,
      body: {
        received: false,
        error: sigResult.error,
        message: sigResult.message,
      },
      ...(sigResult.transient ? { headers: { "Retry-After": "15" } } : {}),
    };
  }

  const serviceClient = params.injectedServiceClient ?? createServiceClient();
  const candidates = extractWebhookCandidateIdentifiers(envelopeResult.envelope);
  const sanitizedPayload = sanitizePayPalWebhookPayload(envelopeResult.envelope);
  const sanitizedMetadata = extractWebhookSanitizedMetadata(envelopeResult.envelope);

  const { data: claimData, error: claimError } = await serviceClient.rpc(
    "claim_paypal_webhook_event",
    {
      p_provider_event_id: envelopeResult.envelope.id,
      p_event_type: envelopeResult.envelope.event_type,
      p_resource_type: envelopeResult.envelope.resource_type ?? null,
      p_resource_id: candidates.resourceId,
      p_payload_sha256: envelopeResult.payloadSha256,
      p_sanitized_payload: sanitizedPayload,
      p_sanitized_metadata: sanitizedMetadata,
      p_event_created_at: envelopeResult.eventCreatedAt,
      p_signature_verified: true,
      p_lease_seconds: DEFAULT_WEBHOOK_LEASE_SECONDS,
      p_max_attempts: DEFAULT_WEBHOOK_MAX_ATTEMPTS,
      p_allow_reprocess: Boolean(params.allowReprocess),
      p_respect_backoff: Boolean(params.respectBackoff),
    }
  );

  if (claimError || !claimData) {
    return {
      httpStatus: 503,
      body: {
        received: false,
        error: "DATABASE_UNAVAILABLE",
        message: "Failed to persist verified webhook event.",
      },
      headers: { "Retry-After": "15" },
    };
  }

  const claim = claimData as {
    success?: boolean;
    claimed?: boolean;
    duplicate?: boolean;
    conflict?: boolean;
    in_progress?: boolean;
    max_attempts_exceeded?: boolean;
    backoff_active?: boolean;
    event_row_id?: string;
    payment_intent_id?: string | null;
    processing_outcome?: string;
    error?: string;
  };

  if (claim.conflict) {
    return {
      httpStatus: 409,
      body: {
        received: true,
        processed: false,
        duplicate: true,
        outcome: "FAILED",
        eventId: envelopeResult.envelope.id,
        error: "PAYLOAD_HASH_MISMATCH",
      },
    };
  }

  if (claim.duplicate) {
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: true,
        duplicate: true,
        outcome: claim.processing_outcome ?? "DUPLICATE",
        eventId: envelopeResult.envelope.id,
        paymentIntentId: claim.payment_intent_id ?? null,
      },
    };
  }

  if (claim.in_progress) {
    return {
      httpStatus: 409,
      body: {
        received: true,
        processed: false,
        inProgress: true,
        outcome: "PROCESSING",
        eventId: envelopeResult.envelope.id,
        error: "WEBHOOK_ALREADY_PROCESSING",
      },
      headers: { "Retry-After": "5" },
    };
  }

  if (claim.max_attempts_exceeded) {
    return {
      httpStatus: 200,
      body: {
        received: true,
        processed: false,
        outcome: "REQUIRES_RECONCILIATION",
        eventId: envelopeResult.envelope.id,
        paymentIntentId: claim.payment_intent_id ?? null,
        error: "MAX_WEBHOOK_ATTEMPTS_EXCEEDED",
      },
    };
  }

  if (claim.backoff_active) {
    return {
      httpStatus: 503,
      body: {
        received: true,
        processed: false,
        outcome: "RETRY",
        eventId: envelopeResult.envelope.id,
        error: "RETRY_BACKOFF_ACTIVE",
      },
      headers: { "Retry-After": "30" },
    };
  }

  if (!claim.success || !claim.claimed || !claim.event_row_id) {
    return {
      httpStatus: 503,
      body: {
        received: false,
        error: claim.error || "WEBHOOK_CLAIM_FAILED",
      },
      headers: { "Retry-After": "15" },
    };
  }

  try {
    return await processVerifiedPayPalWebhookEvent({
      serviceClient,
      paypalClient,
      paypalEnv,
      envelope: envelopeResult.envelope,
      eventRowId: claim.event_row_id,
      eventCreatedAt: envelopeResult.eventCreatedAt,
    });
  } catch {
    await finalizeEventSafely(serviceClient, {
      eventRowId: claim.event_row_id,
      status: "RETRY",
      processingOutcome: "VERIFIED",
      errorDetails: "UNEXPECTED_PROCESSING_ERROR",
    });
    return {
      httpStatus: 503,
      body: {
        received: true,
        processed: false,
        outcome: "RETRY",
        eventId: envelopeResult.envelope.id,
        error: "WEBHOOK_PROCESSING_UNAVAILABLE",
      },
      headers: { "Retry-After": "15" },
    };
  }
}

/**
 * Safely recovers stale or RETRY webhook events whose next_attempt_at has elapsed
 * (or whose PROCESSING lease expired unexpectedly).
 */
export async function recoverPendingPayPalWebhookEvents(params?: {
  limit?: number;
  injectedServiceClient?: SupabaseClient;
  injectedPayPalClient?: PayPalClient;
  injectedPayPalEnv?: PayPalConfig;
}): Promise<{
  attempted: number;
  processed: number;
  deferred: number;
  escalated: number;
}> {
  const serviceClient = params?.injectedServiceClient ?? createServiceClient();
  const limit = Math.max(1, Math.min(params?.limit ?? 20, 100));
  const nowIso = new Date().toISOString();

  let paypalEnv: PayPalConfig;
  try {
    paypalEnv = params?.injectedPayPalEnv ?? getPayPalServerEnv();
  } catch {
    return { attempted: 0, processed: 0, deferred: 0, escalated: 0 };
  }

  const webhookConfig = validatePayPalWebhookServerConfig(paypalEnv);
  if (!webhookConfig.valid) {
    return { attempted: 0, processed: 0, deferred: 0, escalated: 0 };
  }

  const paypalClient = params?.injectedPayPalClient ?? new PayPalClient(paypalEnv);

  const { data: queuedRows, error } = await serviceClient
    .from("provider_webhook_events")
    .select("id, provider_event_id, event_type, resource_type, resource_id, payload_sha256, payload, sanitized_metadata, event_created_at, signature_verified, status, attempt_count, next_attempt_at, lease_expires_at")
    .eq("provider", "PAYPAL")
    .eq("signature_verified", true)
    .in("status", ["RETRY", "RECEIVED", "PROCESSING"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !Array.isArray(queuedRows)) {
    return { attempted: 0, processed: 0, deferred: 0, escalated: 0 };
  }

  let attempted = 0;
  let processed = 0;
  let deferred = 0;
  let escalated = 0;

  for (const row of queuedRows as Array<Record<string, unknown>>) {
    const status = String(row.status || "");
    const leaseExp =
      typeof row.lease_expires_at === "string" ? row.lease_expires_at : null;
    const nextAttempt =
      typeof row.next_attempt_at === "string" ? row.next_attempt_at : null;

    if (status === "PROCESSING" && leaseExp && leaseExp > nowIso) {
      continue;
    }
    if (status === "RETRY" && nextAttempt && nextAttempt > nowIso) {
      continue;
    }

    const payloadObj = row.payload as PayPalWebhookEnvelope | null;
    const eventId = String(row.provider_event_id || "");
    const eventType = String(row.event_type || "");
    const payloadSha = String(row.payload_sha256 || "");
    if (!payloadObj || !eventId || !eventType || !payloadSha) {
      continue;
    }

    const { data: claimData, error: claimError } = await serviceClient.rpc(
      "claim_paypal_webhook_event",
      {
        p_provider_event_id: eventId,
        p_event_type: eventType,
        p_resource_type: typeof row.resource_type === "string" ? row.resource_type : null,
        p_resource_id: typeof row.resource_id === "string" ? row.resource_id : null,
        p_payload_sha256: payloadSha,
        p_sanitized_payload: payloadObj,
        p_sanitized_metadata:
          row.sanitized_metadata && typeof row.sanitized_metadata === "object"
            ? row.sanitized_metadata
            : {},
        p_event_created_at:
          typeof row.event_created_at === "string" ? row.event_created_at : null,
        p_signature_verified: true,
        p_lease_seconds: DEFAULT_WEBHOOK_LEASE_SECONDS,
        p_max_attempts: DEFAULT_WEBHOOK_MAX_ATTEMPTS,
        p_allow_reprocess: false,
        p_respect_backoff: true,
      }
    );

    if (claimError || !claimData) {
      deferred += 1;
      continue;
    }

    const claim = claimData as {
      claimed?: boolean;
      max_attempts_exceeded?: boolean;
      event_row_id?: string;
    };

    if (claim.max_attempts_exceeded) {
      escalated += 1;
      continue;
    }

    if (!claim.claimed || !claim.event_row_id) {
      deferred += 1;
      continue;
    }

    attempted += 1;
    const outcome = await processVerifiedPayPalWebhookEvent({
      serviceClient,
      paypalClient,
      paypalEnv,
      envelope: payloadObj,
      eventRowId: claim.event_row_id,
      eventCreatedAt:
        typeof row.event_created_at === "string" ? row.event_created_at : null,
    });

    if (outcome.body.outcome === "PROCESSED" || outcome.body.outcome === "DUPLICATE") {
      processed += 1;
    } else if (outcome.body.outcome === "REQUIRES_RECONCILIATION") {
      escalated += 1;
    } else {
      deferred += 1;
    }
  }

  return { attempted, processed, deferred, escalated };
}
