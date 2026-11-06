import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectWorkspace } from "@/features/projects/data";

const mockProject = {
  id: "proj-123",
  owner_id: "user-456",
  title: "Test Project",
  client_name: "Test Client",
  client_email: "client@example.com",
  client_email_verified_at: null,
  brief: "A test project brief with sufficient length for validation.",
  currency: "USD",
  total_amount_minor: 100000,
  status: "DRAFT",
  start_date: null,
  target_end_date: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const mockAgreement = {
  id: "agree-789",
  project_id: "proj-123",
  current_version_id: "ver-001",
  status: "DRAFT",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const mockVersions = [
  {
    id: "ver-001",
    agreement_id: "agree-789",
    version_number: 1,
    content: {},
    content_hash: "abc",
    status: "DRAFT",
    created_by: "user-456",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    sent_at: null,
    approved_at: null,
    approved_by_label: null,
  },
];

// Track table query filters
const queriedFilters: Record<string, Array<{ column: string; value: unknown }>> = {};

function createTableMock(tableName: string) {
  queriedFilters[tableName] = [];
  const queryBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((col: string, val: unknown) => {
      queriedFilters[tableName].push({ column: col, value: val });
      return queryBuilder;
    }),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => {
      if (tableName === "projects") return { data: mockProject, error: null };
      if (tableName === "agreements") return { data: mockAgreement, error: null };
      return { data: null, error: null };
    }),
    then: (resolve: (val: unknown) => void) => {
      if (tableName === "agreement_versions") {
        resolve({ data: mockVersions, error: null });
      } else if (tableName === "milestones") {
        resolve({ data: [], error: null });
      } else if (tableName === "activity_events") {
        resolve({ data: [], error: null });
      } else if (tableName === "change_requests") {
        resolve({ data: [], error: null });
      } else {
        resolve({ data: [], error: null });
      }
    },
  };
  return queryBuilder;
}

const mockSupabase = {
  from: vi.fn((tableName: string) => createTableMock(tableName)),
};

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: vi.fn(async () => ({
    supabase: mockSupabase,
    user: { id: "user-456" },
  })),
}));

describe("getProjectWorkspace data fetching regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(queriedFilters)) {
      delete queriedFilters[key];
    }
  });

  it("queries agreement_versions using the actual agreement.id instead of projectId", async () => {
    const workspace = await getProjectWorkspace("proj-123");

    expect(workspace).not.toBeNull();
    expect(workspace?.project.id).toBe("proj-123");
    expect(workspace?.agreement?.id).toBe("agree-789");

    // Verify agreements was queried with project_id = 'proj-123'
    expect(queriedFilters["agreements"]).toEqual([
      { column: "project_id", value: "proj-123" },
    ]);

    // Critical regression check: agreement_versions must be queried by agreement_id = 'agree-789', NOT 'proj-123'
    expect(queriedFilters["agreement_versions"]).toEqual([
      { column: "agreement_id", value: "agree-789" },
    ]);
  });
});
