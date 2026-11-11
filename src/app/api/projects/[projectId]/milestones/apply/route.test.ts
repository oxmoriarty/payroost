import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import * as agreementRouteModule from "@/app/api/projects/[projectId]/agreement/route";
import * as rateLimitModule from "@/lib/security/rate-limit";

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

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

describe("POST /api/projects/[projectId]/milestones/apply (AI-4)", () => {
  const validProjectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const mockUser = {
    id: "u0000000-0000-4000-a000-000000000001",
    email: "freelancer@payroost.dev",
  };

  const mockProject = {
    id: validProjectId,
    owner_id: mockUser.id,
    title: "Mobile Commerce Portal",
    client_name: "Acme Retail",
    brief: "Build an authenticated customer store and management dashboard.",
    currency: "USD",
    total_amount_minor: 200000,
    target_end_date: "2027-01-15",
  };

  const existingDraftAgreement = {
    summary: "Existing working summary preserved on milestone apply.",
    objective: "Build commerce portal cleanly.",
    scopeItems: [
      {
        id: "scope-1",
        title: "Core Platform",
        description: "Core application build",
        deliverables: ["Web app"],
        acceptanceCriteria: ["Passes CI"],
        assumptions: [],
      },
    ],
    exclusions: ["Native desktop app"],
    milestones: [
      {
        id: "old-1",
        title: "Old single milestone",
        description: "Initial placeholder",
        amountMinor: 200000,
        currency: "USD",
        dueDate: null,
        deliverables: ["Full build"],
        acceptanceCriteria: ["Done"],
      },
    ],
    timeline: [],
    clientResponsibilities: ["Provide assets"],
    freelancerResponsibilities: ["Build app"],
    paymentTerms: ["Milestone billing"],
    revisionPolicy: ["2 rounds included"],
    changeProcess: ["Via change requests"],
    terminationNotes: [],
    disputeResolution: ["Draft terms"],
    openQuestions: [],
    warnings: [],
  };

  const validMilestonesPayload = [
    {
      id: "m-1",
      title: "Backend Services",
      description: "API, database schema, and auth endpoints.",
      deliverables: ["REST API", "DB migrations"],
      acceptanceCriteria: ["Integration tests pass"],
      amountMinor: 120000,
      currency: "USD",
      dueDate: null,
    },
    {
      id: "m-2",
      title: "Frontend Portal & QA",
      description: "Client UI components and final acceptance testing.",
      deliverables: ["Responsive UI"],
      acceptanceCriteria: ["E2E checks pass"],
      amountMinor: 80000,
      currency: "USD",
      dueDate: "2027-01-10",
    },
  ];

  let deletedMilestonesCalls: unknown[];
  let insertedMilestonesPayloads: unknown[];
  let insertedActivityEvents: Array<Record<string, unknown>>;
  let paymentIntentWrites: number;

  function setupDb(options?: {
    project?: typeof mockProject | null;
    projectError?: { message: string } | null;
    agreement?: { id: string; status: string; current_version_id: string | null } | null;
    version?: { id: string; version_number: number; status: string; content: unknown } | null;
    milestones?: Array<{ id: string; status: string; sort_order: number }>;
    paymentIntents?: Array<{ id: string; milestone_id: string; status: string }>;
  }) {
    mockFrom.mockImplementation((table: string) => {
      if (table === "projects") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: options && "project" in options ? options.project : mockProject,
                error: options?.projectError ?? null,
              })),
            })),
          })),
        };
      }
      if (table === "agreements") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data:
                  options && "agreement" in options
                    ? options.agreement
                    : { id: "agree-1", status: "DRAFT", current_version_id: "ver-1" },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === "agreement_versions") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data:
                  options && "version" in options
                    ? options.version
                    : {
                        id: "ver-1",
                        version_number: 1,
                        status: "DRAFT",
                        content: existingDraftAgreement,
                      },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === "milestones") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(async () => ({
              data: options?.milestones ?? [],
              error: null,
            })),
          })),
          delete: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(async (col: string, val: unknown) => {
                deletedMilestonesCalls.push({ col, val });
                return { error: null };
              }),
            })),
          })),
          insert: vi.fn(async (rows: unknown) => {
            insertedMilestonesPayloads.push(rows);
            return { error: null };
          }),
        };
      }
      if (table === "payment_intents") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(async () => ({
              data: options?.paymentIntents ?? [],
              error: null,
            })),
          })),
          insert: vi.fn(async () => {
            paymentIntentWrites += 1;
            return { error: null };
          }),
          update: vi.fn(async () => {
            paymentIntentWrites += 1;
            return { error: null };
          }),
        };
      }
      if (table === "activity_events") {
        return {
          insert: vi.fn(async (row: Record<string, unknown>) => {
            insertedActivityEvents.push(row);
            return { error: null };
          }),
        };
      }
      return {};
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    deletedMilestonesCalls = [];
    insertedMilestonesPayloads = [];
    insertedActivityEvents = [];
    paymentIntentWrites = 0;
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(true);
    setupDb();
    vi.spyOn(agreementRouteModule, "saveAgreementDraft").mockResolvedValue({
      data: { id: "ver-1", version_number: 1 },
    });
  });

  it("rejects unauthenticated requests (401), invalid UUID (400), and rate-limited callers (429)", async () => {
    const badIdRes = await POST(
      new Request("http://localhost/api/projects/bad/milestones/apply", {
        method: "POST",
        body: JSON.stringify({ milestones: validMilestonesPayload }),
      }),
      { params: Promise.resolve({ projectId: "not-a-uuid" }) }
    );
    expect(badIdRes.status).toBe(400);

    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "No user" } });
    const unauthRes = await POST(
      new Request(`http://localhost/api/projects/${validProjectId}/milestones/apply`, {
        method: "POST",
        body: JSON.stringify({ milestones: validMilestonesPayload }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );
    expect(unauthRes.status).toBe(401);

    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(false);
    const rateRes = await POST(
      new Request(`http://localhost/api/projects/${validProjectId}/milestones/apply`, {
        method: "POST",
        body: JSON.stringify({ milestones: validMilestonesPayload }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );
    expect(rateRes.status).toBe(429);
  });

  it("rejects mismatched currency or non-reconciled milestone sum against authoritative project budget", async () => {
    const mismatchRes = await POST(
      new Request(`http://localhost/api/projects/${validProjectId}/milestones/apply`, {
        method: "POST",
        body: JSON.stringify({
          milestones: [
            { ...validMilestonesPayload[0], amountMinor: 100000 },
            { ...validMilestonesPayload[1], amountMinor: 80000 },
          ],
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );
    expect(mismatchRes.status).toBe(400);
    expect((await mismatchRes.json()).error).toBe("BUDGET_RECONCILIATION_MISMATCH");

    const currencyRes = await POST(
      new Request(`http://localhost/api/projects/${validProjectId}/milestones/apply`, {
        method: "POST",
        body: JSON.stringify({
          milestones: [
            { ...validMilestonesPayload[0], currency: "EUR" },
            validMilestonesPayload[1],
          ],
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );
    expect(currencyRes.status).toBe(400);
    expect((await currencyRes.json()).error).toBe("CURRENCY_MISMATCH");
  });

  it("applies milestones to active DRAFT agreement via saveAgreementDraft, syncs DRAFT rows in public.milestones, and logs attribution", async () => {
    setupDb({
      milestones: [{ id: "old-draft-ms", status: "DRAFT", sort_order: 0 }],
    });

    const saveSpy = vi.spyOn(agreementRouteModule, "saveAgreementDraft");

    const res = await POST(
      new Request(`http://localhost/api/projects/${validProjectId}/milestones/apply`, {
        method: "POST",
        body: JSON.stringify({
          milestones: validMilestonesPayload,
          source: "AI_EDITED",
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.milestonesTableSynced).toBe(true);
    expect(json.data.revisionCreated).toBe(false);

    // Existing agreement prose was preserved while milestones were updated
    expect(saveSpy).toHaveBeenCalledWith(
      validProjectId,
      expect.objectContaining({
        summary: existingDraftAgreement.summary,
        exclusions: existingDraftAgreement.exclusions,
        milestones: expect.arrayContaining([
          expect.objectContaining({ title: "Backend Services", amountMinor: 120000 }),
          expect.objectContaining({ title: "Frontend Portal & QA", amountMinor: 80000 }),
        ]),
      }),
      { source: "AI_ASSISTED" }
    );

    // Old DRAFT milestones cleaned up and replaced cleanly with DRAFT status & sort_order
    expect(deletedMilestonesCalls).toHaveLength(1);
    expect(insertedMilestonesPayloads).toHaveLength(1);
    const insertedRows = insertedMilestonesPayloads[0] as Array<Record<string, unknown>>;
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]).toMatchObject({
      status: "DRAFT",
      agreement_version_id: "ver-1",
      sort_order: 0,
      amount_minor: 120000,
    });
    expect(insertedRows[1]).toMatchObject({
      status: "DRAFT",
      agreement_version_id: "ver-1",
      sort_order: 1,
      amount_minor: 80000,
    });

    expect(insertedActivityEvents[0]).toMatchObject({
      event_type: "milestone.plan_applied",
      metadata: expect.objectContaining({
        source: "AI_EDITED",
        milestoneCount: 2,
        milestonesTableSynced: true,
      }),
    });
    expect(paymentIntentWrites).toBe(0);
  });

  it("blocks applying directly onto an APPROVED agreement without explicit confirmNewRevision confirmation (409)", async () => {
    setupDb({
      agreement: { id: "agree-1", status: "APPROVED", current_version_id: "ver-1" },
      version: {
        id: "ver-1",
        version_number: 1,
        status: "APPROVED",
        content: existingDraftAgreement,
      },
      milestones: [{ id: "ms-approved", status: "APPROVED", sort_order: 0 }],
    });

    const saveSpy = vi.spyOn(agreementRouteModule, "saveAgreementDraft");

    const res = await POST(
      new Request(`http://localhost/api/projects/${validProjectId}/milestones/apply`, {
        method: "POST",
        body: JSON.stringify({
          milestones: validMilestonesPayload,
          source: "AI_ASSISTED",
          confirmNewRevision: false,
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );

    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe("APPROVED_AGREEMENT_REVISION_REQUIRED");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(insertedMilestonesPayloads).toHaveLength(0);
  });

  it("with confirmNewRevision=true on APPROVED agreement with active payments, creates DRAFT v2 and preserves paid/committed public.milestones untouched", async () => {
    setupDb({
      agreement: { id: "agree-1", status: "APPROVED", current_version_id: "ver-1" },
      version: {
        id: "ver-1",
        version_number: 1,
        status: "APPROVED",
        content: existingDraftAgreement,
      },
      milestones: [{ id: "ms-paid", status: "ACCEPTED", sort_order: 0 }],
      paymentIntents: [{ id: "pi-1", milestone_id: "ms-paid", status: "COMPLETED" }],
    });

    const saveSpy = vi
      .spyOn(agreementRouteModule, "saveAgreementDraft")
      .mockResolvedValue({ data: { id: "ver-2", version_number: 2 } });

    const res = await POST(
      new Request(`http://localhost/api/projects/${validProjectId}/milestones/apply`, {
        method: "POST",
        body: JSON.stringify({
          milestones: validMilestonesPayload,
          source: "AI_ASSISTED",
          confirmNewRevision: true,
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.revisionCreated).toBe(true);
    expect(json.data.requiresClientApproval).toBe(true);
    expect(json.data.milestonesTableSynced).toBe(false);
    expect(json.data.syncNote).toBe("PRESERVED_COMMITTED_OR_PAYMENT_LINKED_MILESTONES");
    expect(json.data.agreementVersion).toEqual({ id: "ver-2", version_number: 2 });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    // Zero mutations on committed/paid milestones or payment intents!
    expect(deletedMilestonesCalls).toHaveLength(0);
    expect(insertedMilestonesPayloads).toHaveLength(0);
    expect(paymentIntentWrites).toBe(0);
  });

  it("propagates NextResponse errors returned cleanly from saveAgreementDraft", async () => {
    vi.spyOn(agreementRouteModule, "saveAgreementDraft").mockResolvedValue({
      error: NextResponse.json({ error: "VERSION_CREATE_FAILED" }, { status: 409 }),
    });

    const res = await POST(
      new Request(`http://localhost/api/projects/${validProjectId}/milestones/apply`, {
        method: "POST",
        body: JSON.stringify({
          milestones: validMilestonesPayload,
          source: "AI_ASSISTED",
        }),
      }),
      { params: Promise.resolve({ projectId: validProjectId }) }
    );

    expect(res.status).toBe(409);
  });
});
