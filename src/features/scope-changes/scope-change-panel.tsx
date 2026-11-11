"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  DollarSign,
  FileDiff,
  Lock,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ChangeRequest } from "@/features/projects/types";
import { normalizeChangeRequestText } from "@/features/scope-changes/classification";
import {
  storedScopeChangeAnalysisSchema,
  type ScopeChangeOverallClassification,
  type StoredScopeChangeAnalysis,
} from "@/features/scope-changes/schema";
import { formatMoney } from "@/lib/utils";

export interface ScopeChangePanelProps {
  mode: "freelancer" | "client";
  projectId?: string;
  portalToken?: string;
  csrfToken?: string;
  projectCurrency: string | null;
  confirmedBudgetMinor: number | null;
  agreementVersionId: string | null;
  agreementVersionNumber: number | null;
  agreementStatus: string | null;
  canUseAi: boolean;
  initialChangeRequests: ChangeRequest[];
}

function classificationTone(
  classification: ScopeChangeOverallClassification
): "success" | "warning" | "neutral" {
  switch (classification) {
    case "LOW":
      return "success";
    case "HIGH":
    case "INSUFFICIENT_INFORMATION":
      return "warning";
    case "MODERATE":
    default:
      return "neutral";
  }
}

function formatClassificationLabel(classification: ScopeChangeOverallClassification): string {
  switch (classification) {
    case "LOW":
      return "Low Scope Impact";
    case "MODERATE":
      return "Moderate Scope Impact";
    case "HIGH":
      return "High Scope Impact";
    case "INSUFFICIENT_INFORMATION":
      return "Insufficient Information";
  }
}

function formatRequestStatusBadge(status: string) {
  switch (status) {
    case "OPEN":
      return <Badge tone="warning">Open Request</Badge>;
    case "RESOLVED":
      return <Badge tone="success">Resolved</Badge>;
    case "WITHDRAWN":
      return <Badge tone="neutral">Withdrawn</Badge>;
    default:
      return <Badge tone="neutral">{status}</Badge>;
  }
}

function formatDeltaAmount(deltaMinor: number, currency: string): string {
  if (deltaMinor === 0) return formatMoney(0, currency);
  const absFormatted = formatMoney(Math.abs(deltaMinor), currency);
  return deltaMinor > 0 ? `+${absFormatted}` : `-${absFormatted}`;
}

function ScopeAnalysisView({ analysis }: { analysis: StoredScopeChangeAnalysis }) {
  const { financialImpact, timelineImpact } = analysis;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-xs text-amber-950">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-700 mt-0.5" />
          <div>
            <p className="font-bold">AI Proposal — Requires Human Review (Non-Contractual)</p>
            <p className="mt-0.5 leading-relaxed">
              {financialImpact.requiresHumanReviewNotice} Baseline compared: Agreement v
              {analysis.originalAgreementContext.agreementVersionNumber} (
              {analysis.originalAgreementContext.agreementStatus}).
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={classificationTone(analysis.overallClassification)}>
          {formatClassificationLabel(analysis.overallClassification)}
        </Badge>
        <Badge tone="neutral">Type: {analysis.changeSummary.changeType}</Badge>
        {analysis.snapshotMetadata.model ? (
          <Badge tone="neutral">Model: {analysis.snapshotMetadata.model}</Badge>
        ) : null}
      </div>

      <div className="rounded-xl border border-ink-100 bg-white p-4">
        <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
          Change Summary & Classification Basis
        </h4>
        <p className="mt-1.5 text-sm text-ink-900">
          {analysis.changeSummary.requestedChangeSummary}
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-700">
          {analysis.classificationCriteria.map((criterion, idx) => (
            <li key={idx}>{criterion}</li>
          ))}
        </ul>
        {analysis.changeSummary.conflictsOrContradictions.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-bold">Conflicts or Ambiguities Detected:</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {analysis.changeSummary.conflictsOrContradictions.map((c, idx) => (
                <li key={idx}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Financial & Timeline Grid */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-ink-100 bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink-700">
            <DollarSign className="h-4 w-4 text-teal-700" />
            <span>Conservative Financial Impact</span>
          </div>
          <dl className="mt-2.5 space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-600">Direction:</dt>
              <dd className="font-semibold text-ink-950">{financialImpact.direction}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-600">Existing Agreed Budget:</dt>
              <dd className="font-semibold text-ink-950">
                {financialImpact.existingAgreedBudgetMinor !== null && financialImpact.currency
                  ? formatMoney(financialImpact.existingAgreedBudgetMinor, financialImpact.currency)
                  : "Unconfirmed"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-600">AI-Proposed Delta:</dt>
              <dd className="font-semibold text-ink-950">
                {financialImpact.proposedCostDeltaMinor !== null && financialImpact.currency
                  ? formatDeltaAmount(
                      financialImpact.proposedCostDeltaMinor,
                      financialImpact.currency
                    )
                  : "Cannot estimate responsibly"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-600">Proposed Revised Total:</dt>
              <dd className="font-semibold text-ink-950">
                {financialImpact.proposedRevisedTotalMinor !== null && financialImpact.currency
                  ? formatMoney(financialImpact.proposedRevisedTotalMinor, financialImpact.currency)
                  : "Unset"}
              </dd>
            </div>
          </dl>
          {financialImpact.costDriversJustification ? (
            <p className="mt-2.5 text-xs text-ink-700 leading-relaxed">
              <strong>Cost drivers:</strong> {financialImpact.costDriversJustification}
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-ink-100 bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink-700">
            <Clock className="h-4 w-4 text-teal-700" />
            <span>Timeline Impact</span>
          </div>
          <p className="mt-2 text-xs font-semibold text-ink-950">
            {timelineImpact.classification.replaceAll("_", " ")}
            {timelineImpact.classification === "POTENTIAL_EXTENSION" &&
            timelineImpact.estimatedAdditionalDaysMin !== null &&
            timelineImpact.estimatedAdditionalDaysMax !== null
              ? ` (+${timelineImpact.estimatedAdditionalDaysMin} to ${timelineImpact.estimatedAdditionalDaysMax} days estimated)`
              : ""}
          </p>
          <p className="mt-1.5 text-xs text-ink-700 leading-relaxed">
            {timelineImpact.explanation}
          </p>
          {timelineImpact.parallelWorkNotes ? (
            <p className="mt-1.5 text-xs text-ink-600">
              <strong>Parallel work:</strong> {timelineImpact.parallelWorkNotes}
            </p>
          ) : null}
          {timelineImpact.missingSchedulingInformation.length > 0 && (
            <div className="mt-2 text-xs text-amber-900">
              <p className="font-semibold">Missing scheduling info:</p>
              <ul className="list-disc pl-4">
                {timelineImpact.missingSchedulingInformation.map((info, idx) => (
                  <li key={idx}>{info}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Affected Deliverables & Affected Milestones */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-ink-100 bg-white p-4">
          <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
            Affected Deliverables ({analysis.affectedDeliverables.length})
          </h4>
          {analysis.affectedDeliverables.length === 0 ? (
            <p className="mt-2 text-xs text-ink-500">No existing deliverables directly altered.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-xs">
              {analysis.affectedDeliverables.map((item, idx) => (
                <li key={idx} className="rounded-lg bg-slate-50 p-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-ink-950">{item.deliverable}</span>
                    <Badge tone="neutral">{item.impactType}</Badge>
                  </div>
                  <p className="mt-1 text-ink-700">{item.explanation}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-ink-100 bg-white p-4">
          <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
            Affected Milestones ({analysis.affectedMilestones.length})
          </h4>
          {analysis.affectedMilestones.length === 0 ? (
            <p className="mt-2 text-xs text-ink-500">No existing milestones affected.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-xs">
              {analysis.affectedMilestones.map((m, idx) => (
                <li
                  key={idx}
                  className={`rounded-lg p-2.5 ${
                    m.isPaymentLinkedOrLocked
                      ? "border border-amber-300 bg-amber-50/70"
                      : "bg-slate-50"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-ink-950">{m.milestoneTitle}</span>
                    <Badge tone="neutral">{m.impactType}</Badge>
                    {m.isPaymentLinkedOrLocked ? (
                      <Badge tone="warning">
                        <Lock className="mr-1 h-3 w-3" />
                        Locked / Payment-Linked Milestone
                      </Badge>
                    ) : null}
                  </div>
                  {m.existingAmountMinor !== null && m.currency ? (
                    <p className="mt-1 font-medium text-ink-800">
                      Existing agreed allocation: {formatMoney(m.existingAmountMinor, m.currency)} (
                      {m.currentStatus ?? "Saved"})
                    </p>
                  ) : null}
                  <p className="mt-1 text-ink-700">{m.explanation}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Proposed Additions, Removals, Dependencies, Risks, Questions & Next Steps */}
      {(analysis.proposedChanges.newDeliverables.length > 0 ||
        analysis.proposedChanges.removedOrReplacedWork.length > 0 ||
        analysis.proposedChanges.proposedNewMilestones.length > 0) && (
        <div className="rounded-xl border border-ink-100 bg-white p-4 space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
            Proposed Additions & Removals (AI Proposal Only)
          </h4>
          {analysis.proposedChanges.newDeliverables.length > 0 && (
            <div className="text-xs">
              <p className="font-semibold text-ink-900">Proposed New Deliverables:</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-ink-700">
                {analysis.proposedChanges.newDeliverables.map((d, idx) => (
                  <li key={idx}>
                    <strong>{d.title}:</strong> {d.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {analysis.proposedChanges.removedOrReplacedWork.length > 0 && (
            <div className="text-xs">
              <p className="font-semibold text-ink-900">Removed or Replaced Scope:</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-ink-700">
                {analysis.proposedChanges.removedOrReplacedWork.map((r, idx) => (
                  <li key={idx}>
                    <strong>{r.item}:</strong> {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {analysis.proposedChanges.proposedNewMilestones.length > 0 && (
            <div className="text-xs">
              <p className="font-semibold text-ink-900">Proposed Additional Milestones:</p>
              <ul className="mt-1 space-y-1 text-ink-700">
                {analysis.proposedChanges.proposedNewMilestones.map((pm, idx) => (
                  <li key={idx} className="rounded-md bg-slate-50 px-2.5 py-1.5">
                    <strong>{pm.title}</strong>
                    {pm.proposedAdditionalAmountMinor !== null && pm.currency
                      ? ` — AI Proposal: ${formatMoney(pm.proposedAdditionalAmountMinor, pm.currency)}`
                      : ""}
                    {pm.estimatedDuration ? ` (${pm.estimatedDuration})` : ""}
                    <span className="block text-ink-600">{pm.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-ink-100 bg-white p-4 text-xs space-y-2">
          <h4 className="font-bold uppercase tracking-wider text-ink-700">
            Risks & Dependency Changes
          </h4>
          {analysis.dependencyChanges.length > 0 && (
            <ul className="list-disc space-y-1 pl-4 text-ink-700">
              {analysis.dependencyChanges.map((dep, idx) => (
                <li key={idx}>
                  <strong>[{dep.dependencyType}]</strong> {dep.description}
                </li>
              ))}
            </ul>
          )}
          {analysis.riskAssessment.length > 0 ? (
            <ul className="space-y-1.5">
              {analysis.riskAssessment.map((risk, idx) => (
                <li key={idx} className="rounded-md bg-slate-50 p-2">
                  <span className="font-semibold text-ink-950">
                    [{risk.severity}] {risk.title}:
                  </span>{" "}
                  <span className="text-ink-700">{risk.mitigation}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-500">No material new delivery risks flagged.</p>
          )}
        </div>

        <div className="rounded-xl border border-ink-100 bg-white p-4 text-xs space-y-2">
          <h4 className="font-bold uppercase tracking-wider text-ink-700">
            Questions, Assumptions & Next Steps
          </h4>
          {analysis.unresolvedQuestions.length > 0 && (
            <div>
              <p className="font-semibold text-ink-900">Clarification Questions:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-700">
                {analysis.unresolvedQuestions.map((q, idx) => (
                  <li key={idx}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.assumptions.length > 0 && (
            <div>
              <p className="font-semibold text-ink-900">Assumptions:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-700">
                {analysis.assumptions.map((a, idx) => (
                  <li key={idx}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.recommendedNextSteps.length > 0 && (
            <div>
              <p className="font-semibold text-ink-900">Recommended Next Steps:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-700">
                {analysis.recommendedNextSteps.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ScopeChangePanel({
  mode,
  projectId,
  portalToken,
  csrfToken,
  projectCurrency,
  confirmedBudgetMinor,
  agreementVersionId,
  agreementVersionNumber,
  agreementStatus,
  canUseAi,
  initialChangeRequests,
}: ScopeChangePanelProps) {
  const router = useRouter();
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>(initialChangeRequests);
  const [requestText, setRequestText] = useState("");
  const [previewAnalysis, setPreviewAnalysis] = useState<StoredScopeChangeAnalysis | null>(null);
  const [analyzedRequestText, setAnalyzedRequestText] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const hasAgreementVersion = Boolean(agreementVersionId);
  const isStaleAnalysis =
    previewAnalysis !== null &&
    analyzedRequestText !== null &&
    normalizeChangeRequestText(requestText) !== normalizeChangeRequestText(analyzedRequestText);

  const analyzeUrl =
    mode === "client" && portalToken
      ? `/api/public/portal/${encodeURIComponent(portalToken)}/scope-change/analyze`
      : "/api/ai/analyze-scope-change";

  const submitUrl =
    mode === "client" && portalToken
      ? `/api/public/portal/${encodeURIComponent(portalToken)}/change-requests`
      : `/api/projects/${projectId}/change-requests`;

  function buildHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (mode === "client" && csrfToken) {
      headers["x-csrf-token"] = csrfToken;
    }
    return headers;
  }

  async function handleAnalyze() {
    if (!hasAgreementVersion || !agreementVersionId) {
      setErrorMsg("An agreement version is required before running scope-change analysis.");
      return;
    }
    if (requestText.trim().length < 3) {
      setErrorMsg("Please describe the requested scope change (at least 3 characters).");
      return;
    }

    setBusy(true);
    setErrorMsg(null);
    setNotice(null);

    try {
      const payload =
        mode === "client"
          ? { agreementVersionId, requestText }
          : { projectId, agreementVersionId, requestText };

      const response = await fetch(analyzeUrl, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(payload),
      });

      const json = (await response.json()) as {
        data?: { analysis?: StoredScopeChangeAnalysis };
        error?: string;
        message?: string;
      };

      if (!response.ok || !json.data?.analysis) {
        setErrorMsg(json.message ?? json.error ?? "Unable to analyze scope change right now.");
        return;
      }

      setPreviewAnalysis(json.data.analysis);
      setAnalyzedRequestText(requestText);
      setNotice(
        "AI scope-change analysis ready in preview. Review all impacts carefully before deciding to submit."
      );
    } catch {
      setErrorMsg("Network error analyzing scope change.");
    } finally {
      setBusy(false);
    }
  }

  function handleDiscardPreview() {
    setPreviewAnalysis(null);
    setAnalyzedRequestText(null);
    setErrorMsg(null);
    setNotice(
      "AI proposal discarded from preview. No change request or agreement change was saved."
    );
  }

  async function handleSubmitChangeRequest() {
    if (!hasAgreementVersion || !agreementVersionId) {
      setErrorMsg("An agreement version is required before submitting a change request.");
      return;
    }
    if (requestText.trim().length < 3) {
      setErrorMsg("Please describe the requested scope change (at least 3 characters).");
      return;
    }
    if (isStaleAnalysis) {
      setErrorMsg(
        "Your request text changed after analysis. Regenerate the AI analysis or discard it before submitting."
      );
      return;
    }

    setBusy(true);
    setErrorMsg(null);
    setNotice(null);

    try {
      const response = await fetch(submitUrl, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          requestText,
          agreementVersionId,
          aiAnalysis: previewAnalysis,
        }),
      });

      const json = (await response.json()) as {
        data?: { changeRequest?: ChangeRequest };
        error?: string;
        message?: string;
      };

      if (!response.ok || !json.data?.changeRequest) {
        setErrorMsg(json.message ?? json.error ?? "Unable to submit change request.");
        return;
      }

      setChangeRequests((prev) => [json.data!.changeRequest!, ...prev]);
      setRequestText("");
      setPreviewAnalysis(null);
      setAnalyzedRequestText(null);
      setNotice(
        "Change request submitted for review. Contractual terms remain unchanged until a new agreement revision is mutually approved."
      );
      router.refresh();
    } catch {
      setErrorMsg("Network error submitting change request.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateStatus(changeRequestId: string, status: "RESOLVED" | "WITHDRAWN") {
    if (mode !== "freelancer" || !projectId) return;
    setBusy(true);
    setErrorMsg(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/projects/${projectId}/change-requests/${changeRequestId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }
      );

      const json = (await response.json()) as {
        data?: { changeRequest?: ChangeRequest };
        error?: string;
        message?: string;
      };

      if (!response.ok || !json.data?.changeRequest) {
        setErrorMsg(json.message ?? json.error ?? "Unable to update change request status.");
        return;
      }

      setChangeRequests((prev) =>
        prev.map((cr) => (cr.id === changeRequestId ? json.data!.changeRequest! : cr))
      );
      setNotice(
        status === "RESOLVED"
          ? "Marked change request resolved. Update and send a formal agreement revision (vN+1) if contractual changes are needed."
          : "Change request marked withdrawn."
      );
      router.refresh();
    } catch {
      setErrorMsg("Network error updating change request status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6 space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FileDiff className="h-5 w-5 text-teal-700" />
            <h2 className="font-display text-xl text-ink-950">Scope Changes & AI Impact</h2>
          </div>
          <p className="mt-1 text-xs text-ink-600">
            Propose a scope adjustment and preview conservative AI impact analysis against{" "}
            {agreementVersionNumber
              ? `Agreement v${agreementVersionNumber} (${agreementStatus ?? "Draft"})`
              : "the project agreement"}
            {confirmedBudgetMinor !== null && projectCurrency
              ? ` · Confirmed budget: ${formatMoney(confirmedBudgetMinor, projectCurrency)}`
              : ""}
            . Submitting never auto-approves or edits agreements, milestones, or payments.
          </p>
        </div>
        <Badge tone="neutral">{changeRequests.length} Request(s)</Badge>
      </div>

      {!hasAgreementVersion && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950">
          Create or generate an initial agreement draft before analyzing or submitting scope
          changes.
        </div>
      )}

      {/* Composer & Preview Controls */}
      <div className="space-y-3 rounded-xl border border-ink-100 bg-slate-50/70 p-4">
        <label className="block text-sm font-semibold text-ink-900">
          Describe Requested Scope Change
          <textarea
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            rows={4}
            maxLength={10000}
            disabled={busy || !hasAgreementVersion}
            placeholder="Describe what should be added, modified, or removed, along with any target dates or constraints..."
            className="mt-2 w-full rounded-xl border border-ink-200 bg-white p-3 text-sm font-normal text-ink-900 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
          />
        </label>

        {isStaleAnalysis && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700 mt-0.5" />
            <div>
              <p className="font-bold">Previous AI Analysis Marked Stale</p>
              <p className="mt-0.5">
                You modified the change request text after generating the analysis. Regenerate the
                AI analysis before submitting with an attached assessment, or discard the stale
                analysis to submit plain request text only.
              </p>
            </div>
          </div>
        )}

        {errorMsg && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900">
            {errorMsg}
          </div>
        )}

        {notice && (
          <div role="status" className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-xs text-teal-950">
            {notice}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2.5">
          {canUseAi ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !hasAgreementVersion || requestText.trim().length < 3}
              onClick={handleAnalyze}
            >
              {previewAnalysis ? (
                <>
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                  {busy ? "Analyzing..." : "Regenerate Analysis"}
                </>
              ) : (
                <>
                  <Bot className="mr-1.5 h-4 w-4" />
                  {busy ? "Analyzing..." : "Analyze Scope Impact"}
                </>
              )}
            </Button>
          ) : (
            <span className="text-xs text-ink-500">
              AI scope analysis unavailable (`GEMINI_API_KEY` not configured); you can still submit
              change requests manually.
            </span>
          )}

          {previewAnalysis && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={handleDiscardPreview}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Discard Proposal
            </Button>
          )}

          <Button
            type="button"
            disabled={
              busy ||
              !hasAgreementVersion ||
              requestText.trim().length < 3 ||
              isStaleAnalysis
            }
            onClick={handleSubmitChangeRequest}
          >
            <Send className="mr-1.5 h-4 w-4" />
            {busy ? "Submitting..." : "Submit Change Request"}
          </Button>
        </div>

        {previewAnalysis && (
          <div className="pt-2">
            <ScopeAnalysisView analysis={previewAnalysis} />
          </div>
        )}
      </div>

      {/* Saved Change Requests History */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-wider text-ink-700">
          Submitted Change Requests
        </h3>

        {changeRequests.length === 0 ? (
          <p className="text-xs text-ink-500">No change requests have been submitted yet.</p>
        ) : (
          <ul className="space-y-3">
            {changeRequests.map((cr) => {
              const parsedAnalysis = storedScopeChangeAnalysisSchema.safeParse(cr.ai_analysis);
              const isExpanded = expandedId === cr.id;
              const isCrAnalysisStale =
                cr.status === "OPEN" &&
                parsedAnalysis.success &&
                Boolean(agreementVersionId) &&
                Boolean(cr.agreement_version_id) &&
                cr.agreement_version_id !== agreementVersionId;

              return (
                <li
                  key={cr.id}
                  className="rounded-xl border border-ink-100 bg-white p-4 space-y-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {formatRequestStatusBadge(cr.status)}
                        <span className="text-xs font-semibold text-ink-800">
                          {cr.submitted_by_label}
                        </span>
                        <span className="text-xs text-ink-500">
                          · {new Date(cr.created_at).toLocaleString()}
                        </span>
                        {parsedAnalysis.success ? (
                          <Badge
                            tone={classificationTone(parsedAnalysis.data.overallClassification)}
                          >
                            AI Proposal:{" "}
                            {formatClassificationLabel(parsedAnalysis.data.overallClassification)}
                          </Badge>
                        ) : (
                          <Badge tone="neutral">Text Only</Badge>
                        )}
                        {isCrAnalysisStale && (
                          <Badge tone="warning">Baseline Changed (Re-run Suggested)</Badge>
                        )}
                      </div>
                      {isCrAnalysisStale && (
                        <p className="text-xs text-amber-800">
                          This analysis was generated against an earlier agreement version
                          {agreementVersionNumber ? ` before v${agreementVersionNumber}` : ""}.
                          Re-run analysis for current baseline impact.
                        </p>
                      )}

                      <div className="pt-1">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">
                          Original Request Text
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-900">
                          {cr.request_text}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {parsedAnalysis.success && (
                        <Button
                          type="button"
                          variant="secondary"
                          className="text-xs"
                          onClick={() => setExpandedId(isExpanded ? null : cr.id)}
                        >
                          {isExpanded ? "Hide AI Analysis" : "View AI Analysis"}
                        </Button>
                      )}
                      {mode === "freelancer" && cr.status === "OPEN" && (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            className="text-xs"
                            disabled={busy}
                            onClick={() => handleUpdateStatus(cr.id, "RESOLVED")}
                          >
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5 text-emerald-700" />
                            Mark Resolved
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="text-xs"
                            disabled={busy}
                            onClick={() => handleUpdateStatus(cr.id, "WITHDRAWN")}
                          >
                            Withdraw
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {isExpanded && parsedAnalysis.success && (
                    <div className="border-t border-ink-100 pt-3">
                      <ScopeAnalysisView analysis={parsedAnalysis.data} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
