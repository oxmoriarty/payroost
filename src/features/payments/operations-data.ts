import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseIntentPaymentMetadata } from "@/lib/paypal/payment-mode";
import {
  deriveOperationalWebhookStatus,
  detectPaymentInconsistencies,
  sanitizeOperationalText,
  PAYPAL_MAX_IDEMPOTENCY_MS,
} from "@/features/payments/recovery-actions";

export type PaymentIntentStatus =
  | "ORDER_CREATING"
  | "ORDER_CREATED"
  | "BUYER_APPROVED"
  | "CAPTURING"
  | "RECONCILING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "RECONCILIATION_REQUIRED";

export interface PaymentOperationRow {
  id: string; // Intent UUID
  reference: string;
  projectId: string;
  projectName: string;
  clientName: string;
  milestoneId: string;
  milestoneName: string;
  amountCents: number;
  amountCanonical: string;
  currency: string;
  status: PaymentIntentStatus;
  paymentMode?: "PLATFORM" | "MERCHANT";
  payeeMerchantId?: string | null;
  sellerPayerId?: string | null;
  providerOrderId: string | null;
  captureId: string | null;
  reconciliationReason: string | null;
  webhookStatus: string | null;
  webhookEventId: string | null;
  webhookEventType?: string | null;
  webhookProviderEventId?: string | null;
  webhookOutcome?: string | null;
  webhookAttemptCount?: number;
  webhookDuplicateCount?: number;
  webhookLastProcessedAt?: string | null;
  webhookNextAttemptAt?: string | null;
  webhookErrorDetails?: string | null;
  webhookSignatureVerified?: boolean;
  webhookIsExhausted?: boolean;
  webhookCount?: number;
  orderCreationLeaseExpiresAt?: string | null;
  captureLeaseExpiresAt?: string | null;
  hasExpiredLease: boolean;
  hasActiveLease?: boolean;
  hasInconsistency?: boolean;
  idempotencyWindowExpired?: boolean;
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentOperationsSummary {
  totalRecords: number;
  confirmedCaptures: number;
  reconciliationRequired: number;
  inFlight: number;
  totalVolumeCents: number;
  isOwner: boolean;
  exhaustedWebhooks?: number;
  expiredLeases?: number;
  platformCount?: number;
  merchantCount?: number;
}

export interface PaymentOperationsDataResult {
  rows: PaymentOperationRow[];
  summary: PaymentOperationsSummary;
  isOwner: boolean;
  error?: string | null;
}

/**
 * Server-side loader for Payment Operations data.
 * Queries Supabase using the authenticated user's client (strictly adhering to RLS policies)
 * and correlates with payment transactions and webhook processing status.
 */
export async function getPaymentOperationsData(): Promise<PaymentOperationsDataResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      rows: [],
      summary: {
        totalRecords: 0,
        confirmedCaptures: 0,
        reconciliationRequired: 0,
        inFlight: 0,
        totalVolumeCents: 0,
        isOwner: false,
      },
      isOwner: false,
      error: "UNAUTHORIZED",
    };
  }

  // 1. Fetch payment intents with joined projects and milestones via user client (RLS enforces member/owner read)
  const { data: intents, error: intentsError } = await supabase
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
        client_name,
        client_email,
        owner_id
      ),
      milestones (
        id,
        title,
        status
      )
    `)
    .order("created_at", { ascending: false });

  if (intentsError) {
    return {
      rows: [],
      summary: {
        totalRecords: 0,
        confirmedCaptures: 0,
        reconciliationRequired: 0,
        inFlight: 0,
        totalVolumeCents: 0,
        isOwner: false,
      },
      isOwner: false,
      error: intentsError.message,
    };
  }

  const rawIntents = (intents || []) as unknown as Array<{
    id: string;
    project_id: string;
    milestone_id: string;
    status: PaymentIntentStatus;
    expected_amount_cents: number;
    expected_amount_canonical: string;
    expected_currency: string;
    expected_merchant_id: string;
    canonical_payload_json: unknown;
    provider_order_id: string | null;
    order_creation_lease_expires_at: string | null;
    capture_lease_expires_at: string | null;
    reconciliation_reason: string | null;
    buyer_approved_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
    projects: {
      id: string;
      title: string;
      client_name: string | null;
      client_email: string | null;
      owner_id: string;
    } | null;
    milestones: {
      id: string;
      title: string;
      status: string;
    } | null;
  }>;

  const intentIds = rawIntents.map((i) => i.id);

  // 2. Fetch ledger transactions for these intents via user client
  let transactions: Array<{
    id: string;
    payment_intent_id: string;
    provider_reference_id: string;
    transaction_type: string;
    status: string;
    amount_cents: number;
    currency: string;
    payee_merchant_id?: string | null;
    captured_at: string;
  }> = [];

  if (intentIds.length > 0) {
    const { data: txData } = await supabase
      .from("payment_transactions")
      .select("id, payment_intent_id, provider_reference_id, transaction_type, status, amount_cents, currency, payee_merchant_id, captured_at")
      .in("payment_intent_id", intentIds);

    if (txData) {
      transactions = txData as unknown as typeof transactions;
    }
  }

  // 3. Correlate webhook status via server service client (read-only diagnostic, tenant-scoped)
  interface WebhookDisplayInfo {
    status: string;
    eventId: string;
    eventType: string | null;
    providerEventId: string | null;
    processingOutcome: string | null;
    attemptCount: number;
    duplicateCount: number;
    lastProcessedAt: string | null;
    nextAttemptAt: string | null;
    errorDetails: string | null;
    signatureVerified: boolean;
    isExhausted: boolean;
  }

  const webhookByIntentId = new Map<string, WebhookDisplayInfo>();
  const webhookByResourceId = new Map<string, WebhookDisplayInfo>();
  const webhookCountByIntentId = new Map<string, number>();
  const webhookCountByResourceId = new Map<string, number>();

  try {
    const serviceClient = createServiceClient();
    const orderIds = rawIntents
      .map((i) => i.provider_order_id)
      .filter((id): id is string => Boolean(id));
    const captureIds = transactions
      .filter((tx) => tx.transaction_type === "CAPTURE" && tx.provider_reference_id)
      .map((tx) => tx.provider_reference_id);
    const allowedResourceIds = new Set([...orderIds, ...captureIds]);
    const allowedIntentIds = new Set(intentIds);

    if (allowedIntentIds.size > 0 || allowedResourceIds.size > 0) {
      const { data: webhooks } = await serviceClient
        .from("provider_webhook_events")
        .select(
          "id, provider_event_id, event_type, resource_id, payment_intent_id, status, processing_outcome, attempt_count, duplicate_delivery_count, signature_verified, last_processed_at, next_attempt_at, error_details, processed_at, created_at, payload"
        )
        .eq("signature_verified", true)
        .order("created_at", { ascending: false })
        .limit(250);

      if (webhooks) {
        for (const rawWh of webhooks as Array<Record<string, unknown>>) {
          const whIntentId =
            typeof rawWh.payment_intent_id === "string" ? rawWh.payment_intent_id : null;
          // Strict tenant barrier: ignore any webhook tied to a different tenant's intent
          if (whIntentId && !allowedIntentIds.has(whIntentId)) {
            continue;
          }

          const payload = rawWh.payload as { id?: string; resource?: { id?: string } } | null;
          const whResourceId =
            (typeof rawWh.resource_id === "string" && rawWh.resource_id) ||
            payload?.resource?.id ||
            payload?.id ||
            null;

          // Enforce strict project-member tenant scope: ignore webhooks outside user's intents/resources
          const matchesIntent = whIntentId !== null && allowedIntentIds.has(whIntentId);
          const matchesResource = whResourceId !== null && allowedResourceIds.has(whResourceId);
          if (!matchesIntent && !matchesResource) {
            continue;
          }

          const rawOutcome =
            typeof rawWh.processing_outcome === "string" && rawWh.processing_outcome.trim()
              ? rawWh.processing_outcome.trim().toUpperCase()
              : null;
          const rawStatus =
            typeof rawWh.status === "string" ? rawWh.status.trim().toUpperCase() : "RECEIVED";
          const attemptCount =
            typeof rawWh.attempt_count === "number" ? rawWh.attempt_count : 0;
          const dupCount =
            typeof rawWh.duplicate_delivery_count === "number"
              ? rawWh.duplicate_delivery_count
              : 0;
          const rawErrorDetails =
            typeof rawWh.error_details === "string" ? rawWh.error_details : null;

          const derived = deriveOperationalWebhookStatus({
            rawStatus,
            processingOutcome: rawOutcome,
            attemptCount,
            signatureVerified: rawWh.signature_verified === true,
            errorDetails: rawErrorDetails,
          });

          const info: WebhookDisplayInfo = {
            status: derived.status || rawStatus,
            eventId: String(rawWh.id || ""),
            eventType: typeof rawWh.event_type === "string" ? rawWh.event_type : null,
            providerEventId:
              typeof rawWh.provider_event_id === "string" ? rawWh.provider_event_id : null,
            processingOutcome: rawOutcome,
            attemptCount,
            duplicateCount: dupCount,
            lastProcessedAt:
              (typeof rawWh.last_processed_at === "string" && rawWh.last_processed_at) ||
              (typeof rawWh.processed_at === "string" && rawWh.processed_at) ||
              (typeof rawWh.created_at === "string" && rawWh.created_at) ||
              null,
            nextAttemptAt:
              typeof rawWh.next_attempt_at === "string" ? rawWh.next_attempt_at : null,
            errorDetails: sanitizeOperationalText(rawErrorDetails, 180),
            signatureVerified: rawWh.signature_verified === true,
            isExhausted: derived.isExhausted,
          };

          if (whIntentId && allowedIntentIds.has(whIntentId)) {
            webhookCountByIntentId.set(
              whIntentId,
              (webhookCountByIntentId.get(whIntentId) ?? 0) + 1
            );
            if (!webhookByIntentId.has(whIntentId)) {
              webhookByIntentId.set(whIntentId, info);
            }
          }
          if (whResourceId && allowedResourceIds.has(whResourceId)) {
            webhookCountByResourceId.set(
              whResourceId,
              (webhookCountByResourceId.get(whResourceId) ?? 0) + 1
            );
            if (!webhookByResourceId.has(whResourceId)) {
              webhookByResourceId.set(whResourceId, info);
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal: Webhooks table correlation remains null if service client unavailable
  }

  const now = Date.now();
  let userIsOwnerOfAny = false;

  const rows: PaymentOperationRow[] = rawIntents.map((intent) => {
    const project = intent.projects;
    const milestone = intent.milestones;
    const isOwner = project?.owner_id === user.id;
    if (isOwner) userIsOwnerOfAny = true;

    const parsedPaymentMeta = parseIntentPaymentMetadata(intent.canonical_payload_json);
    const derivedPaymentMode = parsedPaymentMeta.valid ? parsedPaymentMeta.mode : undefined;
    const sellerPayerId = parsedPaymentMeta.valid
      ? parsedPaymentMeta.sellerPayerId ?? null
      : null;

    // Find capture transaction(s) if available
    const intentCaptures = transactions.filter(
      (tx) => tx.payment_intent_id === intent.id && tx.transaction_type === "CAPTURE"
    );
    const captureTx =
      intentCaptures.find((tx) => tx.status === "COMPLETED") || intentCaptures[0];

    const creationLeaseMs = intent.order_creation_lease_expires_at
      ? new Date(intent.order_creation_lease_expires_at).getTime()
      : null;
    const captureLeaseMs = intent.capture_lease_expires_at
      ? new Date(intent.capture_lease_expires_at).getTime()
      : null;

    const hasExpiredCreationLease = Boolean(creationLeaseMs !== null && creationLeaseMs <= now);
    const hasExpiredCaptureLease = Boolean(captureLeaseMs !== null && captureLeaseMs <= now);
    const hasActiveLease = Boolean(
      (creationLeaseMs !== null && creationLeaseMs > now) ||
        (captureLeaseMs !== null && captureLeaseMs > now)
    );

    const whInfo =
      webhookByIntentId.get(intent.id) ||
      (captureTx ? webhookByResourceId.get(captureTx.provider_reference_id) : undefined) ||
      (intent.provider_order_id ? webhookByResourceId.get(intent.provider_order_id) : undefined);

    const correlatedWebhookCount = Math.max(
      webhookCountByIntentId.get(intent.id) ?? 0,
      captureTx ? webhookCountByResourceId.get(captureTx.provider_reference_id) ?? 0 : 0,
      intent.provider_order_id ? webhookCountByResourceId.get(intent.provider_order_id) ?? 0 : 0
    );

    const createdMs = new Date(intent.created_at).getTime();
    const idempotencyWindowExpired = Number.isFinite(createdMs)
      ? now - createdMs >= PAYPAL_MAX_IDEMPOTENCY_MS
      : false;

    const inconsistencies = detectPaymentInconsistencies({
      status: intent.status,
      paymentMode: derivedPaymentMode,
      sellerPayerId,
      expectedMerchantId: intent.expected_merchant_id,
      expectedCurrency: intent.expected_currency,
      expectedAmountCents: intent.expected_amount_cents,
      providerOrderId: intent.provider_order_id,
      captureId: captureTx?.provider_reference_id || null,
      hasCompletedCaptureTx: intentCaptures.some((tx) => tx.status === "COMPLETED"),
      captureTxCount: intentCaptures.length,
      txPayeeMerchantId: captureTx?.payee_merchant_id ?? null,
      txCurrency: captureTx?.currency ?? null,
      txAmountCents: captureTx?.amount_cents ?? null,
      hasExpiredLease: hasExpiredCreationLease || hasExpiredCaptureLease,
      webhookStatus: whInfo?.status || null,
      webhookIsExhausted: whInfo?.isExhausted,
    });

    return {
      id: intent.id,
      reference: intent.provider_order_id || intent.id.slice(0, 8).toUpperCase(),
      projectId: intent.project_id,
      projectName: project?.title || "Untitled Project",
      clientName: project?.client_name || "—",
      milestoneId: intent.milestone_id,
      milestoneName: milestone?.title || "Milestone",
      amountCents: intent.expected_amount_cents,
      amountCanonical: intent.expected_amount_canonical,
      currency: intent.expected_currency,
      status: intent.status,
      paymentMode: derivedPaymentMode,
      payeeMerchantId: intent.expected_merchant_id,
      sellerPayerId,
      providerOrderId: intent.provider_order_id,
      captureId: captureTx?.provider_reference_id || null,
      reconciliationReason: intent.reconciliation_reason,
      webhookStatus: whInfo?.status || null,
      webhookEventId: whInfo?.eventId || null,
      webhookEventType: whInfo?.eventType ?? null,
      webhookProviderEventId: whInfo?.providerEventId ?? null,
      webhookOutcome: whInfo?.processingOutcome ?? null,
      webhookAttemptCount: whInfo?.attemptCount,
      webhookDuplicateCount: whInfo?.duplicateCount,
      webhookLastProcessedAt: whInfo?.lastProcessedAt ?? null,
      webhookNextAttemptAt: whInfo?.nextAttemptAt ?? null,
      webhookErrorDetails: whInfo?.errorDetails ?? null,
      webhookSignatureVerified: whInfo?.signatureVerified,
      webhookIsExhausted: whInfo?.isExhausted,
      webhookCount: correlatedWebhookCount,
      orderCreationLeaseExpiresAt: intent.order_creation_lease_expires_at,
      captureLeaseExpiresAt: intent.capture_lease_expires_at,
      hasExpiredLease: hasExpiredCreationLease || hasExpiredCaptureLease,
      hasActiveLease,
      hasInconsistency: inconsistencies.length > 0,
      idempotencyWindowExpired,
      isOwner,
      createdAt: intent.created_at,
      updatedAt: intent.updated_at,
    };
  });

  const summary: PaymentOperationsSummary = {
    totalRecords: rows.length,
    confirmedCaptures: rows.filter((r) => r.status === "COMPLETED").length,
    reconciliationRequired: rows.filter((r) => r.status === "RECONCILIATION_REQUIRED").length,
    inFlight: rows.filter((r) =>
      ["ORDER_CREATING", "ORDER_CREATED", "BUYER_APPROVED", "CAPTURING", "RECONCILING"].includes(r.status)
    ).length,
    totalVolumeCents: rows
      .filter((r) => r.status === "COMPLETED")
      .reduce((sum, r) => sum + r.amountCents, 0),
    isOwner: userIsOwnerOfAny,
    exhaustedWebhooks: rows.filter((r) => r.webhookIsExhausted).length,
    expiredLeases: rows.filter((r) => r.hasExpiredLease).length,
    platformCount: rows.filter((r) => r.paymentMode === "PLATFORM").length,
    merchantCount: rows.filter((r) => r.paymentMode === "MERCHANT").length,
  };

  return {
    rows,
    summary,
    isOwner: userIsOwnerOfAny,
  };
}
