import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppHeader } from "@/components/app/header";
import { ProjectHistoryPanel } from "@/features/history/project-history-panel";
import type { ProjectHistoryPageResult } from "@/features/history/types";
import { PortalNotificationsPanel } from "@/features/portal/portal-notifications-panel";
import { NotificationsCenter } from "./notifications-center";
import type { NotificationPageResult, NotificationRecord } from "./types";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh }),
  usePathname: () => "/app/notifications",
}));

const sampleNotification1: NotificationRecord = {
  id: "11111111-1111-4111-a111-111111111111",
  projectId: "p-1",
  sourceActivityEventId: "act-1",
  recipientType: "USER",
  category: "MILESTONE",
  eventType: "milestone.revision_requested",
  severity: "ACTION_REQUIRED",
  title: "Milestone revision requested",
  body: 'Client requested revisions on "API Auth" (Acme Portal).',
  actionRequired: true,
  actionLabel: "Respond to feedback",
  actionHref: "/app/projects/p-1#milestones",
  actorLabel: "Client",
  metadata: {},
  readAt: null,
  createdAt: "2026-11-11T12:00:00.000Z",
};

const sampleNotification2: NotificationRecord = {
  id: "22222222-2222-4222-a222-222222222222",
  projectId: "p-1",
  sourceActivityEventId: "act-2",
  recipientType: "USER",
  category: "PAYMENT",
  eventType: "payment.order_captured",
  severity: "SUCCESS",
  title: "PayPal payment captured (Provider Confirmed)",
  body: "Payment confirmed for Milestone 1.",
  actionRequired: false,
  actionLabel: "View milestones",
  actionHref: "/app/projects/p-1#milestones",
  actorLabel: "PayPal Webhook",
  metadata: {},
  readAt: "2026-11-11T10:00:00.000Z",
  createdAt: "2026-11-11T10:00:00.000Z",
};

describe("Phase P2 Notifications & Project History UI", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("renders persistent notifications in AppHeader with unread grouping, mark-one read, and mark-all read", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/app/csrf") {
        return new Response(JSON.stringify({ csrfToken: "csrf-test-token" }), { status: 200 });
      }
      if (url.endsWith("/read")) {
        return new Response(
          JSON.stringify({
            data: { ...sampleNotification1, readAt: "2026-11-11T12:05:00.000Z" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: { updatedCount: 1 } }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <AppHeader
        actionRequiredCount={1}
        persistentNotifications={[sampleNotification1, sampleNotification2]}
        unreadCount={1}
        userLabel="Ada"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /notifications \(1\)/i }));
    expect(screen.getByText(/action required \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText("Milestone revision requested")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^mark read$/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/app/notifications/${sampleNotification1.id}/read`,
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({ "x-csrf-token": "csrf-test-token" }),
        }),
      );
    });
  });

  it("handles filtering, pagination, mark-all-read, and error recovery in NotificationsCenter", async () => {
    const initialData: NotificationPageResult = {
      notifications: [sampleNotification1],
      unreadCount: 1,
      actionRequiredCount: 1,
      totalCount: 25,
      page: 1,
      pageSize: 20,
      hasMore: true,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("filter=unread")) {
        return new Response("Server error", { status: 500 });
      }
      if (url === "/api/app/csrf") {
        return new Response(JSON.stringify({ csrfToken: "csrf-center" }), { status: 200 });
      }
      if (url.includes("/mark-all-read")) {
        return new Response(JSON.stringify({ data: { updatedCount: 1 } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            notifications: [sampleNotification2],
            unreadCount: 1,
            actionRequiredCount: 0,
            totalCount: 25,
            page: 2,
            pageSize: 20,
            hasMore: false,
          },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <NotificationsCenter
        initialData={initialData}
        projectTitles={{ "p-1": "Acme Portal" }}
      />,
    );

    expect(screen.getByText("Milestone revision requested")).toBeInTheDocument();
    expect(screen.getByText("· Acme Portal")).toBeInTheDocument();

    // Pagination page 2
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    await waitFor(() => {
      expect(screen.getByText("PayPal payment captured (Provider Confirmed)")).toBeInTheDocument();
    });

    // Error state on failed filter load
    fireEvent.click(screen.getByRole("button", { name: /^unread$/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/unable to load notifications/i);
    });

    // Mark all read
    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/app/notifications/mark-all-read",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "x-csrf-token": "csrf-center" }),
        }),
      );
    });
  });

  it("supports client portal notifications mark-read and section jumps without raw tokens", async () => {
    const portalNotif: NotificationRecord = {
      ...sampleNotification1,
      id: "33333333-3333-4333-a333-333333333333",
      recipientType: "CLIENT_PORTAL",
      category: "AGREEMENT",
      title: "Agreement proposal sent for your review",
      body: "Inspect agreement v2 for OTP approval.",
      actionLabel: "Inspect agreement",
      actionHref: "/portal#agreement",
    };

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { ...portalNotif, readAt: "2026-11-11T12:15:00.000Z" },
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const onNavigateSection = vi.fn();
    render(
      <PortalNotificationsPanel
        csrfToken="portal-csrf-123"
        initialData={{
          notifications: [portalNotif],
          unreadCount: 1,
          actionRequiredCount: 1,
          totalCount: 1,
          page: 1,
          pageSize: 10,
          hasMore: false,
        }}
        onNavigateSection={onNavigateSection}
        token="raw-secret-portal-token"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect agreement" }));
    expect(onNavigateSection).toHaveBeenCalledWith("agreement");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/notifications/${portalNotif.id}/read`),
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({ "x-csrf-token": "portal-csrf-123" }),
        }),
      );
    });
  });

  it("renders ProjectHistoryPanel with AI vs Manual attribution, audience filters, and client section jump", async () => {
    const initialHistory: ProjectHistoryPageResult = {
      items: [
        {
          id: "h-1",
          projectId: "p-1",
          eventType: "agreement.version_created",
          category: "AGREEMENT",
          title: "Agreement v2 drafted",
          summary: "Created AI-assisted agreement version 2",
          actorLabel: "Freelancer",
          actorKind: "AI_ASSISTED",
          isAiAssisted: true,
          aiAttributionLabel: "AI-assisted",
          stateDisciplineBadge: "Draft Version",
          entityRef: {
            kind: "AGREEMENT_VERSION",
            label: "Agreement v2",
            href: "#agreement",
          },
          createdAt: "2026-11-11T11:00:00.000Z",
        },
        {
          id: "h-2",
          projectId: "p-1",
          eventType: "payment.order_captured",
          category: "PAYMENT",
          title: "PayPal payment captured (Provider Confirmed)",
          summary: "PayPal confirmed milestone payment capture.",
          actorLabel: "PayPal Webhook",
          actorKind: "SYSTEM",
          isAiAssisted: false,
          aiAttributionLabel: null,
          stateDisciplineBadge: "Payment Confirmed (Work Acceptance Separate)",
          entityRef: {
            kind: "MILESTONE",
            label: "Milestone 1",
            href: "#milestones",
          },
          createdAt: "2026-11-11T10:00:00.000Z",
        },
      ],
      totalCount: 2,
      page: 1,
      pageSize: 20,
      hasMore: false,
    };

    const onClientNavigateSection = vi.fn();
    render(
      <ProjectHistoryPanel
        initialHistory={initialHistory}
        mode="client"
        onClientNavigateSection={onClientNavigateSection}
        portalToken="portal-tok"
        projectId="p-1"
      />,
    );

    // Reconciliation filter pill must NOT appear for clients
    expect(screen.queryByRole("button", { name: "Reconciliation" })).toBeNull();
    expect(screen.getByText("AI-assisted")).toBeInTheDocument();
    expect(
      screen.getByText("Payment Confirmed (Work Acceptance Separate)"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Agreement v2/i }));
    expect(onClientNavigateSection).toHaveBeenCalledWith("agreement");
  });
});
