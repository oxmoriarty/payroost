import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listNotificationsGet } from "./route";
import { PATCH as markReadPatch } from "./[notificationId]/read/route";
import { POST as markAllReadPost } from "./mark-all-read/route";
import { GET as historyGet } from "../../projects/[projectId]/history/route";
import * as rateLimitModule from "@/lib/security/rate-limit";
import * as operatorCsrfModule from "@/lib/security/operator-csrf";
import * as notificationServiceModule from "@/features/notifications/service";
import * as historyServiceModule from "@/features/history/service";

const mockGetUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  allowRequest: vi.fn(),
}));

vi.mock("@/lib/security/operator-csrf", () => ({
  validateOperatorCsrf: vi.fn(),
}));

vi.mock("@/features/notifications/service", () => ({
  listUserNotifications: vi.fn(),
  markUserNotificationRead: vi.fn(),
  markAllUserNotificationsRead: vi.fn(),
}));

vi.mock("@/features/history/service", () => ({
  getProjectHistory: vi.fn(),
}));

describe("Authenticated Freelancer Notification & History API Routes", () => {
  const userId = "u0000000-0000-4000-a000-000000000001";
  const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const notifId = "11111111-1111-4111-a111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimitModule.allowRequest).mockResolvedValue(true);
    vi.mocked(operatorCsrfModule.validateOperatorCsrf).mockResolvedValue({ valid: true });
    mockGetUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  });

  it("returns 401 when unauthenticated and validates notification query parameters", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("No session") });
    const unauthRes = await listNotificationsGet(
      new Request("https://payroost.com/api/app/notifications"),
    );
    expect(unauthRes.status).toBe(401);

    const invalidQueryRes = await listNotificationsGet(
      new Request("https://payroost.com/api/app/notifications?filter=bogus"),
    );
    expect(invalidQueryRes.status).toBe(400);

    vi.mocked(notificationServiceModule.listUserNotifications).mockResolvedValueOnce({
      notifications: [],
      unreadCount: 2,
      actionRequiredCount: 1,
      totalCount: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    const okRes = await listNotificationsGet(
      new Request(
        `https://payroost.com/api/app/notifications?filter=unread&projectId=${projectId}`,
      ),
    );
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as { data: { unreadCount: number } };
    expect(body.data.unreadCount).toBe(2);
    expect(notificationServiceModule.listUserNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        projectId,
        filter: "unread",
      }),
    );
  });

  it("enforces operator CSRF, UUID validation, and 404 ownership checks on mark-read routes", async () => {
    const badIdRes = await markReadPatch(
      new Request("https://payroost.com/api/app/notifications/not-a-uuid/read", {
        method: "PATCH",
      }),
      { params: Promise.resolve({ notificationId: "not-a-uuid" }) },
    );
    expect(badIdRes.status).toBe(400);

    vi.mocked(operatorCsrfModule.validateOperatorCsrf).mockResolvedValueOnce({
      valid: false,
      error: "CSRF_MISMATCH",
    });
    const csrfRes = await markReadPatch(
      new Request(`https://payroost.com/api/app/notifications/${notifId}/read`, {
        method: "PATCH",
      }),
      { params: Promise.resolve({ notificationId: notifId }) },
    );
    expect(csrfRes.status).toBe(403);

    vi.mocked(notificationServiceModule.markUserNotificationRead).mockResolvedValueOnce(null);
    const missingRes = await markReadPatch(
      new Request(`https://payroost.com/api/app/notifications/${notifId}/read`, {
        method: "PATCH",
      }),
      { params: Promise.resolve({ notificationId: notifId }) },
    );
    expect(missingRes.status).toBe(404);

    vi.mocked(notificationServiceModule.markAllUserNotificationsRead).mockResolvedValueOnce({
      updatedCount: 4,
    });
    const markAllRes = await markAllReadPost(
      new Request("https://payroost.com/api/app/notifications/mark-all-read", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),
    );
    expect(markAllRes.status).toBe(200);
    expect(((await markAllRes.json()) as { data: { updatedCount: number } }).data.updatedCount).toBe(
      4,
    );
  });

  it("serves freelancer project history with strict ownership and pagination validation", async () => {
    const badProjectRes = await historyGet(
      new Request("https://payroost.com/api/projects/bad-id/history"),
      { params: Promise.resolve({ projectId: "bad-id" }) },
    );
    expect(badProjectRes.status).toBe(400);

    vi.mocked(historyServiceModule.getProjectHistory).mockResolvedValueOnce(null);
    const forbiddenRes = await historyGet(
      new Request(`https://payroost.com/api/projects/${projectId}/history`),
      { params: Promise.resolve({ projectId }) },
    );
    expect(forbiddenRes.status).toBe(404);

    vi.mocked(historyServiceModule.getProjectHistory).mockResolvedValueOnce({
      items: [],
      totalCount: 15,
      page: 2,
      pageSize: 10,
      hasMore: false,
    });
    const okRes = await historyGet(
      new Request(
        `https://payroost.com/api/projects/${projectId}/history?category=PAYMENT&sort=asc&page=2&pageSize=10`,
      ),
      { params: Promise.resolve({ projectId }) },
    );
    expect(okRes.status).toBe(200);
    expect(historyServiceModule.getProjectHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        userId,
        category: "PAYMENT",
        sort: "asc",
        page: 2,
        pageSize: 10,
      }),
    );
  });
});
