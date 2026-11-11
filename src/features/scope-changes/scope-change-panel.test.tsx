import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScopeChangePanel } from "./scope-change-panel";
import type { StoredScopeChangeAnalysis } from "./schema";
import type { ChangeRequest } from "@/features/projects/types";

const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

describe("ScopeChangePanel UI Component (AI-5)", () => {
  const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const agreementVersionId = "b2222222-2222-4222-8222-222222222222";
  const portalToken = "valid-portal-token-for-scope-ui-test-12345678";
  const csrfToken = "csrf-secret-token-value-1234567890";

  function buildStoredAnalysis(overrides?: {
    summary?: string;
    requesterRole?: "OWNER" | "CLIENT";
    hash?: string;
    classification?: "LOW" | "MODERATE" | "HIGH" | "INSUFFICIENT_INFORMATION";
  }): StoredScopeChangeAnalysis {
    return {
      changeSummary: {
        requestedChangeSummary:
          overrides?.summary ?? "Add custom PDF export to Milestone 2.",
        changeType: "ADDITION",
        conflictsOrContradictions: [],
      },
      originalAgreementContext: {
        agreementVersionNumber: 1,
        agreementStatus: "APPROVED",
        confirmedBudgetMinor: 300000,
        currency: "USD",
        summaryExcerpt: "Approved v1 contract baseline.",
      },
      affectedDeliverables: [
        {
          scopeItemTitle: "Reporting Module",
          deliverable: "CSV analytics export",
          impactType: "MODIFIED",
          explanation: "Extends existing reporting export options to include PDF output.",
        },
      ],
      affectedMilestones: [
        {
          milestoneTitle: "Milestone 1: Core Architecture",
          currentStatus: "PAID",
          isPaymentLinkedOrLocked: true,
          impactType: "NO_DIRECT_CHANGE",
          existingAmountMinor: 150000,
          currency: "USD",
          explanation: "Already paid and locked; cannot be modified in place.",
        },
      ],
      proposedChanges: {
        newDeliverables: [
          {
            title: "PDF Report Exporter",
            description: "Generate printable PDF exports alongside CSV.",
            acceptanceCriteria: ["PDF renders billing summary accurately"],
            rationale: "Fulfills newly requested PDF format.",
          },
        ],
        removedOrReplacedWork: [],
        proposedNewMilestones: [
          {
            title: "Follow-Up Milestone: PDF Export Module",
            description: "Standalone milestone for requested PDF export work.",
            deliverables: ["PDF template and generator"],
            acceptanceCriteria: ["Client approves sample PDF report"],
            proposedAdditionalAmountMinor: 30000,
            currency: "USD",
            estimatedDuration: "4 days",
          },
        ],
      },
      financialImpact: {
        direction: "INCREASE",
        existingAgreedBudgetMinor: 300000,
        currency: "USD",
        proposedCostDeltaMinor: 30000,
        proposedRevisedTotalMinor: 330000,
        costDriversJustification: "PDF layout engineering and print styles.",
        reconcilesExistingMilestonesUnchanged: true,
        requiresHumanReviewNotice:
          "AI-generated financial and scope estimate only — requires mutual human review.",
      },
      timelineImpact: {
        classification: "POTENTIAL_EXTENSION",
        estimatedAdditionalDaysMin: 3,
        estimatedAdditionalDaysMax: 5,
        canProceedInParallel: false,
        parallelWorkNotes: null,
        criticalPathMilestones: ["Milestone 2: Dashboard"],
        missingSchedulingInformation: [],
        explanation: "Adds 3-5 days after dashboard layout freeze.",
      },
      dependencyChanges: [],
      riskAssessment: [
        {
          title: "Font rendering parity",
          severity: "MEDIUM",
          mitigation: "Approve static PDF sample before implementation.",
        },
      ],
      assumptions: ["Follows existing branding guidelines."],
      unresolvedQuestions: ["Confirm paper size (A4 vs US Letter)."],
      recommendedNextSteps: [
        "Discuss proposed follow-up milestone before creating v2 agreement draft.",
      ],
      overallClassification: overrides?.classification ?? "MODERATE",
      classificationCriteria: [
        "Proposes incremental budget addition (+30000 minor units).",
      ],
      snapshotMetadata: {
        analyzedRequestTextSha256: overrides?.hash ?? "a".repeat(64),
        agreementVersionId,
        agreementVersionNumber: 1,
        projectId,
        requesterRole: overrides?.requesterRole ?? "OWNER",
        analyzedAt: "2026-11-11T10:15:00.000Z",
        model: "gemini-3.8-flash",
        integrityTag: "b".repeat(64),
        isProposalOnly: true,
      },
    };
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("previews locked milestone warning, marks edited analysis stale, regenerates, discards safely, submits separated snapshot, and updates status in freelancer mode", async () => {
    const initialAnalysis = buildStoredAnalysis({
      summary: "Initial PDF export impact.",
      hash: "a".repeat(64),
    });
    const regeneratedAnalysis = buildStoredAnalysis({
      summary: "Regenerated PDF + branded watermark impact.",
      hash: "c".repeat(64),
      classification: "HIGH",
    });

    const savedChangeRequest: ChangeRequest = {
      id: "cr-new-1",
      project_id: projectId,
      agreement_version_id: agreementVersionId,
      request_text: "Add PDF invoice export with custom client watermark.",
      submitted_by_label: "Freelancer (freelancer@payroost.dev)",
      status: "OPEN",
      created_at: "2026-11-11T10:20:00.000Z",
      resolved_at: null,
      ai_analysis: regeneratedAnalysis,
      ai_analyzed_at: "2026-11-11T10:15:00.000Z",
      ai_model: "gemini-3.8-flash",
    };

    const resolvedChangeRequest: ChangeRequest = {
      ...savedChangeRequest,
      status: "RESOLVED",
      resolved_at: "2026-11-11T10:25:00.000Z",
    };

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { analysis: initialAnalysis } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { analysis: regeneratedAnalysis } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { changeRequest: savedChangeRequest } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { changeRequest: resolvedChangeRequest } }),
      });

    render(
      <ScopeChangePanel
        mode="freelancer"
        projectId={projectId}
        projectCurrency="USD"
        confirmedBudgetMinor={300000}
        agreementVersionId={agreementVersionId}
        agreementVersionNumber={1}
        agreementStatus="APPROVED"
        canUseAi={true}
        initialChangeRequests={[]}
      />
    );

    const textarea = screen.getByLabelText(/Describe Requested Scope Change/i);
    fireEvent.change(textarea, {
      target: { value: "Add PDF invoice export to Milestone 2." },
    });

    fireEvent.click(screen.getByRole("button", { name: /Analyze Scope Impact/i }));

    await waitFor(() => {
      expect(screen.getByText(/Initial PDF export impact\./i)).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/ai/analyze-scope-change",
      expect.objectContaining({ method: "POST" })
    );
    expect(
      screen.getByText(/AI Proposal — Requires Human Review \(Non-Contractual\)/i)
    ).toBeTruthy();
    expect(screen.getByText(/Locked \/ Payment-Linked Milestone/i)).toBeTruthy();
    expect(screen.getByText(/\+\$300\.00/)).toBeTruthy();

    // Edit text after preview -> stale banner & disabled submit button
    fireEvent.change(textarea, {
      target: { value: "Add PDF invoice export with custom client watermark." },
    });

    expect(screen.getByText(/Previous AI Analysis Marked Stale/i)).toBeTruthy();
    const submitBtnWhileStale = screen.getByRole("button", {
      name: /Submit Change Request/i,
    }) as HTMLButtonElement;
    expect(submitBtnWhileStale.disabled).toBe(true);

    // Regenerate analysis for updated text -> clears stale banner & re-enables submit
    fireEvent.click(screen.getByRole("button", { name: /Regenerate Analysis/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Regenerated PDF \+ branded watermark impact\./i)
      ).toBeTruthy();
    });
    expect(screen.queryByText(/Previous AI Analysis Marked Stale/i)).toBeNull();
    const submitBtnReady = screen.getByRole("button", {
      name: /Submit Change Request/i,
    }) as HTMLButtonElement;
    expect(submitBtnReady.disabled).toBe(false);

    // Explicitly submit -> persists change request with separated original text & AI snapshot
    fireEvent.click(submitBtnReady);

    await waitFor(() => {
      expect(screen.getByText(/Original Request Text/i)).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/projects/${projectId}/change-requests`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          requestText: "Add PDF invoice export with custom client watermark.",
          agreementVersionId,
          aiAnalysis: regeneratedAnalysis,
        }),
      })
    );
    expect(
      screen.getByText("Add PDF invoice export with custom client watermark.")
    ).toBeTruthy();
    expect(screen.getByText(/AI Proposal: High Scope Impact/i)).toBeTruthy();

    // Toggle saved AI analysis drawer open and mark resolved
    fireEvent.click(screen.getByRole("button", { name: /View AI Analysis/i }));
    expect(screen.getByText(/Hide AI Analysis/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Mark Resolved/i }));
    await waitFor(() => {
      expect(screen.getByText(/^Resolved$/i)).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `/api/projects/${projectId}/change-requests/cr-new-1`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "RESOLVED" }),
      })
    );
  });

  it("allows discarding AI preview without saving and preserves manual submission option", async () => {
    const previewAnalysis = buildStoredAnalysis();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { analysis: previewAnalysis } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            changeRequest: {
              id: "cr-manual-1",
              project_id: projectId,
              agreement_version_id: agreementVersionId,
              request_text: "Update footer copyright text.",
              submitted_by_label: "Freelancer (freelancer@payroost.dev)",
              status: "OPEN",
              created_at: "2026-11-11T10:30:00.000Z",
              resolved_at: null,
              ai_analysis: null,
              ai_analyzed_at: null,
              ai_model: null,
            } satisfies ChangeRequest,
          },
        }),
      });

    render(
      <ScopeChangePanel
        mode="freelancer"
        projectId={projectId}
        projectCurrency="USD"
        confirmedBudgetMinor={300000}
        agreementVersionId={agreementVersionId}
        agreementVersionNumber={1}
        agreementStatus="APPROVED"
        canUseAi={true}
        initialChangeRequests={[]}
      />
    );

    const textarea = screen.getByLabelText(/Describe Requested Scope Change/i);
    fireEvent.change(textarea, {
      target: { value: "Update footer copyright text." },
    });

    fireEvent.click(screen.getByRole("button", { name: /Analyze Scope Impact/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Discard Proposal/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Discard Proposal/i }));
    expect(
      screen.getByText(/AI proposal discarded from preview\. No change request/i)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Discard Proposal/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Submit Change Request/i }));
    await waitFor(() => {
      expect(screen.getByText("Update footer copyright text.")).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/projects/${projectId}/change-requests`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          requestText: "Update footer copyright text.",
          agreementVersionId,
          aiAnalysis: null,
        }),
      })
    );
    expect(screen.getByText(/Text Only/i)).toBeTruthy();
  });

  it("uses verified portal endpoints with x-csrf-token header and omits freelancer owner actions in client mode", async () => {
    const clientAnalysis = buildStoredAnalysis({ requesterRole: "CLIENT" });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { analysis: clientAnalysis } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            changeRequest: {
              id: "cr-client-1",
              project_id: projectId,
              agreement_version_id: agreementVersionId,
              request_text: "Add SSO login option for client team.",
              submitted_by_label: "Client (client@acme-corp.com)",
              status: "OPEN",
              created_at: "2026-11-11T10:40:00.000Z",
              resolved_at: null,
              ai_analysis: clientAnalysis,
              ai_analyzed_at: "2026-11-11T10:15:00.000Z",
              ai_model: "gemini-3.8-flash",
            } satisfies ChangeRequest,
          },
        }),
      });

    render(
      <ScopeChangePanel
        mode="client"
        portalToken={portalToken}
        csrfToken={csrfToken}
        projectCurrency="USD"
        confirmedBudgetMinor={300000}
        agreementVersionId={agreementVersionId}
        agreementVersionNumber={1}
        agreementStatus="APPROVED"
        canUseAi={true}
        initialChangeRequests={[]}
      />
    );

    const textarea = screen.getByLabelText(/Describe Requested Scope Change/i);
    fireEvent.change(textarea, {
      target: { value: "Add SSO login option for client team." },
    });

    fireEvent.click(screen.getByRole("button", { name: /Analyze Scope Impact/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Discard Proposal/i })).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/public/portal/${encodeURIComponent(portalToken)}/scope-change/analyze`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          agreementVersionId,
          requestText: "Add SSO login option for client team.",
        }),
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /Submit Change Request/i }));
    await waitFor(() => {
      expect(screen.getByText("Add SSO login option for client team.")).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/public/portal/${encodeURIComponent(portalToken)}/change-requests`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
      })
    );
    expect(screen.queryByRole("button", { name: /Mark Resolved/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Withdraw/i })).toBeNull();
  });

  it("blocks analysis and submission gracefully when no agreement version exists yet", () => {
    render(
      <ScopeChangePanel
        mode="freelancer"
        projectId={projectId}
        projectCurrency="USD"
        confirmedBudgetMinor={null}
        agreementVersionId={null}
        agreementVersionNumber={null}
        agreementStatus={null}
        canUseAi={true}
        initialChangeRequests={[]}
      />
    );

    expect(
      screen.getByText(/Create or generate an initial agreement draft before analyzing/i)
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Analyze Scope Impact/i }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Submit Change Request/i }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
