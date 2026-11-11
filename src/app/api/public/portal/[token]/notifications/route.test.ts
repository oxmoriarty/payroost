import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GET as portalNotificationsGet } from "./route";
import { PATCH as portalMarkReadPatch } from "./[notificationId]/read/route";
import { POST as portalMarkAllReadPost } from "./mark-all-read/route";
import { GET as portalHistoryGet } from "../history/route";
import * as portalAuthModule from "@/features/scope-changes/portal-auth";
import * as notificationServiceModule from "@/features/notifications/service";
import * as historyServiceModule from "@/features/history/service";

vi.mock("@/features/scope-changes/portal-auth", () => ({
  authenticatePortalRequest: vi.fn(),
}));

vi.mock("@/features/notifications/service", () => ({
  listPortalNotifications: vi.fn(),
  markPortalNotificationRead: vi.fn(),
  markAllPortalNotificationsRead: vi.fn(),
}));

vi.mock("@/features/history/service", () => ({
  getPortalProjectHistory: vi.fn(),
}));

describe("Verified Client Portal Notification & History API Routes", () => {
  const token = "portal-test-token-43-chars-base64url-valid_";
  const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const clientEmail = "verified-client@acme.com";
  const notifId = "22222222-2222-4222-a222-222222222222";
  const mockServiceClient = {} as SupabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(portalAuthModule.authenticatePortalRequest).mockResolvedValue({
      ok: true,
      serviceClient: mockServiceClient,
      projectId,
      clientEmail,
      tokenHash: "hash-abc",
    });
  });

  it("authenticates portal notification GET without CSRF header while scoping strictly to projectId + clientEmail", async () => {
    vi.mocked(notificationServiceModule.listPortalNotifications).mockResolvedValueOnce({
      notifications: [],
      unreadCount: 1,
      actionRequiredCount: 1,
      totalCount: 1,
      page: 1,
      pageSize: 10,
      hasMore: false,
    });

    const res = await portalNotificationsGet(
      new Request(
        `https://payroost.com/api/public/portal/${token}/notifications?filter=unread`,
      ),
      { params: Promise.resolve({ token }) },
    );

    expect(res.status).toBe(200);
    expect(portalAuthModule.authenticatePortalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requireCsrf: false,
        rateLimitPrefix: "portal-notifications",
      }),
    );
    expect(notificationServiceModule.listPortalNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        clientEmail,
        filter: "unread",
      }),
    );
  });

  it("enforces CSRF and valid UUID on mutating portal notification endpoints", async () => {
    vi.mocked(portalAuthModule.authenticatePortalRequest).mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "INVALID_CSRF_TOKEN" }, { status: 403 }),
    });

    const noCsrfRes = await portalMarkReadPatch(
      new Request(
        `https://payroost.com/api/public/portal/${token}/notifications/${notifId}/read`,
        { method: "PATCH" },
      ),
      { params: Promise.resolve({ token, notificationId: notifId }) },
    );
    expect(noCsrfRes.status).toBe(403);
    expect(portalAuthModule.authenticatePortalRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requireCsrf: true }),
    );

    const badUuidRes = await portalMarkReadPatch(
      new Request(`https://payroost.com/api/public/portal/${token}/notifications/bad/read`, {
        method: "PATCH",
      }),
      { params: Promise.resolve({ token, notificationId: "bad" }) },
    );
    expect(badUuidRes.status).toBe(400);

    vi.mocked(notificationServiceModule.markAllPortalNotificationsRead).mockResolvedValueOnce({
      updatedCount: 2,
    });
    const bulkRes = await portalMarkAllReadPost(
      new Request(`https://payroost.com/api/public/portal/${token}/notifications/mark-all-read`, {
        method: "POST",
        headers: { "x-csrf-token": "csrf-valid" },
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(bulkRes.status).toBe(200);
    expect(((await bulkRes.json()) as { data: { updatedCount: number } }).data.updatedCount).toBe(2);
  });

  it("serves client-filtered project history only for authenticated portal sessions", async () => {
    vi.mocked(historyServiceModule.getPortalProjectHistory).mockResolvedValueOnce({
      items: [],
      totalCount: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });

    const res = await portalHistoryGet(
      new Request(
        `https://payroost.com/api/public/portal/${token}/history?category=MILESTONE&sort=desc`,
      ),
      { params: Promise.resolve({ token }) },
    );

    expect(res.status).toBe(200);
    expect(portalAuthModule.authenticatePortalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitPrefix: "portal-history",
        requireCsrf: false,
      }),
    );
    expect(historyServiceModule.getPortalProjectHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        category: "MILESTONE",
        sort: "desc",
      }),
    );
  });
});
