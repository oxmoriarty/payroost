import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MilestonePlan } from "./schema";
import { MilestonePlanner } from "./milestone-planner";

const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

describe("MilestonePlanner UI Component (AI-4)", () => {
  const samplePlan: MilestonePlan = {
    overallTimelineEstimate: "5 weeks estimated across 2 sequential milestones",
    milestoneCount: 2,
    allocatesFullBudget: true,
    totalProposedAmountMinor: 200000,
    currency: "USD",
    milestones: [
      {
        id: "m-1",
        position: 1,
        title: "Phase 1: Backend API",
        description: "Build core authenticated backend routes.",
        deliverables: ["API endpoints", "Unit tests"],
        acceptanceCriteria: ["Tests pass"],
        estimatedDuration: "3 weeks",
        dueDate: null,
        dependsOn: [],
        proposedAmountMinor: 120000,
        currency: "USD",
        assumptions: ["DB credentials provided"],
        openQuestions: ["Preferred hosting provider?"],
      },
      {
        id: "m-2",
        position: 2,
        title: "Phase 2: Frontend Dashboard",
        description: "Build client interface and QA checks.",
        deliverables: ["Dashboard screens"],
        acceptanceCriteria: ["Responsive layout verified"],
        estimatedDuration: "2 weeks",
        dueDate: null,
        dependsOn: ["m-1"],
        proposedAmountMinor: 80000,
        currency: "USD",
        assumptions: [],
        openQuestions: [],
      },
    ],
    assumptions: ["Designs finalized prior to Phase 2"],
    unresolvedQuestions: ["Confirm OAuth providers"],
    risksAndDependencies: ["Third-party webhook sandbox latency"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("clearly distinguishes Formally Agreed, Saved Draft, AI-Proposed, and User-Edited milestone states", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { plan: samplePlan, preview: true } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestonePlanner
        projectId="proj-1"
        projectCurrency="USD"
        confirmedBudgetMinor={200000}
        agreementStatus="DRAFT"
        savedMilestones={[
          {
            id: "ms-agreed",
            title: "Completed Kickoff",
            description: "Paid initial discovery",
            deliverables: ["Brief"],
            acceptance_criteria: ["Signed"],
            amount_minor: 50000,
            currency: "USD",
            due_date: null,
            sort_order: 0,
            status: "ACCEPTED",
          },
          {
            id: "ms-saved",
            title: "Existing Saved Draft Step",
            description: "Draft step",
            deliverables: ["Spec"],
            acceptance_criteria: ["Reviewed"],
            amount_minor: 150000,
            currency: "USD",
            due_date: null,
            sort_order: 1,
            status: "DRAFT",
          },
        ]}
        canUseAi={true}
      />
    );

    // Persisted section badges
    expect(screen.getByText("Formally Agreed")).toBeInTheDocument();
    expect(screen.getByText(/Completed Kickoff/)).toBeInTheDocument();
    expect(screen.getByText("Saved Draft")).toBeInTheDocument();
    expect(screen.getByText(/Existing Saved Draft Step/)).toBeInTheDocument();

    // Generate preview (NO apply call occurs yet)
    fireEvent.click(screen.getByRole("button", { name: /generate milestone plan/i }));

    await waitFor(() => {
      expect(screen.getByText("AI-Proposed Milestone Plan (Preview Only)")).toBeInTheDocument();
    });

    expect(screen.getByText("AI-Proposed Milestones")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/ai/generate-milestones",
      expect.objectContaining({ method: "POST" })
    );

    // Edit title -> state explicitly switches to User-Edited Proposal
    const titleInputs = screen.getAllByLabelText("Milestone Title");
    fireEvent.change(titleInputs[0], { target: { value: "Edited Backend Scope" } });

    expect(
      screen.getByText("User-Edited Milestone Proposal (Unsaved Preview)")
    ).toBeInTheDocument();
    expect(screen.getByText("User-Edited Proposal")).toBeInTheDocument();
  });

  it("supports reordering sequence, adjusting dependencies, regenerating, and discarding proposals without modifying saved state", async () => {
    const regeneratedPlan: MilestonePlan = {
      ...samplePlan,
      milestoneCount: 1,
      milestones: [
        {
          ...samplePlan.milestones[0],
          id: "m-1",
          position: 1,
          title: "Consolidated Delivery",
          proposedAmountMinor: 200000,
          dependsOn: [],
        },
      ],
    };

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { plan: samplePlan, preview: true } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { plan: regeneratedPlan, preview: true } }),
      });

    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestonePlanner
        projectId="proj-1"
        projectCurrency="USD"
        confirmedBudgetMinor={200000}
        agreementStatus="DRAFT"
        savedMilestones={[]}
        canUseAi={true}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /generate milestone plan/i }));
    await waitFor(() => {
      expect(screen.getByDisplayValue("Phase 1: Backend API")).toBeInTheDocument();
    });

    // Move milestone 2 up so it becomes position 1 (should reorder array cleanly)
    fireEvent.click(screen.getByRole("button", { name: "Move milestone 2 up" }));
    const titleInputsAfterMove = screen.getAllByLabelText("Milestone Title");
    expect(titleInputsAfterMove[0]).toHaveValue("Phase 2: Frontend Dashboard");

    // Regenerate proposal
    fireEvent.click(screen.getByRole("button", { name: /regenerate proposal/i }));
    await waitFor(() => {
      expect(screen.getByDisplayValue("Consolidated Delivery")).toBeInTheDocument();
    });

    // Discard proposal
    fireEvent.click(screen.getAllByRole("button", { name: /discard proposal/i })[0]);
    expect(screen.queryByDisplayValue("Consolidated Delivery")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Discarded milestone proposal/i)
    ).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("requires explicit revision confirmation when an approved agreement exists before applying, then applies cleanly", async () => {
    const onPlanApplied = vi.fn();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { plan: samplePlan, preview: true } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              agreementVersion: { id: "ver-2", version_number: 2 },
              revisionCreated: true,
              requiresClientApproval: true,
              milestonesTableSynced: false,
            },
          }),
      });

    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestonePlanner
        projectId="proj-approved"
        projectCurrency="USD"
        confirmedBudgetMinor={200000}
        agreementStatus="APPROVED"
        currentVersionNumber={1}
        savedMilestones={[]}
        agreedVersionMilestones={[
          {
            id: "ms-1",
            title: "Original Agreed Phase",
            description: "Original agreement deliverable",
            amountMinor: 200000,
            currency: "USD",
            dueDate: null,
            deliverables: ["Site"],
            acceptanceCriteria: ["Live"],
          },
        ]}
        canUseAi={true}
        onPlanApplied={onPlanApplied}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /generate milestone plan/i }));

    await waitFor(() => {
      expect(screen.getByText(/Approved Agreement Protection \(Version 1\)/)).toBeInTheDocument();
    });

    const applyButton = screen.getByRole("button", {
      name: /apply milestone plan to agreement draft/i,
    });
    // Disabled until explicit revision checkbox is confirmed
    expect(applyButton).toBeDisabled();

    fireEvent.click(
      screen.getByLabelText(/I confirm creating a new Draft agreement revision/i)
    );
    expect(applyButton).not.toBeDisabled();

    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(
        screen.getByText(/Milestone plan saved into new Draft Agreement Version 2/i)
      ).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenLastCalledWith(
      "/api/projects/proj-approved/milestones/apply",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"confirmNewRevision":true'),
      })
    );
    expect(onPlanApplied).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
