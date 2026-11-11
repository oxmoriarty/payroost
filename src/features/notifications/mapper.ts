import type { ActivityEvent } from "@/features/projects/types";
import type { NotificationInsertDraft } from "./types";

export interface NotificationProjectContext {
  id: string;
  ownerId: string;
  title: string;
  clientName: string;
  clientEmail: string;
}

const IGNORED_INTERNAL_EVENTS = new Set<string>([
  "agreement.edited",
  "milestone.plan_synced",
  "payment.capture_initiated",
  "payment.clear_expired_lease",
  "payment.expired_lease_cleared",
  "payment.webhook_reprocessed",
  "payment.retry_order_creation",
  "payment.operator_reconcile",
]);

export function sanitizeNotificationText(input: unknown, maxLen: number, fallback: string): string {
  if (typeof input !== "string") return fallback;
  const cleaned = input.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 2) return fallback;
  return cleaned.slice(0, maxLen);
}

export function safeRelativeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  return trimmed.slice(0, 300);
}

function readMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  for (const key of keys) {
    const val = metadata[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
    if (typeof val === "number" && Number.isFinite(val)) {
      return String(val);
    }
  }
  return null;
}

function makeUserDraft(
  project: NotificationProjectContext,
  activity: Pick<ActivityEvent, "id" | "event_type" | "actor_label" | "created_at">,
  params: {
    idempotencyKey: string;
    category: NotificationInsertDraft["category"];
    severity: NotificationInsertDraft["severity"];
    title: string;
    body: string;
    actionRequired: boolean;
    actionLabel: string | null;
    actionHref: string | null;
    actorLabel?: string;
    metadata?: Record<string, unknown>;
  },
): NotificationInsertDraft {
  return {
    project_id: project.id,
    source_activity_event_id: activity.id,
    recipient_type: "USER",
    recipient_user_id: project.ownerId,
    recipient_client_email: null,
    idempotency_key: params.idempotencyKey.slice(0, 240),
    category: params.category,
    event_type: activity.event_type.slice(0, 100),
    severity: params.severity,
    title: sanitizeNotificationText(params.title, 160, "Project update"),
    body: sanitizeNotificationText(params.body, 500, "Project activity recorded."),
    action_required: params.actionRequired,
    action_label: params.actionLabel ? params.actionLabel.slice(0, 80) : null,
    action_href: safeRelativeHref(params.actionHref),
    actor_label: sanitizeNotificationText(params.actorLabel ?? activity.actor_label, 140, "System"),
    metadata: params.metadata ?? {},
    created_at: activity.created_at,
  };
}

function makeClientDraft(
  project: NotificationProjectContext,
  activity: Pick<ActivityEvent, "id" | "event_type" | "actor_label" | "created_at">,
  params: {
    idempotencyKey: string;
    category: NotificationInsertDraft["category"];
    severity: NotificationInsertDraft["severity"];
    title: string;
    body: string;
    actionRequired: boolean;
    actionLabel: string | null;
    actionHref: string | null;
    actorLabel?: string;
    metadata?: Record<string, unknown>;
  },
): NotificationInsertDraft | null {
  const email = project.clientEmail.trim().toLowerCase();
  if (email.length < 3 || email.length > 320) return null;

  return {
    project_id: project.id,
    source_activity_event_id: activity.id,
    recipient_type: "CLIENT_PORTAL",
    recipient_user_id: null,
    recipient_client_email: email,
    idempotency_key: params.idempotencyKey.slice(0, 240),
    category: params.category,
    event_type: activity.event_type.slice(0, 100),
    severity: params.severity,
    title: sanitizeNotificationText(params.title, 160, "Project update"),
    body: sanitizeNotificationText(params.body, 500, "Project activity recorded."),
    action_required: params.actionRequired,
    action_label: params.actionLabel ? params.actionLabel.slice(0, 80) : null,
    action_href: safeRelativeHref(params.actionHref),
    actor_label: sanitizeNotificationText(params.actorLabel ?? activity.actor_label, 140, "System"),
    metadata: params.metadata ?? {},
    created_at: activity.created_at,
  };
}

/**
 * Maps an authoritative activity_events row into deterministic, idempotent notification drafts.
 * Keeps client portal drafts free of raw tokens, seller merchant IDs, and internal reconciliation details,
 * and uses canonical idempotency keys across duplicate/webhook/reconciliation flows.
 */
export function mapActivityEventToNotificationDrafts(
  activity: Pick<ActivityEvent, "id" | "project_id" | "actor_label" | "event_type" | "summary" | "metadata" | "created_at">,
  project: NotificationProjectContext,
): NotificationInsertDraft[] {
  if (IGNORED_INTERNAL_EVENTS.has(activity.event_type)) {
    return [];
  }

  const meta = (activity.metadata ?? {}) as Record<string, unknown>;
  const intentId = readMetadataString(meta, "paymentIntentId", "intentId");
  const milestoneId = readMetadataString(meta, "milestoneId");
  const milestoneTitle = readMetadataString(meta, "milestoneTitle");
  const versionId = readMetadataString(meta, "agreementVersionId");
  const versionNumber = readMetadataString(meta, "versionNumber", "agreementVersionNumber");
  const changeRequestId = readMetadataString(meta, "changeRequestId");
  const requesterRole = (readMetadataString(meta, "requesterRole") ?? "").toUpperCase();
  const projectHref = `/app/projects/${project.id}`;
  const drafts: NotificationInsertDraft[] = [];

  const pushClient = (draft: NotificationInsertDraft | null) => {
    if (draft) drafts.push(draft);
  };

  switch (activity.event_type) {
    case "project.created":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `project.created:${project.id}`,
          category: "PROJECT",
          severity: "INFO",
          title: "Project created",
          body: `Created "${project.title}" and dispatched email verification to ${project.clientName}.`,
          actionRequired: false,
          actionLabel: "Open workspace",
          actionHref: projectHref,
          metadata: { projectTitle: project.title },
        }),
      );
      break;

    case "client_email.verified":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `client_email.verified:${activity.id}`,
          category: "PROJECT",
          severity: "SUCCESS",
          title: "Client email verified",
          body: `${project.clientName} verified their email on "${project.title}". You can now send agreements for review.`,
          actionRequired: true,
          actionLabel: "Prepare agreement",
          actionHref: `${projectHref}#agreement`,
          actorLabel: "Client",
          metadata: { projectTitle: project.title },
        }),
      );
      break;

    case "client_email.changed":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `client_email.changed:${activity.id}`,
          category: "PROJECT",
          severity: "WARNING",
          title: "Client email updated — re-verification required",
          body: `Client email changed on "${project.title}". Active review and portal links were invalidated.`,
          actionRequired: true,
          actionLabel: "Review project",
          actionHref: projectHref,
          metadata: { projectTitle: project.title },
        }),
      );
      break;

    case "client_email.verification_resent":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `client_email.verification_resent:${activity.id}`,
          category: "PROJECT",
          severity: "INFO",
          title: "Client verification resent",
          body: `Resent email verification prompt for "${project.title}".`,
          actionRequired: false,
          actionLabel: "Open project",
          actionHref: projectHref,
          metadata: { projectTitle: project.title },
        }),
      );
      break;

    case "portal.invited":
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `portal.invited:${activity.id}`,
          category: "PROJECT",
          severity: "INFO",
          title: "Client portal access ready",
          body: `You were invited to the verified workspace for "${project.title}".`,
          actionRequired: false,
          actionLabel: "View milestones",
          actionHref: "/portal#milestones",
          actorLabel: "Freelancer",
          metadata: { projectTitle: project.title },
        }),
      );
      break;

    case "agreement.version_created":
      if (meta.isRevision === true || Number(versionNumber) > 1) {
        drafts.push(
          makeUserDraft(project, activity, {
            idempotencyKey: `agreement.revision:${versionId ?? activity.id}`,
            category: "AGREEMENT",
            severity: "INFO",
            title: "New agreement draft revision created",
            body: `Agreement v${versionNumber ?? "next"} draft created on "${project.title}". Ready to edit and send.`,
            actionRequired: true,
            actionLabel: "Review draft",
            actionHref: `${projectHref}#agreement`,
            metadata: { agreementVersionId: versionId, versionNumber },
          }),
        );
      }
      break;

    case "agreement.sent":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `agreement.sent:${versionId ?? activity.id}`,
          category: "AGREEMENT",
          severity: "INFO",
          title: "Agreement sent for client review",
          body: `Sent agreement proposal for "${project.title}" to ${project.clientName} via OTP review.`,
          actionRequired: false,
          actionLabel: "View agreement",
          actionHref: `${projectHref}#agreement`,
          metadata: { agreementVersionId: versionId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `agreement.sent:${versionId ?? activity.id}`,
          category: "AGREEMENT",
          severity: "ACTION_REQUIRED",
          title: "Agreement proposal sent for your review",
          body: `The freelancer sent an agreement version on "${project.title}" for your review and OTP approval.`,
          actionRequired: true,
          actionLabel: "Inspect agreement",
          actionHref: "/portal#agreement",
          actorLabel: "Freelancer",
          metadata: { agreementVersionId: versionId },
        }),
      );
      break;

    case "agreement.approved":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `agreement.approved:${versionId ?? activity.id}`,
          category: "AGREEMENT",
          severity: "SUCCESS",
          title: "Agreement approved by client",
          body: `${project.clientName} approved the agreement on "${project.title}". Milestones are ready for delivery.`,
          actionRequired: true,
          actionLabel: "View milestones",
          actionHref: `${projectHref}#milestones`,
          actorLabel: "Client",
          metadata: { agreementVersionId: versionId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `agreement.approved:${versionId ?? activity.id}`,
          category: "AGREEMENT",
          severity: "SUCCESS",
          title: "Agreement approved",
          body: `Your OTP-verified approval for "${project.title}" is recorded.`,
          actionRequired: false,
          actionLabel: "View agreed terms",
          actionHref: "/portal#agreement",
          actorLabel: "Client",
          metadata: { agreementVersionId: versionId },
        }),
      );
      break;

    case "agreement.changes_requested":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `agreement.changes_requested:${versionId ?? activity.id}`,
          category: "AGREEMENT",
          severity: "ACTION_REQUIRED",
          title: "Agreement revision requested",
          body: `${project.clientName} requested changes on "${project.title}". Review feedback and create a new draft revision.`,
          actionRequired: true,
          actionLabel: "Create revision",
          actionHref: `${projectHref}#agreement`,
          actorLabel: "Client",
          metadata: { agreementVersionId: versionId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `agreement.changes_requested:${versionId ?? activity.id}`,
          category: "AGREEMENT",
          severity: "INFO",
          title: "Agreement revision feedback submitted",
          body: `Your change request feedback on "${project.title}" has been sent to the freelancer.`,
          actionRequired: false,
          actionLabel: "View agreement history",
          actionHref: "/portal#agreement",
          actorLabel: "Client",
          metadata: { agreementVersionId: versionId },
        }),
      );
      break;

    case "milestone.submitted":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `milestone.submitted:${activity.id}`,
          category: "MILESTONE",
          severity: "INFO",
          title: "Deliverables submitted for review",
          body: `Submitted "${milestoneTitle ?? "milestone"}" on "${project.title}" for client review.`,
          actionRequired: false,
          actionLabel: "View milestone",
          actionHref: `${projectHref}#milestones`,
          metadata: { milestoneId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `milestone.submitted:${activity.id}`,
          category: "MILESTONE",
          severity: "ACTION_REQUIRED",
          title: "Deliverables ready for your review",
          body: `Deliverables were submitted for "${milestoneTitle ?? "a milestone"}" on "${project.title}".`,
          actionRequired: true,
          actionLabel: "Review deliverable",
          actionHref: "/portal#milestones",
          actorLabel: "Freelancer",
          metadata: { milestoneId },
        }),
      );
      break;

    case "milestone.accepted":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `milestone.accepted:${milestoneId ?? activity.id}`,
          category: "MILESTONE",
          severity: "SUCCESS",
          title: "Milestone deliverables accepted",
          body: `${project.clientName} accepted deliverables for "${milestoneTitle ?? "milestone"}" on "${project.title}".`,
          actionRequired: false,
          actionLabel: "View milestones",
          actionHref: `${projectHref}#milestones`,
          actorLabel: "Client",
          metadata: { milestoneId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `milestone.accepted:${milestoneId ?? activity.id}`,
          category: "MILESTONE",
          severity: "SUCCESS",
          title: "Deliverables accepted",
          body: `Acceptance recorded for "${milestoneTitle ?? "milestone"}" on "${project.title}".`,
          actionRequired: false,
          actionLabel: "View milestones",
          actionHref: "/portal#milestones",
          actorLabel: "Client",
          metadata: { milestoneId },
        }),
      );
      break;

    case "milestone.revision_requested":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `milestone.revision_requested:${activity.id}`,
          category: "MILESTONE",
          severity: "ACTION_REQUIRED",
          title: "Milestone revision requested",
          body: `${project.clientName} requested revisions on "${milestoneTitle ?? "milestone"}" (${project.title}).`,
          actionRequired: true,
          actionLabel: "Respond to feedback",
          actionHref: `${projectHref}#milestones`,
          actorLabel: "Client",
          metadata: { milestoneId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `milestone.revision_requested:${activity.id}`,
          category: "MILESTONE",
          severity: "INFO",
          title: "Revision request recorded",
          body: `Your revision feedback for "${milestoneTitle ?? "milestone"}" was sent to the freelancer.`,
          actionRequired: false,
          actionLabel: "View milestones",
          actionHref: "/portal#milestones",
          actorLabel: "Client",
          metadata: { milestoneId },
        }),
      );
      break;

    case "change_request.submitted":
      if (requesterRole === "CLIENT") {
        drafts.push(
          makeUserDraft(project, activity, {
            idempotencyKey: `change_request.submitted:${changeRequestId ?? activity.id}`,
            category: "SCOPE_CHANGE",
            severity: "ACTION_REQUIRED",
            title: "New scope-change request from client",
            body: `${project.clientName} submitted a scope change on "${project.title}".`,
            actionRequired: true,
            actionLabel: "Review scope change",
            actionHref: `${projectHref}#scope-changes`,
            actorLabel: "Client",
            metadata: { changeRequestId },
          }),
        );
      } else {
        pushClient(
          makeClientDraft(project, activity, {
            idempotencyKey: `change_request.submitted:${changeRequestId ?? activity.id}`,
            category: "SCOPE_CHANGE",
            severity: "ACTION_REQUIRED",
            title: "New scope-change proposal from freelancer",
            body: `The freelancer logged a scope change request on "${project.title}".`,
            actionRequired: true,
            actionLabel: "Review scope change",
            actionHref: "/portal#scope-changes",
            actorLabel: "Freelancer",
            metadata: { changeRequestId },
          }),
        );
      }
      break;

    case "change_request.analysis_updated":
    case "change_request.analysis_stale": {
      const stale = activity.event_type === "change_request.analysis_stale";
      const key = `${activity.event_type}:${changeRequestId ?? activity.id}:${versionNumber ?? "0"}`;
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: key,
          category: "SCOPE_CHANGE",
          severity: "WARNING",
          title: stale ? "Scope-change AI analysis may be stale" : "Scope-change AI analysis updated",
          body: activity.summary,
          actionRequired: true,
          actionLabel: "Inspect scope requests",
          actionHref: `${projectHref}#scope-changes`,
          metadata: { changeRequestId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: key,
          category: "SCOPE_CHANGE",
          severity: "WARNING",
          title: stale
            ? "Earlier scope-change analysis predates current agreement"
            : "Scope-change analysis updated",
          body: activity.summary,
          actionRequired: false,
          actionLabel: "View scope requests",
          actionHref: "/portal#scope-changes",
          actorLabel: "System",
          metadata: { changeRequestId },
        }),
      );
      break;
    }

    case "change_request.resolved":
    case "change_request.withdrawn": {
      const resolved = activity.event_type === "change_request.resolved";
      const key = `${activity.event_type}:${changeRequestId ?? activity.id}`;
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: key,
          category: "SCOPE_CHANGE",
          severity: resolved ? "SUCCESS" : "INFO",
          title: resolved ? "Scope-change request resolved" : "Scope-change request withdrawn",
          body: activity.summary,
          actionRequired: false,
          actionLabel: "View scope changes",
          actionHref: `${projectHref}#scope-changes`,
          metadata: { changeRequestId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: key,
          category: "SCOPE_CHANGE",
          severity: resolved ? "SUCCESS" : "INFO",
          title: resolved ? "Scope-change request resolved" : "Scope-change request withdrawn",
          body: resolved
            ? `A scope-change request on "${project.title}" was marked resolved. Formal agreement changes require an approved agreement revision.`
            : `A scope-change request on "${project.title}" was withdrawn.`,
          actionRequired: false,
          actionLabel: "View scope changes",
          actionHref: "/portal#scope-changes",
          actorLabel: "Freelancer",
          metadata: { changeRequestId },
        }),
      );
      break;
    }

    case "payment.webhook_order_approved":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `payment.order_approved:${intentId ?? activity.id}`,
          category: "PAYMENT",
          severity: "INFO",
          title: "PayPal checkout order approved by buyer",
          body: `A PayPal checkout order on "${project.title}" received verified buyer approval. Awaiting final capture confirmation.`,
          actionRequired: false,
          actionLabel: "View milestone",
          actionHref: `${projectHref}#milestones`,
          actorLabel: "PayPal Webhook",
          metadata: { milestoneId, paymentIntentId: intentId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `payment.order_approved:${intentId ?? activity.id}`,
          category: "PAYMENT",
          severity: "INFO",
          title: "PayPal checkout approval confirmed",
          body: `Your PayPal order approval for "${project.title}" is verified by webhook. Capture confirmation determines paid status.`,
          actionRequired: false,
          actionLabel: "Check payment status",
          actionHref: "/portal#milestones",
          actorLabel: "PayPal Webhook",
          metadata: { milestoneId },
        }),
      );
      break;

    case "payment.order_captured":
    case "payment.reconciliation_completed":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `payment.captured:${intentId ?? activity.id}`,
          category: "PAYMENT",
          severity: "SUCCESS",
          title: "PayPal payment captured (Provider Confirmed)",
          body: `A milestone payment on "${project.title}" was captured and confirmed via PayPal. Deliverable acceptance stays separate.`,
          actionRequired: false,
          actionLabel: "View payment & work status",
          actionHref: `${projectHref}#milestones`,
          actorLabel: "PayPal Confirmed",
          metadata: { milestoneId, paymentIntentId: intentId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `payment.captured:${intentId ?? activity.id}`,
          category: "PAYMENT",
          severity: "SUCCESS",
          title: "PayPal payment captured (Provider Confirmed)",
          body: `Your milestone payment on "${project.title}" is confirmed via PayPal. Review submitted deliverables independently before accepting.`,
          actionRequired: false,
          actionLabel: "View milestones",
          actionHref: "/portal#milestones",
          actorLabel: "PayPal Confirmed",
          metadata: { milestoneId },
        }),
      );
      break;

    case "payment.capture_pending":
    case "payment.webhook_capture_pending":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `payment.capture_pending:${intentId ?? activity.id}`,
          category: "RECONCILIATION",
          severity: "WARNING",
          title: "PayPal payment capture pending verification",
          body: `A milestone payment on "${project.title}" returned PENDING from PayPal and awaits settlement verification.`,
          actionRequired: true,
          actionLabel: "Inspect payment operations",
          actionHref: "/app/payments",
          actorLabel: "System",
          metadata: { milestoneId, paymentIntentId: intentId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `payment.capture_pending:${intentId ?? activity.id}`,
          category: "PAYMENT",
          severity: "WARNING",
          title: "Payment capture pending verification",
          body: `Your PayPal payment for "${project.title}" is pending settlement confirmation and is not marked Paid yet.`,
          actionRequired: false,
          actionLabel: "Check payment status",
          actionHref: "/portal#milestones",
          actorLabel: "PayPal",
          metadata: { milestoneId },
        }),
      );
      break;

    case "payment.capture_failed":
    case "payment.webhook_capture_denied":
    case "payment.reconciliation_failed":
    case "payment.reconciliation_cancelled":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `payment.capture_failed:${intentId ?? activity.id}:${activity.event_type}`,
          category: "PAYMENT",
          severity: "WARNING",
          title: "PayPal payment capture failed or declined",
          body: `A PayPal payment attempt on "${project.title}" did not complete and remains unpaid.`,
          actionRequired: false,
          actionLabel: "Inspect payment operations",
          actionHref: "/app/payments",
          actorLabel: "PayPal",
          metadata: { milestoneId, paymentIntentId: intentId },
        }),
      );
      pushClient(
        makeClientDraft(project, activity, {
          idempotencyKey: `payment.capture_failed:${intentId ?? activity.id}:${activity.event_type}`,
          category: "PAYMENT",
          severity: "WARNING",
          title: "PayPal payment could not be completed",
          body: `Your PayPal payment attempt on "${project.title}" did not succeed. You can retry checkout if eligible.`,
          actionRequired: false,
          actionLabel: "View payment status",
          actionHref: "/portal#milestones",
          actorLabel: "PayPal",
          metadata: { milestoneId },
        }),
      );
      break;

    case "payment.marked_reconciliation_required":
    case "payment.capture_reconciliation_required":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `payment.reconciliation_required:${intentId ?? activity.id}`,
          category: "RECONCILIATION",
          severity: "ACTION_REQUIRED",
          title: "Payment reconciliation requires attention",
          body: `A PayPal payment intent on "${project.title}" entered RECONCILIATION_REQUIRED status.`,
          actionRequired: true,
          actionLabel: "Open Payment Operations",
          actionHref: "/app/payments",
          actorLabel: "System",
          metadata: { milestoneId, paymentIntentId: intentId },
        }),
      );
      break;

    case "payment.order_recovered":
    case "payment.reconciliation_resolved_without_payment":
      drafts.push(
        makeUserDraft(project, activity, {
          idempotencyKey: `payment.recovery:${intentId ?? activity.id}:${activity.event_type}`,
          category: "RECONCILIATION",
          severity: "INFO",
          title:
            activity.event_type === "payment.order_recovered"
              ? "PayPal order recovered"
              : "Payment reconciliation resolved without payment",
          body: activity.summary,
          actionRequired: false,
          actionLabel: "View payment operations",
          actionHref: "/app/payments",
          metadata: { milestoneId, paymentIntentId: intentId },
        }),
      );
      break;
  }

  return drafts;
}
