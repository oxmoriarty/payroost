import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH, PUT } from "./route";
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

describe("/api/projects/[projectId]/milestones/[milestoneId] authorization & lifecycle", () => {
  const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const milestoneId = "a1111111-1111-4111-8111-111111111111";
  const mockUser = { id: "u0000000-0000-4000-a000-000000000001" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(true);
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
  });

  function setupMilestoneDb(status: string, ownerId = mockUser.id, activeIntents: Array<{ id: string; status: string }> = []) {
    const updateSingle = vi.fn().mockResolvedValue({
      data: { id: milestoneId, status: "SUBMITTED", updated_at: "2026-11-11T12:00:00Z" },
      error: null,
    });
    const activityInsert = vi.fn().mockResolvedValue({ error: null });

    mockFrom.mockImplementation((table: string) => {
      if (table === "projects") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: projectId, owner_id: ownerId, currency: "USD" },
                error: null,
              }),
            })),
          })),
        };
      }
      if (table === "milestones") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: milestoneId, status, title: "Milestone 1" },
                  error: null,
                }),
              })),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({ single: updateSingle })),
              })),
            })),
          })),
        };
      }
      if (table === "payment_intents") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                in: vi.fn().mockResolvedValue({ data: activeIntents, error: null }),
              })),
            })),
          })),
        };
      }
      if (table === "activity_events") {
        return { insert: activityInsert };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    return { updateSingle, activityInsert };
  }

  it("returns 401 when unauthenticated on PATCH", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error("No session") });

    const res = await PATCH(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "IN_PROGRESS" }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );

    expect(res.status).toBe(401);
  });

  it("returns 403 when caller does not own the project", async () => {
    setupMilestoneDb("APPROVED", "different-owner-id");

    const res = await PATCH(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "IN_PROGRESS" }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );

    expect(res.status).toBe(403);
  });

  it("blocks freelancer PUT from setting ACCEPTED or editing post-approval financials", async () => {
    const putBody = {
      title: "Edited Milestone",
      description: "Scope tweak",
      deliverables: ["Item"],
      acceptanceCriteria: ["Done"],
      amountMinor: 50000,
      currency: "USD",
      dueDate: null,
      status: "ACCEPTED",
    };

    const resAccept = await PUT(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );
    expect(resAccept.status).toBe(403);

    setupMilestoneDb("APPROVED");
    const resLocked = await PUT(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...putBody, status: "APPROVED" }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );
    expect(resLocked.status).toBe(409);
  });

  it("requires submission notes and valid URL when freelancer submits deliverables", async () => {
    setupMilestoneDb("IN_PROGRESS");

    const resShortNote = await PATCH(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "SUBMITTED", submissionNote: "hi" }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );
    expect(resShortNote.status).toBe(400);

    const resBadUrl = await PATCH(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "SUBMITTED",
          submissionNote: "Completed staging deliverable",
          deliverableUrl: "javascript:alert(1)",
        }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );
    expect(resBadUrl.status).toBe(400);
  });

  it("submits deliverables from IN_PROGRESS and logs structured activity metadata", async () => {
    const { activityInsert } = setupMilestoneDb("IN_PROGRESS");

    const res = await PATCH(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "SUBMITTED",
          submissionNote: "Uploaded responsive screens and test build.",
          deliverableUrl: "https://staging.example.com/demo",
        }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );

    expect(res.status).toBe(200);
    expect(activityInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "milestone.submitted",
        metadata: expect.objectContaining({
          milestoneId,
          submissionNote: "Uploaded responsive screens and test build.",
          deliverableUrl: "https://staging.example.com/demo",
        }),
      }),
    );
  });

  it("prevents transitioning DRAFT or ACCEPTED milestones via PATCH", async () => {
    setupMilestoneDb("DRAFT");
    const resDraft = await PATCH(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "SUBMITTED",
          submissionNote: "Premature submission",
        }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );
    expect(resDraft.status).toBe(409);

    setupMilestoneDb("ACCEPTED");
    const resAccepted = await PATCH(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "IN_PROGRESS" }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );
    expect(resAccepted.status).toBe(409);
  });

  it("blocks leaving CHANGES_REQUESTED while an active PayPal intent is running", async () => {
    setupMilestoneDb("CHANGES_REQUESTED", mockUser.id, [{ id: "pi-1", status: "CAPTURING" }]);

    const res = await PATCH(
      new Request("https://payroost.com/api/projects/x/milestones/y", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "IN_PROGRESS" }),
      }),
      { params: Promise.resolve({ projectId, milestoneId }) },
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("PAYMENT_OPERATION_IN_PROGRESS");
  });
});
