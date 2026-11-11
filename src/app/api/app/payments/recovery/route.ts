import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireUser } from "@/lib/auth/require-user";
import { validateOperatorCsrf } from "@/lib/security/operator-csrf";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";
import {
  reconcilePaymentIntentServerSide,
  PAYPAL_MAX_IDEMPOTENCY_RETENTION_MS,
} from "@/lib/paypal/reconciliation-service";
import { PayPalClient } from "@/lib/paypal/client";
import { getPayPalServerEnv } from "@/lib/paypal/env";
import {
  resolveCapturePaymentContext,
  executePayPalOrderGet,
} from "@/features/payments/capture-helpers";
import {
  PAYPAL_AUTOMATED_RETRY_CUTOFF_MS,
  type PayPalOrderResponse,
} from "@/app/api/public/portal/[token]/payments/orders/route";

const recoveryRequestSchema = z
  .object({
    intentId: z.string().uuid(),
    action: z.enum([
      "RECONCILE",
      "CLEAR_EXPIRED_LEASE",
      "RETRY_ORDER_CREATION",
      "CANCEL_INACTIVE",
      "ESCALATE_MANUAL",
      "REPROCESS_WEBHOOK",
    ]),
    notes: z.string().max(500).optional(),
    webhookEventId: z.string().uuid().optional(),
  })
  .strict();

export async function POST(request: Request) {
  // 1. Authenticate user session
  let authResult: Awaited<ReturnType<typeof requireUser>>;
  try {
    authResult = await requireUser();
  } catch {
    return apiError("UNAUTHORIZED", 401);
  }
  const { user } = authResult;

  // 2. CSRF validation for mutating operator actions
  const csrfValidation = await validateOperatorCsrf(request);
  if (!csrfValidation.valid) {
    return apiError("INVALID_CSRF_TOKEN", 403);
  }

  // 3. DB-backed rate limiting per authenticated operator
  const rateLimitKey = `operator-recovery:${user.id}`;
  const rateLimit = await checkRateLimit(rateLimitKey, 30, 600_000, {
    failClosedInProduction: true,
  });

  if (!rateLimit.allowed) {
    if (rateLimit.status === "service_unavailable") {
      return apiError("RATE_LIMITER_UNAVAILABLE", 503);
    }
    return apiError("RATE_LIMITED", 429);
  }

  // 4. Validate payload format strictly
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400);
  }

  const parsed = recoveryRequestSchema.safeParse(bodyJson);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", 400);
  }
  const { intentId, action, notes, webhookEventId } = parsed.data;

  // 5. Query payment intent and project via authenticated client
  const supabase = await createClient();
  const { data: intent, error: intentError } = await supabase
    .from("payment_intents")
    .select(`
      id,
      project_id,
      milestone_id,
      status,
      provider_order_id,
      order_idempotency_key,
      capture_idempotency_key,
      canonical_payload_json,
      expected_currency,
      order_creation_lease_expires_at,
      capture_lease_expires_at,
      expected_merchant_id,
      expected_amount_canonical,
      expected_amount_cents,
      created_at,
      projects (
        id,
        owner_id
      )
    `)
    .eq("id", intentId)
    .maybeSingle();

  if (intentError || !intent) {
    return apiError("NOT_FOUND_OR_FORBIDDEN", 404);
  }

  // 6. Strict Project Ownership Assertion: Only project owner can trigger operational recovery
  const rawProjects = (intent.projects as unknown) as
    | { id: string; owner_id: string }
    | Array<{ id: string; owner_id: string }>
    | null;
  const projectOwnerId = Array.isArray(rawProjects)
    ? rawProjects[0]?.owner_id
    : rawProjects?.owner_id;

  if (!projectOwnerId || projectOwnerId !== user.id) {
    return apiError("FORBIDDEN", 403);
  }

  const serviceClient = createServiceClient();
  const actor = user.email || user.id;
  const now = Date.now();

  // 7. Dispatch authorized recovery action
  switch (action) {
    // ------------------------------------------------------------------------
    // CASE 1: RECONCILE WITH PAYPAL
    // ------------------------------------------------------------------------
    case "RECONCILE": {
      const result = await reconcilePaymentIntentServerSide({
        intentId: intent.id,
        actorLabel: actor,
        injectedServiceClient: serviceClient,
      });

      // Audit log operator-initiated action reliably (fail-closed if log fails)
      try {
        await logOperatorActivity({
          serviceClient,
          projectId: intent.project_id,
          userId: user.id,
          actorLabel: actor,
          eventType: "payment.operator_reconcile",
          summary: `Operator initiated reconciliation for intent ${intent.id} (${result.previousStatus} -> ${result.resultingStatus})`,
          metadata: {
            intentId: intent.id,
            action,
            previousStatus: result.previousStatus,
            resultingStatus: result.resultingStatus,
            providerOrderId: result.providerOrderId,
            recovered: result.recovered,
            reason: result.reason || result.error || null,
          },
        });
      } catch {
        return apiError("AUDIT_LOGGING_FAILED", 500);
      }

      return NextResponse.json({
        success: result.success,
        action,
        previousStatus: result.previousStatus,
        resultingStatus: result.resultingStatus,
        providerOrderId: result.providerOrderId,
        recovered: result.recovered,
        error: result.error,
      });
    }

    // ------------------------------------------------------------------------
    // CASE 2: CLEAR EXPIRED LEASE (AUDIT-3B44-03 Hardening)
    // ------------------------------------------------------------------------
    case "CLEAR_EXPIRED_LEASE": {
      const hasExpiredCreationLease = Boolean(
        intent.order_creation_lease_expires_at &&
        new Date(intent.order_creation_lease_expires_at).getTime() <= now
      );
      const hasExpiredCaptureLease = Boolean(
        intent.capture_lease_expires_at &&
        new Date(intent.capture_lease_expires_at).getTime() <= now
      );

      // Check for active unexpired lease to prevent race with running workers
      const isCreationLeaseActive = Boolean(
        intent.order_creation_lease_expires_at &&
        new Date(intent.order_creation_lease_expires_at).getTime() > now
      );
      const isCaptureLeaseActive = Boolean(
        intent.capture_lease_expires_at &&
        new Date(intent.capture_lease_expires_at).getTime() > now
      );

      if (isCreationLeaseActive || isCaptureLeaseActive) {
        return apiError("CANNOT_CLEAR_ACTIVE_LEASE", 409);
      }

      if (!hasExpiredCreationLease && !hasExpiredCaptureLease) {
        return apiError("NO_EXPIRED_LEASE_FOUND", 400);
      }

      // If CAPTURING, run authoritative reconciliation before clearing
      if (intent.status === "CAPTURING") {
        const reconResult = await reconcilePaymentIntentServerSide({
          intentId: intent.id,
          actorLabel: actor,
          injectedServiceClient: serviceClient,
        });

        // 1. If capture was completed on PayPal, ledger is completed
        if (reconResult.success && reconResult.resultingStatus === "COMPLETED") {
          return NextResponse.json({
            success: true,
            action,
            previousStatus: intent.status,
            resultingStatus: "COMPLETED",
            message: "Capture was already completed on provider; ledger successfully completed.",
          });
        }

        // 2. If recovered to ORDER_CREATED (e.g. APPROVED order reset), lease was already cleared
        if (reconResult.success && reconResult.resultingStatus === "ORDER_CREATED") {
          return NextResponse.json({
            success: true,
            action,
            previousStatus: intent.status,
            resultingStatus: "ORDER_CREATED",
            recovered: true,
            message: "Order was reset to ORDER_CREATED and expired capture lease was cleared.",
          });
        }

        // 3. If reconciliation transitioned intent to RECONCILIATION_REQUIRED, lease is already cleared
        if (reconResult.resultingStatus === "RECONCILIATION_REQUIRED") {
          return NextResponse.json({
            success: true,
            action,
            previousStatus: intent.status,
            resultingStatus: "RECONCILIATION_REQUIRED",
            reasonCode: reconResult.reason || "RECONCILIATION_REQUIRED",
            message: "Intent moved to RECONCILIATION_REQUIRED and capture lease was cleared.",
          });
        }

        // 4. Inconclusive or failed reconciliation must report truthful error
        if (!reconResult.success) {
          return apiError(reconResult.error || reconResult.reason || "RECONCILIATION_FAILED", 409);
        }
      }

      // Invoke safe RPC to clear lease tokens and transition out of in-flight state
      // (The RPC commits the lease reset and activity_events audit log atomically)
      const { data: rpcData, error: rpcError } = await serviceClient.rpc(
        "admin_clear_expired_lease",
        {
          p_payment_intent_id: intent.id,
          p_actor: actor,
        }
      );

      if (rpcError || !(rpcData as { success?: boolean })?.success) {
        return apiError((rpcData as { error?: string })?.error || "CLEAR_LEASE_FAILED", 409);
      }

      const res = rpcData as { status: string; reason_code: string };
      return NextResponse.json({
        success: true,
        action,
        previousStatus: intent.status,
        resultingStatus: res.status,
        reasonCode: res.reason_code,
      });
    }

    // ------------------------------------------------------------------------
    // CASE 3: RETRY ORDER CREATION (Ghost-order replay within 6h retention)
    // ------------------------------------------------------------------------
    case "RETRY_ORDER_CREATION": {
      if (intent.status !== "RECONCILIATION_REQUIRED" && intent.status !== "ORDER_CREATING") {
        return apiError("INELIGIBLE_INTENT_STATUS", 400);
      }

      if (intent.provider_order_id) {
        return apiError("PROVIDER_ORDER_ALREADY_EXISTS", 409);
      }

      const intentAgeMs = now - new Date(intent.created_at).getTime();
      if (intentAgeMs >= PAYPAL_MAX_IDEMPOTENCY_RETENTION_MS) {
        return apiError("IDEMPOTENCY_RETENTION_EXPIRED", 400);
      }

      const result = await reconcilePaymentIntentServerSide({
        intentId: intent.id,
        actorLabel: actor,
        injectedServiceClient: serviceClient,
      });

      try {
        await logOperatorActivity({
          serviceClient,
          projectId: intent.project_id,
          userId: user.id,
          actorLabel: actor,
          eventType: "payment.retry_order_creation",
          summary: `Operator retried order creation for intent ${intent.id} via idempotency replay`,
          metadata: {
            intentId: intent.id,
            action,
            previousStatus: result.previousStatus,
            resultingStatus: result.resultingStatus,
            providerOrderId: result.providerOrderId,
            recovered: result.recovered,
          },
        });
      } catch {
        return apiError("AUDIT_LOGGING_FAILED", 500);
      }

      return NextResponse.json({
        success: result.success,
        action,
        previousStatus: result.previousStatus,
        resultingStatus: result.resultingStatus,
        providerOrderId: result.providerOrderId,
        recovered: result.recovered,
        error: result.error,
      });
    }

    // ------------------------------------------------------------------------
    // CASE 4: CANCEL INACTIVE INTENT (AUDIT-3B44-01 Hardening)
    // ------------------------------------------------------------------------
    case "CANCEL_INACTIVE": {
      if (intent.status === "COMPLETED") {
        return apiError("CANNOT_CANCEL_COMPLETED_INTENT", 409);
      }

      // Check if a completed capture exists on the ledger (Critical Financial Guard)
      const { data: completedCapture } = await serviceClient
        .from("payment_transactions")
        .select("id")
        .eq("payment_intent_id", intent.id)
        .eq("transaction_type", "CAPTURE")
        .eq("status", "COMPLETED")
        .maybeSingle();

      if (completedCapture) {
        return apiError("COMPLETED_CAPTURE_EXISTS", 409);
      }

      const paypalConfig = getPayPalServerEnv();
      const paypalClient = new PayPalClient(paypalConfig);

      // Branch A: Provider Order ID is known — Authoritative PayPal Inquiry
      if (intent.provider_order_id) {
        const ctxResult = await resolveCapturePaymentContext({
          intent: {
            id: intent.id,
            project_id: intent.project_id,
            milestone_id: intent.milestone_id,
            expected_amount_cents: intent.expected_amount_cents,
            expected_currency: intent.expected_currency,
            expected_merchant_id: intent.expected_merchant_id,
            canonical_payload_json: intent.canonical_payload_json,
          },
          paypalEnv: paypalConfig,
          serviceClient,
          requireLiveSellerReady: false,
        });

        if (!ctxResult.ok) {
          return apiError(ctxResult.error, ctxResult.httpStatus);
        }

        let orderDetails: PayPalOrderResponse;
        try {
          const getRes = await executePayPalOrderGet(
            paypalClient,
            intent.provider_order_id,
            ctxResult.context
          );
          if (!getRes?.data) throw new Error("Empty provider response");
          orderDetails = getRes.data as PayPalOrderResponse;
        } catch {
          return apiError("PROVIDER_INQUIRY_FAILED", 502);
        }

        const orderStatus = orderDetails.status?.toUpperCase();
        if (orderStatus !== "VOIDED" && orderStatus !== "EXPIRED") {
          if (orderStatus === "COMPLETED") {
            return apiError("CANNOT_CANCEL_COMPLETED_ORDER", 409);
          }
          return apiError(`CANNOT_CANCEL_ACTIVE_ORDER_${orderStatus}`, 409);
        }

        // Provider confirmed VOIDED or EXPIRED: Safe to resolve without payment
        // (admin_resolve_reconciliation_without_payment logs to activity_events atomically)
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
            p_notes: notes || `Operator cancelled after provider inquiry confirmed order was ${orderStatus}`,
            p_actor: actor,
          }
        );

        if (resolveError || !(resolveData as { success?: boolean })?.success) {
          return apiError((resolveData as { error?: string })?.error || "RESOLUTION_FAILED", 409);
        }

        return NextResponse.json({
          success: true,
          action,
          previousStatus: intent.status,
          resultingStatus: "CANCELLED",
          reasonCode: `PAYPAL_ORDER_${orderStatus}`,
        });
      }

      // Branch B: Provider Order ID is null (Ghost Order)
      // AUDIT-3B44-01 REMEDIATION:
      // Caller-provided text or support ticket CANNOT substitute for authoritative PayPal evidence.
      // Must enforce conservative automated retry cutoff (5 hours). Outside cutoff, escalate to manual.
      const intentCreatedAtMs = intent.created_at ? new Date(intent.created_at).getTime() : now;
      const intentAgeMs = now - intentCreatedAtMs;

      if (intentAgeMs >= PAYPAL_AUTOMATED_RETRY_CUTOFF_MS) {
        return apiError("IDEMPOTENCY_RETENTION_EXPIRED_MANUAL_ESCALATION_REQUIRED", 409);
      }

      // Replay order creation with original idempotency key and canonical payload
      const replayResult = await reconcilePaymentIntentServerSide({
        intentId: intent.id,
        actorLabel: actor,
        injectedServiceClient: serviceClient,
      });

      // If replay returns the original order, bind it and reject cancellation
      if (replayResult.success && (replayResult.recovered || replayResult.resultingStatus === "ORDER_CREATED")) {
        return apiError("CANNOT_CANCEL_RECOVERED_ORDER", 409);
      }

      // If provider replay was ambiguous, failed, or timed out, we CANNOT prove no order exists.
      // Refuse cancellation to prevent dual-capture race.
      return apiError("CANNOT_CANCEL_UNVERIFIED_GHOST_ORDER", 409);
    }

    // ------------------------------------------------------------------------
    // CASE 5: ESCALATE TO MANUAL INVESTIGATION
    // ------------------------------------------------------------------------
    case "ESCALATE_MANUAL": {
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(intent.status)) {
        return apiError("CANNOT_ESCALATE_TERMINAL_INTENT", 400);
      }

      // RPC commits state change and activity_events log atomically
      const { data: markData, error: markError } = await serviceClient.rpc(
        "admin_mark_intent_reconciliation_required",
        {
          p_payment_intent_id: intent.id,
          p_reason_code: "OPERATOR_MANUAL_ESCALATION",
          p_actor: actor,
        }
      );

      if (markError || !(markData as { success?: boolean })?.success) {
        return apiError((markData as { error?: string })?.error || "ESCALATION_FAILED", 409);
      }

      return NextResponse.json({
        success: true,
        action,
        previousStatus: intent.status,
        resultingStatus: "RECONCILIATION_REQUIRED",
        reasonCode: "OPERATOR_MANUAL_ESCALATION",
      });
    }

    // ------------------------------------------------------------------------
    // CASE 6: REPROCESS WEBHOOK EVENT (AUDIT-3B44-02 & AUDIT-3B44-04 Hardening)
    // ------------------------------------------------------------------------
    case "REPROCESS_WEBHOOK": {
      if (!webhookEventId) {
        return apiError("MISSING_WEBHOOK_EVENT_ID", 400);
      }

      const { data: webhookEvent, error: whError } = await serviceClient
        .from("provider_webhook_events")
        .select("id, provider_event_id, event_type, resource_type, resource_id, payment_intent_id, status, processing_outcome, payload, signature_verified, lease_expires_at")
        .eq("id", webhookEventId)
        .maybeSingle();

      if (whError || !webhookEvent) {
        return apiError("WEBHOOK_EVENT_NOT_FOUND", 404);
      }

      // 1. Signature-Verification Boundary (Fail-Closed)
      // Reprocessing is strictly unavailable for unverified events
      const isSignatureVerified =
        webhookEvent.signature_verified === true ||
        (webhookEvent.payload as Record<string, unknown> | null)?.signature_verified === true ||
        (webhookEvent.payload as Record<string, unknown> | null)?.verification_status === "SUCCESS";

      if (!isSignatureVerified) {
        return apiError("UNVERIFIED_WEBHOOK_EVENT", 422);
      }

      // 2. Duplicate-Event Idempotency
      if (webhookEvent.status === "PROCESSED") {
        return NextResponse.json({
          success: true,
          action,
          alreadyProcessed: true,
          previousStatus: intent.status,
          resultingStatus: intent.status,
          webhookEventId: webhookEvent.id,
          message: "Webhook event has already been successfully processed.",
        });
      }

      // 3. Concurrency Protection
      if (
        webhookEvent.status === "PROCESSING" &&
        webhookEvent.lease_expires_at &&
        new Date(webhookEvent.lease_expires_at).getTime() > now
      ) {
        return apiError("WEBHOOK_EVENT_CURRENTLY_PROCESSING", 409);
      }

      // 4. Strict Event-to-Intent Correlation
      const payload = webhookEvent.payload as {
        id?: string;
        event_type?: string;
        resource_type?: string;
        resource?: {
          id?: string;
          custom_id?: string;
          purchase_units?: Array<{
            custom_id?: string;
          }>;
          supplementary_data?: {
            related_ids?: {
              order_id?: string;
            };
          };
        };
      } | null;

      if (!payload || !payload.resource) {
        return apiError("MALFORMED_WEBHOOK_PAYLOAD", 400);
      }

      const webhookPaymentIntentId = (webhookEvent as { payment_intent_id?: string | null })
        .payment_intent_id;
      const resourceCustomId =
        payload.resource.custom_id ?? payload.resource.purchase_units?.[0]?.custom_id;
      const resourceId =
        payload.resource.id ??
        (webhookEvent as { resource_id?: string | null }).resource_id ??
        undefined;
      const relatedOrderId = payload.resource.supplementary_data?.related_ids?.order_id;

      let isCorrelated = false;

      if (webhookPaymentIntentId) {
        if (webhookPaymentIntentId === intent.id) {
          isCorrelated = true;
        } else {
          return apiError("WEBHOOK_INTENT_MISMATCH", 403);
        }
      }

      // Rule A: custom_id matches intent.id
      if (resourceCustomId) {
        if (resourceCustomId === intent.id) {
          isCorrelated = true;
        } else {
          // Explicit mismatch: points to a different intent
          return apiError("WEBHOOK_INTENT_MISMATCH", 403);
        }
      }

      // Rule B: resource.id or related order_id matches intent.provider_order_id
      if (!isCorrelated && intent.provider_order_id) {
        if (resourceId === intent.provider_order_id || relatedOrderId === intent.provider_order_id) {
          isCorrelated = true;
        }
      }

      if (!isCorrelated) {
        return apiError("WEBHOOK_INTENT_MISMATCH", 403);
      }

      // 5. Reconcile associated payment intent
      const reconResult = await reconcilePaymentIntentServerSide({
        intentId: intent.id,
        actorLabel: actor,
        injectedServiceClient: serviceClient,
      });

      // 6. Atomic status transition & audit log via admin_reprocess_webhook_event RPC
      const newEventStatus =
        reconResult.success && reconResult.resultingStatus === "COMPLETED"
          ? "PROCESSED"
          : "FAILED";
      const errorDetails = reconResult.success
        ? null
        : (reconResult.error || reconResult.reason || "Reconciliation failed").slice(0, 500);

      const { data: updateData, error: updateError } = await serviceClient.rpc(
        "admin_reprocess_webhook_event",
        {
          p_webhook_event_id: webhookEvent.id,
          p_payment_intent_id: intent.id,
          p_status: newEventStatus,
          p_error_details: errorDetails,
          p_actor: actor,
        }
      );

      if (updateError || !(updateData as { success?: boolean })?.success) {
        return apiError("DATABASE_UPDATE_FAILED", 500);
      }

      if (newEventStatus === "FAILED") {
        return NextResponse.json(
          {
            success: false,
            action,
            error: reconResult.error || reconResult.reason || "RECONCILIATION_FAILED",
            previousStatus: intent.status,
            resultingStatus: reconResult.resultingStatus,
            webhookEventId: webhookEvent.id,
          },
          { status: 409 }
        );
      }

      return NextResponse.json({
        success: true,
        action,
        previousStatus: intent.status,
        resultingStatus: reconResult.resultingStatus,
        webhookEventId: webhookEvent.id,
      });
    }

    default:
      return apiError("UNSUPPORTED_ACTION", 400);
  }
}

/**
 * Persists an operator activity record into public.activity_events.
 * Ensures strict append-only auditability with operator identity and structured metadata.
 * Fails closed by throwing if insert fails.
 */
async function logOperatorActivity(params: {
  serviceClient: ReturnType<typeof createServiceClient>;
  projectId: string;
  userId: string;
  actorLabel: string;
  eventType: string;
  summary: string;
  metadata: Record<string, unknown>;
}) {
  const { error } = await params.serviceClient.from("activity_events").insert({
    project_id: params.projectId,
    actor_user_id: params.userId,
    actor_label: params.actorLabel,
    event_type: params.eventType,
    summary: params.summary,
    metadata: {
      ...params.metadata,
      timestamp: new Date().toISOString(),
    },
  });

  if (error) {
    throw new Error(`AUDIT_LOG_INSERT_FAILED: ${error.message}`);
  }
}
