import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppHeader } from "@/components/app/header";
import { ProjectsListView } from "@/features/projects/projects-list-view";
import type { ProjectSummaryItem, WorkspaceNotification } from "@/features/projects/types";
import { renderPortalInvitationEmail } from "@/lib/email/templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/projects",
}));

describe("Workspace Header, Notifications, Projects Filtering, and Email Terminology", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders dynamic user identity, interactive mobile drawer, and notification popover", () => {
    const notifications: WorkspaceNotification[] = [
      {
        id: "n-1",
        projectId: "p-1",
        projectTitle: "E-Commerce Refresh",
        kind: "SCOPE_OPEN",
        title: "Open scope-change request",
        description: "Client requested extra analytics tracking.",
        href: "/app/projects/p-1#scope-changes",
        tone: "warning",
        createdAt: "2026-11-11T10:00:00Z",
      },
    ];

    render(
      <AppHeader
        userLabel="Ada Studio"
        userEmail="ada@studio.dev"
        notifications={notifications}
      />,
    );

    expect(screen.getByText("Welcome back, Ada Studio")).toBeInTheDocument();

    // Open Notifications dropdown
    fireEvent.click(screen.getByRole("button", { name: /notifications \(1\)/i }));
    expect(screen.getByText("Workspace notifications")).toBeInTheDocument();
    expect(screen.getByText("Client requested extra analytics tracking.")).toBeInTheDocument();

    // Open Mobile Navigation drawer
    fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));
    expect(screen.getByRole("dialog", { name: /mobile navigation/i })).toBeInTheDocument();
    expect(screen.getByText("Payment operations")).toBeInTheDocument();
  });

  it("renders clean empty state inside notifications popover when nothing is pending", () => {
    render(<AppHeader userLabel="Ada" notifications={[]} />);

    fireEvent.click(screen.getByRole("button", { name: /notifications \(0\)/i }));
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("filters ProjectsListView by status and search text and clears empty filter states cleanly", () => {
    const projects: ProjectSummaryItem[] = [
      {
        id: "p-1",
        owner_id: "u-1",
        title: "Design System V2",
        client_name: "Northwind",
        client_email: "nw@example.com",
        client_email_verified_at: "2026-11-10T10:00:00Z",
        brief: "Design system documentation.",
        currency: "USD",
        total_amount_minor: 300000,
        status: "ACTIVE",
        start_date: null,
        target_end_date: null,
        created_at: "2026-11-10T09:00:00Z",
        updated_at: "2026-11-10T09:00:00Z",
        agreementStatus: "APPROVED",
        agreementVersionNumber: 1,
        milestoneCount: 2,
        acceptedMilestoneCount: 1,
        submittedMilestoneCount: 1,
        revisionRequestedMilestoneCount: 0,
        openChangeRequestCount: 1,
      },
      {
        id: "p-2",
        owner_id: "u-1",
        title: "Marketing Microsite",
        client_name: "Contoso",
        client_email: "c@example.com",
        client_email_verified_at: null,
        brief: "Campaign microsite.",
        currency: "USD",
        total_amount_minor: 150000,
        status: "DRAFT",
        start_date: null,
        target_end_date: null,
        created_at: "2026-11-10T09:00:00Z",
        updated_at: "2026-11-10T09:00:00Z",
        agreementStatus: "DRAFT",
        agreementVersionNumber: null,
        milestoneCount: 0,
        acceptedMilestoneCount: 0,
        submittedMilestoneCount: 0,
        revisionRequestedMilestoneCount: 0,
        openChangeRequestCount: 0,
      },
    ];

    render(<ProjectsListView projects={projects} />);

    expect(screen.getByText("Design System V2")).toBeInTheDocument();
    expect(screen.getByText("Marketing Microsite")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Active \(1\)/i }));
    expect(screen.getByText("Design System V2")).toBeInTheDocument();
    expect(screen.queryByText("Marketing Microsite")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: /search projects/i }), {
      target: { value: "nonexistent" },
    });
    expect(screen.getByText("No matching projects")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(screen.getByText("Marketing Microsite")).toBeInTheDocument();
  });

  it("ensures portal invitation template avoids misleading payment escrow wording", () => {
    const email = renderPortalInvitationEmail({
      clientName: "Jane",
      projectTitle: "Audit Project",
      portalUrl: "https://payroost.com/portal/abc",
      expiresInDays: 7,
    });

    expect(email.html.toLowerCase()).not.toContain("escrow");
    expect(email.text.toLowerCase()).not.toContain("escrow");
  });
});
