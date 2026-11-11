import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listPortalNotifications,
  listUserNotifications,
  markAllUserNotificationsRead,
  markPortalNotificationRead,
  markUserNotificationRead,
  syncNotificationsFromActivityEvents,
} from "./service";

const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const userId = "u0000000-0000-4000-a000-000000000001";
const otherUserId = "u9999999-9999-4999-a999-999999999999";

interface StoredNotification {
  id: string;
  project_id: string;
  source_activity_event_id: string | null;
  recipient_type: "USER" | "CLIENT_PORTAL";
  recipient_user_id: string | null;
  recipient_client_email: string | null;
  idempotency_key: string;
  category: string;
  event_type: string;
  severity: string;
  title: string;
  body: string;
  action_required: boolean;
  action_label: string | null;
  action_href: string | null;
  actor_label: string;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

function createInMemorySupabase(seed?: {
  notifications?: StoredNotification[];
  activities?: Array<Record<string, unknown>>;
  simulate23505OnBatchInsert?: boolean;
}) {
  const notifications: StoredNotification[] = [...(seed?.notifications ?? [])];
  const activities = seed?.activities ?? [];
  let seq = 1;

  const client = {
    from: vi.fn((table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let isHead = false;
      let wantCount = false;
      let pendingUpdate: Record<string, unknown> | null = null;
      let orderAsc = false;
      let rangeSlice: [number, number] | null = null;
      let limitVal: number | null = null;

      function applyFilters(rows: Array<Record<string, unknown>>) {
        let out = rows.filter((r) => filters.every((fn) => fn(r)));
        out = [...out].sort((a, b) => {
          const cmp = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
          return orderAsc ? cmp : -cmp;
        });
        return out;
      }

      const builder: Record<string, unknown> = {
        select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
          wantCount = Boolean(opts?.count);
          isHead = Boolean(opts?.head);
          return builder;
        }),
        eq: vi.fn((col: string, val: unknown) => {
          filters.push((row) => row[col] === val);
          return builder;
        }),
        is: vi.fn((col: string, val: unknown) => {
          filters.push((row) => (val === null ? row[col] == null : row[col] === val));
          return builder;
        }),
        in: vi.fn((col: string, vals: unknown[]) => {
          filters.push((row) => vals.includes(row[col]));
          return builder;
        }),
        order: vi.fn((_col: string, opts?: { ascending?: boolean }) => {
          if (opts && typeof opts.ascending === "boolean") {
            orderAsc = opts.ascending;
          }
          return builder;
        }),
        range: vi.fn((from: number, to: number) => {
          rangeSlice = [from, to];
          return builder;
        }),
        limit: vi.fn((n: number) => {
          limitVal = n;
          return builder;
        }),
        update: vi.fn((patch: Record<string, unknown>) => {
          pendingUpdate = patch;
          return builder;
        }),
        insert: vi.fn(async (payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
          const list = Array.isArray(payload) ? payload : [payload];
          if (Array.isArray(payload) && seed?.simulate23505OnBatchInsert) {
            return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          for (const item of list) {
            const duplicate = notifications.some(
              (existing) =>
                existing.recipient_type === item.recipient_type &&
                existing.idempotency_key === item.idempotency_key &&
                (item.recipient_type === "USER"
                  ? existing.recipient_user_id === item.recipient_user_id
                  : existing.project_id === item.project_id &&
                    existing.recipient_client_email === item.recipient_client_email),
            );
            if (duplicate) {
              return { error: { code: "23505", message: "duplicate key value" } };
            }
            notifications.push({
              id: `00000000-0000-4000-a000-${String(seq++).padStart(12, "0")}`,
              read_at: null,
              ...item,
            } as StoredNotification);
          }
          return { error: null };
        }),
        maybeSingle: vi.fn(async () => {
          if (table === "projects") {
            const matched = applyFilters([
              {
                id: projectId,
                owner_id: userId,
                title: "Acme Revamp",
                client_name: "Alice Client",
                client_email: "Client@Acme.COM",
              },
            ]);
            return { data: matched[0] ?? null, error: null };
          }

          if (pendingUpdate) {
            const matched = applyFilters(notifications as unknown as Array<Record<string, unknown>>);
            if (matched.length === 0) return { data: null, error: null };
            const target = matched[0] as unknown as StoredNotification;
            if (!target.read_at && pendingUpdate.read_at) {
              target.read_at = String(pendingUpdate.read_at);
            }
            return { data: { ...target }, error: null };
          }

          const matched = applyFilters(notifications as unknown as Array<Record<string, unknown>>);
          return { data: matched[0] ? { ...matched[0] } : null, error: null };
        }),
        then: (resolve: (val: unknown) => void) => {
          if (table === "activity_events") {
            let out = applyFilters(activities);
            if (limitVal !== null) out = out.slice(0, limitVal);
            resolve({ data: out, error: null });
            return;
          }

          if (pendingUpdate) {
            const matched = applyFilters(notifications as unknown as Array<Record<string, unknown>>);
            const updatedIds: Array<{ id: string }> = [];
            for (const row of matched) {
              const target = row as unknown as StoredNotification;
              if (!target.read_at && pendingUpdate.read_at) {
                target.read_at = String(pendingUpdate.read_at);
                updatedIds.push({ id: target.id });
              }
            }
            resolve({ data: updatedIds, error: null });
            return;
          }

          const matched = applyFilters(notifications as unknown as Array<Record<string, unknown>>);
          const count = wantCount ? matched.length : null;
          let paged = matched;
          if (rangeSlice) {
            paged = matched.slice(rangeSlice[0], rangeSlice[1] + 1);
          }
          resolve({
            data: isHead ? null : paged.map((r) => ({ ...r })),
            count,
            error: null,
          });
        },
      };

      return builder;
    }),
  };

  return {
    supabase: client as unknown as SupabaseClient,
    notifications,
  };
}

describe("Notifications Server Service", () => {
  it("projects activity_events idempotently and handles concurrent 23505 conflicts safely", async () => {
    const { supabase, notifications } = createInMemorySupabase({
      simulate23505OnBatchInsert: true,
      activities: [
        {
          id: "act-1",
          project_id: projectId,
          actor_label: "PayPal Webhook",
          event_type: "payment.order_captured",
          summary: "Captured intent pi-1",
          metadata: { paymentIntentId: "pi-1", milestoneId: "m-1" },
          created_at: "2026-11-11T10:00:00Z",
        },
        {
          id: "act-2",
          project_id: projectId,
          actor_label: "Reconciliation",
          event_type: "payment.reconciliation_completed",
          summary: "Reconciled intent pi-1",
          metadata: { paymentIntentId: "pi-1", milestoneId: "m-1" },
          created_at: "2026-11-11T10:05:00Z",
        },
      ],
    });

    await syncNotificationsFromActivityEvents({ projectId, serviceClient: supabase });
    // Even with both events mapping to payment.captured:pi-1 for USER + CLIENT_PORTAL,
    // only 2 rows exist (one USER, one CLIENT_PORTAL) despite batch 23505 fallback.
    expect(notifications).toHaveLength(2);
    expect(notifications.some((n) => n.recipient_type === "USER")).toBe(true);
    expect(notifications.some((n) => n.recipient_client_email === "client@acme.com")).toBe(true);

    // Re-running catch-up sync inserts 0 additional rows
    await syncNotificationsFromActivityEvents({ projectId, serviceClient: supabase });
    expect(notifications).toHaveLength(2);
  });

  it("lists filtered paginated notifications and enforces per-user & per-portal isolation on mark read", async () => {
    const { supabase } = createInMemorySupabase({
      notifications: [
        {
          id: "n-1",
          project_id: projectId,
          source_activity_event_id: null,
          recipient_type: "USER",
          recipient_user_id: userId,
          recipient_client_email: null,
          idempotency_key: "k-1",
          category: "AGREEMENT",
          event_type: "agreement.approved",
          severity: "SUCCESS",
          title: "Agreement approved",
          body: "Client approved v1",
          action_required: true,
          action_label: "Open",
          action_href: `/app/projects/${projectId}#milestones`,
          actor_label: "Client",
          metadata: {},
          read_at: null,
          created_at: "2026-11-11T11:00:00Z",
        },
        {
          id: "n-2",
          project_id: projectId,
          source_activity_event_id: null,
          recipient_type: "USER",
          recipient_user_id: userId,
          recipient_client_email: null,
          idempotency_key: "k-2",
          category: "PROJECT",
          event_type: "project.created",
          severity: "INFO",
          title: "Project created",
          body: "Project initialized",
          action_required: false,
          action_label: null,
          action_href: `/app/projects/${projectId}`,
          actor_label: "System",
          metadata: {},
          read_at: "2026-11-11T09:00:00Z",
          created_at: "2026-11-11T09:00:00Z",
        },
        {
          id: "n-client-1",
          project_id: projectId,
          source_activity_event_id: null,
          recipient_type: "CLIENT_PORTAL",
          recipient_user_id: null,
          recipient_client_email: "client@acme.com",
          idempotency_key: "c-1",
          category: "MILESTONE",
          event_type: "milestone.submitted",
          severity: "ACTION_REQUIRED",
          title: "Deliverables submitted",
          body: "Please review Milestone 1",
          action_required: true,
          action_label: "Review",
          action_href: "/portal#milestones",
          actor_label: "Freelancer",
          metadata: {},
          read_at: null,
          created_at: "2026-11-11T11:30:00Z",
        },
      ],
    });

    const page1 = await listUserNotifications({
      userId,
      page: 1,
      pageSize: 1,
      sync: false,
      supabaseClient: supabase,
    });
    expect(page1.notifications).toHaveLength(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.totalCount).toBe(2);
    expect(page1.unreadCount).toBe(1);
    expect(page1.actionRequiredCount).toBe(1);

    // Cross-user mark-read is denied (returns null)
    const crossUserAttempt = await markUserNotificationRead({
      userId: otherUserId,
      notificationId: "n-1",
      supabaseClient: supabase,
    });
    expect(crossUserAttempt).toBeNull();

    // Preserves existing read_at idempotently
    const alreadyRead = await markUserNotificationRead({
      userId,
      notificationId: "n-2",
      supabaseClient: supabase,
    });
    expect(alreadyRead?.readAt).toBe("2026-11-11T09:00:00Z");

    // Mark all unread for userId
    const bulkResult = await markAllUserNotificationsRead({ userId, supabaseClient: supabase });
    expect(bulkResult.updatedCount).toBe(1);

    // Portal listing normalizes clientEmail casing & scopes strictly
    const portalList = await listPortalNotifications({
      projectId,
      clientEmail: "CLIENT@ACME.COM",
      sync: false,
      serviceClient: supabase,
    });
    expect(portalList.unreadCount).toBe(1);

    const wrongClientMark = await markPortalNotificationRead({
      projectId,
      clientEmail: "attacker@acme.com",
      notificationId: "n-client-1",
      serviceClient: supabase,
    });
    expect(wrongClientMark).toBeNull();

    const rightClientMark = await markPortalNotificationRead({
      projectId,
      clientEmail: "client@acme.com",
      notificationId: "n-client-1",
      serviceClient: supabase,
    });
    expect(rightClientMark?.readAt).toBeTruthy();
  });

  it("falls back cleanly on pre-migration 42P01 missing table error while rethrowing unexpected DB errors", async () => {
    const missingTableClient = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockReturnThis(),
        then: (resolve: (val: unknown) => void) =>
          resolve({
            data: null,
            error: { code: "42P01", message: 'relation "public.notifications" does not exist' },
          }),
      })),
    } as unknown as SupabaseClient;

    const result = await listUserNotifications({
      userId,
      sync: false,
      supabaseClient: missingTableClient,
    });
    expect(result.notifications).toEqual([]);
    expect(result.unreadCount).toBe(0);

    const outageClient = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockReturnThis(),
        then: (resolve: (val: unknown) => void) =>
          resolve({
            data: null,
            error: { code: "XX000", message: "connection timeout" },
          }),
      })),
    } as unknown as SupabaseClient;

    await expect(
      listUserNotifications({ userId, sync: false, supabaseClient: outageClient }),
    ).rejects.toMatchObject({ code: "XX000" });
  });
});
