import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseIntentPaymentMetadata } from "@/lib/paypal/payment-mode";
import {
  computeRecoveryActionMatrix,
  deriveOperationalWebhookStatus,
  detectPaymentInconsistencies,
  sanitizeOperationalText,
  PAYPAL_MAX_IDEMPOTENCY_MS,
  type RecoveryActionDescriptor,
} from "@/features/payments/recovery-actions";

export interface InvestigationTransactionRecord {
  id: string;
  transactionType: string;
  provider: string;
  providerReferenceId: string;
  status: string;
  amountCents: number;
  currency: string;
  payeeMerchantId: string | null;
  capturedAt: string | null;
  createdAt: string;
}

export interface InvestigationWebhookRecord {
  id: string;
  providerEventId: string;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  paymentMode: "PLATFORM" | "MERCHANT" | null;
  signatureVerified: boolean;
  status: string;
  operationalStatus: string | null;
  processingOutcome: string | null;
  attemptCount: number;
  duplicateDeliveryCount: number;
  isExhausted: boolean;
  eventCreatedAt: string | null;
  lastProcessedAt: string | null;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  isLeaseExpired: boolean;
  errorDetails: string | null;
  createdAt: string;
}

export interface InvestigationTimelineEvent {
  id: string;
  eventType: string;
  summary: string;
  actorLabel: string;
  createdAt: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface InvestigationSellerContext {
  paymentMode: "PLATFORM" | "MERCHANT" | "UNKNOWN";
  isLegacyWithoutMode: boolean;
  expectedMerchantId: string;
  sellerPayerId: string | null;
  accountStatus: string | null;
  paymentsReceivable: boolean | null;
  primaryEmailConfirmed: boolean | null;
  connectedAt: string | null;
  accountMatchesIntentMerchant: boolean | null;
}

export interface PaymentInvestigationDossier {
  intent: {
    id: string;
    projectId: string;
    projectName: string;
    milestoneId: string;
    milestoneName: string;
    milestoneStatus: string;
    status: string;
    amountCents: number;
    amountCanonical: string;
    currency: string;
    providerOrderId: string | null;
    captureId: string | null;
    reconciliationReason: string | null;
    orderCreationLeaseExpiresAt: string | null;
    captureLeaseExpiresAt: string | null;
    hasExpiredLease: boolean;
    hasActiveLease: boolean;
    idempotencyWindowExpired: boolean;
    idempotencyKeyPrefix: string;
    captureKeyPrefix: string;
    buyerApprovedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    isOwner: boolean;
  };
  sellerContext: InvestigationSellerContext;
  transactions: InvestigationTransactionRecord[];
  webhooks: InvestigationWebhookRecord[];
  timeline: InvestigationTimelineEvent[];
  consistencyWarnings: string[];
  actions: RecoveryActionDescriptor[];
  milestoneIndependenceNotice: string;
}

export type GetPaymentInvestigationResult =
  | { ok: true; dossier: PaymentInvestigationDossier }
  | { ok: false; error: "UNAUTHORIZED" | "NOT_FOUND_OR_FORBIDDEN" | "DATABASE_UNAVAILABLE"; httpStatus: 401 | 404 | 503 };

const ALLOWLISTED_AUDIT_META_KEYS = [
  "intentId",
  "payment_intent_id",
  "action",
  "previousStatus",
  "resultingStatus",
  "providerOrderId",
  "providerCaptureId",
  "paymentMode",
  "webhookEventId",
  "reasonCode",
  "recovered",
  "timestamp",
] as const;

function maskActorLabel(label: unknown): string {
  if (typeof label !== "string" || !label.trim()) return "system";
  const trimmed = label.trim();
  if (!trimmed.includes("@")) return trimmed;
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return "[operator]";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function projectSafeAuditMetadata(raw: unknown): Record<string, string | number | boolean | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const safe: Record<string, string | number | boolean | null> = {};
  for (const key of ALLOWLISTED_AUDIT_META_KEYS) {
    const val = source[key];
    if (
      typeof val === "string" ||
      typeof val === "number" ||
      typeof val === "boolean" ||
      val === null
    ) {
      safe[key] = typeof val === "string" ? sanitizeOperationalText(val, 120) : val;
    }
  }
  return safe;
}

function normalizeSingleRelation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function getPaymentInvestigationDetails(params: {
  intentId: string;
  supabaseClient?: SupabaseClient;
  authenticatedUserId?: string;
}): Promise<GetPaymentInvestigationResult> {
  const supabase = params.supabaseClient ?? (await createClient());
  let userId = params.authenticatedUserId;

  if (!userId) {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return { ok: false, error: "UNAUTHORIZED", httpStatus: 401 };
    }
    userId = user.id;
  }

  // 1. Fetch intent strictly via authenticated RLS client (tenant-isolated)
  const { data: rawIntent, error: intentError } = await supabase
    .from("payment_intents")
    .select(`
      id,
      project_id,
      milestone_id,
      status,
      expected_amount_cents,
      expected_amount_canonical,
      expected_currency,
      expected_merchant_id,
      canonical_payload_json,
      provider_order_id,
      order_idempotency_key,
      capture_idempotency_key,
      order_creation_lease_expires_at,
      capture_lease_expires_at,
      reconciliation_reason,
      buyer_approved_at,
      completed_at,
      created_at,
      updated_at,
      projects (
        id,
        title,
        owner_id
      ),
      milestones (
        id,
        title,
        status
      )
    `)
    .eq("id", params.intentId)
    .maybeSingle();

  if (intentError) {
    return { ok: false, error: "DATABASE_UNAVAILABLE", httpStatus: 503 };
  }

  if (!rawIntent) {
    return { ok: false, error: "NOT_FOUND_OR_FORBIDDEN", httpStatus: 404 };
  }

  const intent = rawIntent as unknown as {
    id: string;
    project_id: string;
    milestone_id: string;
    status: string;
    expected_amount_cents: number;
    expected_amount_canonical: string;
    expected_currency: string;
    expected_merchant_id: string;
    canonical_payload_json: unknown;
    provider_order_id: string | null;
    order_idempotency_key: string;
    capture_idempotency_key: string;
    order_creation_lease_expires_at: string | null;
    capture_lease_expires_at: string | null;
    reconciliation_reason: string | null;
    buyer_approved_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
    projects: { id: string; title: string; owner_id: string } | null;
    milestones: { id: string; title: string; status: string } | null;
  };

  const normalizedProject = normalizeSingleRelation(intent.projects);
  const normalizedMilestone = normalizeSingleRelation(intent.milestones);
  const projectOwnerId = normalizedProject?.owner_id ?? null;
  const isOwner = projectOwnerId === userId;

  const parsedMeta = parseIntentPaymentMetadata(intent.canonical_payload_json);
  const paymentMode = parsedMeta.valid ? parsedMeta.mode : "UNKNOWN";
  const isLegacyWithoutMode = parsedMeta.valid ? Boolean(parsedMeta.isLegacyWithoutMode) : false;
  const sellerPayerId = parsedMeta.valid ? parsedMeta.sellerPayerId ?? null : null;

  const serviceClient = createServiceClient();

  // 2. Correlate payment transactions for this verified intent
  const { data: txRows } = await serviceClient
    .from("payment_transactions")
    .select(
      "id, transaction_type, provider, provider_reference_id, status, amount_cents, currency, payee_merchant_id, captured_at, created_at"
    )
    .eq("payment_intent_id", intent.id)
    .order("created_at", { ascending: true });

  const transactions: InvestigationTransactionRecord[] = ((txRows || []) as Array<Record<string, unknown>>).map(
    (tx) => ({
      id: String(tx.id || ""),
      transactionType: String(tx.transaction_type || ""),
      provider: String(tx.provider || "PAYPAL"),
      providerReferenceId: String(tx.provider_reference_id || ""),
      status: String(tx.status || ""),
      amountCents: Number(tx.amount_cents || 0),
      currency: String(tx.currency || "USD"),
      payeeMerchantId: typeof tx.payee_merchant_id === "string" ? tx.payee_merchant_id : null,
      capturedAt: typeof tx.captured_at === "string" ? tx.captured_at : null,
      createdAt: String(tx.created_at || ""),
    })
  );

  const captureTransactions = transactions.filter((t) => t.transactionType === "CAPTURE");
  const completedCaptureTx = captureTransactions.find((t) => t.status === "COMPLETED") || captureTransactions[0];
  const resourceIdsToMatch = Array.from(
    new Set(
      [
        intent.provider_order_id,
        ...transactions.map((t) => t.providerReferenceId),
      ].filter((val): val is string => typeof val === "string" && val.length > 0)
    )
  );

  // 3. Correlate webhook events (strictly scoped to intent ID or verified resource IDs, excluding other intents)
  const webhookMap = new Map<string, Record<string, unknown>>();
  const { data: webhooksByIntent } = await serviceClient
    .from("provider_webhook_events")
    .select(
      "id, provider_event_id, event_type, resource_type, resource_id, payment_intent_id, payment_mode, processing_outcome, status, attempt_count, duplicate_delivery_count, event_created_at, last_processed_at, next_attempt_at, lease_expires_at, error_details, signature_verified, created_at"
    )
    .eq("payment_intent_id", intent.id)
    .order("created_at", { ascending: false })
    .limit(50);

  for (const row of (webhooksByIntent || []) as Array<Record<string, unknown>>) {
    if (typeof row.id === "string") {
      webhookMap.set(row.id, row);
    }
  }

  if (resourceIdsToMatch.length > 0) {
    const { data: webhooksByResource } = await serviceClient
      .from("provider_webhook_events")
      .select(
        "id, provider_event_id, event_type, resource_type, resource_id, payment_intent_id, payment_mode, processing_outcome, status, attempt_count, duplicate_delivery_count, event_created_at, last_processed_at, next_attempt_at, lease_expires_at, error_details, signature_verified, created_at"
      )
      .in("resource_id", resourceIdsToMatch)
      .order("created_at", { ascending: false })
      .limit(50);

    for (const row of (webhooksByResource || []) as Array<Record<string, unknown>>) {
      const boundIntentId = typeof row.payment_intent_id === "string" ? row.payment_intent_id : null;
      // Tenant & intent isolation guard: never include webhook bound to a different intent
      if (boundIntentId && boundIntentId !== intent.id) continue;
      if (typeof row.id === "string" && !webhookMap.has(row.id)) {
        webhookMap.set(row.id, row);
      }
    }
  }

  const nowMs = Date.now();
  const webhooks: InvestigationWebhookRecord[] = Array.from(webhookMap.values())
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .map((wh) => {
      const rawStatus = typeof wh.status === "string" ? wh.status.trim().toUpperCase() : "RECEIVED";
      const processingOutcome =
        typeof wh.processing_outcome === "string" ? wh.processing_outcome.trim().toUpperCase() : null;
      const attemptCount = typeof wh.attempt_count === "number" ? wh.attempt_count : 0;
      const errorDetails = sanitizeOperationalText(
        typeof wh.error_details === "string" ? wh.error_details : null,
        240
      );
      const signatureVerified = wh.signature_verified === true;
      const derived = deriveOperationalWebhookStatus({
        rawStatus,
        processingOutcome,
        attemptCount,
        signatureVerified,
        errorDetails,
      });

      const leaseExp = typeof wh.lease_expires_at === "string" ? wh.lease_expires_at : null;
      const isLeaseExpired = Boolean(
        rawStatus === "PROCESSING" && leaseExp && new Date(leaseExp).getTime() <= nowMs
      );

      const whMode =
        wh.payment_mode === "PLATFORM" || wh.payment_mode === "MERCHANT"
          ? wh.payment_mode
          : null;

      return {
        id: String(wh.id || ""),
        providerEventId: String(wh.provider_event_id || ""),
        eventType: String(wh.event_type || ""),
        resourceType: typeof wh.resource_type === "string" ? wh.resource_type : null,
        resourceId: typeof wh.resource_id === "string" ? wh.resource_id : null,
        paymentMode: whMode,
        signatureVerified,
        status: rawStatus,
        operationalStatus: derived.status,
        processingOutcome,
        attemptCount,
        duplicateDeliveryCount:
          typeof wh.duplicate_delivery_count === "number" ? wh.duplicate_delivery_count : 0,
        isExhausted: derived.isExhausted,
        eventCreatedAt: typeof wh.event_created_at === "string" ? wh.event_created_at : null,
        lastProcessedAt: typeof wh.last_processed_at === "string" ? wh.last_processed_at : null,
        nextAttemptAt: typeof wh.next_attempt_at === "string" ? wh.next_attempt_at : null,
        leaseExpiresAt: leaseExp,
        isLeaseExpired,
        errorDetails,
        createdAt: String(wh.created_at || ""),
      };
    });

  // 4. Seller account attribution (non-secret summary)
  const sellerContext: InvestigationSellerContext = {
    paymentMode,
    isLegacyWithoutMode,
    expectedMerchantId: intent.expected_merchant_id,
    sellerPayerId,
    accountStatus: null,
    paymentsReceivable: null,
    primaryEmailConfirmed: null,
    connectedAt: null,
    accountMatchesIntentMerchant: null,
  };

  if (paymentMode === "PLATFORM" && projectOwnerId) {
    const { data: sellerAccount } = await serviceClient
      .from("freelancer_paypal_accounts")
      .select("paypal_merchant_id, onboarding_status, payments_receivable, primary_email_confirmed, connected_at")
      .eq("user_id", projectOwnerId)
      .maybeSingle();

    if (sellerAccount) {
      const sa = sellerAccount as {
        paypal_merchant_id: string | null;
        onboarding_status: string | null;
        payments_receivable: boolean | null;
        primary_email_confirmed: boolean | null;
        connected_at: string | null;
      };
      sellerContext.accountStatus = sa.onboarding_status;
      sellerContext.paymentsReceivable = sa.payments_receivable;
      sellerContext.primaryEmailConfirmed = sa.primary_email_confirmed;
      sellerContext.connectedAt = sa.connected_at;
      sellerContext.accountMatchesIntentMerchant =
        typeof sa.paypal_merchant_id === "string"
          ? sa.paypal_merchant_id.trim() === intent.expected_merchant_id.trim()
          : false;
    }
  }

  // 5. Activity timeline for this payment intent (strictly sanitized, no raw PII/secrets)
  const { data: rawEvents } = await serviceClient
    .from("activity_events")
    .select("id, event_type, summary, actor_label, metadata, created_at")
    .eq("project_id", intent.project_id)
    .order("created_at", { ascending: false })
    .limit(100);

  const timeline: InvestigationTimelineEvent[] = [];
  for (const ev of (rawEvents || []) as Array<Record<string, unknown>>) {
    const evType = typeof ev.event_type === "string" ? ev.event_type : "";
    const summary = typeof ev.summary === "string" ? ev.summary : "";
    const meta = (ev.metadata && typeof ev.metadata === "object" ? ev.metadata : {}) as Record<
      string,
      unknown
    >;

    const matchesIntentMeta =
      meta.intentId === intent.id ||
      meta.payment_intent_id === intent.id ||
      (intent.provider_order_id && meta.providerOrderId === intent.provider_order_id) ||
      (intent.provider_order_id && meta.provider_order_id === intent.provider_order_id);
    const matchesSummary =
      summary.includes(intent.id) ||
      (intent.provider_order_id ? summary.includes(intent.provider_order_id) : false);

    if (!matchesIntentMeta && !matchesSummary) {
      continue;
    }

    timeline.push({
      id: String(ev.id || ""),
      eventType: evType,
      summary: sanitizeOperationalText(summary, 300) || evType,
      actorLabel: maskActorLabel(ev.actor_label),
      createdAt: String(ev.created_at || ""),
      metadata: projectSafeAuditMetadata(meta),
    });
  }

  // 6. Leases, consistency warnings & action matrix
  const creationLeaseMs = intent.order_creation_lease_expires_at
    ? new Date(intent.order_creation_lease_expires_at).getTime()
    : null;
  const captureLeaseMs = intent.capture_lease_expires_at
    ? new Date(intent.capture_lease_expires_at).getTime()
    : null;

  const hasExpiredLease = Boolean(
    (creationLeaseMs !== null && creationLeaseMs <= nowMs) ||
      (captureLeaseMs !== null && captureLeaseMs <= nowMs)
  );
  const hasActiveLease = Boolean(
    (creationLeaseMs !== null && creationLeaseMs > nowMs) ||
      (captureLeaseMs !== null && captureLeaseMs > nowMs)
  );
  const createdMs = new Date(intent.created_at).getTime();
  const idempotencyWindowExpired = Number.isFinite(createdMs)
    ? nowMs - createdMs >= PAYPAL_MAX_IDEMPOTENCY_MS
    : false;

  const latestWebhook = webhooks[0] ?? null;

  const consistencyWarnings = detectPaymentInconsistencies({
    status: intent.status,
    paymentMode: paymentMode === "UNKNOWN" ? null : paymentMode,
    sellerPayerId,
    expectedMerchantId: intent.expected_merchant_id,
    expectedCurrency: intent.expected_currency,
    expectedAmountCents: intent.expected_amount_cents,
    providerOrderId: intent.provider_order_id,
    captureId: completedCaptureTx?.providerReferenceId ?? null,
    hasCompletedCaptureTx: captureTransactions.some((t) => t.status === "COMPLETED"),
    captureTxCount: captureTransactions.length,
    txPayeeMerchantId: completedCaptureTx?.payeeMerchantId ?? null,
    txCurrency: completedCaptureTx?.currency ?? null,
    txAmountCents: completedCaptureTx?.amountCents ?? null,
    hasExpiredLease,
    webhookStatus: latestWebhook?.operationalStatus ?? null,
    webhookIsExhausted: latestWebhook?.isExhausted,
  });

  if (sellerContext.accountMatchesIntentMerchant === false) {
    consistencyWarnings.push(
      "Seller connected PayPal merchant ID has changed since this intent was created; historical intent retains its pinned expected merchant ID."
    );
  }

  const actions = computeRecoveryActionMatrix(
    {
      intentId: intent.id,
      status: intent.status,
      paymentMode: paymentMode === "UNKNOWN" ? null : paymentMode,
      providerOrderId: intent.provider_order_id,
      captureId: completedCaptureTx?.providerReferenceId ?? null,
      hasCompletedCaptureTx: captureTransactions.some((t) => t.status === "COMPLETED"),
      hasExpiredLease,
      hasActiveLease,
      orderCreationLeaseExpiresAt: intent.order_creation_lease_expires_at,
      captureLeaseExpiresAt: intent.capture_lease_expires_at,
      createdAt: intent.created_at,
      isOwner,
      webhookEventId: latestWebhook?.id ?? null,
      webhookStatus: latestWebhook?.operationalStatus ?? latestWebhook?.status ?? null,
      webhookSignatureVerified: latestWebhook?.signatureVerified,
      webhookIsExhausted: latestWebhook?.isExhausted,
    },
    nowMs
  );

  return {
    ok: true,
    dossier: {
      intent: {
        id: intent.id,
        projectId: intent.project_id,
        projectName: normalizedProject?.title || "Untitled Project",
        milestoneId: intent.milestone_id,
        milestoneName: normalizedMilestone?.title || "Milestone",
        milestoneStatus: normalizedMilestone?.status || "UNKNOWN",
        status: intent.status,
        amountCents: intent.expected_amount_cents,
        amountCanonical: intent.expected_amount_canonical,
        currency: intent.expected_currency,
        providerOrderId: intent.provider_order_id,
        captureId: completedCaptureTx?.providerReferenceId ?? null,
        reconciliationReason: sanitizeOperationalText(intent.reconciliation_reason, 240),
        orderCreationLeaseExpiresAt: intent.order_creation_lease_expires_at,
        captureLeaseExpiresAt: intent.capture_lease_expires_at,
        hasExpiredLease,
        hasActiveLease,
        idempotencyWindowExpired,
        idempotencyKeyPrefix: intent.order_idempotency_key.slice(0, 8),
        captureKeyPrefix: intent.capture_idempotency_key.slice(0, 8),
        buyerApprovedAt: intent.buyer_approved_at,
        completedAt: intent.completed_at,
        createdAt: intent.created_at,
        updatedAt: intent.updated_at,
        isOwner,
      },
      sellerContext,
      transactions,
      webhooks,
      timeline,
      consistencyWarnings,
      actions,
      milestoneIndependenceNotice:
        "Milestones are never automatically approved or completed by PayPal captures, webhook deliveries, or operator recovery actions.",
    },
  };
}
