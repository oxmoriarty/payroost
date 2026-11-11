import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { AgreementEditor } from "./agreement-editor";
import type { AgreementDraft } from "./schema";

describe("AgreementEditor AI-3 Preview and Staging Workflow", () => {
  const sampleGeneratedDraft: AgreementDraft = {
    summary: "AI generated draft summary for preview.",
    objective: "Deliverable objectives.",
    scopeItems: [
      {
        id: "scope-1",
        title: "Initial Scope",
        description: "Initial description",
        deliverables: ["Deliverable 1"],
        acceptanceCriteria: ["Criteria 1"],
        assumptions: [],
      },
    ],
    exclusions: ["Out of scope"],
    milestones: [
      {
        id: "m-1",
        title: "Milestone 1",
        description: "Prototype",
        amountMinor: 200000,
        currency: "USD",
        dueDate: null,
        deliverables: ["Prototype link"],
        acceptanceCriteria: ["Approval"],
      },
    ],
    timeline: [],
    clientResponsibilities: ["Provide content"],
    freelancerResponsibilities: ["Build application"],
    paymentTerms: ["200000 USD total"],
    revisionPolicy: ["2 revisions"],
    changeProcess: ["Requires new version"],
    terminationNotes: ["7 days notice"],
    disputeResolution: ["Project agreement"],
    openQuestions: ["Shipping details"],
    warnings: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads proposed AI draft into preview mode without performing immediate save or page reload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { draft: sampleGeneratedDraft, preview: true } }),
      })
    );

    render(
      <AgreementEditor
        projectId="proj-123"
        versions={[]}
        canUseAi={true}
        isClientVerified={true}
        clientEmail="client@acme.com"
      />
    );

    // Initial state: No draft exists
    expect(screen.getByText("Start with a reviewable draft.")).toBeInTheDocument();
    const generateBtn = screen.getByRole("button", { name: /generate with ai/i });

    fireEvent.click(generateBtn);

    // Should load the draft into preview mode
    await waitFor(() => {
      expect(screen.getByText("AI Proposed Agreement (Preview Mode)")).toBeInTheDocument();
      expect(screen.getByDisplayValue("AI generated draft summary for preview.")).toBeInTheDocument();
      expect(screen.getByText("AI Proposal (Preview)")).toBeInTheDocument();
    });

    // Verify preview notice copy
    expect(
      screen.getByText(/This draft was generated from the project brief and is currently in preview/i)
    ).toBeInTheDocument();
  });

  it("allows user to edit proposed draft fields in preview mode before saving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { draft: sampleGeneratedDraft, preview: true } }),
      })
    );

    render(
      <AgreementEditor
        projectId="proj-123"
        versions={[]}
        canUseAi={true}
        isClientVerified={true}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /generate with ai/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Summary")).toBeInTheDocument();
    });

    // Edit summary
    const summaryInput = screen.getByLabelText("Summary");
    fireEvent.change(summaryInput, { target: { value: "User modified summary." } });
    expect(summaryInput).toHaveValue("User modified summary.");
  });

  it("persists edited draft only when user explicitly clicks 'Save draft'", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/ai/generate-agreement")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { draft: sampleGeneratedDraft, preview: true } }),
        });
      }
      if (url.includes("/api/projects/proj-123/agreement")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { id: "version-1", version_number: 1 } }),
        });
      }
      return Promise.reject(new Error("Unknown route"));
    });

    vi.stubGlobal("fetch", mockFetch);

    render(
      <AgreementEditor
        projectId="proj-123"
        versions={[]}
        canUseAi={true}
        isClientVerified={true}
      />
    );

    // 1. Generate preview
    fireEvent.click(screen.getByRole("button", { name: /generate with ai/i }));

    await waitFor(() => {
      expect(screen.getByText("AI Proposed Agreement (Preview Mode)")).toBeInTheDocument();
    });

    // 2. Modify field
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Final reviewed summary." } });

    // 3. Explicitly Save Draft
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(screen.getByText("Draft saved successfully.")).toBeInTheDocument();
    });

    // Verify save request payload included modified summary and AI_ASSISTED source attribution
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/proj-123/agreement",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Final reviewed summary."),
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/proj-123/agreement",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"source":"AI_ASSISTED"'),
      })
    );
  });

  it("protects an existing saved draft during regeneration and restores it when Discard proposal is clicked", async () => {
    const existingSavedDraft: AgreementDraft = {
      ...sampleGeneratedDraft,
      summary: "Original manually saved draft summary.",
    };

    const existingVersions = [
      {
        id: "ver-1",
        version_number: 1,
        content: existingSavedDraft,
        status: "DRAFT",
        created_at: "2026-11-10T10:00:00Z",
        sent_at: null,
        approved_at: null,
      },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { draft: sampleGeneratedDraft, preview: true } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <AgreementEditor
        projectId="proj-123"
        versions={existingVersions}
        canUseAi={true}
        isClientVerified={true}
      />
    );

    // 1. Shows original saved draft
    expect(screen.getByDisplayValue("Original manually saved draft summary.")).toBeInTheDocument();

    // 2. Click "Re-propose with AI"
    fireEvent.click(screen.getByRole("button", { name: /re-propose with ai/i }));

    await waitFor(() => {
      expect(screen.getByText("AI Proposed Agreement (Preview Mode)")).toBeInTheDocument();
      expect(screen.getByDisplayValue("AI generated draft summary for preview.")).toBeInTheDocument();
    });

    // Save endpoint was NEVER called during preview generation
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("/api/ai/generate-agreement", expect.anything());

    // 3. Click "Discard proposal"
    fireEvent.click(screen.getByRole("button", { name: /discard proposal/i }));

    await waitFor(() => {
      expect(screen.queryByText("AI Proposed Agreement (Preview Mode)")).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("Original manually saved draft summary.")).toBeInTheDocument();
      expect(screen.getByText("Reverted to previously saved draft.")).toBeInTheDocument();
    });
  });
});
