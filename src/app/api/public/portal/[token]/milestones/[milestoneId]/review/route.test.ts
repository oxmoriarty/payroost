import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { POST } from "./route";
import * as portalAuthModule from "@/features/scope-changes/portal-auth";

vi.mock("@/features/scope-changes/portal-auth", () => ({
  authenticatePortalRequest: vi.fn(),
}));

describe("POST /api/public/portal/[token]/milestones/[milestoneId]/review", () => {
  const validToken = "valid-portal-token-for-milestone-review-1234567";
  const projectId = "c0000000-0000-4000-a000-000000000001";
  const milestoneId = "b1111111-1111-4111-8111-111111111111";

  function buildServiceClient(params: {
    milestone?: {
      id: string;
      project_id: string;
      title: string;
      currency: string;
      amount_minor: number;
      status: string;
    } | null;
    intents?: Array<{ id: string; status: string }>;
    captures?: Array<{ id: string }>;
  }) {
    const updateMaybeSingle = vi.fn().mockResolvedValue({
      data: { id: milestoneId, status: "UPDATED", updated_at: "2026-11-11T12:00:00Z" },
      error: null,
    });
    const activityInsert = vi.fn().mockResolvedValue({ error: null });

    const serviceClient = {
      from: vi.fn((table: string) => {
        if (table === "milestones") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: params.milestone ?? null,
                    error: null,
                  }),
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({ maybeSingle: updateMaybeSingle })),
                  })),
                })),
              })),
            })),
          };
        }
        if (table === "payment_intents") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({
                  data: params.intents ?? [],
                  error: null,
                }),
              })),
            })),
          };
        }
        if (table === "payment_transactions") {
          return {
            select: vi.fn(() => ({
              in: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn().mockResolvedValue({
                    data: params.captures ?? [],
                    error: null,
                  }),
                })),
              })),
            })),
          };
        }
        if (table === "activity_events") {
          return { insert: activityInsert };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };

    return { serviceClient, updateMaybeSingle, activityInsert };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards portal authentication, session, and CSRF rejections", async () => {
    vi.mocked(portalAuthModule.authenticatePortalRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "INVALID_CSRF_TOKEN" }, { status: 403 }),
    });

    const res = await POST(
      new Request("https://payroost.com/api/public/portal/tok/milestones/m/review", {
        method: "POST",
        body: JSON.stringify({ action: "ACCEPT" }),
      }),
      { params: Promise.resolve({ token: validToken, milestoneId }) },
    );

    expect(res.status).toBe(403);
  });

  it("blocks ACCEPT on an unpaid USD SUBMITTED milestone (Decision #2: no override while R4 checkout blocked)", async () => {
    const { serviceClient, updateMaybeSingle } = buildServiceClient({
      milestone: {
        id: milestoneId,
        project_id: projectId,
        title: "Design Delivery",
        currency: "USD",
        amount_minor: 150000,
        status: "SUBMITTED",
      },
      intents: [],
    });

    vi.mocked(portalAuthModule.authenticatePortalRequest).mockResolvedValue({
      ok: true,
      serviceClient: serviceClient as never,
      projectId,
      clientEmail: "client@acme.com",
      tokenHash: "hash",
    });

    const res = await POST(
      new Request("https://payroost.com/api/public/portal/tok/milestones/m/review", {
        method: "POST",
        body: JSON.stringify({ action: "ACCEPT", overrideUnpaid: true }),
      }),
      { params: Promise.resolve({ token: validToken, milestoneId }) },
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("PAYMENT_REQUIRED_BEFORE_ACCEPTANCE");
    expect(json.message).toMatch(/ACCEPTED/);
    expect(updateMaybeSingle).not.toHaveBeenCalled();
  });

  it("allows ACCEPT on an already-PAID USD SUBMITTED milestone and records acceptance activity", async () => {
    const { serviceClient, updateMaybeSingle, activityInsert } = buildServiceClient({
      milestone: {
        id: milestoneId,
        project_id: projectId,
        title: "Design Delivery",
        currency: "USD",
        amount_minor: 150000,
        status: "SUBMITTED",
      },
      intents: [{ id: "pi-1", status: "COMPLETED" }],
      captures: [{ id: "tx-1" }],
    });

    vi.mocked(portalAuthModule.authenticatePortalRequest).mockResolvedValue({
      ok: true,
      serviceClient: serviceClient as never,
      projectId,
      clientEmail: "client@acme.com",
      tokenHash: "hash",
    });

    const res = await POST(
      new Request("https://payroost.com/api/public/portal/tok/milestones/m/review", {
        method: "POST",
        body: JSON.stringify({ action: "ACCEPT", note: "Looks great, matches acceptance criteria." }),
      }),
      { params: Promise.resolve({ token: validToken, milestoneId }) },
    );

    expect(res.status).toBe(200);
    expect(updateMaybeSingle).toHaveBeenCalledTimes(1);
    expect(activityInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "milestone.accepted",
        actor_label: "Client (client@acme.com)",
        metadata: expect.objectContaining({
          milestoneId,
          nextStatus: "ACCEPTED",
          feedbackNote: "Looks great, matches acceptance criteria.",
        }),
      }),
    );
  });

  it("blocks deliverable transitions when a PayPal operation is currently in flight", async () => {
    const { serviceClient, updateMaybeSingle } = buildServiceClient({
      milestone: {
        id: milestoneId,
        project_id: projectId,
        title: "Design Delivery",
        currency: "USD",
        amount_minor: 150000,
        status: "SUBMITTED",
      },
      intents: [{ id: "pi-1", status: "CAPTURING" }],
    });

    vi.mocked(portalAuthModule.authenticatePortalRequest).mockResolvedValue({
      ok: true,
      serviceClient: serviceClient as never,
      projectId,
      clientEmail: "client@acme.com",
      tokenHash: "hash",
    });

    const res = await POST(
      new Request("https://payroost.com/api/public/portal/tok/milestones/m/review", {
        method: "POST",
        body: JSON.stringify({ action: "REQUEST_REVISION", note: "Please hold on check" }),
      }),
      { params: Promise.resolve({ token: validToken, milestoneId }) },
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("PAYMENT_OPERATION_IN_PROGRESS");
    expect(updateMaybeSingle).not.toHaveBeenCalled();
  });

  it("requires revision feedback note >= 3 chars and moves SUBMITTED to CHANGES_REQUESTED", async () => {
    const { serviceClient, activityInsert } = buildServiceClient({
      milestone: {
        id: milestoneId,
        project_id: projectId,
        title: "Design Delivery",
        currency: "USD",
        amount_minor: 150000,
        status: "SUBMITTED",
      },
      intents: [],
    });

    vi.mocked(portalAuthModule.authenticatePortalRequest).mockResolvedValue({
      ok: true,
      serviceClient: serviceClient as never,
      projectId,
      clientEmail: "client@acme.com",
      tokenHash: "hash",
    });

    const missingNoteRes = await POST(
      new Request("https://payroost.com/api/public/portal/tok/milestones/m/review", {
        method: "POST",
        body: JSON.stringify({ action: "REQUEST_REVISION", note: "no" }),
      }),
      { params: Promise.resolve({ token: validToken, milestoneId }) },
    );
    expect(missingNoteRes.status).toBe(400);

    const okRes = await POST(
      new Request("https://payroost.com/api/public/portal/tok/milestones/m/review", {
        method: "POST",
        body: JSON.stringify({
          action: "REQUEST_REVISION",
          note: "Missing export button in header menu.",
        }),
      }),
      { params: Promise.resolve({ token: validToken, milestoneId }) },
    );
    expect(okRes.status).toBe(200);
    expect(activityInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "milestone.revision_requested",
        metadata: expect.objectContaining({
          nextStatus: "CHANGES_REQUESTED",
          feedbackNote: "Missing export button in header menu.",
        }),
      }),
    );
  });
});
