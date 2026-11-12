import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const mockRevalidatePath = vi.fn();
const mockRequireUser = vi.fn();
const mockSendVerificationEmail = vi.fn();
const mockGetDashboardSummary = vi.fn();
const mockGetMyProjectsWithSummary = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => mockRevalidatePath(path),
}));

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: () => mockRequireUser(),
}));

vi.mock("@/lib/email/provider", () => ({
  sendClientVerificationEmail: (args: unknown) => mockSendVerificationEmail(args),
}));

vi.mock("@/features/projects/data", () => ({
  getDashboardSummary: () => mockGetDashboardSummary(),
  getMyProjectsWithSummary: () => mockGetMyProjectsWithSummary(),
}));

import { createProjectAction } from "@/features/projects/actions";
import { NewProjectForm } from "@/features/projects/new-project-form";
import { ProjectsListView } from "@/features/projects/projects-list-view";
import NewProjectPage from "@/app/(app)/app/projects/new/page";
import DashboardPage from "@/app/(app)/app/page";
import ProjectsPage from "@/app/(app)/app/projects/page";

function buildValidFormData(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  formData.set("title", overrides.title ?? "Client Brand Redesign");
  formData.set("clientName", overrides.clientName ?? "Acme Studio");
  formData.set("clientEmail", overrides.clientEmail ?? "client@acmestudio.example");
  formData.set("currency", overrides.currency ?? "USD");
  formData.set("totalAmountMinor", overrides.totalAmountMinor ?? "250000");
  formData.set("startDate", overrides.startDate ?? "2026-11-15");
  formData.set("targetEndDate", overrides.targetEndDate ?? "2026-12-15");
  formData.set(
    "brief",
    overrides.brief ??
      "Complete brand and responsive web redesign with three interactive review milestones."
  );
  if (overrides.submissionToken !== undefined) {
    formData.set("submissionToken", overrides.submissionToken);
  }
  return formData;
}

function createSupabaseMock(options: {
  existingProfile?: { id: string } | null;
  profileInsertError?: { code?: string; message?: string } | null;
  recentDuplicate?: { id: string } | null;
  insertedProject?: { id: string } | null;
  projectInsertError?: { code?: string; message?: string; details?: string } | null;
  setupErrors?: Partial<Record<"project_participants" | "agreements" | "activity_events", { code?: string; message?: string }>>;
} = {}) {
  const deleteEq2 = vi.fn().mockResolvedValue({ error: null });
  const deleteEq1 = vi.fn(() => ({ eq: deleteEq2 }));
  const mockProjectDelete = vi.fn(() => ({ eq: deleteEq1 }));
  const mockProjectInsert = vi.fn(() => ({
    select: vi.fn(() => ({
      single: vi.fn().mockResolvedValue({
        data:
          options.insertedProject === undefined
            ? { id: "proj-new-123" }
            : options.insertedProject,
        error: options.projectInsertError ?? null,
      }),
    })),
  }));
  const mockProfileInsert = vi.fn().mockResolvedValue({
    error: options.profileInsertError ?? null,
  });
  const mockParticipantInsert = vi.fn().mockResolvedValue({
    error: options.setupErrors?.project_participants ?? null,
  });
  const mockAgreementInsert = vi.fn().mockResolvedValue({
    error: options.setupErrors?.agreements ?? null,
  });
  const mockActivityInsert = vi.fn().mockResolvedValue({
    error: options.setupErrors?.activity_events ?? null,
  });

  const mockRpc = vi.fn().mockResolvedValue({ error: null });

  const mockFrom = vi.fn((table: string) => {
    if (table === "profiles") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: options.existingProfile === undefined ? { id: "user-1" } : options.existingProfile,
              error: null,
            }),
          })),
        })),
        insert: mockProfileInsert,
      };
    }

    if (table === "projects") {
      return {
        select: vi.fn(() => {
          const chain = {
            eq: vi.fn(() => chain),
            gte: vi.fn(() => chain),
            order: vi.fn(() => chain),
            limit: vi.fn(() => chain),
            maybeSingle: vi.fn().mockResolvedValue({
              data: options.recentDuplicate ?? null,
              error: null,
            }),
          };
          return chain;
        }),
        insert: mockProjectInsert,
        delete: mockProjectDelete,
      };
    }

    if (table === "project_participants") {
      return { insert: mockParticipantInsert };
    }
    if (table === "agreements") {
      return { insert: mockAgreementInsert };
    }
    if (table === "activity_events") {
      return { insert: mockActivityInsert };
    }

    throw new Error(`Unexpected table queried in test: ${table}`);
  });

  return {
    supabase: { from: mockFrom, rpc: mockRpc },
    spies: {
      mockProfileInsert,
      mockProjectInsert,
      mockProjectDelete,
      mockParticipantInsert,
      mockAgreementInsert,
      mockActivityInsert,
      mockRpc,
    },
  };
}

describe("Project creation workflow and UI text cleanup", () => {
  const mockUser = {
    id: "user-1",
    email: "freelancer@payroost.dev",
    user_metadata: { display_name: "Sam Designer" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendVerificationEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("creates profile when missing, persists project + setup records, and redirects to workspace", async () => {
    const mock = createSupabaseMock({ existingProfile: null });
    mockRequireUser.mockResolvedValue({ supabase: mock.supabase, user: mockUser });

    const formData = buildValidFormData({ submissionToken: "token-create-001" });

    await expect(createProjectAction(formData)).rejects.toThrow(
      "NEXT_REDIRECT:/app/projects/proj-new-123"
    );

    expect(mock.spies.mockProfileInsert).toHaveBeenCalledWith({
      id: "user-1",
      display_name: "Sam Designer",
    });
    expect(mock.spies.mockProjectInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_id: "user-1",
        title: "Client Brand Redesign",
        client_email: "client@acmestudio.example",
        total_amount_minor: 250000,
        currency: "USD",
      })
    );
    expect(mock.spies.mockParticipantInsert).toHaveBeenCalledTimes(2);
    expect(mock.spies.mockAgreementInsert).toHaveBeenCalledTimes(1);
    expect(mock.spies.mockActivityInsert).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/app");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/app/projects");
  });

  it("returns field-level validation errors without writing to database (including invalid date range)", async () => {
    const mock = createSupabaseMock();
    mockRequireUser.mockResolvedValue({ supabase: mock.supabase, user: mockUser });

    const formData = buildValidFormData({
      brief: "Too short",
      startDate: "2026-12-20",
      targetEndDate: "2026-12-01",
      submissionToken: "token-val-001",
    });

    const result = await createProjectAction({ status: "idle", message: null, fieldErrors: {} }, formData);

    expect(result.status).toBe("error");
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.fieldErrors.brief).toMatch(/20 characters/i);
    expect(result.fieldErrors.targetEndDate).toMatch(/on or after the start date/i);
    expect(mock.spies.mockProjectInsert).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("rejects owner email used as client email with clear field error", async () => {
    const mock = createSupabaseMock();
    mockRequireUser.mockResolvedValue({ supabase: mock.supabase, user: mockUser });

    const formData = buildValidFormData({
      clientEmail: "FREELANCER@payroost.dev",
      submissionToken: "token-owner-email-001",
    });

    const result = await createProjectAction(formData);

    expect(result.status).toBe("error");
    expect(result.code).toBe("OWNER_EMAIL_FORBIDDEN");
    expect(result.fieldErrors.clientEmail).toBeTruthy();
    expect(mock.spies.mockProjectInsert).not.toHaveBeenCalled();
  });

  it("propagates unauthenticated redirect when session is missing", async () => {
    mockRequireUser.mockImplementationOnce(() => {
      mockRedirect("/login");
    });

    const formData = buildValidFormData({ submissionToken: "token-unauth-001" });
    await expect(createProjectAction(formData)).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("returns actionable error for RLS 42501 permission denied and rolls back orphan project on setup failure", async () => {
    const rlsMock = createSupabaseMock({
      insertedProject: null,
      projectInsertError: { code: "42501", message: "permission denied for table projects" },
    });
    mockRequireUser.mockResolvedValue({ supabase: rlsMock.supabase, user: mockUser });

    const rlsResult = await createProjectAction(
      buildValidFormData({ submissionToken: "token-rls-001" })
    );
    expect(rlsResult.status).toBe("error");
    expect(rlsResult.code).toBe("DB_PERMISSION_DENIED");
    expect(rlsResult.message).toMatch(/database permission/i);

    const setupFailMock = createSupabaseMock({
      insertedProject: { id: "proj-orphan-99" },
      setupErrors: {
        agreements: { code: "42501", message: "permission denied for table agreements" },
      },
    });
    mockRequireUser.mockResolvedValue({ supabase: setupFailMock.supabase, user: mockUser });

    const setupResult = await createProjectAction(
      buildValidFormData({ submissionToken: "token-setup-fail-001" })
    );
    expect(setupResult.status).toBe("error");
    expect(setupFailMock.spies.mockProjectDelete).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate project creation when matching submissionToken is retried or duplicated", async () => {
    const mock = createSupabaseMock();
    mockRequireUser.mockResolvedValue({ supabase: mock.supabase, user: mockUser });

    const token = "token-dedupe-123456";
    const first = buildValidFormData({ submissionToken: token });
    const retry = buildValidFormData({ submissionToken: token });

    await expect(createProjectAction(first)).rejects.toThrow(
      "NEXT_REDIRECT:/app/projects/proj-new-123"
    );
    await expect(createProjectAction(retry)).rejects.toThrow(
      "NEXT_REDIRECT:/app/projects/proj-new-123"
    );

    expect(mock.spies.mockProjectInsert).toHaveBeenCalledTimes(1);
  });

  it("preserves entered form values and displays field-specific errors when NewProjectForm fails validation", async () => {
    const mock = createSupabaseMock({
      insertedProject: null,
      projectInsertError: { code: "23503", message: "violates foreign key constraint" },
    });
    mockRequireUser.mockResolvedValue({ supabase: mock.supabase, user: mockUser });

    render(<NewProjectForm />);

    expect(screen.queryByText(/Optional: AI Project Brief Assistant/i)).not.toBeInTheDocument();

    const titleInput = screen.getByLabelText("Project title");
    const clientNameInput = screen.getByLabelText("Client name");
    const clientEmailInput = screen.getByLabelText(/Client email/i);
    const amountInput = screen.getByLabelText(/Total amount/i);
    const briefInput = screen.getByLabelText("Project brief");

    fireEvent.change(titleInput, { target: { value: "Preserved Website Build" } });
    fireEvent.change(clientNameInput, { target: { value: "Preserved Client" } });
    fireEvent.change(clientEmailInput, { target: { value: "client@preserved.example" } });
    fireEvent.change(amountInput, { target: { value: "150000" } });
    fireEvent.change(briefInput, {
      target: { value: "Detailed brief that must remain intact when submission returns an error." },
    });

    fireEvent.click(screen.getByRole("button", { name: /create project workspace/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/workspace profile record/i);
    });

    expect(screen.getByLabelText("Project title")).toHaveValue("Preserved Website Build");
    expect(screen.getByLabelText("Client name")).toHaveValue("Preserved Client");
    expect(screen.getByLabelText(/Client email/i)).toHaveValue("client@preserved.example");
    expect(screen.getByLabelText("Project brief")).toHaveValue(
      "Detailed brief that must remain intact when submission returns an error."
    );
  });

  it("removes unwanted UI copy from Overview, Projects, ProjectsListView, and NewProjectPage", async () => {
    mockGetDashboardSummary.mockResolvedValue({
      isConfigured: true,
      metrics: {
        activeProjectsCount: 0,
        completedProjectsCount: 0,
        awaitingApprovalCount: 0,
        openActionItemsCount: 0,
      },
      needsAttention: [],
      recentProjects: [],
      recentActivities: [],
    });
    mockGetMyProjectsWithSummary.mockResolvedValue([]);

    const overviewElement = await DashboardPage();
    render(overviewElement);
    expect(screen.queryByText(/Audit trail across your workspace/i)).not.toBeInTheDocument();
    cleanup();

    const projectsPageElement = await ProjectsPage();
    render(projectsPageElement);
    expect(
      screen.queryByText(/Each project keeps its agreement, milestones, client verification, and activity together/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Start with the facts you know\. You can shape the agreement and milestones inside the project workspace\./i)
    ).not.toBeInTheDocument();
    cleanup();

    render(<ProjectsListView projects={[]} />);
    expect(
      screen.queryByText(/Start with the facts you know\. You can shape the agreement and milestones inside the project workspace\./i)
    ).not.toBeInTheDocument();
    cleanup();

    const newProjectElement = await NewProjectPage({ searchParams: Promise.resolve({}) });
    render(newProjectElement);
    expect(
      screen.queryByText(/Add the facts you know\. Agreement drafting comes after the project record exists\./i)
    ).not.toBeInTheDocument();
  });
});
