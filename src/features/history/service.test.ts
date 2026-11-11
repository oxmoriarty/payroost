import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPortalProjectHistory, getProjectHistory } from "./service";

const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const ownerId = "u0000000-0000-4000-a000-000000000001";

function createHistorySupabase(options: {
  ownedBy?: string;
  activities: Array<Record<string, unknown>>;
}) {
  const client = {
    from: vi.fn((table: string) => {
      const filters: Record<string, unknown> = {};
      let orderAsc = false;

      const builder: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        }),
        order: vi.fn((_col: string, opts?: { ascending?: boolean }) => {
          if (opts && typeof opts.ascending === "boolean") {
            orderAsc = opts.ascending;
          }
          return builder;
        }),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => {
          if (table === "projects") {
            const match =
              filters.id === projectId &&
              (filters.owner_id === undefined || filters.owner_id === (options.ownedBy ?? ownerId));
            return { data: match ? { id: projectId } : null, error: null };
          }
          return { data: null, error: null };
        }),
        then: (resolve: (val: unknown) => void) => {
          const out = [...options.activities].sort((a, b) => {
            const cmp = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
            return orderAsc ? cmp : -cmp;
          });
          resolve({ data: out, error: null });
        },
      };
      return builder;
    }),
  };

  return client as unknown as SupabaseClient;
}

describe("Project History Server Service", () => {
  const sampleEvents = [
    {
      id: "e-1",
      project_id: projectId,
      actor_label: "Freelancer",
      event_type: "agreement.edited",
      summary: "Edited internal draft",
      metadata: {},
      created_at: "2026-11-11T09:00:00Z",
    },
    {
      id: "e-2",
      project_id: projectId,
      actor_label: "Client OTP",
      event_type: "agreement.approved",
      summary: "Client approved v1",
      metadata: { agreementVersionId: "v-1", versionNumber: 1 },
      created_at: "2026-11-11T10:00:00Z",
    },
    {
      id: "e-3",
      project_id: projectId,
      actor_label: "PayPal Webhook",
      event_type: "payment.order_captured",
      summary: "Captured intent pi-1",
      metadata: { paymentIntentId: "pi-1", milestoneId: "m-1" },
      created_at: "2026-11-11T11:00:00Z",
    },
  ];

  it("enforces owner verification and paginates freelancer history accurately", async () => {
    const supabase = createHistorySupabase({ ownedBy: ownerId, activities: sampleEvents });

    const crossUser = await getProjectHistory({
      projectId,
      userId: "u9999999-9999-4999-a999-999999999999",
      supabaseClient: supabase,
    });
    expect(crossUser).toBeNull();

    const page1 = await getProjectHistory({
      projectId,
      userId: ownerId,
      page: 1,
      pageSize: 2,
      sort: "desc",
      supabaseClient: supabase,
    });
    expect(page1?.totalCount).toBe(3);
    expect(page1?.items.map((i) => i.id)).toEqual(["e-3", "e-2"]);
    expect(page1?.hasMore).toBe(true);
  });

  it("filters hidden internal events BEFORE counting/paginating portal history", async () => {
    const supabase = createHistorySupabase({ activities: sampleEvents });

    const portalResult = await getPortalProjectHistory({
      projectId,
      page: 1,
      pageSize: 2,
      sort: "asc",
      serviceClient: supabase,
    });

    // Only 2 events visible to client (e-1 hidden), so totalCount=2 and hasMore=false
    expect(portalResult.totalCount).toBe(2);
    expect(portalResult.hasMore).toBe(false);
    expect(portalResult.items.map((i) => i.id)).toEqual(["e-2", "e-3"]);
  });
});
