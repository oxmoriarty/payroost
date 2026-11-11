import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { hashPortalToken } from "@/lib/security/tokens";
import { authenticatePortalSession } from "@/lib/security/portal-session";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ClientPortalEntryView } from "@/features/portal/client-portal-entry-view";
import { ClientPortalWorkspaceView } from "@/features/portal/client-portal-workspace-view";
import type {
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
      status
    `)
    .eq("id", boundProjectId)
    .maybeSingle();

  if (projectError || !project || project.client_email !== authResult.clientEmail) {
    return renderUnavailablePortal("Project data could not be retrieved.");
  }

  // 7. Query agreement and agreement version for boundProjectId
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

  if (agreement?.current_version_id) {
    const { data: version, error: versionError } = await serviceClient
      .from("agreement_versions")
      .select("id, version_number, status")
      .eq("id", agreement.current_version_id)
      .maybeSingle();

    if (versionError) {
      return renderUnavailablePortal("Agreement version data could not be retrieved.");
    }

    if (version) {
      agreementVersionId = version.id;
      scopeBaselineVersionId = version.id;
      scopeBaselineVersionNumber = version.version_number;
      scopeBaselineStatus = version.status;
      agreementVersionNumber = version.version_number;
      isAgreementApproved = version.status === "APPROVED";
      if (isAgreementApproved) {
        agreementStatus = "APPROVED";
      }
    }
  }

  // Prefer the newest APPROVED version for scope-change baseline if current_version_id points to a newer draft
  if (agreement?.id && !isAgreementApproved) {
    const { data: approvedBaseline } = await serviceClient
      .from("agreement_versions")
      .select("id, version_number, status")
      .eq("agreement_id", agreement.id)
      .eq("status", "APPROVED")
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (approvedBaseline?.id) {
      scopeBaselineVersionId = approvedBaseline.id;
      scopeBaselineVersionNumber = approvedBaseline.version_number;
      scopeBaselineStatus = approvedBaseline.status;
    }
  }

  // 8. Query milestones for boundProjectId
  const { data: rawMilestones, error: milestonesError } = await serviceClient
    .from("milestones")
    .select(`
      id,
      title,
      description,
      deliverables,
      amount_minor,
      currency,
      due_date,
      sort_order,
      status,
      agreement_version_id
    `)
    .eq("project_id", boundProjectId)
    .order("sort_order", { ascending: true });

  if (milestonesError) {
    return renderUnavailablePortal("Milestone data could not be retrieved.");
  }

  const milestoneList = (rawMilestones || []) as Array<{
    id: string;
    title: string;
    description: string;
    deliverables: string[];
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

    return {
      id: m.id,
      title: m.title,
      description: m.description,
      deliverables: m.deliverables || [],
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
    agreementStatus,
    agreementVersionId: scopeBaselineVersionId ?? agreementVersionId,
    agreementVersionNumber,
    scopeBaselineVersionNumber: scopeBaselineVersionNumber ?? agreementVersionNumber,
    scopeBaselineStatus: scopeBaselineStatus ?? agreementStatus,
    canUseAi: Boolean(process.env.GEMINI_API_KEY),
    changeRequests: portalChangeRequests,
    milestones: portalMilestones,
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientPortalWorkspaceView
        token={token}
        projectData={projectData}
        csrfToken={authResult.csrfSecret}
        initialPaymentReturn={initialPaymentReturn}
      />
    </div>
  );
}

function renderUnavailablePortal(message: string) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md p-8 text-center">
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
