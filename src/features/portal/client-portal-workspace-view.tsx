"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  LogOut,
  CreditCard,
  Calendar,
  ExternalLink,
  FileText,
  DollarSign,
  Loader2,
  MessageSquareWarning,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils";
import { AgreementDocumentView } from "@/features/agreements/agreement-document-view";
import { ProjectAssistantPanel } from "@/features/assistant/project-assistant-panel";
import { mapActivityEventsToHistoryItems } from "@/features/history/mapper";
import { ProjectHistoryPanel } from "@/features/history/project-history-panel";
import type { ProjectHistoryPageResult } from "@/features/history/types";
import { ScopeChangePanel } from "@/features/scope-changes/scope-change-panel";
import { MilestoneCheckout } from "./milestone-checkout";
import { PortalNotificationsPanel } from "./portal-notifications-panel";
import type {
  PortalProjectData,
  PortalMilestone,
  PortalPaymentReturnContext,
} from "./types";

interface ClientPortalWorkspaceViewProps {
  token: string;
  projectData: PortalProjectData;
  csrfToken: string;
  initialPaymentReturn?: PortalPaymentReturnContext;
}

export function ClientPortalWorkspaceView({
  token,
  projectData,
  csrfToken,
  initialPaymentReturn,
}: ClientPortalWorkspaceViewProps) {
  const router = useRouter();
  const initialMatchedMilestone = initialPaymentReturn
    ? projectData.milestones.find(
        (m) => m.paymentIntentId === initialPaymentReturn.paymentIntentId
      )
    : undefined;
  const [activeMilestoneId, setActiveMilestoneId] = useState<string | null>(
    initialMatchedMilestone?.id ?? null
  );
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [milestoneOverrides, setMilestoneOverrides] = useState<
    Record<string, { status: string; latestFeedbackNote: string | null }>
  >({});
  const [reviewFormMilestoneId, setReviewFormMilestoneId] = useState<string | null>(null);
  const [reviewActionMode, setReviewActionMode] = useState<"ACCEPT" | "REQUEST_REVISION">("REQUEST_REVISION");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);
  const [reviewMessageByMilestone, setReviewMessageByMilestone] = useState<
    Record<string, { type: "success" | "error"; text: string }>
  >({});
  const [showAgreementDetails, setShowAgreementDetails] = useState(false);
  const [selectedAgreementVersionId, setSelectedAgreementVersionId] = useState<string | null>(
    () =>
      projectData.agreementVersionHistory?.find((v) => v.status === "APPROVED")?.id ??
      projectData.agreementVersionHistory?.[0]?.id ??
      null
  );

  const milestones = projectData.milestones.map((m) => {
    const override = milestoneOverrides[m.id];
    if (!override) return m;
    return {
      ...m,
      status: override.status,
      latestFeedbackNote: override.latestFeedbackNote ?? m.latestFeedbackNote,
    };
  });

  const paidMilestonesCount = milestones.filter((m) => m.paymentStatus === "PAID").length;
  const acceptedMilestonesCount = milestones.filter((m) => m.status === "ACCEPTED").length;
  const totalMilestonesCount = milestones.length;

  const versionHistory = projectData.agreementVersionHistory ?? [];
  const inspectedAgreementVersion =
    versionHistory.find((v) => v.id === selectedAgreementVersionId) ?? versionHistory[0] ?? null;
  const displayedAgreementContent =
    inspectedAgreementVersion?.content ?? projectData.agreementContent ?? null;

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await fetch(`/api/public/portal/${encodeURIComponent(token)}/session`, {
        method: "DELETE",
      });
      router.refresh();
    } catch {
      window.location.reload();
    }
  }

  async function submitMilestoneReview(
    milestoneId: string,
    action: "ACCEPT" | "REQUEST_REVISION",
    noteText: string,
  ) {
    setReviewBusyId(milestoneId);
    setReviewMessageByMilestone((prev) => {
      const next = { ...prev };
      delete next[milestoneId];
      return next;
    });

    try {
      const res = await fetch(
        `/api/public/portal/${encodeURIComponent(token)}/milestones/${milestoneId}/review`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({ action, note: noteText }),
        },
      );

      const payload = (await res.json()) as {
        error?: string;
        message?: string;
        data?: { id: string; status: string };
      };

      if (!res.ok || !payload.data) {
        setReviewMessageByMilestone((prev) => ({
          ...prev,
          [milestoneId]: {
            type: "error",
            text: payload.message || payload.error || "Unable to submit deliverable decision.",
          },
        }));
        return;
      }

      setMilestoneOverrides((prev) => ({
        ...prev,
        [milestoneId]: {
          status: payload.data!.status,
          latestFeedbackNote: noteText.trim() || null,
        },
      }));
      setReviewFormMilestoneId(null);
      setReviewNote("");
      setReviewMessageByMilestone((prev) => ({
        ...prev,
        [milestoneId]: {
          type: "success",
          text:
            action === "ACCEPT"
              ? "Deliverables accepted and recorded in project history."
              : "Revision request sent to the freelancer.",
        },
      }));
      router.refresh();
    } catch {
      setReviewMessageByMilestone((prev) => ({
        ...prev,
        [milestoneId]: {
          type: "error",
          text: "Network error submitting deliverable review.",
        },
      }));
    } finally {
      setReviewBusyId(null);
    }
  }

  function workBadgeTone(status: string): "success" | "warning" | "info" | "neutral" {
    if (status === "ACCEPTED") return "success";
    if (status === "CHANGES_REQUESTED") return "warning";
    if (status === "SUBMITTED" || status === "IN_PROGRESS" || status === "APPROVED") return "info";
    return "neutral";
  }

  function getStatusBadge(milestone: PortalMilestone) {
    switch (milestone.paymentStatus) {
      case "PAID":
        return <Badge tone="success">Paid (Provider Verified)</Badge>;
      case "PENDING_VERIFICATION":
        return <Badge tone="warning">Pending Verification</Badge>;
      case "IN_PROGRESS":
        return <Badge tone="info">Payment In Progress</Badge>;
      default:
        if (milestone.isPayable) {
          return <Badge tone="info">Ready for Payment</Badge>;
        }
        return <Badge tone="neutral">Not Payable Yet</Badge>;
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Top Navigation Bar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-ink-100 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-teal-700">Client Portal</span>
            <span className="text-ink-300">•</span>
            <span className="text-xs text-ink-600">{projectData.clientEmail}</span>
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-ink-950 sm:text-3xl">
            {projectData.title}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone="success">
            <ShieldCheck className="mr-1 h-3.5 w-3.5" />
            Verified Client Session
          </Badge>
          <Button
            variant="ghost"
            className="text-xs text-ink-600 hover:text-ink-900"
            onClick={handleSignOut}
            disabled={isSigningOut}
          >
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            {isSigningOut ? "Signing out..." : "Sign Out"}
          </Button>
        </div>
      </div>

      {/* Project Overview Card */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-600">
            <DollarSign className="h-4 w-4 text-teal-600" />
            <span>Total Value</span>
          </div>
          <p className="mt-2 font-display text-2xl font-bold text-ink-950">
            {formatMoney(projectData.totalAmountMinor, projectData.currency)}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">Fixed-scope milestone contract</p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-600">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>Milestones Completed</span>
          </div>
          <p className="mt-2 font-display text-2xl font-bold text-ink-950">
            {paidMilestonesCount} of {totalMilestonesCount}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            {paidMilestonesCount === totalMilestonesCount
              ? "All milestones paid"
              : `${totalMilestonesCount - paidMilestonesCount} payment remaining`}
            {" · "}
            {acceptedMilestonesCount} deliverable{acceptedMilestonesCount === 1 ? "" : "s"} accepted
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-600">
            <FileText className="h-4 w-4 text-teal-600" />
            <span>Agreement Status</span>
          </div>
          <p className="mt-2 font-display text-2xl font-bold text-ink-950">
            {projectData.agreementStatus.replaceAll("_", " ")}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            {projectData.scopeBaselineVersionNumber
              ? `Baseline v${projectData.scopeBaselineVersionNumber}`
              : projectData.agreementVersionNumber
                ? `Version ${projectData.agreementVersionNumber}`
                : "Active Version"}
            {projectData.agreementApprovedAt
              ? ` · Approved ${new Date(projectData.agreementApprovedAt).toLocaleDateString()}`
              : ""}
          </p>
        </Card>
      </div>

      {/* Portal Notifications Feed */}
      {projectData.notifications && (
        <PortalNotificationsPanel
          csrfToken={csrfToken}
          initialData={projectData.notifications}
          onNavigateSection={(sectionId) => {
            if (sectionId === "agreement") {
              setShowAgreementDetails(true);
            }
          }}
          token={token}
        />
      )}

      {/* Project Brief / Context */}
      {projectData.brief && (
        <Card className="mt-6 p-5 sm:p-6 bg-slate-50/50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-600">Project Objective</h3>
            {(projectData.startDate || projectData.targetEndDate) && (
              <span className="text-xs text-ink-600">
                {projectData.startDate
                  ? `Start ${new Date(projectData.startDate).toLocaleDateString()}`
                  : "Flexible start"}
                {" · "}
                {projectData.targetEndDate
                  ? `Target ${new Date(projectData.targetEndDate).toLocaleDateString()}`
                  : "Flexible completion"}
              </span>
            )}
          </div>
          <p className="mt-2 whitespace-pre-line text-sm text-ink-800 leading-relaxed">{projectData.brief}</p>
        </Card>
      )}

      {/* Agreement Terms & Version History */}
      {(displayedAgreementContent || versionHistory.length > 0) && (
        <Card className="mt-6 p-5 sm:p-6" id="agreement">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-bold text-ink-950">
                Agreement Terms &amp; Version History
              </h2>
              <p className="mt-0.5 text-xs text-ink-600">
                {projectData.agreementStatus === "APPROVED"
                  ? "Inspect the formally approved scope, acceptance criteria, and terms."
                  : "Inspect agreement drafts and prior versions. Draft terms are distinct from approved terms."}
              </p>
            </div>
            <Button
              className="text-xs"
              onClick={() => setShowAgreementDetails((prev) => !prev)}
              type="button"
              variant="secondary"
            >
              {showAgreementDetails ? "Hide agreement terms" : "View agreement terms"}
            </Button>
          </div>

          {showAgreementDetails && (
            <div className="mt-5 space-y-5 border-t border-ink-100 pt-5">
              {versionHistory.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {versionHistory.map((version) => {
                    const selected = inspectedAgreementVersion?.id === version.id;
                    return (
                      <button
                        className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                          selected
                            ? "border-teal-600 bg-teal-50 text-teal-900"
                            : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50"
                        }`}
                        key={version.id}
                        onClick={() => setSelectedAgreementVersionId(version.id)}
                        type="button"
                      >
                        v{version.versionNumber} · {version.status.replaceAll("_", " ")}
                      </button>
                    );
                  })}
                </div>
              )}

              <AgreementDocumentView content={displayedAgreementContent} />
            </div>
          )}
        </Card>
      )}

      {/* Milestones Section */}
      <div className="mt-8" id="milestones">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold text-ink-950">Project Milestones</h2>
            <p className="text-xs text-ink-600">
              Review work status and deliverables against acceptance criteria independently from PayPal milestone checkout.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {milestones.length === 0 ? (
            <Card className="p-8 text-center text-ink-600">
              <p className="text-sm">No milestones have been defined for this project.</p>
            </Card>
          ) : (
            milestones.map((milestone, idx) => {
              const isSelected = activeMilestoneId === milestone.id;

              return (
                <div key={milestone.id} className="space-y-4">
                  <Card className="p-5 sm:p-6 transition-all hover:border-ink-200">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-ink-700">
                            {idx + 1}
                          </span>
                          <h3 className="font-display text-base font-bold text-ink-950 sm:text-lg">
                            {milestone.title}
                          </h3>
                          <Badge tone={workBadgeTone(milestone.status)}>
                            Work: {milestone.status.replaceAll("_", " ")}
                          </Badge>
                          {getStatusBadge(milestone)}
                        </div>

                        {milestone.description && (
                          <p className="text-sm text-ink-700 leading-relaxed pl-8">
                            {milestone.description}
                          </p>
                        )}

                        {milestone.deliverables && milestone.deliverables.length > 0 && (
                          <div className="pl-8 pt-1">
                            <p className="text-xs font-semibold text-ink-600 uppercase tracking-wider">Deliverables:</p>
                            <ul className="mt-1 space-y-1 text-xs text-ink-800">
                              {milestone.deliverables.map((deliv, dIdx) => (
                                <li key={dIdx} className="flex items-center gap-1.5">
                                  <span className="h-1.5 w-1.5 rounded-full bg-teal-600 shrink-0" />
                                  <span>{deliv}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {milestone.acceptanceCriteria && milestone.acceptanceCriteria.length > 0 && (
                          <div className="pl-8 pt-1">
                            <p className="text-xs font-semibold text-teal-800 uppercase tracking-wider">
                              Acceptance Criteria:
                            </p>
                            <ul className="mt-1 space-y-1 text-xs text-ink-800">
                              {milestone.acceptanceCriteria.map((criterion, cIdx) => (
                                <li key={cIdx} className="flex items-center gap-1.5">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 shrink-0" />
                                  <span>{criterion}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {(milestone.latestSubmissionNote || milestone.latestDeliverableUrl) && (
                          <div className="ml-8 rounded-xl border border-teal-200/80 bg-teal-50/40 p-3 text-xs text-ink-800">
                            <p className="font-bold text-teal-900">Freelancer Submission Note</p>
                            {milestone.latestSubmissionNote && (
                              <p className="mt-1 whitespace-pre-line">{milestone.latestSubmissionNote}</p>
                            )}
                            {milestone.latestDeliverableUrl && (
                              <a
                                className="mt-1.5 inline-flex items-center gap-1 font-semibold text-teal-700 hover:underline"
                                href={milestone.latestDeliverableUrl}
                                rel="noopener noreferrer"
                                target="_blank"
                              >
                                Open submitted deliverable link <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        )}

                        {milestone.latestFeedbackNote && (
                          <div className="ml-8 rounded-xl border border-ink-200 bg-ink-50 p-3 text-xs text-ink-800">
                            <p className="font-bold text-ink-900">Your Latest Review Note</p>
                            <p className="mt-1 whitespace-pre-line">{milestone.latestFeedbackNote}</p>
                          </div>
                        )}

                        {milestone.dueDate && (
                          <div className="flex items-center gap-1.5 pl-8 pt-1 text-xs text-ink-500">
                            <Calendar className="h-3.5 w-3.5" />
                            <span>Target Completion: {new Date(milestone.dueDate).toLocaleDateString()}</span>
                          </div>
                        )}

                        {/* Deliverable Acceptance & Revision Review Controls */}
                        {reviewMessageByMilestone[milestone.id] && (
                          <div
                            className={`ml-8 rounded-xl border p-3 text-xs ${
                              reviewMessageByMilestone[milestone.id].type === "success"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                                : "border-red-200 bg-red-50 text-red-950"
                            }`}
                            role="status"
                          >
                            {reviewMessageByMilestone[milestone.id].text}
                          </div>
                        )}

                        {milestone.status === "SUBMITTED" && (
                          <div className="ml-8 mt-3 space-y-3 rounded-xl border border-ink-200 bg-slate-50/80 p-4">
                            <p className="text-xs font-bold uppercase tracking-wider text-ink-800">
                              Deliverable Review Required
                            </p>

                            {milestone.paymentStatus === "PENDING_VERIFICATION" ||
                            milestone.paymentStatus === "IN_PROGRESS" ? (
                              <p className="text-xs text-amber-900">
                                A PayPal checkout or verification is active for this milestone. Wait for payment confirmation or cancel checkout before updating deliverable review status.
                              </p>
                            ) : (
                              <>
                                {milestone.currency === "USD" &&
                                  milestone.amountMinor > 0 &&
                                  milestone.paymentStatus !== "PAID" && (
                                    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
                                      <p className="font-bold">Payment Required Before Deliverable Acceptance</p>
                                      <p className="mt-1">
                                        The current PayPal checkout flow does not permit checkout initiation once a milestone status becomes ACCEPTED. Keep this milestone SUBMITTED until PayPal payment is completed, or request revisions below.
                                      </p>
                                    </div>
                                  )}

                                {reviewFormMilestoneId === milestone.id ? (
                                  <form
                                    className="space-y-3"
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      void submitMilestoneReview(
                                        milestone.id,
                                        reviewActionMode,
                                        reviewNote,
                                      );
                                    }}
                                  >
                                    <label className="block text-xs font-semibold text-ink-800">
                                      {reviewActionMode === "ACCEPT"
                                        ? "Optional acceptance feedback"
                                        : "Describe required revisions (min 3 characters)"}
                                      <textarea
                                        className="mt-1.5 min-h-20 w-full rounded-xl border border-ink-200 bg-white p-2.5 text-sm font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                                        minLength={reviewActionMode === "REQUEST_REVISION" ? 3 : 0}
                                        onChange={(e) => setReviewNote(e.target.value)}
                                        placeholder={
                                          reviewActionMode === "ACCEPT"
                                            ? "Optional confirmation note..."
                                            : "Explain what needs adjusting against the acceptance criteria..."
                                        }
                                        required={reviewActionMode === "REQUEST_REVISION"}
                                        value={reviewNote}
                                      />
                                    </label>
                                    <div className="flex flex-wrap gap-2">
                                      <Button
                                        className="min-h-8 px-3 text-xs"
                                        disabled={reviewBusyId === milestone.id}
                                        type="submit"
                                      >
                                        {reviewBusyId === milestone.id ? (
                                          <>
                                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                            Submitting...
                                          </>
                                        ) : reviewActionMode === "ACCEPT" ? (
                                          "Confirm Acceptance"
                                        ) : (
                                          "Send Revision Request"
                                        )}
                                      </Button>
                                      <Button
                                        className="min-h-8 px-3 text-xs"
                                        disabled={reviewBusyId === milestone.id}
                                        onClick={() => {
                                          setReviewFormMilestoneId(null);
                                          setReviewNote("");
                                        }}
                                        type="button"
                                        variant="ghost"
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  </form>
                                ) : (
                                  <div className="flex flex-wrap gap-2">
                                    {(milestone.paymentStatus === "PAID" ||
                                      milestone.currency !== "USD" ||
                                      milestone.amountMinor <= 0) && (
                                      <Button
                                        className="min-h-8 px-3 text-xs"
                                        onClick={() => {
                                          setReviewActionMode("ACCEPT");
                                          setReviewFormMilestoneId(milestone.id);
                                          setReviewNote("");
                                        }}
                                        type="button"
                                      >
                                        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                                        Accept Deliverable
                                      </Button>
                                    )}
                                    <Button
                                      className="min-h-8 px-3 text-xs"
                                      onClick={() => {
                                        setReviewActionMode("REQUEST_REVISION");
                                        setReviewFormMilestoneId(milestone.id);
                                        setReviewNote("");
                                      }}
                                      type="button"
                                      variant="secondary"
                                    >
                                      <MessageSquareWarning className="mr-1.5 h-3.5 w-3.5" />
                                      Request Revision
                                    </Button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Right Column: Amount & Pay Action */}
                      <div className="flex flex-row items-center justify-between sm:flex-col sm:items-end gap-3 pt-3 sm:pt-0 border-t sm:border-t-0 border-ink-100">
                        <span className="font-display text-xl font-bold text-ink-950 sm:text-2xl">
                          {formatMoney(milestone.amountMinor, milestone.currency)}
                        </span>

                        {milestone.paymentStatus === "PAID" ? (
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="h-4 w-4" />
                            <span>Paid</span>
                          </div>
                        ) : milestone.paymentStatus === "PENDING_VERIFICATION" ? (
                          <Button
                            variant="secondary"
                            className="text-xs"
                            onClick={() => setActiveMilestoneId(isSelected ? null : milestone.id)}
                          >
                            <AlertTriangle className="mr-1.5 h-3.5 w-3.5 text-amber-600" />
                            Pending Verification
                          </Button>
                        ) : milestone.isPayable ? (
                          <Button
                            onClick={() => setActiveMilestoneId(isSelected ? null : milestone.id)}
                            className="text-xs sm:text-sm"
                          >
                            <CreditCard className="mr-1.5 h-4 w-4" />
                            {isSelected ? "Hide Checkout" : "Pay Milestone"}
                          </Button>
                        ) : (
                          <span className="text-xs text-ink-400 font-medium">
                            Not Payable
                          </span>
                        )}
                      </div>
                    </div>
                  </Card>

                  {/* Render Checkout Component when selected */}
                  {isSelected && (
                    <div className="pl-0 sm:pl-8">
                      <MilestoneCheckout
                        token={token}
                        milestone={milestone}
                        csrfToken={csrfToken}
                        paymentReturn={
                          initialPaymentReturn &&
                          initialPaymentReturn.paymentIntentId === milestone.paymentIntentId
                            ? initialPaymentReturn
                            : undefined
                        }
                        onCancel={() => setActiveMilestoneId(null)}
                        onPaymentSuccess={() => {
                          router.refresh();
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Scope Changes & AI Impact Assessment (AI-5) */}
      <div className="mt-8" id="scope-changes">
        <ScopeChangePanel
          mode="client"
          portalToken={token}
          csrfToken={csrfToken}
          projectCurrency={projectData.currency}
          confirmedBudgetMinor={projectData.totalAmountMinor}
          agreementVersionId={projectData.agreementVersionId ?? null}
          agreementVersionNumber={
            projectData.scopeBaselineVersionNumber ?? projectData.agreementVersionNumber ?? null
          }
          agreementStatus={projectData.scopeBaselineStatus ?? projectData.agreementStatus}
          canUseAi={Boolean(projectData.canUseAi)}
          initialChangeRequests={projectData.changeRequests ?? []}
        />
      </div>

      {/* Context-Aware Read-Only Project Assistant (AI-6) */}
      <div className="mt-8">
        <ProjectAssistantPanel
          mode="client"
          portalToken={token}
          csrfToken={csrfToken}
          projectTitle={projectData.title}
          canUseAi={Boolean(projectData.canUseAi)}
        />
      </div>

      {/* Chronological Privacy-Filtered Project History */}
      {(projectData.history || (projectData.activities && projectData.activities.length > 0)) && (
        <div className="mt-8">
          <ProjectHistoryPanel
            initialHistory={
              projectData.history ??
              ((): ProjectHistoryPageResult => {
                const mapped = mapActivityEventsToHistoryItems(
                  (projectData.activities ?? []).map((act) => ({
                    id: act.id,
                    project_id: projectData.id,
                    actor_label: act.actorLabel,
                    event_type: act.eventType,
                    summary: act.summary,
                    metadata: {},
                    created_at: act.createdAt,
                  })),
                  "client",
                );
                return {
                  items: mapped,
                  totalCount: mapped.length,
                  page: 1,
                  pageSize: 20,
                  hasMore: false,
                };
              })()
            }
            mode="client"
            onClientNavigateSection={(sectionId) => {
              if (sectionId === "agreement") {
                setShowAgreementDetails(true);
              }
            }}
            portalToken={token}
            projectId={projectData.id}
          />
        </div>
      )}
    </div>
  );
}
