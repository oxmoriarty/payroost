import { describe, expect, it } from "vitest";
import {
  mapActivityEventToNotificationDrafts,
  safeRelativeHref,
  sanitizeNotificationText,
  type NotificationProjectContext,
} from "./mapper";

const project: NotificationProjectContext = {
  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  ownerId: "u0000000-0000-4000-a000-000000000001",
  title: "Acme Design System",
  clientName: "Alice Client",
  clientEmail: "  Alice.Client@Acme.COM ",
};

function makeActivity(
  eventType: string,
  overrides?: Partial<{
    id: string;
    actor_label: string;
    summary: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>,
) {
  return {
    id: overrides?.id ?? "a1111111-1111-4111-8111-111111111111",
    project_id: project.id,
    actor_label: overrides?.actor_label ?? "System",
    event_type: eventType,
    summary: overrides?.summary ?? `Recorded ${eventType}`,
    metadata: overrides?.metadata ?? {},
    created_at: overrides?.created_at ?? "2026-11-11T12:00:00.000Z",
  };
}

describe("Notification Mapper & Privacy/Idempotency Rules", () => {
  it("sanitizes control characters and enforces relative action URLs", () => {
    expect(sanitizeNotificationText("Hello\r\n\tworld  !", 50, "Fallback")).toBe("Hello world !");
    expect(sanitizeNotificationText(" ", 50, "Fallback")).toBe("Fallback");

    expect(safeRelativeHref("/app/projects/123#agreement")).toBe("/app/projects/123#agreement");
    expect(safeRelativeHref("https://evil.example/phish")).toBeNull();
    expect(safeRelativeHref("//evil.example/phish")).toBeNull();
  });

  it("ignores noisy internal events with no user-facing meaning", () => {
    for (const internalType of [
      "agreement.edited",
      "milestone.plan_synced",
      "payment.capture_initiated",
      "payment.clear_expired_lease",
      "payment.expired_lease_cleared",
      "payment.webhook_reprocessed",
      "payment.retry_order_creation",
      "payment.operator_reconcile",
    ]) {
      expect(mapActivityEventToNotificationDrafts(makeActivity(internalType), project)).toEqual([]);
    }
  });

  it("projects project onboarding, verification, and portal invite without raw tokens", () => {
    const inviteDrafts = mapActivityEventToNotificationDrafts(
      makeActivity("portal.invited", { metadata: { expiresAt: "2026-11-18T00:00:00Z" } }),
      project,
    );
    expect(inviteDrafts).toHaveLength(1);
    expect(inviteDrafts[0]?.recipient_type).toBe("CLIENT_PORTAL");
    expect(inviteDrafts[0]?.recipient_client_email).toBe("alice.client@acme.com");
    expect(inviteDrafts[0]?.action_href).toBe("/portal#milestones");
    expect(JSON.stringify(inviteDrafts)).not.toContain("token");

    const resentDrafts = mapActivityEventToNotificationDrafts(
      makeActivity("client_email.verification_resent"),
      project,
    );
    expect(resentDrafts).toHaveLength(1);
    expect(resentDrafts[0]?.recipient_type).toBe("USER");
    expect(resentDrafts[0]?.category).toBe("PROJECT");
  });

  it("emits agreement, milestone, and scope-change notifications with separate work vs payment states", () => {
    const revDrafts = mapActivityEventToNotificationDrafts(
      makeActivity("agreement.version_created", {
        metadata: { agreementVersionId: "ver-2", versionNumber: 2, isRevision: true },
      }),
      project,
    );
    expect(revDrafts).toHaveLength(1);
    expect(revDrafts[0]?.recipient_type).toBe("USER");
    expect(revDrafts[0]?.idempotency_key).toBe("agreement.revision:ver-2");

    const sentDrafts = mapActivityEventToNotificationDrafts(
      makeActivity("agreement.sent", { metadata: { agreementVersionId: "ver-2" } }),
      project,
    );
    expect(sentDrafts).toHaveLength(2);
    expect(sentDrafts.find((d) => d.recipient_type === "CLIENT_PORTAL")?.action_required).toBe(true);

    const submittedDrafts = mapActivityEventToNotificationDrafts(
      makeActivity("milestone.submitted", {
        metadata: { milestoneId: "m-1", milestoneTitle: "Phase 1" },
      }),
      project,
    );
    expect(submittedDrafts).toHaveLength(2);
    expect(submittedDrafts.find((d) => d.recipient_type === "CLIENT_PORTAL")?.action_href).toBe(
      "/portal#milestones",
    );

    const clientChangeDrafts = mapActivityEventToNotificationDrafts(
      makeActivity("change_request.submitted", {
        metadata: { changeRequestId: "cr-1", requesterRole: "CLIENT" },
      }),
      project,
    );
    expect(clientChangeDrafts).toHaveLength(1);
    expect(clientChangeDrafts[0]?.recipient_type).toBe("USER");
    expect(clientChangeDrafts[0]?.action_required).toBe(true);

    const staleDrafts = mapActivityEventToNotificationDrafts(
      makeActivity("change_request.analysis_stale", {
        metadata: { changeRequestId: "cr-1", versionNumber: 2 },
      }),
      project,
    );
    expect(staleDrafts).toHaveLength(2);
    expect(staleDrafts[0]?.severity).toBe("WARNING");
  });

  it("uses identical canonical idempotency keys across duplicate webhook & reconciliation capture events", () => {
    const intentId = "pi-9999";
    const webhookCapture = mapActivityEventToNotificationDrafts(
      makeActivity("payment.order_captured", {
        id: "act-1",
        metadata: { paymentIntentId: intentId, milestoneId: "m-1" },
      }),
      project,
    );
    const reconciledCapture = mapActivityEventToNotificationDrafts(
      makeActivity("payment.reconciliation_completed", {
        id: "act-2",
        metadata: { paymentIntentId: intentId, milestoneId: "m-1" },
      }),
      project,
    );

    expect(webhookCapture).toHaveLength(2);
    expect(reconciledCapture).toHaveLength(2);
    expect(webhookCapture[0]?.idempotency_key).toBe(`payment.captured:${intentId}`);
    expect(reconciledCapture[0]?.idempotency_key).toBe(`payment.captured:${intentId}`);

    // Client payment notification never includes internal paymentIntentId in metadata or escrow wording
    const clientCapture = webhookCapture.find((d) => d.recipient_type === "CLIENT_PORTAL");
    expect(clientCapture?.metadata).toEqual({ milestoneId: "m-1" });
    expect(clientCapture?.body.toLowerCase()).not.toContain("escrow");

    // Reconciliation required & recovery events stay freelancer-only
    const reconRequired = mapActivityEventToNotificationDrafts(
      makeActivity("payment.marked_reconciliation_required", {
        metadata: { paymentIntentId: intentId, milestoneId: "m-1" },
      }),
      project,
    );
    expect(reconRequired).toHaveLength(1);
    expect(reconRequired[0]?.recipient_type).toBe("USER");
    expect(reconRequired[0]?.category).toBe("RECONCILIATION");
    expect(reconRequired[0]?.action_href).toBe("/app/payments");
  });
});
