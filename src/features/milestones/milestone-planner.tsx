"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  Clock,
  FileCheck2,
  HelpCircle,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { AgreementDraft } from "@/features/agreements/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";
import {
  movePlannedMilestone,
  sumAllocatedMinorUnits,
  syncPlanSummaryFields,
  toggleMilestoneDependency,
} from "./planning-utils";
import type { MilestonePlan, PlannedMilestone } from "./schema";

export interface WorkspaceMilestoneSummary {
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
}

export interface MilestonePlannerProps {
  projectId: string;
  projectCurrency: string;
  confirmedBudgetMinor: number | null;
  agreementStatus: string | null;
  currentVersionNumber?: number | null;
  savedMilestones: WorkspaceMilestoneSummary[];
  agreedVersionMilestones?: AgreementDraft["milestones"];
  draftVersionMilestones?: AgreementDraft["milestones"];
  canUseAi: boolean;
  onPlanApplied?: () => void;
}

function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const COMMITTED_MILESTONE_STATUSES = new Set([
  "APPROVED",
  "IN_PROGRESS",
  "SUBMITTED",
  "ACCEPTED",
]);

export function MilestonePlanner({
  projectId,
  projectCurrency,
  confirmedBudgetMinor,
  agreementStatus,
  currentVersionNumber,
  savedMilestones,
  agreedVersionMilestones = [],
  draftVersionMilestones = [],
  canUseAi,
  onPlanApplied,
}: MilestonePlannerProps) {
  const router = useRouter();
  const [planningGoal, setPlanningGoal] = useState("");
  const [includeFinancialAllocation, setIncludeFinancialAllocation] = useState(
    Boolean(confirmedBudgetMinor && confirmedBudgetMinor > 0)
  );
  const [plan, setPlan] = useState<MilestonePlan | null>(null);
  const [proposalState, setProposalState] = useState<"NONE" | "AI_PROPOSED" | "AI_EDITED">(
    "NONE"
  );
  const [confirmNewRevision, setConfirmNewRevision] = useState(false);
  const [busyMode, setBusyMode] = useState<"idle" | "generating" | "applying">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const hasApprovedAgreement = agreementStatus === "APPROVED";
  const isReviewPending = agreementStatus === "PENDING_CLIENT";
  const requiresRevisionConfirmation = hasApprovedAgreement || isReviewPending;

  const formallyAgreedMilestones = savedMilestones.filter((m) =>
    COMMITTED_MILESTONE_STATUSES.has(m.status)
  );
  const savedDraftMilestones = savedMilestones.filter(
    (m) => !COMMITTED_MILESTONE_STATUSES.has(m.status) && m.status !== "CANCELLED"
  );

  function updateMilestones(nextMilestones: PlannedMilestone[]) {
    if (!plan) return;
    setPlan(syncPlanSummaryFields(plan, nextMilestones));
    setProposalState("AI_EDITED");
    setNotice(null);
    setErrorMsg(null);
  }

  function updateSingleMilestone(
    index: number,
    patch: Partial<PlannedMilestone>
  ) {
    if (!plan) return;
    const updated = plan.milestones.map((m, i) =>
      i === index ? { ...m, ...patch } : m
    );
    updateMilestones(updated);
  }

  async function handleGeneratePlan() {
    setBusyMode("generating");
    setNotice(null);
    setErrorMsg(null);
    setConfirmNewRevision(false);

    try {
      const res = await fetch("/api/ai/generate-milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          planningGoal: planningGoal.trim() || undefined,
          includeFinancialAllocation,
        }),
      });

      const payload = (await res.json()) as {
        data?: { plan?: MilestonePlan; preview?: boolean };
        error?: string;
        message?: string;
      };

      if (!res.ok || !payload.data?.plan) {
        if (res.status === 401) {
          throw new Error("Please sign in to generate milestone plans.");
        }
        if (res.status === 429) {
          throw new Error("Rate limit reached for AI milestone planning. Please wait a minute.");
        }
        if (res.status === 503) {
          throw new Error("AI milestone planning is temporarily unavailable. Please try again.");
        }
        if (res.status === 422) {
          throw new Error(
            "AI generated an invalid milestone allocation or structure. Please try again or clarify your planning goal."
          );
        }
        throw new Error(payload.message ?? payload.error ?? "Unable to generate milestone plan.");
      }

      setPlan(payload.data.plan);
      setProposalState("AI_PROPOSED");
      setNotice(
        "AI milestone proposal ready for review. No milestones or agreements have been saved."
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Unable to generate milestone plan."
      );
    } finally {
      setBusyMode("idle");
    }
  }

  function handleDiscardProposal() {
    setPlan(null);
    setProposalState("NONE");
    setConfirmNewRevision(false);
    setErrorMsg(null);
    setNotice("Discarded milestone proposal. Saved workspace records remain unchanged.");
  }

  const budgetCheck = (() => {
    if (!plan) return { canApply: false, reason: "" };
    if (confirmedBudgetMinor == null || confirmedBudgetMinor <= 0) {
      return {
        canApply: false,
        reason: "Project must establish a confirmed positive budget before saving milestones.",
      };
    }

    for (const m of plan.milestones) {
      if (m.title.trim().length < 2) {
        return {
          canApply: false,
          reason: `Milestone #${m.position} title must be at least 2 characters.`,
        };
      }
      if (m.description.trim().length < 1) {
        return {
          canApply: false,
          reason: `Milestone "${m.title}" requires a description before saving.`,
        };
      }
      if (m.deliverables.length < 1 || m.acceptanceCriteria.length < 1) {
        return {
          canApply: false,
          reason: `Milestone "${m.title}" must include at least 1 deliverable and 1 acceptance criterion.`,
        };
      }
      if (
        m.proposedAmountMinor === null ||
        !Number.isInteger(m.proposedAmountMinor) ||
        m.proposedAmountMinor <= 0
      ) {
        return {
          canApply: false,
          reason: `Milestone "${m.title}" requires a positive integer minor-unit amount before applying to an agreement.`,
        };
      }
      if (m.currency && m.currency !== projectCurrency) {
        return {
          canApply: false,
          reason: `Milestone "${m.title}" currency (${m.currency}) must match ${projectCurrency}.`,
        };
      }
    }

    const { allocatedMinor } = sumAllocatedMinorUnits(plan.milestones);
    if (allocatedMinor !== confirmedBudgetMinor) {
      return {
        canApply: false,
        reason: `Allocated total (${formatMoney(allocatedMinor, projectCurrency)}) must equal confirmed project budget (${formatMoney(confirmedBudgetMinor, projectCurrency)}).`,
      };
    }

    if (requiresRevisionConfirmation && !confirmNewRevision) {
      return {
        canApply: false,
        reason:
          "Confirm creating a new Draft agreement revision requiring client OTP approval before applying.",
      };
    }

    return { canApply: true, reason: "" };
  })();

  async function handleApplyPlan() {
    if (!plan || !budgetCheck.canApply) return;

    setBusyMode("applying");
    setNotice(null);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/milestones/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          milestones: plan.milestones.map((m) => ({
            id: m.id,
            title: m.title.trim(),
            description: m.description.trim().slice(0, 1500),
            deliverables: m.deliverables,
            acceptanceCriteria: m.acceptanceCriteria,
            amountMinor: m.proposedAmountMinor!,
            currency: projectCurrency,
            dueDate: m.dueDate ?? null,
            dependsOn: m.dependsOn,
            estimatedDuration: m.estimatedDuration,
          })),
          source: proposalState === "AI_EDITED" ? "AI_EDITED" : "AI_ASSISTED",
          confirmNewRevision: requiresRevisionConfirmation ? confirmNewRevision : false,
        }),
      });

      const payload = (await res.json()) as {
        data?: {
          agreementVersion?: { version_number: number };
          revisionCreated?: boolean;
          requiresClientApproval?: boolean;
          milestonesTableSynced?: boolean;
        };
        error?: string;
        message?: string;
      };

      if (!res.ok || !payload.data) {
        throw new Error(payload.message ?? payload.error ?? "Failed to apply milestone plan.");
      }

      const verNum = payload.data.agreementVersion?.version_number;
      setPlan(null);
      setProposalState("NONE");
      setConfirmNewRevision(false);
      setNotice(
        payload.data.revisionCreated
          ? `Milestone plan saved into new Draft Agreement Version ${verNum ?? ""}. Send the draft for client OTP approval to formalize it.`
          : `Milestone plan saved to Draft Agreement Version ${verNum ?? ""}. Review and send for client approval when ready.`
      );

      if (onPlanApplied) {
        onPlanApplied();
      }
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to apply milestone plan.");
    } finally {
      setBusyMode("idle");
    }
  }

  return (
    <Card className="p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">
              Milestone planning
            </p>
            <Badge tone="neutral">Free Tier AI</Badge>
          </div>
          <h2 className="mt-1 font-display text-2xl text-ink-950">
            Standalone milestone planner
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            Generate, review, reorder, and refine proposed milestones independently before applying them to a draft agreement.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {plan && (
            <Button
              disabled={busyMode !== "idle"}
              onClick={handleDiscardProposal}
              type="button"
              variant="ghost"
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Discard proposal
            </Button>
          )}
          {canUseAi && (
            <Button
              disabled={busyMode !== "idle"}
              onClick={handleGeneratePlan}
              type="button"
              variant={plan ? "secondary" : "primary"}
            >
              {busyMode === "generating" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : plan ? (
                <RefreshCw className="mr-2 h-4 w-4" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              {plan ? "Regenerate proposal" : "Generate milestone plan"}
            </Button>
          )}
        </div>
      </div>

      {/* Explicit Status Legend / Current Persisted State */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-ink-200 bg-ink-50/60 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-800">
              Formally agreed milestones
            </span>
            <Badge tone={hasApprovedAgreement || formallyAgreedMilestones.length > 0 ? "success" : "neutral"}>
              {hasApprovedAgreement || formallyAgreedMilestones.length > 0
                ? "Formally Agreed"
                : "Not Yet Agreed"}
            </Badge>
          </div>
          {formallyAgreedMilestones.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-xs text-ink-800">
              {formallyAgreedMilestones.map((m) => (
                <li className="flex items-center justify-between gap-2" key={m.id}>
                  <span className="font-medium">
                    {m.sort_order + 1}. {m.title}
                  </span>
                  <span className="text-ink-600">
                    {formatMoney(m.amount_minor, m.currency)} · {m.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : hasApprovedAgreement && agreedVersionMilestones.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-xs text-ink-800">
              {agreedVersionMilestones.map((m, idx) => (
                <li className="flex items-center justify-between gap-2" key={m.id || idx}>
                  <span className="font-medium">
                    {idx + 1}. {m.title}
                  </span>
                  <span className="text-ink-600">
                    {formatMoney(m.amountMinor, m.currency)} · Approved v{currentVersionNumber ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-ink-600">
              No milestones have formal bilateral client approval yet.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-ink-200 bg-ink-50/60 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-ink-800">
              Saved milestones (Workspace draft)
            </span>
            <Badge tone={savedDraftMilestones.length > 0 || (!hasApprovedAgreement && draftVersionMilestones.length > 0) ? "info" : "neutral"}>
              Saved Draft
            </Badge>
          </div>
          {savedDraftMilestones.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-xs text-ink-800">
              {savedDraftMilestones.map((m) => (
                <li className="flex items-center justify-between gap-2" key={m.id}>
                  <span className="font-medium">
                    {m.sort_order + 1}. {m.title}
                  </span>
                  <span className="text-ink-600">
                    {formatMoney(m.amount_minor, m.currency)} · {m.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : !hasApprovedAgreement && draftVersionMilestones.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-xs text-ink-800">
              {draftVersionMilestones.map((m, idx) => (
                <li className="flex items-center justify-between gap-2" key={m.id || idx}>
                  <span className="font-medium">
                    {idx + 1}. {m.title}
                  </span>
                  <span className="text-ink-600">
                    {formatMoney(m.amountMinor, m.currency)} · Draft Agreement
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-ink-600">
              No saved draft milestones currently stored in the workspace.
            </p>
          )}
        </div>
      </div>

      {/* Generation Options */}
      {canUseAi ? (
        <div className="mt-5 space-y-3 rounded-xl border border-ink-200 bg-white p-4">
          <label className="block text-xs font-semibold uppercase tracking-wider text-ink-700">
            Optional planning guidance
            <input
              aria-label="Planning goal"
              className="mt-1.5 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
              onChange={(e) => setPlanningGoal(e.target.value)}
              placeholder="e.g., Separate backend API delivery from frontend UI polish and QA"
              value={planningGoal}
            />
          </label>
          {confirmedBudgetMinor != null && confirmedBudgetMinor > 0 && (
            <label className="inline-flex items-center gap-2 text-xs font-medium text-ink-800">
              <input
                checked={includeFinancialAllocation}
                className="h-4 w-4 rounded border-ink-300 text-teal-700"
                onChange={(e) => setIncludeFinancialAllocation(e.target.checked)}
                type="checkbox"
              />
              Propose minor-unit financial allocation against confirmed project budget (
              {formatMoney(confirmedBudgetMinor, projectCurrency)})
            </label>
          )}
        </div>
      ) : (
        <p className="mt-4 rounded-xl bg-ink-50 p-3 text-sm text-ink-700">
          Gemini AI is not configured in this environment. You can continue managing milestones in the Agreement Editor below.
        </p>
      )}

      {errorMsg && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
          <span>{errorMsg}</span>
        </div>
      )}

      {notice && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
          <span>{notice}</span>
        </div>
      )}

      {/* Staged AI Proposal Review & Editor */}
      {plan && (
        <div className="mt-6 space-y-5 border-t border-ink-200 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Bot className="h-4 w-4 text-amber-800" />
                <span className="text-sm font-bold text-amber-950">
                  {proposalState === "AI_EDITED"
                    ? "User-Edited Milestone Proposal (Unsaved Preview)"
                    : "AI-Proposed Milestone Plan (Preview Only)"}
                </span>
                <Badge tone={proposalState === "AI_EDITED" ? "warning" : "info"}>
                  {proposalState === "AI_EDITED" ? "User-Edited Proposal" : "AI-Proposed Milestones"}
                </Badge>
              </div>
              <p className="text-xs text-amber-900">
                Unapproved draft proposal — NOT a confirmed agreement or payment schedule. Review all details carefully before applying.
              </p>
            </div>
            <div className="text-right text-xs text-amber-950">
              <p className="font-semibold">
                {plan.milestoneCount} planned milestones
              </p>
              {plan.overallTimelineEstimate && (
                <p className="inline-flex items-center gap-1 text-amber-800">
                  <Clock className="h-3 w-3" /> {plan.overallTimelineEstimate}
                </p>
              )}
            </div>
          </div>

          {/* Individual Milestone Cards */}
          <div className="space-y-4">
            {plan.milestones.map((milestone, index) => {
              const earlierMilestones = plan.milestones.filter(
                (other) => other.position < milestone.position
              );
              const { allocatedMinor } = sumAllocatedMinorUnits(plan.milestones);
              const diffMinor =
                confirmedBudgetMinor != null
                  ? confirmedBudgetMinor - allocatedMinor
                  : null;

              return (
                <div
                  className="space-y-4 rounded-xl border border-ink-200 bg-ink-50/40 p-4"
                  data-testid={`planned-milestone-${index}`}
                  key={milestone.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-teal-100 px-2 py-0.5 text-xs font-bold text-teal-900">
                        Position #{milestone.position}
                      </span>
                      <span className="text-xs font-mono text-ink-500">{milestone.id}</span>
                      <Badge tone={proposalState === "AI_EDITED" ? "warning" : "info"}>
                        {proposalState === "AI_EDITED" ? "User-Edited" : "AI-Proposed"}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        aria-label={`Move milestone ${milestone.position} up`}
                        className="min-h-7 px-2 text-xs"
                        disabled={busyMode !== "idle" || index === 0}
                        onClick={() =>
                          updateMilestones(movePlannedMilestone(plan.milestones, index, "up"))
                        }
                        type="button"
                        variant="ghost"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        aria-label={`Move milestone ${milestone.position} down`}
                        className="min-h-7 px-2 text-xs"
                        disabled={busyMode !== "idle" || index === plan.milestones.length - 1}
                        onClick={() =>
                          updateMilestones(movePlannedMilestone(plan.milestones, index, "down"))
                        }
                        type="button"
                        variant="ghost"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs font-semibold text-ink-800">
                      Milestone Title
                      <input
                        className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600"
                        onChange={(e) =>
                          updateSingleMilestone(index, { title: e.target.value })
                        }
                        value={milestone.title}
                      />
                    </label>

                    <label className="text-xs font-semibold text-ink-800">
                      Proposed Amount (minor units) · {milestone.currency ?? projectCurrency}
                      <input
                        className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600"
                        min={1}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          if (raw === "") {
                            updateSingleMilestone(index, { proposedAmountMinor: null });
                          } else {
                            const num = Number(raw);
                            if (Number.isFinite(num)) {
                              updateSingleMilestone(index, {
                                proposedAmountMinor: Math.max(1, Math.trunc(num)),
                                currency: milestone.currency ?? projectCurrency,
                              });
                            }
                          }
                        }}
                        placeholder="Unassigned"
                        type="number"
                        value={milestone.proposedAmountMinor ?? ""}
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs font-semibold text-ink-800">
                      Estimated Duration
                      <input
                        className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600"
                        onChange={(e) =>
                          updateSingleMilestone(index, {
                            estimatedDuration: e.target.value.trim() || null,
                          })
                        }
                        placeholder="Not specified"
                        value={milestone.estimatedDuration ?? ""}
                      />
                    </label>

                    <label className="text-xs font-semibold text-ink-800">
                      Target Due Date (optional)
                      <input
                        className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600"
                        onChange={(e) =>
                          updateSingleMilestone(index, {
                            dueDate: e.target.value || null,
                          })
                        }
                        type="date"
                        value={milestone.dueDate ?? ""}
                      />
                    </label>
                  </div>

                  <label className="block text-xs font-semibold text-ink-800">
                    Description
                    <textarea
                      className="mt-1 min-h-20 w-full rounded-xl border border-ink-200 bg-white p-2.5 text-sm font-normal outline-none focus:border-teal-600"
                      onChange={(e) =>
                        updateSingleMilestone(index, { description: e.target.value })
                      }
                      value={milestone.description}
                    />
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs font-semibold text-ink-800">
                      Deliverables (one per line)
                      <textarea
                        className="mt-1 min-h-20 w-full rounded-xl border border-ink-200 bg-white p-2.5 text-sm font-normal outline-none focus:border-teal-600"
                        onChange={(e) =>
                          updateSingleMilestone(index, {
                            deliverables: linesToArray(e.target.value),
                          })
                        }
                        value={milestone.deliverables.join("\n")}
                      />
                    </label>

                    <label className="block text-xs font-semibold text-ink-800">
                      Acceptance Criteria (one per line)
                      <textarea
                        className="mt-1 min-h-20 w-full rounded-xl border border-ink-200 bg-white p-2.5 text-sm font-normal outline-none focus:border-teal-600"
                        onChange={(e) =>
                          updateSingleMilestone(index, {
                            acceptanceCriteria: linesToArray(e.target.value),
                          })
                        }
                        value={milestone.acceptanceCriteria.join("\n")}
                      />
                    </label>
                  </div>

                  {/* Dependencies selector */}
                  {earlierMilestones.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs font-semibold text-ink-800">
                        Depends on preceding milestones
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {earlierMilestones.map((dep) => {
                          const checked = milestone.dependsOn.includes(dep.id);
                          return (
                            <label
                              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs text-ink-800"
                              key={dep.id}
                            >
                              <input
                                checked={checked}
                                onChange={() =>
                                  updateMilestones(
                                    toggleMilestoneDependency(plan.milestones, index, dep.id)
                                  )
                                }
                                type="checkbox"
                              />
                              #{dep.position} {dep.title}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {(milestone.assumptions.length > 0 || milestone.openQuestions.length > 0) && (
                    <div className="grid gap-2 rounded-lg bg-white p-3 text-xs sm:grid-cols-2">
                      {milestone.assumptions.length > 0 && (
                        <div>
                          <p className="font-semibold text-ink-800">Assumptions</p>
                          <ul className="mt-1 list-disc pl-4 text-ink-600">
                            {milestone.assumptions.map((a, idx) => (
                              <li key={idx}>{a}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {milestone.openQuestions.length > 0 && (
                        <div>
                          <p className="font-semibold text-ink-800">Open questions</p>
                          <ul className="mt-1 list-disc pl-4 text-ink-600">
                            {milestone.openQuestions.map((q, idx) => (
                              <li key={idx}>{q}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {index === plan.milestones.length - 1 && confirmedBudgetMinor != null && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 pt-3 text-xs">
                      <span className="font-semibold text-ink-800">
                        Proposed sum: {formatMoney(allocatedMinor, projectCurrency)} / Budget:{" "}
                        {formatMoney(confirmedBudgetMinor, projectCurrency)}
                      </span>
                      {diffMinor === 0 ? (
                        <span className="font-semibold text-teal-700">Reconciled cleanly</span>
                      ) : (
                        <span className="font-semibold text-amber-800">
                          Difference: {diffMinor !== null && diffMinor > 0 ? `+${diffMinor}` : diffMinor} minor units
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Plan-Level Unresolved Questions & Risks */}
          {(plan.unresolvedQuestions.length > 0 ||
            plan.risksAndDependencies.length > 0 ||
            plan.assumptions.length > 0) && (
            <div className="grid gap-4 rounded-xl border border-ink-200 bg-ink-50/50 p-4 text-xs sm:grid-cols-3">
              <div>
                <p className="flex items-center gap-1 font-bold text-ink-900">
                  <HelpCircle className="h-3.5 w-3.5 text-teal-700" />
                  Unresolved planning questions
                </p>
                {plan.unresolvedQuestions.length > 0 ? (
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ink-700">
                    {plan.unresolvedQuestions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-ink-500">None raised.</p>
                )}
              </div>

              <div>
                <p className="flex items-center gap-1 font-bold text-ink-900">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
                  Delivery risks & dependencies
                </p>
                {plan.risksAndDependencies.length > 0 ? (
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ink-700">
                    {plan.risksAndDependencies.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-ink-500">None raised.</p>
                )}
              </div>

              <div>
                <p className="font-bold text-ink-900">Plan assumptions</p>
                {plan.assumptions.length > 0 ? (
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ink-700">
                    {plan.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-ink-500">None listed.</p>
                )}
              </div>
            </div>
          )}

          {/* Approved Agreement Protection Gate */}
          {requiresRevisionConfirmation && (
            <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950">
              <p className="font-bold text-amber-900">
                {hasApprovedAgreement
                  ? `Approved Agreement Protection (Version ${currentVersionNumber ?? ""})`
                  : "Agreement Review In Progress"}
              </p>
              <p className="text-amber-800">
                {hasApprovedAgreement
                  ? "This project already has a formally approved agreement. Applying a new milestone plan will NOT alter the approved agreement directly; instead, it creates a new Draft agreement revision requiring client OTP re-approval. Existing committed/paid milestones are never overwritten."
                  : "This agreement is currently awaiting client review. Applying a new milestone plan requires creating a new Draft revision."}
              </p>
              <label className="inline-flex items-center gap-2 font-semibold text-amber-950">
                <input
                  checked={confirmNewRevision}
                  onChange={(e) => setConfirmNewRevision(e.target.checked)}
                  type="checkbox"
                />
                I confirm creating a new Draft agreement revision requiring client re-approval
              </label>
            </div>
          )}

          {!budgetCheck.canApply && budgetCheck.reason && (
            <p className="text-xs font-medium text-amber-800">{budgetCheck.reason}</p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button
              disabled={busyMode !== "idle"}
              onClick={handleDiscardProposal}
              type="button"
              variant="ghost"
            >
              Discard proposal
            </Button>
            <Button
              disabled={busyMode !== "idle" || !budgetCheck.canApply}
              onClick={handleApplyPlan}
              type="button"
            >
              {busyMode === "applying" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileCheck2 className="mr-2 h-4 w-4" />
              )}
              Apply milestone plan to agreement draft
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
