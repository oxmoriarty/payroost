import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgreementEditor } from "@/features/agreements/agreement-editor";
import { PublicReviewView } from "@/features/agreements/public-review-view";
import type { AgreementDraft } from "@/features/agreements/schema";

const baseDraft: AgreementDraft = {
  summary: "Build verified onboarding and agreement workspace.",
  objective: "Ship an agreed milestone-based client platform.",
  scopeItems: [
    {
      id: "scope-1",
      title: "Portal Workflow",
      description: "Implement verified portal view",
      deliverables: ["Portal screen", "Activity feed"],
      acceptanceCriteria: ["Passes accessibility check", "Renders agreed schedule"],
      assumptions: ["Client supplies brand assets"],
    },
  ],
  exclusions: ["Third-party legal filings"],
  milestones: [
    {
      id: "ms-1",
      title: "Phase 1 Delivery",
      description: "Core portal views",
      amountMinor: 200000,
      currency: "USD",
      dueDate: "2026-12-01",
      deliverables: ["Portal build"],
      acceptanceCriteria: ["Approved by client"],
    },
  ],
  timeline: [],
  clientResponsibilities: ["Provide assets within 3 business days"],
  freelancerResponsibilities: ["Weekly demos"],
  paymentTerms: ["PayPal payment per milestone"],
  revisionPolicy: ["Up to 2 revision rounds per milestone"],
  changeProcess: ["Scope changes require mutual written review"],
  terminationNotes: [],
  disputeResolution: [],
  openQuestions: [],
  warnings: [],
};

describe("Agreement non-DRAFT visibility, revision cloning, and PublicReviewView completeness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("displays an APPROVED agreement version with terms & history and lets freelancer create draft vN+1", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "ver-2", version_number: 2 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <AgreementEditor
        projectId="proj-123"
        canUseAi={true}
        isClientVerified={true}
        clientEmail="client@acme.com"
        versions={[
          {
            id: "ver-1",
            version_number: 1,
            content: baseDraft,
            status: "APPROVED",
            created_at: "2026-11-10T10:00:00Z",
            sent_at: "2026-11-10T10:05:00Z",
            approved_at: "2026-11-10T12:00:00Z",
          },
        ]}
      />,
    );

    expect(screen.queryByText("Start with a reviewable draft.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Version 1" })).toBeInTheDocument();
    expect(screen.getByText("Locked Agreement Baseline")).toBeInTheDocument();
    expect(screen.getByText("Portal Workflow", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Passes accessibility check")).toBeInTheDocument();
    expect(screen.getByText("Third-party legal filings")).toBeInTheDocument();
    expect(screen.getByText("Up to 2 revision rounds per milestone")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /create draft revision \(v2\)/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj-123/agreement",
        expect.objectContaining({ method: "POST" }),
      );
      expect(
        screen.getByText(/Draft revision created from Version 1/i),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Summary")).toHaveValue(baseDraft.summary);
    });
  });

  it("displays client revision guidance when agreement version is CHANGES_REQUESTED", () => {
    render(
      <AgreementEditor
        projectId="proj-123"
        canUseAi={false}
        isClientVerified={true}
        versions={[
          {
            id: "ver-1",
            version_number: 1,
            content: baseDraft,
            status: "CHANGES_REQUESTED",
            created_at: "2026-11-10T10:00:00Z",
            sent_at: "2026-11-10T10:05:00Z",
            approved_at: null,
          },
        ]}
      />,
    );

    expect(
      screen.getByText(/Client requested revisions on Version 1/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create draft revision \(v2\)/i }),
    ).toBeInTheDocument();
  });

  it("renders full deliverables, acceptance criteria, exclusions, terms, and disclaimer in PublicReviewView", () => {
    render(
      <PublicReviewView
        token="review-tok-1234567890"
        reviewData={{
          review_link_id: "rl-1",
          project_title: "Client Portal Rollout",
          client_name: "Acme Corp",
          freelancer_name: "Studio Roost",
          content: baseDraft,
          version_number: 2,
          sent_at: "2026-11-10T10:00:00Z",
          expires_at: "2026-11-24T10:00:00Z",
        }}
      />,
    );

    expect(screen.getByText("Portal screen")).toBeInTheDocument();
    expect(screen.getByText("Passes accessibility check")).toBeInTheDocument();
    expect(screen.getByText("Third-party legal filings")).toBeInTheDocument();
    expect(screen.getByText("PayPal payment per milestone")).toBeInTheDocument();
    expect(screen.getByText("Up to 2 revision rounds per milestone")).toBeInTheDocument();
    expect(screen.getByText(/not legal advice/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /print \/ pdf/i })).toBeInTheDocument();
  });
});
