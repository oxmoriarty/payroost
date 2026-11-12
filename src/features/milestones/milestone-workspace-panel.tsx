"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Send,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { MilestoneWorkflowNotes } from "@/features/milestones/activity-notes";
import type { MilestoneReadOnlyPaymentState } from "@/features/projects/data";
import type { Milestone } from "@/features/projects/types";
import { formatMoney } from "@/lib/utils";

type MilestoneWorkspacePanelProps = {
  projectId: string;
  milestones: Milestone[];
  agreementApproved: boolean;
  paymentStates: Record<string, MilestoneReadOnlyPaymentState>;
  initialNotes: Record<string, MilestoneWorkflowNotes>;
};

function workStatusTone(status: string): "success" | "warning" | "info" | "neutral" {
  if (status === "ACCEPTED") return "success";
  if (status === "CHANGES_REQUESTED") return "warning";
  if (status === "SUBMITTED" || status === "IN_PROGRESS" || status === "APPROVED") return "info";
  return "neutral";
}

function paymentStatusTone(
  status: MilestoneReadOnlyPaymentState["paymentStatus"],
): "success" | "warning" | "info" | "neutral" {
  if (status === "PAID") return "success";
  if (status === "PENDING_VERIFICATION") return "warning";
  if (status === "IN_PROGRESS") return "info";
  return "neutral";
}

function paymentStatusLabel(status: MilestoneReadOnlyPaymentState["paymentStatus"]): string {
  if (status === "PAID") return "Paid (Provider Verified)";
  if (status === "PENDING_VERIFICATION") return "Payment Pending Verification";
  if (status === "IN_PROGRESS") return "Checkout In Progress";
  return "Unpaid";
}

export function MilestoneWorkspacePanel({
  projectId,
  milestones,
  agreementApproved,
  paymentStates,
  initialNotes,
}: MilestoneWorkspacePanelProps) {
  const [localMilestones, setLocalMilestones] = useState<Milestone[]>(milestones);
  const [notesByMilestone, setNotesByMilestone] =
    useState<Record<string, MilestoneWorkflowNotes>>(initialNotes);
  const [activeSubmitId, setActiveSubmitId] = useState<string | null>(null);
  const [submissionNote, setSubmissionNote] = useState("");
  const [deliverableUrl, setDeliverableUrl] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const hasUnsyncedDrafts =
    agreementApproved &&
    (localMilestones.length === 0 || localMilestones.some((m) => m.status === "DRAFT"));

  async function handleSyncApproved() {
    setSyncing(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/milestones/sync`, {
        method: "POST",
      });
      const payload = (await res.json()) as {
        error?: string;
        data?: { promotedCount: number; insertedCount: number; reason: string };
      };
      if (!res.ok) {
        setFeedback({
          type: "error",
          text: payload.error || "Unable to synchronize milestones from the approved agreement.",
        });
        return;
      }

      const count = (payload.data?.promotedCount ?? 0) + (payload.data?.insertedCount ?? 0);
      if (count > 0 && typeof window !== "undefined") {
        window.location.reload();
        return;
      }
      setFeedback({
        type: "success",
        text: "Agreed milestones are already synchronized.",
      });
    } catch {
      setFeedback({
        type: "error",
        text: "Network error synchronizing milestones.",
      });
    } finally {
      setSyncing(false);
    }
  }

  async function updateMilestoneStatus(
    milestoneId: string,
    targetStatus: "IN_PROGRESS" | "SUBMITTED",
    noteText = "",
    linkUrl = "",
  ) {
    setBusyId(milestoneId);
    setFeedback(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/milestones/${milestoneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: targetStatus,
          submissionNote: noteText,
          deliverableUrl: linkUrl,
        }),
      });

      const payload = (await res.json()) as {
        error?: string;
        message?: string;
        data?: { id: string; status: string; updated_at?: string };
      };

      if (!res.ok || !payload.data) {
        setFeedback({
          type: "error",
          text: payload.message || payload.error || "Unable to update milestone status.",
        });
        return;
      }

      setLocalMilestones((prev) =>
        prev.map((m) => (m.id === milestoneId ? { ...m, status: payload.data!.status } : m)),
      );

      if (targetStatus === "SUBMITTED") {
        setNotesByMilestone((prev) => ({
          ...prev,
          [milestoneId]: {
            latestFeedbackNote: prev[milestoneId]?.latestFeedbackNote ?? null,
            latestFeedbackAt: prev[milestoneId]?.latestFeedbackAt ?? null,
            latestSubmissionNote: noteText.trim() || null,
            latestDeliverableUrl: linkUrl.trim() || null,
            latestSubmissionAt: new Date().toISOString(),
          },
        }));
        setActiveSubmitId(null);
        setSubmissionNote("");
        setDeliverableUrl("");
        setFeedback({
          type: "success",
          text: "Deliverables submitted for client review in the Client Portal.",
        });
      } else {
        setFeedback({
          type: "success",
          text: "Milestone marked In Progress.",
        });
      }
    } catch {
      setFeedback({
        type: "error",
        text: "Network error updating milestone status.",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="p-6" id="milestones">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">
            Milestone execution &amp; deliverables
          </p>
          <h2 className="mt-1 font-display text-2xl text-ink-950">
            Work progress &amp; client acceptance
          </h2>
          <p className="mt-1 text-sm text-ink-700">
            Submit completed work against agreed milestones. Deliverable review and PayPal checkout status remain tracked separately.
          </p>
        </div>

        {hasUnsyncedDrafts && (
          <Button disabled={syncing} onClick={handleSyncApproved} type="button" variant="secondary">
            {syncing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Sync approved milestones
              </>
            )}
          </Button>
        )}
      </div>

      {feedback && (
        <div
          className={`mt-4 rounded-xl border p-3 text-sm ${
            feedback.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-950"
              : "border-red-200 bg-red-50 text-red-950"
          }`}
          role="status"
        >
          {feedback.text}
        </div>
      )}

      {localMilestones.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-ink-200 bg-ink-50 px-6 py-10 text-center">
          <ListChecks className="mx-auto text-teal-700" size={28} />
          <h3 className="mt-3 font-display text-xl text-ink-950">No milestones saved yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-700">
            Plan and apply milestones below or draft the agreement first. Approved agreement milestones become ready for work tracking and client portal checkout.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {localMilestones.map((milestone, index) => {
            const paymentState = paymentStates[milestone.id] ?? {
              paymentStatus: "UNPAID" as const,
              completedCaptureId: null,
            };
            const notes = notesByMilestone[milestone.id];
            const canWork = ["APPROVED", "CHANGES_REQUESTED"].includes(milestone.status);
            const canSubmit = ["APPROVED", "IN_PROGRESS", "CHANGES_REQUESTED", "SUBMITTED"].includes(
              milestone.status,
            );
            const isSubmitOpen = activeSubmitId === milestone.id;
            const isBusy = busyId === milestone.id;

            return (
              <div
                className="rounded-2xl border border-ink-200 bg-white p-5 space-y-4"
                key={milestone.id}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-ink-100 text-xs font-bold text-ink-800">
                        {index + 1}
                      </span>
                      <h3 className="font-display text-lg font-semibold text-ink-950">
                        {milestone.title}
                      </h3>
                      <Badge tone={workStatusTone(milestone.status)}>
                        Work: {milestone.status.replaceAll("_", " ")}
                      </Badge>
                      <Badge tone={paymentStatusTone(paymentState.paymentStatus)}>
                        {paymentStatusLabel(paymentState.paymentStatus)}
                      </Badge>
                    </div>

                    {milestone.description && (
                      <p className="text-sm text-ink-700">{milestone.description}</p>
                    )}

                    {milestone.due_date && (
                      <p className="flex items-center gap-1.5 text-xs text-ink-600">
                        <Calendar className="h-3.5 w-3.5" />
                        Due {new Date(milestone.due_date).toLocaleDateString()}
                      </p>
                    )}
                  </div>

                  <div className="text-left sm:text-right">
                    <p className="font-display text-xl font-bold text-ink-950">
                      {formatMoney(milestone.amount_minor, milestone.currency)}
                    </p>
                    {paymentState.completedCaptureId && (
                      <p className="mt-0.5 text-xs font-mono text-emerald-700">
                        Capture: {paymentState.completedCaptureId}
                      </p>
                    )}
                  </div>
                </div>

                {(milestone.deliverables?.length > 0 || milestone.acceptance_criteria?.length > 0) && (
                  <div className="grid gap-4 rounded-xl border border-ink-100 bg-ink-50/50 p-4 sm:grid-cols-2">
                    {milestone.deliverables?.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-ink-700">
                          Deliverables
                        </p>
                        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-ink-800">
                          {milestone.deliverables.map((d, idx) => (
                            <li key={idx}>{d}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {milestone.acceptance_criteria?.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-teal-800">
                          Acceptance criteria
                        </p>
                        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-ink-800">
                          {milestone.acceptance_criteria.map((c, idx) => (
                            <li key={idx}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {milestone.status === "CHANGES_REQUESTED" && notes?.latestFeedbackNote && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-950">
                    <div className="flex items-center gap-1.5 font-bold">
                      <AlertTriangle className="h-4 w-4 text-amber-700" />
                      <span>Client Revision Request</span>
                    </div>
                    <p className="mt-1 whitespace-pre-line">{notes.latestFeedbackNote}</p>
                  </div>
                )}

                {notes?.latestSubmissionNote && (
                  <div className="rounded-xl border border-teal-200/80 bg-teal-50/40 p-3.5 text-xs text-ink-800">
                    <p className="font-bold text-teal-900">Latest Submitted Deliverables</p>
                    <p className="mt-1 whitespace-pre-line">{notes.latestSubmissionNote}</p>
                    {notes.latestDeliverableUrl && (
                      <a
                        className="mt-1.5 inline-flex items-center gap-1 font-semibold text-teal-700 hover:underline"
                        href={notes.latestDeliverableUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        Open deliverable link <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                )}

                {milestone.status === "ACCEPTED" ? (
                  <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>
                      Deliverables accepted by client
                      {notes?.latestFeedbackNote ? ` — "${notes.latestFeedbackNote}"` : ""}
                    </span>
                  </div>
                ) : milestone.status === "DRAFT" ? (
                  <p className="text-xs text-ink-600">
                    Draft milestone — becomes active once the client approves the agreement via OTP review.
                  </p>
                ) : (
                  <div className="space-y-3 pt-1">
                    <div className="flex flex-wrap gap-2">
                      {canWork && milestone.status !== "IN_PROGRESS" && (
                        <Button
                          className="min-h-9 px-3 text-xs"
                          disabled={isBusy}
                          onClick={() => updateMilestoneStatus(milestone.id, "IN_PROGRESS")}
                          type="button"
                          variant="secondary"
                        >
                          <Play className="mr-1.5 h-3.5 w-3.5" />
                          Start work
                        </Button>
                      )}
                      {canSubmit && (
                        <Button
                          className="min-h-9 px-3 text-xs"
                          disabled={isBusy}
                          onClick={() => {
                            if (isSubmitOpen) {
                              setActiveSubmitId(null);
                            } else {
                              setActiveSubmitId(milestone.id);
                              setSubmissionNote(notes?.latestSubmissionNote ?? "");
                              setDeliverableUrl(notes?.latestDeliverableUrl ?? "");
                            }
                          }}
                          type="button"
                        >
                          <Send className="mr-1.5 h-3.5 w-3.5" />
                          {milestone.status === "SUBMITTED"
                            ? "Update submission"
                            : "Submit deliverables"}
                        </Button>
                      )}
                    </div>

                    {isSubmitOpen && (
                      <form
                        className="space-y-3 rounded-xl border border-ink-200 bg-ink-50/50 p-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void updateMilestoneStatus(
                            milestone.id,
                            "SUBMITTED",
                            submissionNote,
                            deliverableUrl,
                          );
                        }}
                      >
                        <label className="block text-xs font-semibold text-ink-800">
                          Deliverable summary &amp; handoff notes (required)
                          <textarea
                            className="mt-1.5 min-h-20 w-full rounded-xl border border-ink-200 bg-white p-2.5 text-base font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 sm:text-sm"
                            minLength={3}
                            onChange={(e) => setSubmissionNote(e.target.value)}
                            placeholder="Summarize completed deliverables and how the client should verify acceptance criteria..."
                            required
                            value={submissionNote}
                          />
                        </label>
                        <label className="block text-xs font-semibold text-ink-800">
                          Deliverable URL (optional, https:// or http://)
                          <input
                            className="mt-1.5 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-base font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 sm:text-sm"
                            onChange={(e) => setDeliverableUrl(e.target.value)}
                            placeholder="https://..."
                            type="url"
                            value={deliverableUrl}
                          />
                        </label>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            className="min-h-10 px-3 text-xs sm:min-h-8"
                            disabled={isBusy}
                            onClick={() => setActiveSubmitId(null)}
                            type="button"
                            variant="ghost"
                          >
                            Cancel
                          </Button>
                          <Button className="min-h-10 px-3 text-xs sm:min-h-8" disabled={isBusy} type="submit">
                            {isBusy ? (
                              <>
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                Submitting...
                              </>
                            ) : (
                              "Confirm deliverable submission"
                            )}
                          </Button>
                        </div>
                      </form>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
