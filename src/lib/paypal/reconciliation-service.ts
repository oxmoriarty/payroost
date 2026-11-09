import { createServiceClient } from "@/lib/supabase/service";
import { getPayPalServerEnv } from "@/lib/paypal/env";
import { PayPalClient } from "@/lib/paypal/client";
import type { PayPalConfig } from "@/lib/paypal/types";
import { PayPalOrderResponse } from "@/app/api/public/portal/[token]/payments/orders/route";

/**
 * PayPal Orders v2 documented idempotency retention window: 6 hours (21,600,000 ms).
 * Automated inquiries and replays using PayPal-Request-Id are valid strictly within this window.
 */
export const PAYPAL_MAX_IDEMPOTENCY_RETENTION_MS = 6 * 60 * 60 * 1000;

export interface ReconciliationResult {
  success: boolean;
  intentId: string;
  previousStatus: string;
  resultingStatus: string;
  providerOrderId: string | null;
  recovered: boolean;
  milestoneBlocked: boolean;
  reason?: string;
  error?: string;
}

/**
 * Server-Side Authoritative Reconciliation Service.
 *
 * This is the ONLY trusted application pathway for recovering ghost orders and
 * resolving payment intents in RECONCILIATION_REQUIRED.
 *
 * Security & Financial Invariants:
 * 1. Independently authenticates with PayPal using server-only credentials.
 * 2. If provider_order_id was never persisted and idempotency key is within 6h,
 *    replays the creation request using the identical original request ID and payload.
 * 3. Binds recovered order to the intent only after strict cross-verification of IDs, amounts,
 *    currency, and merchant ID.
 * 4. Never assumes an order was not created merely because provider_order_id is null.
 * 5. If retention has expired or provider inquiry fails, retains RECONCILIATION_REQUIRED,
 *    keeping the milestone locked.
 * 6. Never unlocks a milestone when completed capture or unresolved provider order exists.
 */
export async function reconcilePaymentIntentServerSide(params: {
  intentId: string;
  actorLabel?: string;
  injectedServiceClient?: ReturnType<typeof createServiceClient>;
  injectedPayPalClient?: PayPalClient;
  injectedPayPalEnv?: PayPalConfig;
}): Promise<ReconciliationResult> {
  const serviceClient = params.injectedServiceClient ?? createServiceClient();
  let paypalEnv: PayPalConfig;
  try {
    paypalEnv = params.injectedPayPalEnv ?? getPayPalServerEnv();
  } catch (err: unknown) {
    return {
      success: false,
      intentId: params.intentId,
      previousStatus: "UNKNOWN",
      resultingStatus: "UNKNOWN",
      providerOrderId: null,
      recovered: false,
      milestoneBlocked: true,
      error: `CONFIGURATION_ERROR: ${err instanceof Error ? err.message : "Invalid PayPal environment"}`,
    };
  }
  const paypalClient = params.injectedPayPalClient ?? new PayPalClient(paypalEnv);
  const actor = params.actorLabel ?? "system_reconciliation_service";

  // 1. Fetch payment intent from database
  const { data: intent, error: intentError } = await serviceClient
    .from("payment_intents")
    .select(
      "id, project_id, milestone_id, status, expected_merchant_id, expected_currency, expected_amount_canonical, order_idempotency_key, canonical_payload_json, provider_order_id, order_creation_lease_expires_at, capture_lease_expires_at, created_at"
    )
    .eq("id", params.intentId)
    .maybeSingle();

  if (intentError || !intent) {
    return {
      success: false,
      intentId: params.intentId,
      previousStatus: "UNKNOWN",
      resultingStatus: "UNKNOWN",
      providerOrderId: null,
      recovered: false,
      milestoneBlocked: true,
      error: "PAYMENT_INTENT_NOT_FOUND",
    };
  }

  // 2. Intent must be in RECONCILIATION_REQUIRED, ORDER_CREATING, or expired CAPTURING (F-04)
  const isCaptureLeaseExpired =
    intent.status === "CAPTURING" &&
    (!intent.capture_lease_expires_at || new Date(intent.capture_lease_expires_at).getTime() < Date.now());

  const isEligible =
    ["RECONCILIATION_REQUIRED", "ORDER_CREATING"].includes(intent.status) || isCaptureLeaseExpired;

  if (!isEligible) {
    return {
      success: false,
      intentId: intent.id,
      previousStatus: intent.status,
      resultingStatus: intent.status,
      providerOrderId: intent.provider_order_id,
      recovered: false,
      milestoneBlocked: ["ORDER_CREATED", "BUYER_APPROVED", "CAPTURING", "RECONCILING", "RECONCILIATION_REQUIRED"].includes(intent.status),
      error: "INELIGIBLE_PAYMENT_INTENT_STATUS",
    };
  }

  const intentCreatedAtMs = intent.created_at ? new Date(intent.created_at).getTime() : Date.now();
  const intentAgeMs = Date.now() - intentCreatedAtMs;

  // ============================================================================
  // CASE A: provider_order_id IS SET — Inquire directly on existing PayPal order
  // ============================================================================
  if (intent.provider_order_id) {
    let orderDetails: PayPalOrderResponse;
    try {
      const getRes = await paypalClient.get<PayPalOrderResponse>(
        `/v2/checkout/orders/${encodeURIComponent(intent.provider_order_id)}`
      );
      if (!getRes || !getRes.data) {
        throw new Error("Empty provider response");
      }
      orderDetails = getRes.data;
    } catch {
      // Inconclusive: Provider inquiry failed; mark RECONCILIATION_REQUIRED if in CAPTURING
      if (intent.status === "CAPTURING") {
        await serviceClient.rpc("admin_mark_intent_reconciliation_required", {
          p_payment_intent_id: intent.id,
          p_reason_code: "PROVIDER_INQUIRY_INCONCLUSIVE",
        });
      }
      return {
        success: false,
        intentId: intent.id,
        previousStatus: intent.status,
        resultingStatus: "RECONCILIATION_REQUIRED",
        providerOrderId: intent.provider_order_id,
        recovered: false,
        milestoneBlocked: true,
        reason: "PROVIDER_INQUIRY_INCONCLUSIVE",
      };
    }

    const orderStatus = orderDetails.status?.toUpperCase();

    // If order was cancelled/voided/expired on PayPal, resolve to CANCELLED with authoritative evidence
    if (orderStatus === "VOIDED" || orderStatus === "EXPIRED") {
      const { data: resolveData, error: resolveError } = await serviceClient.rpc(
        "admin_resolve_reconciliation_without_payment",
        {
          p_intent_id: intent.id,
          p_target_status: "CANCELLED",
          p_reason_code: `PAYPAL_ORDER_${orderStatus}`,
          p_evidence: {
            evidence_type: "ORDER_VERIFIED_INACTIVE",
            confirmed_by: actor,
            order_id: intent.provider_order_id,
            paypal_order_status: orderStatus,
            verified_at: new Date().toISOString(),
            raw_response: orderDetails,
          },
          p_notes: `PayPal order ${intent.provider_order_id} verified as ${orderStatus} on provider. Safe to cancel.`,
          p_actor: actor,
        }
      );

      if (resolveError || !(resolveData as { success?: boolean })?.success) {
        return {
          success: false,
          intentId: intent.id,
          previousStatus: intent.status,
          resultingStatus: "RECONCILIATION_REQUIRED",
          providerOrderId: intent.provider_order_id,
          recovered: false,
          milestoneBlocked: true,
          error: "DATABASE_RESOLUTION_FAILED",
        };
      }

      return {
        success: true,
        intentId: intent.id,
        previousStatus: intent.status,
        resultingStatus: "CANCELLED",
        providerOrderId: intent.provider_order_id,
        recovered: false,
        milestoneBlocked: false, // Cancelled order safely unblocks milestone
        reason: `PAYPAL_ORDER_${orderStatus}`,
      };
    }

    // If order is CREATED or APPROVED, ensure it is properly bound and reset to ORDER_CREATED
    if (orderStatus === "CREATED" || orderStatus === "APPROVED") {
      const { data: bindData, error: bindError } = await serviceClient.rpc(
        "admin_recover_and_bind_paypal_order",
        {
          p_intent_id: intent.id,
          p_recovered_order_id: intent.provider_order_id,
          p_raw_order_response: orderDetails,
          p_actor: actor,
        }
      );

      if (bindError || !(bindData as { success?: boolean })?.success) {
        return {
          success: false,
          intentId: intent.id,
          previousStatus: intent.status,
          resultingStatus: "RECONCILIATION_REQUIRED",
          providerOrderId: intent.provider_order_id,
          recovered: false,
          milestoneBlocked: true,
          error: "BIND_ORDER_FAILED",
        };
      }

      return {
        success: true,
        intentId: intent.id,
        previousStatus: intent.status,
        resultingStatus: "ORDER_CREATED",
        providerOrderId: intent.provider_order_id,
        recovered: true,
        milestoneBlocked: true,
      };
    }

    // If order is COMPLETED on PayPal, check captures and reconcile
    if (orderStatus === "COMPLETED") {
      const pu = orderDetails.purchase_units?.[0] as {
        reference_id?: string;
        custom_id?: string;
        payee?: { merchant_id?: string };
        payments?: {
          captures?: Array<{
            id: string;
            status: string;
            amount?: { currency_code?: string; value?: string };
            payee?: { merchant_id?: string };
            custom_id?: string;
          }>;
        };
      } | undefined;

      const capture = pu?.payments?.captures?.[0];
      const captureStatus = capture?.status?.toUpperCase();

      if (capture && capture.id && captureStatus === "COMPLETED") {
        const { data: completeSuccess, error: completeError } = await serviceClient.rpc(
          "reconcile_and_complete_payment_intent",
          {
            p_intent_id: intent.id,
            p_provider_capture_id: capture.id.trim(),
            p_raw_capture_response: capture,
            p_raw_order_response: orderDetails,
            p_resolution_notes: `Recovered and completed via PayPal order status COMPLETED with capture ${capture.id.trim()}`,
          }
        );

        if (!completeError && completeSuccess) {
          return {
            success: true,
            intentId: intent.id,
            previousStatus: intent.status,
            resultingStatus: "COMPLETED",
            providerOrderId: intent.provider_order_id,
            recovered: true,
            milestoneBlocked: false,
          };
        }
      }

      // If capture is PENDING, mark reconciliation required with PAYPAL_CAPTURE_PENDING
      if (capture && captureStatus === "PENDING") {
        if (intent.status === "CAPTURING") {
          await serviceClient.rpc("admin_mark_intent_reconciliation_required", {
            p_payment_intent_id: intent.id,
            p_reason_code: "PAYPAL_CAPTURE_PENDING",
          });
        }
        return {
          success: false,
          intentId: intent.id,
          previousStatus: intent.status,
          resultingStatus: "RECONCILIATION_REQUIRED",
          providerOrderId: intent.provider_order_id,
          recovered: false,
          milestoneBlocked: true,
          reason: "PAYPAL_CAPTURE_PENDING",
        };
      }

      // Otherwise, transition CAPTURING to RECONCILIATION_REQUIRED
      if (intent.status === "CAPTURING") {
        await serviceClient.rpc("admin_mark_intent_reconciliation_required", {
          p_payment_intent_id: intent.id,
          p_reason_code: "ORDER_COMPLETED_ON_PROVIDER_REQUIRES_CAPTURE_RECONCILIATION",
        });
      }

      return {
        success: false,
        intentId: intent.id,
        previousStatus: intent.status,
        resultingStatus: "RECONCILIATION_REQUIRED",
        providerOrderId: intent.provider_order_id,
        recovered: false,
        milestoneBlocked: true,
        reason: "ORDER_COMPLETED_ON_PROVIDER_REQUIRES_CAPTURE_RECONCILIATION",
      };
    }

    // Any other PayPal status: remain in or move to RECONCILIATION_REQUIRED
    if (intent.status === "CAPTURING") {
      await serviceClient.rpc("admin_mark_intent_reconciliation_required", {
        p_payment_intent_id: intent.id,
        p_reason_code: `UNKNOWN_PROVIDER_ORDER_STATUS_${orderStatus}`,
      });
    }

    return {
      success: false,
      intentId: intent.id,
      previousStatus: intent.status,
      resultingStatus: "RECONCILIATION_REQUIRED",
      providerOrderId: intent.provider_order_id,
      recovered: false,
      milestoneBlocked: true,
      reason: `UNKNOWN_PROVIDER_ORDER_STATUS_${orderStatus}`,
    };
  }

  // ============================================================================
  // CASE B: provider_order_id IS NULL — Ghost-Order Recovery via Idempotency Replay
  // ============================================================================

  // Finite retention check: if key has expired at PayPal (> 6 hours), do not replay create
  if (intentAgeMs >= PAYPAL_MAX_IDEMPOTENCY_RETENTION_MS) {
    return {
      success: false,
      intentId: intent.id,
      previousStatus: intent.status,
      resultingStatus: "RECONCILIATION_REQUIRED",
      providerOrderId: null,
      recovered: false,
      milestoneBlocked: true,
      reason: "IDEMPOTENCY_RETENTION_EXPIRED_UNRESOLVED",
    };
  }

  // Idempotency key is still within 6-hour window: Replay order creation
  const canonicalPayload = (intent.canonical_payload_json as {
    purchase_units?: Array<unknown>;
  }) || {};

  if (!canonicalPayload.purchase_units || !Array.isArray(canonicalPayload.purchase_units) || canonicalPayload.purchase_units.length !== 1) {
    return {
      success: false,
      intentId: intent.id,
      previousStatus: intent.status,
      resultingStatus: "RECONCILIATION_REQUIRED",
      providerOrderId: null,
      recovered: false,
      milestoneBlocked: true,
      error: "CORRUPTED_CANONICAL_PAYLOAD",
    };
  }

  const replayPayload = {
    intent: "CAPTURE",
    purchase_units: canonicalPayload.purchase_units,
  };

  let replayResponse: PayPalOrderResponse;
  try {
    const res = await paypalClient.post<PayPalOrderResponse>(
      "/v2/checkout/orders",
      replayPayload,
      {
        paypalRequestId: intent.order_idempotency_key,
        headers: {
          Prefer: "return=representation",
        },
      }
    );
    replayResponse = res.data;
  } catch {
    // Replay failed: network error, timeout, or 5xx. DO NOT assume no order exists!
    return {
      success: false,
      intentId: intent.id,
      previousStatus: intent.status,
      resultingStatus: "RECONCILIATION_REQUIRED",
      providerOrderId: null,
      recovered: false,
      milestoneBlocked: true,
      reason: "PROVIDER_REPLAY_INCONCLUSIVE",
    };
  }

  if (!replayResponse || typeof replayResponse.id !== "string" || replayResponse.id.trim().length === 0) {
    return {
      success: false,
      intentId: intent.id,
      previousStatus: intent.status,
      resultingStatus: "RECONCILIATION_REQUIRED",
      providerOrderId: null,
      recovered: false,
      milestoneBlocked: true,
      error: "MALFORMED_REPLAY_RESPONSE",
    };
  }

  const recoveredOrderId = replayResponse.id.trim();

  // If replay response returned minimal representation, fetch full representation
  if (!replayResponse.purchase_units || replayResponse.purchase_units.length === 0 || !replayResponse.purchase_units[0]?.payee?.merchant_id) {
    try {
      const getRes = await paypalClient.get<PayPalOrderResponse>(
        `/v2/checkout/orders/${encodeURIComponent(recoveredOrderId)}`
      );
      if (getRes && getRes.data) {
        replayResponse = getRes.data;
      }
    } catch {
      return {
        success: false,
        intentId: intent.id,
        previousStatus: intent.status,
        resultingStatus: "RECONCILIATION_REQUIRED",
        providerOrderId: recoveredOrderId,
        recovered: false,
        milestoneBlocked: true,
        reason: "REPLAY_GET_DETAILS_FAILED",
      };
    }
  }

  // Cross-verify recovered order payload against intent invariants
  const pu = replayResponse.purchase_units?.[0];
  const isMatch =
    replayResponse.status === "CREATED" &&
    pu?.reference_id === intent.milestone_id &&
    pu?.custom_id === intent.id &&
    pu?.amount?.currency_code === "USD" &&
    pu?.amount?.value === intent.expected_amount_canonical &&
    pu?.payee?.merchant_id?.trim() === intent.expected_merchant_id;

  if (!isMatch) {
    // Payload mismatch on recovered order: Retain RECONCILIATION_REQUIRED
    return {
      success: false,
      intentId: intent.id,
      previousStatus: intent.status,
      resultingStatus: "RECONCILIATION_REQUIRED",
      providerOrderId: recoveredOrderId,
      recovered: false,
      milestoneBlocked: true,
      reason: "RECOVERED_ORDER_PAYLOAD_MISMATCH",
    };
  }

  // Bind recovered ghost order to payment intent atomically
  const { data: bindData, error: bindError } = await serviceClient.rpc(
    "admin_recover_and_bind_paypal_order",
    {
      p_intent_id: intent.id,
      p_recovered_order_id: recoveredOrderId,
      p_raw_order_response: replayResponse,
      p_actor: actor,
    }
  );

  if (bindError || !(bindData as { success?: boolean })?.success) {
    return {
      success: false,
      intentId: intent.id,
      previousStatus: intent.status,
      resultingStatus: "RECONCILIATION_REQUIRED",
      providerOrderId: recoveredOrderId,
      recovered: false,
      milestoneBlocked: true,
      error: "BIND_RECOVERED_ORDER_FAILED",
    };
  }

  return {
    success: true,
    intentId: intent.id,
    previousStatus: intent.status,
    resultingStatus: "ORDER_CREATED",
    providerOrderId: recoveredOrderId,
    recovered: true,
    milestoneBlocked: true, // Order is created; milestone is protected
  };
}
