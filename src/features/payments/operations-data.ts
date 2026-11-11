import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

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
  providerOrderId: string | null;
  captureId: string | null;
  reconciliationReason: string | null;
  webhookStatus: string | null;
  webhookEventId: string | null;
  hasExpiredLease: boolean;
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
    captured_at: string;
  }> = [];

  if (intentIds.length > 0) {
    const { data: txData } = await supabase
      .from("payment_transactions")
      .select("id, payment_intent_id, provider_reference_id, transaction_type, status, amount_cents, currency, captured_at")
      .in("payment_intent_id", intentIds);

    if (txData) {
      transactions = txData as unknown as typeof transactions;
    }
  }

  // 3. Correlate webhook status via server service client (read-only diagnostic)
  const webhookMap = new Map<string, { status: string; eventId: string }>();
  try {
    const serviceClient = createServiceClient();
    const orderIds = rawIntents
      .map((i) => i.provider_order_id)
      .filter((id): id is string => Boolean(id));

    if (orderIds.length > 0) {
      const { data: webhooks } = await serviceClient
        .from("provider_webhook_events")
        .select("id, provider_event_id, status, payload")
        .order("created_at", { ascending: false });

      if (webhooks) {
        for (const wh of webhooks) {
          const payload = wh.payload as { id?: string; resource?: { id?: string } } | null;
          const resourceId = payload?.resource?.id || payload?.id;
          if (resourceId && !webhookMap.has(resourceId)) {
            webhookMap.set(resourceId, { status: wh.status, eventId: wh.id });
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

    // Find capture transaction if available
    const captureTx = transactions.find(
      (tx) => tx.payment_intent_id === intent.id && tx.transaction_type === "CAPTURE"
    );

    const hasExpiredCreationLease = Boolean(
      intent.order_creation_lease_expires_at &&
      new Date(intent.order_creation_lease_expires_at).getTime() < now
    );
    const hasExpiredCaptureLease = Boolean(
      intent.capture_lease_expires_at &&
      new Date(intent.capture_lease_expires_at).getTime() < now
    );

    const whInfo = intent.provider_order_id
      ? webhookMap.get(intent.provider_order_id) || (captureTx ? webhookMap.get(captureTx.provider_reference_id) : undefined)
      : undefined;

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
      providerOrderId: intent.provider_order_id,
      captureId: captureTx?.provider_reference_id || null,
      reconciliationReason: intent.reconciliation_reason,
      webhookStatus: whInfo?.status || null,
      webhookEventId: whInfo?.eventId || null,
      hasExpiredLease: hasExpiredCreationLease || hasExpiredCaptureLease,
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
  };

  return {
    rows,
    summary,
    isOwner: userIsOwnerOfAny,
  };
}
