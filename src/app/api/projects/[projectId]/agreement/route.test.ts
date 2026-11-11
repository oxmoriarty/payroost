import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, saveAgreementDraft } from "./route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import type { AgreementDraft } from "@/features/agreements/schema";

const mockGetUser = vi.fn();

const mockProjectsMaybeSingle = vi.fn();
const mockAgreementsSingle = vi.fn();
const mockAgreementVersionsSelectSingle = vi.fn();
const mockAgreementVersionsUpdateSingle = vi.fn();
const mockAgreementVersionsLimit = vi.fn();
const mockAgreementVersionsInsertSingle = vi.fn();
const mockAgreementsUpdateEq = vi.fn();
const mockActivityInsert = vi.fn();

const mockFrom = vi.fn((table: string) => {
  if (table === "projects") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: mockProjectsMaybeSingle })),
      })),
    };
  }
  if (table === "agreements") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ single: mockAgreementsSingle })),
      })),
      update: vi.fn(() => ({
        eq: mockAgreementsUpdateEq,
      })),
    };
  }
  if (table === "agreement_versions") {
    return {
      select: vi.fn((cols: string) => {
        if (cols === "id, status") {
          return {
            eq: vi.fn(() => ({ single: mockAgreementVersionsSelectSingle })),
          };
        }
        return {
          eq: vi.fn(() => ({
            order: vi.fn(() => ({ limit: mockAgreementVersionsLimit })),
          })),
        };
      }),
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({ single: mockAgreementVersionsUpdateSingle })),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({ single: mockAgreementVersionsInsertSingle })),
      })),
    };
  }
  if (table === "activity_events") {
    return {
      insert: mockActivityInsert,
    };
  }
  throw new Error(`Unexpected table: ${table}`);
});

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  allowRequest: vi.fn(),
}));

describe("Agreement Draft Application & Versioning Lifecycle (/api/projects/[projectId]/agreement)", () => {
  const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const mockUser = {
    id: "u0000000-0000-4000-a000-000000000001",
    email: "freelancer@payroost.dev",
  };

  const mockProject = {
    id: projectId,
    owner_id: mockUser.id,
    title: "Test Project",
    client_name: "Client Name",
    brief: "Full description of project requirements exceeding 20 characters.",
    currency: "USD",
    total_amount_minor: 150000,
    target_end_date: "2026-12-31",
  };

  const sampleDraft: AgreementDraft = {
    summary: "Updated agreement draft summary.",
    objective: "Deliver core functionality.",
    scopeItems: [
      {
        id: "scope-1",
        title: "Scope 1",
        description: "Core build",
        deliverables: ["App"],
        acceptanceCriteria: ["Works"],
        assumptions: [],
      },
    ],
    exclusions: ["Hosting fees"],
    milestones: [
      {
        id: "m-1",
        title: "Milestone 1",
        description: "First payment",
        amountMinor: 150000,
        currency: "USD",
        dueDate: null,
        deliverables: ["Release"],
        acceptanceCriteria: ["Approved"],
      },
    ],
    timeline: [],
    clientResponsibilities: ["Assets"],
    freelancerResponsibilities: ["Code"],
    paymentTerms: ["150000 USD"],
    revisionPolicy: ["2 rounds"],
    changeProcess: ["Versioned changes"],
    terminationNotes: ["Notice required"],
    disputeResolution: ["Non-legal workflow draft"],
    openQuestions: [],
    warnings: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(true);

    mockProjectsMaybeSingle.mockResolvedValue({ data: mockProject, error: null });
    mockAgreementsSingle.mockResolvedValue({
      data: { id: "agree-1", current_version_id: "ver-1" },
      error: null,
    });
    mockAgreementVersionsSelectSingle.mockResolvedValue({
      data: { id: "ver-1", status: "DRAFT" },
      error: null,
    });
    mockAgreementVersionsUpdateSingle.mockResolvedValue({
      data: { id: "ver-1", version_number: 1 },
      error: null,
    });
    mockAgreementVersionsLimit.mockResolvedValue({
      data: [{ version_number: 1 }],
      error: null,
    });
    mockAgreementVersionsInsertSingle.mockResolvedValue({
      data: { id: "ver-2", version_number: 2 },
      error: null,
    });
    mockAgreementsUpdateEq.mockResolvedValue({ error: null });
    mockActivityInsert.mockResolvedValue({ error: null });
  });

  it("updates existing DRAFT version when explicit save is triggered and attributes AI_ASSISTED source", async () => {
    const request = new Request(`http://localhost/api/projects/${projectId}/agreement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: sampleDraft,
        source: "AI_ASSISTED",
      }),
    });

    const response = await POST(request, { params: Promise.resolve({ projectId }) });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({ id: "ver-1", version_number: 1 });

    // Must record activity event distinguishing AI-assisted draft without falsely indicating approval
    expect(mockActivityInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: projectId,
        event_type: "agreement.edited",
        summary: "Saved AI-assisted agreement draft",
        metadata: { source: "AI_ASSISTED" },
      })
    );
  });

  it("protects historical reviewed versions (APPROVED / PENDING_CLIENT / CHANGES_REQUESTED) by creating a new DRAFT version", async () => {
    // Current version is APPROVED — immutable!
    mockAgreementVersionsSelectSingle.mockResolvedValueOnce({
      data: { id: "ver-1", status: "APPROVED" },
      error: null,
    });

    const result = await saveAgreementDraft(projectId, sampleDraft, { source: "AI_ASSISTED" });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ id: "ver-2", version_number: 2 });

    // Existing version update must NOT be called
    expect(mockAgreementVersionsUpdateSingle).not.toHaveBeenCalled();

    // New version insert and agreement pointer update to status: "DRAFT" MUST be called (never APPROVED)
    expect(mockAgreementsUpdateEq).toHaveBeenCalled();
    expect(mockActivityInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: projectId,
        event_type: "agreement.version_created",
        summary: "Created AI-assisted agreement version 2",
        metadata: { source: "AI_ASSISTED" },
      })
    );
  });

  it("returns 401 UNAUTHORIZED when user is unauthenticated", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("No session") });

    const result = await saveAgreementDraft(projectId, sampleDraft);
    expect(result.error?.status).toBe(401);
  });

  it("returns 403 FORBIDDEN for cross-user project save attempts", async () => {
    mockProjectsMaybeSingle.mockResolvedValueOnce({
      data: { ...mockProject, owner_id: "u9999999-9999-4999-a999-999999999999" },
      error: null,
    });

    const result = await saveAgreementDraft(projectId, sampleDraft);
    expect(result.error?.status).toBe(403);
  });

  it("returns 500 DATABASE_ERROR when database query fails rather than masking as 403", async () => {
    mockProjectsMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "DB connection error" },
    });

    const result = await saveAgreementDraft(projectId, sampleDraft);
    expect(result.error?.status).toBe(500);
  });
});
