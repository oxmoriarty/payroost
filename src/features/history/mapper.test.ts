import { describe, expect, it } from "vitest";
import { mapActivityEventsToHistoryItems } from "./mapper";

const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("Project History Mapper & Audience Privacy Filtering", () => {
  it("hides internal edits, recovery, and reconciliation events from client audience while retaining them for freelancer", () => {
    const events = [
      {
        id: "e-1",
        project_id: projectId,
        actor_label: "Freelancer",
        event_type: "agreement.edited",
        summary: "Edited internal draft clauses",
        metadata: {},
        created_at: "2026-11-11T09:00:00.000Z",
      },
      {
        id: "e-2",
        project_id: projectId,
        actor_label: "Operator (ops@payroost.dev)",
        event_type: "payment.marked_reconciliation_required",
        summary: "Moved intent pi-123 to RECONCILIATION_REQUIRED",
        metadata: { paymentIntentId: "pi-123" },
        created_at: "2026-11-11T09:10:00.000Z",
      },
      {
        id: "e-3",
        project_id: projectId,
        actor_label: "PayPal Webhook",
        event_type: "payment.order_captured",
        summary: "Capture completed for merchant M1234",
        metadata: { paymentIntentId: "pi-123", milestoneId: "m-1", milestoneTitle: "Phase 1" },
        created_at: "2026-11-11T09:20:00.000Z",
      },
    ];

    const freelancerHistory = mapActivityEventsToHistoryItems(events, "freelancer");
    const clientHistory = mapActivityEventsToHistoryItems(events, "client");

    expect(freelancerHistory).toHaveLength(3);
    expect(freelancerHistory[1]?.category).toBe("RECONCILIATION");
    expect(freelancerHistory[1]?.entityRef?.href).toBe("/app/payments");
    expect(freelancerHistory[0]?.actorLabel).toBe("Freelancer");

    // Client only sees sanitized payment capture confirmation
    expect(clientHistory).toHaveLength(1);
    expect(clientHistory[0]?.eventType).toBe("payment.order_captured");
    expect(clientHistory[0]?.summary).not.toContain("M1234");
    expect(clientHistory[0]?.stateDisciplineBadge).toBe(
      "Payment Confirmed (Work Acceptance Separate)",
    );
    expect(clientHistory[0]?.entityRef?.href).toBe("#milestones");
  });

  it("distinguishes AI-assisted actions from manual actions and preserves approval/work separation badges", () => {
    const events = [
      {
        id: "e-ai",
        project_id: projectId,
        actor_label: "Freelancer",
        event_type: "agreement.version_created",
        summary: "Created AI-assisted agreement version 2",
        metadata: { source: "AI_ASSISTED", agreementVersionId: "v-2", versionNumber: 2 },
        created_at: "2026-11-11T10:00:00.000Z",
      },
      {
        id: "e-manual",
        project_id: projectId,
        actor_label: "Freelancer",
        event_type: "milestone.plan_applied",
        summary: "Applied manual milestone plan to draft",
        metadata: { source: "MANUAL" },
        created_at: "2026-11-11T10:05:00.000Z",
      },
      {
        id: "e-approved-order",
        project_id: projectId,
        actor_label: "PayPal Webhook",
        event_type: "payment.webhook_order_approved",
        summary: "Buyer approved checkout order",
        metadata: { milestoneId: "m-1" },
        created_at: "2026-11-11T10:10:00.000Z",
      },
      {
        id: "e-accepted",
        project_id: projectId,
        actor_label: "Client OTP",
        event_type: "milestone.accepted",
        summary: "Client accepted deliverables",
        metadata: { milestoneId: "m-1", milestoneTitle: "Architecture" },
        created_at: "2026-11-11T10:20:00.000Z",
      },
    ];

    const items = mapActivityEventsToHistoryItems(events, "freelancer");
    expect(items[0]?.isAiAssisted).toBe(true);
    expect(items[0]?.aiAttributionLabel).toBe("AI-assisted");
    expect(items[0]?.entityRef?.href).toBe(`/app/projects/${projectId}#agreement`);

    expect(items[1]?.isAiAssisted).toBe(false);
    expect(items[1]?.aiAttributionLabel).toBe("Manual");

    // Payment order approved != captured; Deliverable accepted != payment completed
    expect(items[2]?.stateDisciplineBadge).toBe("Order Approved (Not Captured)");
    expect(items[3]?.stateDisciplineBadge).toBe("Deliverables Accepted (Payment Separate)");
  });

  it("suppresses unmapped/unknown operational events from client history so raw internal summary text cannot leak", () => {
    const events = [
      {
        id: "e-unknown-op",
        project_id: projectId,
        actor_label: "Operator (internal@payroost.dev)",
        event_type: "system.paypal_debug_retry",
        summary: "Internal token debug stack trace for merchant MCH-SECRET-99",
        metadata: { debugPayload: "sensitive" },
        created_at: "2026-11-11T11:00:00.000Z",
      },
      {
        id: "e-client-safe",
        project_id: projectId,
        actor_label: "Freelancer (owner@agency.example)",
        event_type: "portal.invited",
        summary: "Sent verified Client Portal invitation link",
        metadata: {},
        created_at: "2026-11-11T11:05:00.000Z",
      },
    ];

    const freelancerHistory = mapActivityEventsToHistoryItems(events, "freelancer");
    expect(freelancerHistory).toHaveLength(2);
    expect(freelancerHistory[0]?.eventType).toBe("system.paypal_debug_retry");
    expect(freelancerHistory[0]?.summary).toContain("MCH-SECRET-99");

    const clientHistory = mapActivityEventsToHistoryItems(events, "client");
    expect(clientHistory).toHaveLength(1);
    expect(clientHistory[0]?.eventType).toBe("portal.invited");
    expect(clientHistory[0]?.actorLabel).toBe("Freelancer");
    expect(JSON.stringify(clientHistory)).not.toContain("MCH-SECRET-99");
    expect(JSON.stringify(clientHistory)).not.toContain("system.paypal_debug_retry");
    expect(JSON.stringify(clientHistory)).not.toContain("owner@agency.example");
  });
});
