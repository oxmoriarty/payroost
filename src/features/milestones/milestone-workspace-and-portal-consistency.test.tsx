import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MilestoneWorkspacePanel } from "@/features/milestones/milestone-workspace-panel";
import { ClientPortalWorkspaceView } from "@/features/portal/client-portal-workspace-view";
import type { PortalProjectData } from "@/features/portal/types";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

describe("Milestone submission & Client Portal acceptance consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("allows freelancer to submit deliverables and view separated work vs payment badges", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { id: "ms-1", status: "SUBMITTED", updated_at: "2026-11-11T12:00:00Z" },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneWorkspacePanel
        projectId="proj-1"
        agreementApproved={true}
        paymentStates={{ "ms-1": { paymentStatus: "UNPAID", completedCaptureId: null } }}
        initialNotes={{}}
        milestones={[
          {
            id: "ms-1",
            project_id: "proj-1",
            agreement_version_id: "ver-1",
            title: "Design Wireframes",
            description: "All core flows",
            deliverables: ["Figma frames"],
            acceptance_criteria: ["Approved typography"],
            amount_minor: 100000,
            currency: "USD",
            due_date: "2026-12-01",
            sort_order: 0,
            status: "APPROVED",
            created_at: "2026-11-10T10:00:00Z",
            updated_at: "2026-11-10T10:00:00Z",
          },
        ]}
      />,
    );

    expect(screen.getByText("Work: APPROVED")).toBeInTheDocument();
    expect(screen.getByText("Unpaid")).toBeInTheDocument();
    expect(screen.getByText("Approved typography")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /submit deliverables/i }));

    fireEvent.change(
      screen.getByPlaceholderText(/Summarize completed deliverables/i),
      { target: { value: "Delivered all Figma frames for review." } },
    );
    fireEvent.change(screen.getByPlaceholderText("https://..."), {
      target: { value: "https://figma.example.com/file/abc" },
    });

    fireEvent.click(screen.getByRole("button", { name: /confirm deliverable submission/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj-1/milestones/ms-1",
        expect.objectContaining({ method: "PATCH" }),
      );
      expect(screen.getByText("Work: SUBMITTED")).toBeInTheDocument();
      expect(screen.getByText("Delivered all Figma frames for review.")).toBeInTheDocument();
    });
  });

  it("blocks acceptance override on unpaid USD SUBMITTED milestones in Client Portal and allows revision request", async () => {
    const portalData: PortalProjectData = {
      id: "proj-1",
      title: "Acme App Build",
      clientName: "Acme Corp",
      clientEmail: "client@acme.com",
      brief: "Build client portal",
      currency: "USD",
      totalAmountMinor: 100000,
      projectStatus: "ACTIVE",
      agreementStatus: "APPROVED",
      agreementVersionId: "ver-1",
      agreementVersionNumber: 1,
      agreementContent: {
        summary: "Scope summary line.",
        objective: "Project objective line.",
        exclusions: ["Domain registration"],
      },
      agreementVersionHistory: [
        {
          id: "ver-1",
          versionNumber: 1,
          status: "APPROVED",
          createdAt: "2026-11-10T10:00:00Z",
          approvedAt: "2026-11-10T11:00:00Z",
          content: {
            summary: "Scope summary line.",
            objective: "Project objective line.",
            exclusions: ["Domain registration"],
          },
        },
      ],
      activities: [
        {
          id: "act-1",
          actorLabel: "Freelancer",
          eventType: "milestone.submitted",
          summary: 'Submitted deliverables for "Design Wireframes"',
          createdAt: "2026-11-11T10:00:00Z",
        },
      ],
      milestones: [
        {
          id: "ms-1",
          title: "Design Wireframes",
          description: "Core application flows",
          deliverables: ["Figma kit"],
          acceptanceCriteria: ["Responsive breakpoints verified"],
          amountMinor: 100000,
          currency: "USD",
          dueDate: "2026-12-01",
          sortOrder: 0,
          status: "SUBMITTED",
          isPayable: true,
          paymentStatus: "UNPAID",
          latestSubmissionNote: "Ready for review",
          latestDeliverableUrl: "https://figma.example.com/kit",
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "ms-1", status: "CHANGES_REQUESTED" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <ClientPortalWorkspaceView
        token="valid-portal-token-for-consistency-123456"
        csrfToken="csrf-secret"
        projectData={portalData}
      />,
    );

    expect(screen.getByText("Work: SUBMITTED")).toBeInTheDocument();
    expect(screen.getByText("Responsive breakpoints verified")).toBeInTheDocument();
    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(screen.getByText("Payment Required Before Deliverable Acceptance")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept deliverable/i })).not.toBeInTheDocument();

    // Check agreed terms & activity history visibility
    fireEvent.click(screen.getByRole("button", { name: /view agreement terms/i }));
    expect(screen.getByText("Domain registration")).toBeInTheDocument();
    expect(screen.getByText("Project Activity History")).toBeInTheDocument();
    expect(screen.getByText('Submitted deliverables for "Design Wireframes"')).toBeInTheDocument();

    // Client requests revision
    fireEvent.click(screen.getByRole("button", { name: /request revision/i }));
    fireEvent.change(screen.getByPlaceholderText(/Explain what needs adjusting/i), {
      target: { value: "Mobile navigation state is missing." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send revision request/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/public/portal/valid-portal-token-for-consistency-123456/milestones/ms-1/review",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "x-csrf-token": "csrf-secret" }),
        }),
      );
      expect(screen.getByText("Work: CHANGES REQUESTED")).toBeInTheDocument();
    });
  });

  it("allows client to accept a PAID SUBMITTED milestone without touching payments", async () => {
    const portalData: PortalProjectData = {
      id: "proj-1",
      title: "Acme App Build",
      clientName: "Acme Corp",
      clientEmail: "client@acme.com",
      brief: "Build client portal",
      currency: "USD",
      totalAmountMinor: 100000,
      projectStatus: "ACTIVE",
      agreementStatus: "APPROVED",
      milestones: [
        {
          id: "ms-paid",
          title: "Backend API",
          description: "REST endpoints",
          deliverables: ["OpenAPI spec"],
          acceptanceCriteria: ["Integration tests pass"],
          amountMinor: 100000,
          currency: "USD",
          dueDate: "2026-12-01",
          sortOrder: 0,
          status: "SUBMITTED",
          isPayable: false,
          paymentStatus: "PAID",
          completedCaptureId: "CAP-123",
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "ms-paid", status: "ACCEPTED" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <ClientPortalWorkspaceView
        token="valid-portal-token-for-consistency-123456"
        csrfToken="csrf-secret"
        projectData={portalData}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /accept deliverable/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm acceptance/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/public/portal/valid-portal-token-for-consistency-123456/milestones/ms-paid/review",
        expect.objectContaining({ method: "POST" }),
      );
      expect(screen.getByText("Work: ACCEPTED")).toBeInTheDocument();
      expect(mockRefresh).toHaveBeenCalled();
    });
  });
});
