import type { ActivityEvent } from "@/features/projects/types";

export type MilestoneWorkflowNotes = {
  latestSubmissionNote: string | null;
  latestDeliverableUrl: string | null;
  latestSubmissionAt: string | null;
  latestFeedbackNote: string | null;
  latestFeedbackAt: string | null;
};

/**
 * Extracts per-milestone deliverable submission notes and client revision feedback
 * from project `activity_events` ordered newest-first.
 */
export function extractMilestoneNotes(
  activities: Array<Pick<ActivityEvent, "event_type" | "metadata" | "created_at">>,
): Record<string, MilestoneWorkflowNotes> {
  const byMilestone: Record<string, MilestoneWorkflowNotes> = {};

  for (const activity of activities) {
    const meta = activity.metadata;
    if (!meta || typeof meta !== "object") continue;

    const milestoneId = typeof meta.milestoneId === "string" ? meta.milestoneId : null;
    if (!milestoneId) continue;

    if (!byMilestone[milestoneId]) {
      byMilestone[milestoneId] = {
        latestSubmissionNote: null,
        latestDeliverableUrl: null,
        latestSubmissionAt: null,
        latestFeedbackNote: null,
        latestFeedbackAt: null,
      };
    }

    const entry = byMilestone[milestoneId];

    if (activity.event_type === "milestone.submitted" && !entry.latestSubmissionAt) {
      entry.latestSubmissionNote =
        typeof meta.submissionNote === "string" && meta.submissionNote.trim()
          ? meta.submissionNote.trim()
          : null;
      entry.latestDeliverableUrl =
        typeof meta.deliverableUrl === "string" && /^https?:\/\//i.test(meta.deliverableUrl)
          ? meta.deliverableUrl
          : null;
      entry.latestSubmissionAt = activity.created_at;
    }

    if (
      (activity.event_type === "milestone.revision_requested" ||
        activity.event_type === "milestone.accepted") &&
      !entry.latestFeedbackAt
    ) {
      entry.latestFeedbackNote =
        typeof meta.feedbackNote === "string" && meta.feedbackNote.trim()
          ? meta.feedbackNote.trim()
          : null;
      entry.latestFeedbackAt = activity.created_at;
    }
  }

  return byMilestone;
}
