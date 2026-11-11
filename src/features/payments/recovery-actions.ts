export type RecoveryActionType =
  | "RECONCILE"
  | "CLEAR_EXPIRED_LEASE"
  | "RETRY_ORDER_CREATION"
  | "CANCEL_INACTIVE"
  | "ESCALATE_MANUAL"
  | "REPROCESS_WEBHOOK";

export type OperationalWebhookStatus =
  | "RECEIVED"
  | "VERIFIED"
  | "PROCESSING"
  | "RETRY_SCHEDULED"
  | "PROCESSED"
  | "DUPLICATE"
  | "FAILED"
  | "REQUIRES_RECONCILIATION"
  | "EXHAUSTED";

export const PAYPAL_MAX_IDEMPOTENCY_HOURS = 6;
export const PAYPAL_MAX_IDEMPOTENCY_MS = PAYPAL_MAX_IDEMPOTENCY_HOURS * 60 * 60 * 1000;

export interface RecoveryEligibilityInput {
  intentId: string;
  status: string;
  paymentMode?: "PLATFORM" | "MERCHANT" | null;
  providerOrderId: string | null;
  captureId: string | null;
  hasCompletedCaptureTx?: boolean;
  hasExpiredLease: boolean;
  hasActiveLease?: boolean;
  orderCreationLeaseExpiresAt?: string | null;
  captureLeaseExpiresAt?: string | null;
  createdAt: string;
  isOwner: boolean;
  webhookEventId: string | null;
  webhookStatus: string | null;
  webhookSignatureVerified?: boolean;
  webhookIsExhausted?: boolean;
}

export interface RecoveryActionDescriptor {
  action: RecoveryActionType;
  label: string;
  shortLabel: string;
  description: string;
  impactSummary: string;
  confirmationPrompt: string;
  allowed: boolean;
  blockedReason: string | null;
  recommended: boolean;
  destructive: boolean;
}

export interface PaymentConsistencyInput {
  status: string;
  paymentMode?: "PLATFORM" | "MERCHANT" | null;
  sellerPayerId?: string | null;
  expectedMerchantId?: string | null;
  expectedCurrency?: string | null;
  expectedAmountCents?: number;
  providerOrderId: string | null;
  captureId: string | null;
  hasCompletedCaptureTx?: boolean;
  captureTxCount?: number;
  txPayeeMerchantId?: string | null;
  txCurrency?: string | null;
  txAmountCents?: number | null;
  hasExpiredLease: boolean;
  webhookStatus?: string | null;
  webhookIsExhausted?: boolean;
}

const REDACTED_EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const REDACTED_SECRET_REGEX = /(bearer\s+[a-z0-9._-]+|client_secret|authorization|paypal-auth-assertion)/gi;

/**
 * Strips potentially sensitive tokens or accidental email fragments from operational
 * error summaries while keeping machine-readable PayPal/DB diagnostic codes intact.
 */
export function sanitizeOperationalText(input: string | null | undefined, maxLength = 240): string | null {
  if (!input || typeof input !== "string") return null;
  const cleaned = input
    .replace(REDACTED_EMAIL_REGEX, "[redacted-email]")
    .replace(REDACTED_SECRET_REGEX, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
}

/**
 * Maps raw provider_webhook_events fields into clear operational status labels.
 */
export function deriveOperationalWebhookStatus(params: {
  rawStatus?: string | null;
  processingOutcome?: string | null;
  attemptCount?: number | null;
  signatureVerified?: boolean | null;
  errorDetails?: string | null;
  maxAttempts?: number;
}): {
  status: OperationalWebhookStatus | null;
  isExhausted: boolean;
} {
  const rawStatus = (params.rawStatus || "").trim().toUpperCase();
  const outcome = (params.processingOutcome || "").trim().toUpperCase();
  const attempts = typeof params.attemptCount === "number" ? params.attemptCount : 0;
  const maxAttempts = params.maxAttempts ?? 8;
  const err = (params.errorDetails || "").trim().toUpperCase();

  const isExhausted =
    err.includes("MAX_WEBHOOK_ATTEMPTS_EXCEEDED") ||
    (rawStatus === "FAILED" && attempts >= maxAttempts) ||
    (outcome === "REQUIRES_RECONCILIATION" && attempts >= maxAttempts);

  if (!rawStatus && !outcome) {
    return { status: null, isExhausted: false };
  }

  if (outcome === "DUPLICATE") {
    return { status: "DUPLICATE", isExhausted: false };
  }
  if (rawStatus === "PROCESSED" || outcome === "PROCESSED") {
    return { status: "PROCESSED", isExhausted: false };
  }
  if (isExhausted) {
    return { status: "EXHAUSTED", isExhausted: true };
  }
  if (outcome === "REQUIRES_RECONCILIATION") {
    return { status: "REQUIRES_RECONCILIATION", isExhausted: false };
  }
  if (rawStatus === "FAILED" || outcome === "FAILED") {
    return { status: "FAILED", isExhausted: false };
  }
  if (rawStatus === "RETRY") {
    return { status: "RETRY_SCHEDULED", isExhausted: false };
  }
  if (rawStatus === "PROCESSING" || outcome === "PROCESSING") {
    return { status: "PROCESSING", isExhausted: false };
  }
  if (outcome === "VERIFIED" || params.signatureVerified === true) {
    return { status: rawStatus === "RECEIVED" ? "VERIFIED" : "VERIFIED", isExhausted: false };
  }
  if (rawStatus === "RECEIVED") {
    return { status: "RECEIVED", isExhausted: false };
  }

  return { status: "RECEIVED", isExhausted: false };
}

/**
 * Computes non-destructive server/client consistency diagnostics across intent, ledger, and webhooks.
 */
export function detectPaymentInconsistencies(input: PaymentConsistencyInput): string[] {
  const warnings: string[] = [];
  const hasCompletedTx = Boolean(input.hasCompletedCaptureTx || input.captureId);

  if (input.status === "COMPLETED" && !hasCompletedTx) {
    warnings.push(
      "Intent is marked COMPLETED without a linked COMPLETED CAPTURE transaction on the payment ledger."
    );
  }

  if (input.status !== "COMPLETED" && hasCompletedTx) {
    warnings.push(
      `Ledger contains a COMPLETED CAPTURE (${input.captureId || "recorded"}) while intent remains in ${input.status} state.`
    );
  }

  if (typeof input.captureTxCount === "number" && input.captureTxCount > 1) {
    warnings.push(
      `Multiple CAPTURE ledger rows (${input.captureTxCount}) recorded for this intent — verify single authoritative capture.`
    );
  }

  if (
    input.txPayeeMerchantId &&
    input.expectedMerchantId &&
    input.txPayeeMerchantId.trim() !== input.expectedMerchantId.trim()
  ) {
    warnings.push(
      `Payee merchant mismatch between intent (${input.expectedMerchantId}) and ledger (${input.txPayeeMerchantId}).`
    );
  }

  if (
    input.txCurrency &&
    input.expectedCurrency &&
    input.txCurrency.trim().toUpperCase() !== input.expectedCurrency.trim().toUpperCase()
  ) {
    warnings.push(
      `Currency mismatch between intent (${input.expectedCurrency}) and ledger (${input.txCurrency}).`
    );
  }

  if (
    typeof input.txAmountCents === "number" &&
    typeof input.expectedAmountCents === "number" &&
    input.txAmountCents !== input.expectedAmountCents
  ) {
    warnings.push(
      `Amount mismatch between intent (${input.expectedAmountCents} cents) and capture transaction (${input.txAmountCents} cents).`
    );
  }

  if (input.paymentMode === "PLATFORM" && !input.sellerPayerId) {
    warnings.push(
      "PLATFORM payment intent is missing canonical seller_payer_id metadata; Auth Assertion requests will fail closed until verified seller metadata exists."
    );
  }

  if (input.hasExpiredLease) {
    warnings.push("Processing lease has expired while intent remains in an active transitional state.");
  }

  if (input.webhookIsExhausted || input.webhookStatus === "EXHAUSTED") {
    warnings.push("Automated webhook retry attempts are exhausted — operator reconciliation or manual replay required.");
  } else if (
    input.webhookStatus === "FAILED" ||
    input.webhookStatus === "REQUIRES_RECONCILIATION"
  ) {
    warnings.push("Latest correlated PayPal webhook failed automatic settlement and requires operator review.");
  }

  return warnings;
}

/**
 * Single source of truth for action eligibility, blocked precondition explanations,
 * and explicit operator confirmation text across UI and backend.
 */
export function computeRecoveryActionMatrix(
  input: RecoveryEligibilityInput,
  nowMs = Date.now()
): RecoveryActionDescriptor[] {
  const createdMs = new Date(input.createdAt).getTime();
  const intentAgeMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : PAYPAL_MAX_IDEMPOTENCY_MS + 1;
  const withinIdempotencyWindow = intentAgeMs < PAYPAL_MAX_IDEMPOTENCY_MS;

  const hasOrderLease = Boolean(input.orderCreationLeaseExpiresAt);
  const hasCaptureLease = Boolean(input.captureLeaseExpiresAt);
  const orderLeaseExpired = Boolean(
    input.orderCreationLeaseExpiresAt &&
      new Date(input.orderCreationLeaseExpiresAt).getTime() <= nowMs
  );
  const captureLeaseExpired = Boolean(
    input.captureLeaseExpiresAt && new Date(input.captureLeaseExpiresAt).getTime() <= nowMs
  );
  const activeLease =
    Boolean(input.hasActiveLease) ||
    ((hasOrderLease && !orderLeaseExpired) || (hasCaptureLease && !captureLeaseExpired));

  const expiredLease = Boolean(input.hasExpiredLease || orderLeaseExpired || captureLeaseExpired);
  const completedCapturePresent = Boolean(input.hasCompletedCaptureTx || input.captureId);

  const modeLabel =
    input.paymentMode === "PLATFORM"
      ? "PLATFORM (Multi-Party PayPal)"
      : "MERCHANT (Historical First-Party)";

  // 1. RECONCILE
  let reconcileBlocked: string | null = null;
  if (!input.isOwner) {
    reconcileBlocked = "Only the project owner is authorized to execute payment recovery.";
  } else if (input.status === "COMPLETED") {
    reconcileBlocked = "Intent is already COMPLETED with finalized ledger state.";
  } else if (input.status === "CANCELLED" || input.status === "FAILED") {
    reconcileBlocked = `Terminal intent status ${input.status} cannot be reconciled automatically.`;
  } else if (input.status === "CAPTURING" && !expiredLease) {
    reconcileBlocked = "Active CAPTURING worker lease has not expired yet; wait until lease expiry.";
  } else if (
    input.status !== "RECONCILIATION_REQUIRED" &&
    input.status !== "ORDER_CREATING" &&
    !(input.status === "CAPTURING" && expiredLease)
  ) {
    reconcileBlocked = `Status ${input.status} is not in a reconciliation state; escalate to RECONCILIATION_REQUIRED first if stuck.`;
  }

  // 2. CLEAR_EXPIRED_LEASE
  let clearLeaseBlocked: string | null = null;
  if (!input.isOwner) {
    clearLeaseBlocked = "Only the project owner is authorized to clear expired leases.";
  } else if (!expiredLease && !hasOrderLease && !hasCaptureLease) {
    clearLeaseBlocked = "No order-creation or capture lease token is currently set on this intent.";
  } else if (!expiredLease && activeLease) {
    clearLeaseBlocked = "Worker lease is still active and cannot be preempted until expiry.";
  }

  // 3. RETRY_ORDER_CREATION
  let retryOrderBlocked: string | null = null;
  if (!input.isOwner) {
    retryOrderBlocked = "Only the project owner is authorized to retry order creation.";
  } else if (input.providerOrderId) {
    retryOrderBlocked = `PayPal Order ID ${input.providerOrderId} is already bound; use PayPal inquiry reconciliation instead.`;
  } else if (input.status !== "ORDER_CREATING" && input.status !== "RECONCILIATION_REQUIRED") {
    retryOrderBlocked = `Order creation replay only applies to ORDER_CREATING or RECONCILIATION_REQUIRED intents (currently ${input.status}).`;
  } else if (activeLease) {
    retryOrderBlocked = "An active order creation worker lease is still running.";
  } else if (!withinIdempotencyWindow) {
    retryOrderBlocked = `PayPal ${PAYPAL_MAX_IDEMPOTENCY_HOURS}-hour order idempotency window has expired; verify before manual cancellation.`;
  }

  // 4. REPROCESS_WEBHOOK
  let reprocessBlocked: string | null = null;
  if (!input.isOwner) {
    reprocessBlocked = "Only the project owner is authorized to reprocess webhook events.";
  } else if (!input.webhookEventId) {
    reprocessBlocked = "No correlated PayPal webhook event is attached to this intent.";
  } else if (input.webhookSignatureVerified === false) {
    reprocessBlocked = "Correlated webhook failed PayPal signature verification (fail-closed).";
  } else if (input.webhookStatus === "PROCESSED" || input.webhookStatus === "DUPLICATE") {
    reprocessBlocked = "Latest correlated webhook event is already PROCESSED.";
  }

  // 5. ESCALATE_MANUAL
  let escalateBlocked: string | null = null;
  if (!input.isOwner) {
    escalateBlocked = "Only the project owner is authorized to escalate payment intents.";
  } else if (input.status === "COMPLETED" || input.status === "CANCELLED" || input.status === "FAILED") {
    escalateBlocked = `Terminal status ${input.status} cannot be escalated.`;
  } else if (input.status === "RECONCILIATION_REQUIRED") {
    escalateBlocked = "Intent is already flagged RECONCILIATION_REQUIRED.";
  } else if (activeLease) {
    escalateBlocked = "Cannot escalate while an active worker lease holds this intent.";
  } else if (!["ORDER_CREATED", "BUYER_APPROVED", "RECONCILING", "ORDER_CREATING", "CAPTURING"].includes(input.status)) {
    escalateBlocked = `Status ${input.status} cannot be escalated.`;
  }

  // 6. CANCEL_INACTIVE
  let cancelBlocked: string | null = null;
  if (!input.isOwner) {
    cancelBlocked = "Only the project owner is authorized to cancel inactive intents.";
  } else if (input.status === "COMPLETED" || completedCapturePresent) {
    cancelBlocked = "Cannot cancel an intent with a COMPLETED status or captured payment transaction.";
  } else if (input.status === "CANCELLED") {
    cancelBlocked = "Intent is already CANCELLED.";
  }

  return [
    {
      action: "RECONCILE",
      label: "Reconcile via PayPal API",
      shortLabel: "Reconcile",
      description:
        "Queries PayPal authoritatively (respecting persisted PLATFORM vs MERCHANT mode) to synchronize capture, approval, or ghost-order status into the ledger.",
      impactSummary: `Queries PayPal using ${modeLabel} context and reconciles ledger without overwriting milestone completion rules.`,
      confirmationPrompt: `Confirm PayPal inquiry reconciliation for intent ${input.intentId.slice(0, 8)} (${modeLabel}). Milestones will NOT be auto-approved.`,
      allowed: reconcileBlocked === null,
      blockedReason: reconcileBlocked,
      recommended:
        reconcileBlocked === null &&
        (input.status === "RECONCILIATION_REQUIRED" ||
          (input.status === "CAPTURING" && expiredLease)),
      destructive: false,
    },
    {
      action: "CLEAR_EXPIRED_LEASE",
      label: "Clear Expired Processing Lease",
      shortLabel: "Clear Lease",
      description:
        "Clears expired order-creation or capture lease locks (after checking PayPal on CAPTURING intents so no completed capture is lost).",
      impactSummary:
        "Frees stuck lease locks safely so client payment or reconciliation can proceed.",
      confirmationPrompt: `Confirm clearing expired lease lock on intent ${input.intentId.slice(0, 8)} (${modeLabel}).`,
      allowed: clearLeaseBlocked === null,
      blockedReason: clearLeaseBlocked,
      recommended:
        clearLeaseBlocked === null && expiredLease && input.status !== "RECONCILIATION_REQUIRED",
      destructive: false,
    },
    {
      action: "RETRY_ORDER_CREATION",
      label: "Retry Order Creation (Idempotent Replay)",
      shortLabel: "Retry Order",
      description:
        "Replays the exact canonical order request within PayPal's 6-hour idempotency retention window when no PayPal Order ID was persisted.",
      impactSummary:
        "Binds the existing PayPal order (never creates a second order or charge) and restores ORDER_CREATED.",
      confirmationPrompt: `Confirm safe PayPal idempotency replay for ghost order on intent ${input.intentId.slice(0, 8)} (${modeLabel}).`,
      allowed: retryOrderBlocked === null,
      blockedReason: retryOrderBlocked,
      recommended: retryOrderBlocked === null && !input.providerOrderId && withinIdempotencyWindow,
      destructive: false,
    },
    {
      action: "REPROCESS_WEBHOOK",
      label: "Reprocess Verified Webhook",
      shortLabel: "Reprocess Webhook",
      description:
        "Re-runs processing for a signature-verified PayPal webhook event after checking current PayPal API state.",
      impactSummary:
        "Verifies PayPal order/capture status authoritatively and updates webhook + payment state idempotently.",
      confirmationPrompt: `Confirm reprocessing verified webhook ${input.webhookEventId?.slice(0, 8) || ""} for intent ${input.intentId.slice(0, 8)}.`,
      allowed: reprocessBlocked === null,
      blockedReason: reprocessBlocked,
      recommended:
        reprocessBlocked === null &&
        Boolean(input.webhookIsExhausted || input.webhookStatus === "FAILED" || input.webhookStatus === "REQUIRES_RECONCILIATION"),
      destructive: false,
    },
    {
      action: "ESCALATE_MANUAL",
      label: "Escalate to Reconciliation Required",
      shortLabel: "Escalate",
      description:
        "Locks an ambiguous in-flight intent into RECONCILIATION_REQUIRED so duplicate capture attempts are blocked until resolved.",
      impactSummary:
        "Moves intent to RECONCILIATION_REQUIRED and blocks new capture submissions.",
      confirmationPrompt: `Confirm escalating intent ${input.intentId.slice(0, 8)} to RECONCILIATION_REQUIRED.`,
      allowed: escalateBlocked === null,
      blockedReason: escalateBlocked,
      recommended: false,
      destructive: false,
    },
    {
      action: "CANCEL_INACTIVE",
      label: "Verify Inactive & Mark Cancelled",
      shortLabel: "Cancel Inactive",
      description:
        "Queries PayPal authoritatively and marks this intent CANCELLED only if no completed capture exists and PayPal confirms the order does not exist or is VOIDED/inactive.",
      impactSummary:
        "Performs mandatory live PayPal verification first; never cancels unverified ghost orders or completed captures.",
      confirmationPrompt: `Confirm authoritative PayPal check and permanent cancellation of inactive intent ${input.intentId.slice(0, 8)}.`,
      allowed: cancelBlocked === null,
      blockedReason: cancelBlocked,
      recommended: false,
      destructive: true,
    },
  ];
}
