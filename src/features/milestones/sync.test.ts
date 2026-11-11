import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncApprovedAgreementMilestones } from "@/features/milestones/sync";
import { extractMilestoneNotes } from "@/features/milestones/activity-notes";
import type { AgreementDraft } from "@/features/agreements/schema";

const sampleDraft: AgreementDraft = {
  summary: "Approved scope agreement.",
  objective: "Deliver core application.",
  scopeItems: [
    {
      id: "s-1",
      title: "App build",
      description: "Core application workflow",
      deliverables: ["Web workspace"],
      acceptanceCriteria: ["Passes end-to-end checks"],
      assumptions: [],
    },
  ],
  exclusions: ["Hosting fees"],
  milestones: [
    {
      id: "m-1",
      title: "Architecture & Setup",
      description: "Initial architecture and core pages",
      amountMinor: 100000,
      currency: "USD",
      dueDate: "2026-12-01",
      deliverables: ["Setup repo"],
      acceptanceCriteria: ["Repo compiles cleanly"],
    },
    {
      id: "m-2",
      title: "Final Delivery",
      description: "Production polish and handoff",
      amountMinor: 150000,
      currency: "USD",
      dueDate: "2026-12-15",
      deliverables: ["Production release"],
      acceptanceCriteria: ["Client acceptance verified"],
    },
  ],
  timeline: [],
  clientResponsibilities: ["Timely reviews"],
  freelancerResponsibilities: ["Weekly status"],
  paymentTerms: ["Milestone based"],
  revisionPolicy: ["Up to 2 rounds"],
  changeProcess: ["Scope change review"],
  terminationNotes: [],
  disputeResolution: [],
  openQuestions: [],
  warnings: [],
};

describe("syncApprovedAgreementMilestones & extractMilestoneNotes", () => {
  it("promotes DRAFT milestones to APPROVED when an APPROVED agreement version exists", async () => {
    const updateIn = vi.fn().mockResolvedValue({ error: null });
    const insertActivity = vi.fn().mockResolvedValue({ error: null });

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "agreements") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: "ag-1" }, error: null }),
              })),
            })),
          };
        }
        if (table === "agreement_versions") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  order: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: { id: "ver-1", version_number: 1, content: sampleDraft },
                        error: null,
                      }),
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        if (table === "milestones") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn().mockResolvedValue({
                  data: [
                    { id: "ms-1", agreement_version_id: "ver-1", status: "DRAFT", sort_order: 0 },
                    { id: "ms-2", agreement_version_id: "ver-1", status: "DRAFT", sort_order: 1 },
                  ],
                  error: null,
                }),
              })),
            })),
            update: vi.fn(() => ({ in: updateIn })),
          };
        }
        if (table === "payment_intents") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          };
        }
        if (table === "activity_events") {
          return { insert: insertActivity };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;

    const result = await syncApprovedAgreementMilestones({
      supabase: mockSupabase,
      projectId: "proj-1",
      actorLabel: "Client OTP Approval",
    });

    expect(result).toEqual({
      synced: true,
      promotedCount: 2,
      insertedCount: 0,
      reason: "PROMOTED_DRAFT_MILESTONES",
    });
    expect(updateIn).toHaveBeenCalledWith("id", ["ms-1", "ms-2"]);
    expect(insertActivity).toHaveBeenCalledTimes(1);
  });

  it("materializes APPROVED milestones from agreement content when public.milestones is empty", async () => {
    const insertMilestones = vi.fn().mockResolvedValue({ error: null });
    const insertActivity = vi.fn().mockResolvedValue({ error: null });

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "agreements") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: "ag-1" }, error: null }),
              })),
            })),
          };
        }
        if (table === "agreement_versions") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  order: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: { id: "ver-1", version_number: 1, content: sampleDraft },
                        error: null,
                      }),
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        if (table === "milestones") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn().mockResolvedValue({ data: [], error: null }),
              })),
            })),
            insert: insertMilestones,
          };
        }
        if (table === "payment_intents") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          };
        }
        if (table === "activity_events") {
          return { insert: insertActivity };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;

    const result = await syncApprovedAgreementMilestones({
      supabase: mockSupabase,
      projectId: "proj-1",
    });

    expect(result).toEqual({
      synced: true,
      promotedCount: 0,
      insertedCount: 2,
      reason: "MATERIALIZED_FROM_APPROVED_AGREEMENT",
    });
    expect(insertMilestones).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: "proj-1",
          agreement_version_id: "ver-1",
          title: "Architecture & Setup",
          amount_minor: 100000,
          status: "APPROVED",
          sort_order: 0,
        }),
        expect.objectContaining({
          title: "Final Delivery",
          amount_minor: 150000,
          status: "APPROVED",
          sort_order: 1,
        }),
      ]),
    );
    expect(insertActivity).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when milestones are already synced and preserves committed/paid rows", async () => {
    const updateFn = vi.fn();
    const insertFn = vi.fn();
    const activityFn = vi.fn();

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "agreements") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: "ag-1" }, error: null }),
              })),
            })),
          };
        }
        if (table === "agreement_versions") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  order: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: { id: "ver-1", version_number: 1, content: sampleDraft },
                        error: null,
                      }),
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        if (table === "milestones") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn().mockResolvedValue({
                  data: [
                    { id: "ms-1", agreement_version_id: "ver-1", status: "IN_PROGRESS", sort_order: 0 },
                  ],
                  error: null,
                }),
              })),
            })),
            update: updateFn,
            insert: insertFn,
          };
        }
        if (table === "payment_intents") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({
                data: [{ id: "pi-1", milestone_id: "ms-1" }],
                error: null,
              }),
            })),
          };
        }
        if (table === "activity_events") {
          return { insert: activityFn };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;

    const result = await syncApprovedAgreementMilestones({
      supabase: mockSupabase,
      projectId: "proj-1",
    });

    expect(result).toEqual({
      synced: true,
      promotedCount: 0,
      insertedCount: 0,
      reason: "ALREADY_SYNCED",
    });
    expect(updateFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
    expect(activityFn).not.toHaveBeenCalled();
  });

  it("extracts latest submission notes, safe URLs, and revision feedback per milestone", () => {
    const notes = extractMilestoneNotes([
      {
        event_type: "milestone.revision_requested",
        created_at: "2026-11-11T10:00:00Z",
        metadata: {
          milestoneId: "ms-1",
          feedbackNote: "Please include desktop responsive breakpoint screenshots.",
        },
      },
      {
        event_type: "milestone.submitted",
        created_at: "2026-11-11T09:00:00Z",
        metadata: {
          milestoneId: "ms-1",
          submissionNote: "Deployed staging preview v2.",
          deliverableUrl: "https://staging.example.com/build",
        },
      },
      {
        event_type: "milestone.submitted",
        created_at: "2026-11-11T08:00:00Z",
        metadata: {
          milestoneId: "ms-1",
          submissionNote: "Older submission note should not override newer one.",
          deliverableUrl: "javascript:alert(1)",
        },
      },
    ]);

    expect(notes["ms-1"]).toEqual({
      latestSubmissionNote: "Deployed staging preview v2.",
      latestDeliverableUrl: "https://staging.example.com/build",
      latestSubmissionAt: "2026-11-11T09:00:00Z",
      latestFeedbackNote: "Please include desktop responsive breakpoint screenshots.",
      latestFeedbackAt: "2026-11-11T10:00:00Z",
    });
  });
});
