import type { ActivityEvent } from "@/features/projects/types";
import { sanitizeNotificationText } from "@/features/notifications/mapper";
import type {
  ProjectHistoryActorKind,
  ProjectHistoryAudience,
  ProjectHistoryCategory,
  ProjectHistoryEntityRef,
  ProjectHistoryItem,
} from "./types";

const CLIENT_HIDDEN_EVENTS = new Set<string>([
  "agreement.edited",
  "client_email.verification_resent",
  "milestone.plan_synced",
  "payment.capture_initiated",
  "payment.clear_expired_lease",
  "payment.expired_lease_cleared",
  "payment.webhook_reprocessed",
  "payment.operator_reconcile",
  "payment.retry_order_creation",
  "payment.marked_reconciliation_required",
  "payment.capture_reconciliation_required",
  "payment.reconciliation_resolved_without_payment",
  "payment.reconciliation_cancelled",
  "payment.order_recovered",
]);

function readMetaStr(
  metadata: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  for (const key of keys) {
    const val = metadata[key];
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
    if (typeof val === "number" && Number.isFinite(val)) return String(val);
  }
  return null;
}

function classifyCategory(eventType: string): ProjectHistoryCategory {
  if (eventType.startsWith("agreement.")) return "AGREEMENT";
  if (eventType.startsWith("milestone.")) return "MILESTONE";
  if (eventType.startsWith("change_request.")) return "SCOPE_CHANGE";
  if (
    eventType.includes("reconcil") ||
    eventType.includes("lease") ||
    eventType.includes("recovered") ||
    eventType.includes("webhook_reprocessed")
  ) {
    return "RECONCILIATION";
  }
  if (eventType.startsWith("payment.")) return "PAYMENT";
  return "PROJECT";
}

function deriveAiAttribution(
  eventType: string,
  metadata: Record<string, unknown>,
): { isAiAssisted: boolean; aiAttributionLabel: "AI-assisted" | "Manual" | null } {
  const source = (readMetaStr(metadata, "source") ?? "").toUpperCase();
  if (source === "AI_ASSISTED" || metadata.hasAiAnalysis === true) {
    return { isAiAssisted: true, aiAttributionLabel: "AI-assisted" };
  }
  if (
    eventType === "agreement.edited" ||
    eventType === "agreement.version_created" ||
    eventType === "milestone.plan_applied" ||
    eventType === "change_request.submitted"
  ) {
    return { isAiAssisted: false, aiAttributionLabel: "Manual" };
  }
  return { isAiAssisted: false, aiAttributionLabel: null };
}

function deriveActorKind(
  actorLabel: string,
  isAiAssisted: boolean,
  audience: ProjectHistoryAudience,
): { actorKind: ProjectHistoryActorKind; cleanActorLabel: string } {
  const normalized = actorLabel.trim();
  const lower = normalized.toLowerCase();

  if (lower.startsWith("operator")) {
    return {
      actorKind: "OPERATOR",
      cleanActorLabel: audience === "client" ? "System Support" : sanitizeNotificationText(normalized, 100, "Operator"),
    };
  }
  if (lower.includes("client") || lower.includes("otp")) {
    return {
      actorKind: "CLIENT",
      cleanActorLabel: audience === "client" ? "Client" : sanitizeNotificationText(normalized, 100, "Client"),
    };
  }
  if (lower.includes("freelancer")) {
    return {
      actorKind: "FREELANCER",
      cleanActorLabel: audience === "client" ? "Freelancer" : sanitizeNotificationText(normalized, 100, "Freelancer"),
    };
  }
  if (isAiAssisted) {
    return {
      actorKind: "AI_ASSISTED",
      cleanActorLabel: sanitizeNotificationText(normalized, 100, "AI-assisted"),
    };
  }
  if (lower.includes("system") || lower.includes("paypal")) {
    return {
      actorKind: "SYSTEM",
      cleanActorLabel: sanitizeNotificationText(normalized, 100, "System"),
    };
  }
  return {
    actorKind: "FREELANCER",
    cleanActorLabel: audience === "client" ? "Freelancer" : sanitizeNotificationText(normalized, 100, "Participant"),
  };
}

function buildTitleAndDiscipline(
  eventType: string,
  rawSummary: string,
  audience: ProjectHistoryAudience,
  metadata: Record<string, unknown>,
): {
  title: string;
  summary: string;
  stateDisciplineBadge: string | null;
} {
  const milestoneTitle = readMetaStr(metadata, "milestoneTitle");
  const versionNumber = readMetaStr(metadata, "versionNumber", "agreementVersionNumber");

  switch (eventType) {
    case "project.created":
      return {
        title: "Project created",
        summary: sanitizeNotificationText(rawSummary, 300, "Project created"),
        stateDisciplineBadge: null,
      };
    case "client_email.verified":
      return {
        title: "Client email verified",
        summary: audience === "client" ? "Client email verification confirmed." : sanitizeNotificationText(rawSummary, 300, "Client email verified"),
        stateDisciplineBadge: null,
      };
    case "client_email.changed":
      return {
        title: "Client email updated",
        summary: audience === "client" ? "Client contact email updated; re-verification required." : sanitizeNotificationText(rawSummary, 300, "Client email updated"),
        stateDisciplineBadge: null,
      };
    case "client_email.verification_resent":
      return {
        title: "Client verification email resent",
        summary: sanitizeNotificationText(rawSummary, 300, "Resent client verification link"),
        stateDisciplineBadge: null,
      };
    case "portal.invited":
      return {
        title: "Client portal invitation sent",
        summary: "Client workspace access link sent via verified email.",
        stateDisciplineBadge: null,
      };
    case "agreement.edited":
      return {
        title: "Agreement draft updated",
        summary: sanitizeNotificationText(rawSummary, 300, "Updated draft agreement"),
        stateDisciplineBadge: null,
      };
    case "agreement.version_created":
      return {
        title: versionNumber ? `Agreement v${versionNumber} drafted` : "Agreement version drafted",
        summary: sanitizeNotificationText(rawSummary, 300, "Created agreement version"),
        stateDisciplineBadge: "Draft Version",
      };
    case "agreement.sent":
      return {
        title: "Agreement sent for client approval",
        summary: sanitizeNotificationText(rawSummary, 300, "Sent agreement for OTP review"),
        stateDisciplineBadge: "Awaiting Approval",
      };
    case "agreement.approved":
      return {
        title: "Agreement approved",
        summary: sanitizeNotificationText(rawSummary, 300, "Client approved agreement"),
        stateDisciplineBadge: "Formally Agreed",
      };
    case "agreement.changes_requested":
      return {
        title: "Agreement revision requested",
        summary: sanitizeNotificationText(rawSummary, 300, "Client requested agreement revisions"),
        stateDisciplineBadge: "Changes Requested",
      };
    case "milestone.created":
    case "milestone.updated":
      return {
        title: eventType === "milestone.created" ? "Milestone added" : "Milestone updated",
        summary: sanitizeNotificationText(rawSummary, 300, "Milestone updated"),
        stateDisciplineBadge: null,
      };
    case "milestone.plan_applied":
      return {
        title: "Milestone schedule applied to draft",
        summary: sanitizeNotificationText(rawSummary, 300, "Applied milestone schedule"),
        stateDisciplineBadge: "Draft Plan",
      };
    case "milestone.plan_synced":
      return {
        title: "Approved agreement milestones synced",
        summary: sanitizeNotificationText(rawSummary, 300, "Synced approved milestones"),
        stateDisciplineBadge: "Agreed Scope",
      };
    case "milestone.started":
      return {
        title: milestoneTitle ? `Started work on "${milestoneTitle}"` : "Milestone work started",
        summary: sanitizeNotificationText(rawSummary, 300, "Started milestone work"),
        stateDisciplineBadge: "Work In Progress",
      };
    case "milestone.submitted":
      return {
        title: milestoneTitle ? `Deliverables submitted: ${milestoneTitle}` : "Milestone deliverables submitted",
        summary: sanitizeNotificationText(rawSummary, 300, "Submitted milestone deliverables"),
        stateDisciplineBadge: "Submitted (Not Accepted)",
      };
    case "milestone.accepted":
      return {
        title: milestoneTitle ? `Deliverables accepted: ${milestoneTitle}` : "Milestone deliverables accepted",
        summary: sanitizeNotificationText(rawSummary, 300, "Accepted milestone deliverables"),
        stateDisciplineBadge: "Deliverables Accepted (Payment Separate)",
      };
    case "milestone.revision_requested":
      return {
        title: milestoneTitle ? `Revisions requested: ${milestoneTitle}` : "Milestone revision requested",
        summary: sanitizeNotificationText(rawSummary, 300, "Requested deliverable revisions"),
        stateDisciplineBadge: "Revision Requested",
      };
    case "change_request.submitted":
      return {
        title: "Scope-change request submitted",
        summary: sanitizeNotificationText(rawSummary, 300, "Submitted scope-change request"),
        stateDisciplineBadge: "Proposal Only",
      };
    case "change_request.analysis_updated":
    case "change_request.analysis_stale":
      return {
        title:
          eventType === "change_request.analysis_stale"
            ? "Scope-change AI analysis marked stale"
            : "Scope-change AI analysis updated",
        summary: sanitizeNotificationText(rawSummary, 300, "Scope-change analysis status changed"),
        stateDisciplineBadge: "AI Analysis",
      };
    case "change_request.resolved":
      return {
        title: "Scope-change request resolved",
        summary: sanitizeNotificationText(rawSummary, 300, "Scope-change request resolved"),
        stateDisciplineBadge: "Resolved",
      };
    case "change_request.withdrawn":
      return {
        title: "Scope-change request withdrawn",
        summary: sanitizeNotificationText(rawSummary, 300, "Scope-change request withdrawn"),
        stateDisciplineBadge: "Withdrawn",
      };
    case "payment.webhook_order_approved":
      return {
        title: "PayPal buyer order approved",
        summary:
          audience === "client"
            ? "PayPal webhook confirmed buyer approval for this checkout order. Capture confirmation is still separate."
            : sanitizeNotificationText(rawSummary, 300, "PayPal buyer order approved via webhook"),
        stateDisciplineBadge: "Order Approved (Not Captured)",
      };
    case "payment.order_captured":
    case "payment.reconciliation_completed":
      return {
        title: "PayPal payment captured (Provider Confirmed)",
        summary:
          audience === "client"
            ? "PayPal confirmed milestone payment capture. Deliverable acceptance remains independent."
            : sanitizeNotificationText(rawSummary, 300, "PayPal capture verified"),
        stateDisciplineBadge: "Payment Confirmed (Work Acceptance Separate)",
      };
    case "payment.capture_pending":
    case "payment.webhook_capture_pending":
      return {
        title: "PayPal payment capture pending",
        summary:
          audience === "client"
            ? "PayPal capture is pending settlement verification and is not marked Paid yet."
            : sanitizeNotificationText(rawSummary, 300, "PayPal capture pending verification"),
        stateDisciplineBadge: "Capture Pending",
      };
    case "payment.capture_failed":
    case "payment.webhook_capture_denied":
    case "payment.reconciliation_failed":
      return {
        title: "PayPal payment capture failed",
        summary:
          audience === "client"
            ? "PayPal payment attempt failed or was declined."
            : sanitizeNotificationText(rawSummary, 300, "PayPal payment capture failed"),
        stateDisciplineBadge: "Capture Failed",
      };
    case "payment.marked_reconciliation_required":
    case "payment.capture_reconciliation_required":
    case "payment.reconciliation_resolved_without_payment":
    case "payment.reconciliation_cancelled":
    case "payment.order_recovered":
      return {
        title: "Payment reconciliation & recovery update",
        summary: sanitizeNotificationText(rawSummary, 300, "Payment reconciliation recorded"),
        stateDisciplineBadge: "Reconciliation",
      };
    default:
      return {
        title: sanitizeNotificationText(eventType.replaceAll(".", " · "), 120, "Project event"),
        summary: sanitizeNotificationText(rawSummary, 300, "Project event recorded"),
        stateDisciplineBadge: null,
      };
  }
}

function buildEntityRef(
  projectId: string,
  eventType: string,
  audience: ProjectHistoryAudience,
  metadata: Record<string, unknown>,
): ProjectHistoryEntityRef | null {
  const versionNumber = readMetaStr(metadata, "versionNumber", "agreementVersionNumber");
  const versionId = readMetaStr(metadata, "agreementVersionId");
  const milestoneTitle = readMetaStr(metadata, "milestoneTitle");
  const milestoneId = readMetaStr(metadata, "milestoneId");
  const changeRequestId = readMetaStr(metadata, "changeRequestId");
  const paymentIntentId = readMetaStr(metadata, "paymentIntentId", "intentId");

  const sectionBase = audience === "freelancer" ? `/app/projects/${projectId}` : "";

  if (eventType.startsWith("agreement.") || versionId) {
    if (eventType.startsWith("change_request.")) {
      return {
        kind: "CHANGE_REQUEST",
        label: versionNumber ? `Scope Change (v${versionNumber})` : "Scope Change",
        href: `${sectionBase}#scope-changes`,
      };
    }
    return {
      kind: "AGREEMENT_VERSION",
      label: versionNumber ? `Agreement v${versionNumber}` : "Agreement",
      href: `${sectionBase}#agreement`,
    };
  }

  if (eventType.startsWith("change_request.") || changeRequestId) {
    return {
      kind: "CHANGE_REQUEST",
      label: "Scope Change Request",
      href: `${sectionBase}#scope-changes`,
    };
  }

  if (eventType.startsWith("payment.")) {
    if (audience === "freelancer" && eventType.includes("reconcil")) {
      return {
        kind: "PAYMENT_INTENT",
        label: paymentIntentId ? `Payment ${paymentIntentId.slice(0, 8)}` : "Payment Operations",
        href: "/app/payments",
      };
    }
    return {
      kind: "MILESTONE",
      label: milestoneTitle ?? "Milestone Payment",
      href: `${sectionBase}#milestones`,
    };
  }

  if (eventType.startsWith("milestone.") || milestoneId) {
    return {
      kind: "MILESTONE",
      label: milestoneTitle ?? "Milestone",
      href: `${sectionBase}#milestones`,
    };
  }

  return null;
}

/**
 * Converts raw activity_events rows into consistent, audience-safe ProjectHistoryItem DTOs.
 */
export function mapActivityEventsToHistoryItems(
  activities: Array<Pick<ActivityEvent, "id" | "project_id" | "actor_label" | "event_type" | "summary" | "metadata" | "created_at">>,
  audience: ProjectHistoryAudience,
): ProjectHistoryItem[] {
  const result: ProjectHistoryItem[] = [];

  for (const activity of activities) {
    if (audience === "client" && CLIENT_HIDDEN_EVENTS.has(activity.event_type)) {
      continue;
    }

    const metadata = (activity.metadata ?? {}) as Record<string, unknown>;
    const category = classifyCategory(activity.event_type);
    const { isAiAssisted, aiAttributionLabel } = deriveAiAttribution(activity.event_type, metadata);
    const { actorKind, cleanActorLabel } = deriveActorKind(
      activity.actor_label,
      isAiAssisted,
      audience,
    );
    const { title, summary, stateDisciplineBadge } = buildTitleAndDiscipline(
      activity.event_type,
      activity.summary,
      audience,
      metadata,
    );
    const entityRef = buildEntityRef(activity.project_id, activity.event_type, audience, metadata);

    result.push({
      id: activity.id,
      projectId: activity.project_id,
      eventType: activity.event_type,
      category,
      title,
      summary,
      actorLabel: cleanActorLabel,
      actorKind,
      isAiAssisted,
      aiAttributionLabel,
      stateDisciplineBadge,
      entityRef,
      createdAt: activity.created_at,
    });
  }

  return result;
}
