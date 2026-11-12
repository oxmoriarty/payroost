import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { hashPortalToken } from "@/lib/security/tokens";
import { authenticatePortalSession } from "@/lib/security/portal-session";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Brand, PublicBrandHeader } from "@/components/brand";
import { type AgreementContentLike } from "@/features/agreements/agreement-document-view";
import { extractMilestoneNotes } from "@/features/milestones/activity-notes";
import { syncApprovedAgreementMilestones } from "@/features/milestones/sync";
import { getPortalProjectHistory } from "@/features/history/service";
import type { ProjectHistoryPageResult } from "@/features/history/types";
import { listPortalNotifications } from "@/features/notifications/service";
import type { NotificationPageResult } from "@/features/notifications/types";
import { ClientPortalEntryView } from "@/features/portal/client-portal-entry-view";
import { ClientPortalWorkspaceView } from "@/features/portal/client-portal-workspace-view";
import type {
  PortalActivityItem,
  PortalAgreementVersionSummary,
  PortalMilestone,
  PortalPaymentReturnContext,
  PortalProjectData,
} from "@/features/portal/types";
import type { ChangeRequest } from "@/features/projects/types";

const RETURN_INTENT_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETURN_ORDER_TOKEN_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export default async function ClientPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : {};

  const rawPaymentIntentId =
    typeof resolvedSearchParams.payment_intent_id === "string"
      ? resolvedSearchParams.payment_intent_id.trim()
      : "";
  const rawPaymentStatus =
    typeof resolvedSearchParams.payment_status === "string"
      ? resolvedSearchParams.payment_status.trim().toLowerCase()
      : "";
  const rawOrderToken =
    typeof resolvedSearchParams.token === "string"
      ? resolvedSearchParams.token.trim()
      : "";

  const initialPaymentReturn: PortalPaymentReturnContext | undefined =
    RETURN_INTENT_UUID_REGEX.test(rawPaymentIntentId) &&
    (rawPaymentStatus === "approved" || rawPaymentStatus === "cancelled")
      ? {
          paymentIntentId: rawPaymentIntentId,
          paymentStatus: rawPaymentStatus,
          orderToken: RETURN_ORDER_TOKEN_REGEX.test(rawOrderToken) ? rawOrderToken : null,
        }
      : undefined;

  // 1. Basic token validation
  if (!token || token.length < 20 || token.length > 128) {
    return renderUnavailablePortal("Invalid link format");
  }

  const tokenHash = hashPortalToken(token);
  const supabase = await createClient();

  // 2. Validate portal invitation via read-only SECURITY DEFINER RPC
  const { data: invitationData, error: invitationError } = await supabase.rpc(
    "validate_portal_invitation",
    {
      p_token_hash: tokenHash,
    }
  );

  if (invitationError || !invitationData || typeof invitationData !== "object" || !("valid" in invitationData)) {
    return renderUnavailablePortal(
      "This client portal link is invalid, has expired, or has been revoked. Please contact the project manager if you require a new link."
    );
  }

  const invitation = invitationData as {
    valid: boolean;
    projectTitle: string;
    expiresAt: string;
  };

  // 3. Resolve the invitation's project_id from authoritative client_portal_tokens
  const serviceClient = createServiceClient();

  const { data: portalToken, error: tokenError } = await serviceClient
    .from("client_portal_tokens")
    .select("project_id, expires_at, revoked_at, consumed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (
    tokenError ||
    !portalToken ||
    portalToken.revoked_at !== null ||
    portalToken.consumed_at !== null ||
    new Date(portalToken.expires_at) <= new Date()
  ) {
    return renderUnavailablePortal(
      "This client portal link is invalid, has expired, or has been revoked. Please contact the project manager if you require a new link."
    );
  }

  const boundProjectId = portalToken.project_id;

  // 4. Authenticate portal session strictly bound to this invitation's project ID
  const authResult = await authenticatePortalSession({
    expectedProjectId: boundProjectId,
    supabaseClient: serviceClient,
  });

  // 5. If not authenticated or session belongs to another project, render OTP Verification entry view
  if (!authResult.success) {
    return (
      <div className="min-h-screen bg-slate-50">
        <PublicBrandHeader subtitle="Verified Client Portal" />
        <ClientPortalEntryView
          token={token}
          projectTitle={invitation.projectTitle}
          expiresAt={invitation.expiresAt}
        />
      </div>
    );
  }

  // 6. Query authoritative project strictly for boundProjectId
  const { data: project, error: projectError } = await serviceClient
    .from("projects")
    .select(`
      id,
      title,
      client_name,
      client_email,
      brief,
      currency,
      total_amount_minor,
      status,
      start_date,
      target_end_date
    `)
    .eq("id", boundProjectId)
    .maybeSingle();

  if (projectError || !project || project.client_email !== authResult.clientEmail) {
    return renderUnavailablePortal("Project data could not be retrieved.");
  }

  // 7. Query agreement and all agreement versions for boundProjectId
  const { data: agreement, error: agreementError } = await serviceClient
    .from("agreements")
    .select("id, status, current_version_id")
    .eq("project_id", boundProjectId)
    .maybeSingle();

  if (agreementError) {
    return renderUnavailablePortal("Agreement data could not be retrieved.");
  }

  let agreementStatus = agreement?.status || "DRAFT";
  let agreementVersionNumber = 1;
  let agreementVersionId: string | null = agreement?.current_version_id ?? null;
  let scopeBaselineVersionId: string | null = agreement?.current_version_id ?? null;
  let scopeBaselineVersionNumber: number | null = null;
  let scopeBaselineStatus: string | null = agreement?.status ?? null;
  let isAgreementApproved = false;
  let agreementContent: AgreementContentLike | null = null;
  let agreementApprovedAt: string | null = null;
  let agreementVersionHistory: PortalAgreementVersionSummary[] = [];

  if (agreement?.id) {
    const { data: allVersions, error: versionsError } = await serviceClient
      .from("agreement_versions")
      .select("id, version_number, status, content, created_at, approved_at")
      .eq("agreement_id", agreement.id)
      .order("version_number", { ascending: false });

    if (versionsError) {
      return renderUnavailablePortal("Agreement version data could not be retrieved.");
    }

    const typedVersions = (allVersions ?? []) as Array<{
      id: string;
      version_number: number;
      status: string;
      content: AgreementContentLike | null;
      created_at: string;
      approved_at: string | null;
    }>;

    agreementVersionHistory = typedVersions.map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      status: v.status,
      createdAt: v.created_at,
      approvedAt: v.approved_at,
      content: v.content ?? null,
    }));

    const currentVersion =
      typedVersions.find((v) => v.id === agreement.current_version_id) ?? typedVersions[0] ?? null;
    const latestApprovedVersion = typedVersions.find((v) => v.status === "APPROVED") ?? null;

    if (currentVersion) {
      agreementVersionId = currentVersion.id;
      agreementVersionNumber = currentVersion.version_number;
      agreementStatus = currentVersion.status;
      agreementContent = currentVersion.content ?? null;
      agreementApprovedAt = currentVersion.approved_at;
    }

    const activeBaseline = latestApprovedVersion ?? currentVersion;
    if (activeBaseline) {
      scopeBaselineVersionId = activeBaseline.id;
      scopeBaselineVersionNumber = activeBaseline.version_number;
      scopeBaselineStatus = activeBaseline.status;
      if (latestApprovedVersion) {
        isAgreementApproved = true;
        agreementStatus = "APPROVED";
        agreementContent = latestApprovedVersion.content ?? agreementContent;
        agreementApprovedAt = latestApprovedVersion.approved_at ?? agreementApprovedAt;
      }
    }
  }

  // Catch-up idempotent sync so approved agreements always materialize agreed milestones
  if (isAgreementApproved) {
    try {
      await syncApprovedAgreementMilestones({
        supabase: serviceClient,
        projectId: boundProjectId,
        actorLabel: "System catch-up",
      });
    } catch {
      // Non-fatal fallback; portal continues rendering current database milestones
    }
  }

  // 8. Query milestones, sanitized activity history, and client portal notifications for boundProjectId
  const [
    { data: rawMilestones, error: milestonesError },
    { data: rawActivities },
    portalHistoryResult,
    portalNotificationsResult,
  ] = await Promise.all([
    serviceClient
      .from("milestones")
      .select(`
        id,
        title,
        description,
        deliverables,
        acceptance_criteria,
        amount_minor,
        currency,
        due_date,
        sort_order,
        status,
        agreement_version_id
      `)
      .eq("project_id", boundProjectId)
      .order("sort_order", { ascending: true }),
    serviceClient
      .from("activity_events")
      .select("id, actor_label, event_type, summary, metadata, created_at")
      .eq("project_id", boundProjectId)
      .order("created_at", { ascending: false })
      .limit(30),
    getPortalProjectHistory({
      projectId: boundProjectId,
      page: 1,
      pageSize: 20,
      serviceClient,
    }).catch(() => null),
    listPortalNotifications({
      projectId: boundProjectId,
      clientEmail: authResult.clientEmail || project.client_email,
      page: 1,
      pageSize: 10,
      serviceClient,
    }).catch(() => null),
  ]);

  if (milestonesError) {
    return renderUnavailablePortal("Milestone data could not be retrieved.");
  }

  const typedActivities = ((rawActivities ?? []) as Array<{
    id: string;
    actor_label: string;
    event_type: string;
    summary: string;
    metadata?: Record<string, unknown> | null;
    created_at: string;
  }>);

  const milestoneNotes = extractMilestoneNotes(typedActivities);

  const portalHistory: ProjectHistoryPageResult = portalHistoryResult ?? {
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
  };

  const portalNotifications: NotificationPageResult | undefined =
    portalNotificationsResult ?? undefined;

  const portalActivities: PortalActivityItem[] = portalHistory.items.map((item) => ({
    id: item.id,
    actorLabel: item.actorLabel,
    eventType: item.eventType,
    summary: item.summary,
    createdAt: item.createdAt,
  }));

  const milestoneList = (rawMilestones || []) as Array<{
    id: string;
    title: string;
    description: string;
    deliverables: string[];
    acceptance_criteria: string[];
    amount_minor: number;
    currency: string;
    due_date: string | null;
    sort_order: number;
    status: string;
    agreement_version_id: string;
  }>;

  // 9. Query payment intents for milestones
  const milestoneIds = milestoneList.map((m) => m.id);
  const paymentIntentMap = new Map<
    string,
    { id: string; status: string; providerOrderId: string | null }
  >();
  let allProjectIntentIds: string[] = [];

  if (milestoneIds.length > 0) {
    const { data: intents, error: intentsError } = await serviceClient
      .from("payment_intents")
      .select("id, milestone_id, status, provider_order_id, created_at")
      .in("milestone_id", milestoneIds)
      .eq("project_id", boundProjectId)
      .order("created_at", { ascending: false });

    if (intentsError) {
      return renderUnavailablePortal("Payment records could not be retrieved.");
    }

    if (intents) {
      allProjectIntentIds = intents.map((i) => i.id);
      for (const intent of intents) {
        if (!paymentIntentMap.has(intent.milestone_id)) {
          paymentIntentMap.set(intent.milestone_id, {
            id: intent.id,
            status: intent.status,
            providerOrderId: intent.provider_order_id,
          });
        }
      }
    }
  }

  // 10. Query completed captures strictly scoped to current project's payment intents
  const captureMap = new Map<string, string>(); // milestoneId -> captureId
  if (allProjectIntentIds.length > 0) {
    const { data: transactions, error: txError } = await serviceClient
      .from("payment_transactions")
      .select("payment_intent_id, provider_reference_id, status")
      .in("payment_intent_id", allProjectIntentIds)
      .eq("status", "COMPLETED")
      .eq("transaction_type", "CAPTURE");

    if (txError) {
      return renderUnavailablePortal("Unable to verify payment records. Please try again later.");
    }

    if (transactions) {
      // Map intentId -> milestoneId for all project intents
      const intentToMilestoneMap = new Map<string, string>();
      for (const [mId, pi] of paymentIntentMap.entries()) {
        intentToMilestoneMap.set(pi.id, mId);
      }
      for (const tx of transactions) {
        const mId = intentToMilestoneMap.get(tx.payment_intent_id);
        if (mId) {
          captureMap.set(mId, tx.provider_reference_id);
        }
      }
    }
  }

  // Active in-flight payment statuses that are reusable for checkout
  const REUSABLE_ACTIVE_INTENT_STATUSES = [
    "ORDER_CREATING",
    "ORDER_CREATED",
    "BUYER_APPROVED",
  ];

  // Active in-flight capture or reconciliation statuses that require verification lock
  const IN_FLIGHT_VERIFICATION_STATUSES = [
    "CAPTURING",
    "RECONCILING",
    "RECONCILIATION_REQUIRED",
  ];

  // 11. Transform milestones with authoritative server-side payment eligibility
  const portalMilestones: PortalMilestone[] = milestoneList.map((m) => {
    const intent = paymentIntentMap.get(m.id);
    const completedCaptureId = captureMap.get(m.id);

    let paymentStatus: PortalMilestone["paymentStatus"] = "UNPAID";
    let reusableIntentId: string | null = null;
    let reusableOrderId: string | null = null;

    if (intent?.status === "COMPLETED" || completedCaptureId) {
      paymentStatus = "PAID";
      reusableIntentId = intent?.id || null;
      reusableOrderId = intent?.providerOrderId || null;
    } else if (intent?.status && IN_FLIGHT_VERIFICATION_STATUSES.includes(intent.status)) {
      paymentStatus = "PENDING_VERIFICATION";
      reusableIntentId = intent.id;
      reusableOrderId = intent.providerOrderId;
    } else if (intent?.status && REUSABLE_ACTIVE_INTENT_STATUSES.includes(intent.status)) {
      paymentStatus = "IN_PROGRESS";
      reusableIntentId = intent.id;
      reusableOrderId = intent.providerOrderId;
    } else {
      // Intent was FAILED or CANCELLED or never initiated:
      // Leave reusableIntentId = null and reusableOrderId = null to allow safe fresh retry!
      paymentStatus = "UNPAID";
      reusableIntentId = null;
      reusableOrderId = null;
    }

    // Backend eligibility rules (mirrors create_payment_intent invariants):
    // 1. Milestone status must be APPROVED, IN_PROGRESS, or SUBMITTED
    // 2. Currency must be USD
    // 3. Amount must be positive
    // 4. Agreement version must be APPROVED
    // 5. Must not already be completed or undergoing verification (CAPTURING, RECONCILING, RECONCILIATION_REQUIRED)
    const isPayable =
      ["APPROVED", "IN_PROGRESS", "SUBMITTED"].includes(m.status) &&
      m.currency === "USD" &&
      m.amount_minor > 0 &&
      isAgreementApproved &&
      paymentStatus !== "PAID" &&
      paymentStatus !== "PENDING_VERIFICATION";

    const notes = milestoneNotes[m.id];

    return {
      id: m.id,
      title: m.title,
      description: m.description,
      deliverables: m.deliverables || [],
      acceptanceCriteria: m.acceptance_criteria || [],
      amountMinor: m.amount_minor,
      currency: m.currency,
      dueDate: m.due_date,
      sortOrder: m.sort_order,
      status: m.status,
      isPayable,
      paymentStatus,
      paymentIntentId: reusableIntentId,
      providerOrderId: reusableOrderId,
      completedCaptureId: completedCaptureId || null,
      latestSubmissionNote: notes?.latestSubmissionNote ?? null,
      latestDeliverableUrl: notes?.latestDeliverableUrl ?? null,
      latestFeedbackNote: notes?.latestFeedbackNote ?? null,
    };
  });

  const { data: rawChangeRequests } = await serviceClient
    .from("change_requests")
    .select("*")
    .eq("project_id", boundProjectId)
    .order("created_at", { ascending: false });

  const portalChangeRequests: ChangeRequest[] = ((rawChangeRequests ?? []) as Array<
    Record<string, unknown>
  >).map((row) => ({
    id: String(row.id),
    project_id: typeof row.project_id === "string" ? row.project_id : undefined,
    agreement_version_id:
      typeof row.agreement_version_id === "string" ? row.agreement_version_id : undefined,
    request_text: typeof row.request_text === "string" ? row.request_text : "",
    submitted_by_label:
      typeof row.submitted_by_label === "string" ? row.submitted_by_label : "Client",
    status: typeof row.status === "string" ? row.status : "OPEN",
    created_at: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
    resolved_at: typeof row.resolved_at === "string" ? row.resolved_at : null,
    ai_analysis: row.ai_analysis ?? null,
    ai_analyzed_at: typeof row.ai_analyzed_at === "string" ? row.ai_analyzed_at : null,
    ai_model: typeof row.ai_model === "string" ? row.ai_model : null,
  }));

  const projectData: PortalProjectData = {
    id: project.id,
    title: project.title,
    clientName: project.client_name,
    clientEmail: project.client_email,
    brief: project.brief,
    currency: project.currency,
    totalAmountMinor: project.total_amount_minor,
    projectStatus: project.status,
    startDate: (project as { start_date?: string | null }).start_date ?? null,
    targetEndDate: (project as { target_end_date?: string | null }).target_end_date ?? null,
    agreementStatus,
    agreementVersionId: scopeBaselineVersionId ?? agreementVersionId,
    agreementVersionNumber,
    scopeBaselineVersionNumber: scopeBaselineVersionNumber ?? agreementVersionNumber,
    scopeBaselineStatus: scopeBaselineStatus ?? agreementStatus,
    agreementContent,
    agreementApprovedAt,
    agreementVersionHistory,
    canUseAi: Boolean(process.env.GEMINI_API_KEY),
    changeRequests: portalChangeRequests,
    activities: portalActivities,
    history: portalHistory,
    notifications: portalNotifications,
    milestones: portalMilestones,
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <PublicBrandHeader subtitle="Verified Client Portal" />
      <div className="pr-page-enter">
        <ClientPortalWorkspaceView
          token={token}
          projectData={projectData}
          csrfToken={authResult.csrfSecret}
          initialPaymentReturn={initialPaymentReturn}
        />
      </div>
    </div>
  );
}

function renderUnavailablePortal(message: string) {
  return (
    <div className="pr-page-enter flex min-h-screen flex-col items-center justify-center bg-slate-50 p-4">
      <Link className="mb-6 inline-flex items-center" href="/">
        <Brand size="sm" />
      </Link>
      <Card className="pr-interactive-card w-full max-w-md p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-600">
          <AlertCircle className="h-7 w-7" />
        </div>
        <h1 className="mt-5 font-display text-2xl font-bold text-ink-950">Portal Unavailable</h1>
        <p className="mt-3 text-sm text-ink-600 leading-relaxed">{message}</p>
        <div className="mt-6">
          <Link href="/">
            <Button variant="secondary" className="w-full">
              Return to Payroost
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
