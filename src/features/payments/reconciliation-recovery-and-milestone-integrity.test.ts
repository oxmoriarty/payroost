import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("PayRoost Phase 3B.4.1.4: Reconciliation Recovery & Milestone Integrity", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611070002_reconciliation_recovery_and_milestone_integrity.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC DDL AND ACCESS CONTROL AUDIT
  // ==========================================================================
  describe("1. Static SQL Grants and Function Definitions", () => {
    it("updates protect_milestone_payment_invariants to protect milestones during RECONCILIATION_REQUIRED", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.protect_milestone_payment_invariants\(\)/i);
      expect(migrationSql).toMatch(/'RECONCILIATION_REQUIRED'/);
      expect(migrationSql).toMatch(/milestones_protect_payment_invariants/);
      expect(migrationSql).toMatch(/before\s+update\s+or\s+delete\s+on\s+public\.milestones/i);
    });

    it("updates protect_payment_intent_immutability to permit privileged recovery to FAILED or CANCELLED", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.protect_payment_intent_immutability\(\)/i);
      expect(migrationSql).toMatch(/current_setting\('payroost\.reconciliation_active',\s*true\)\s+is\s+distinct\s+from\s+'true'/i);
      expect(migrationSql).toMatch(/new\.status\s+not\s+in\s+\('COMPLETED',\s*'FAILED',\s*'CANCELLED'\)/i);
    });

    it("defines admin_resolve_reconciliation_without_payment with security definer and safe search_path", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.admin_resolve_reconciliation_without_payment\(/i);
      expect(migrationSql).toMatch(/security\s+definer/i);
      expect(migrationSql).toMatch(/set\s+search_path\s*=\s*''/i);
    });

    it("restricts admin_resolve_reconciliation_without_payment strictly to service_role", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.admin_resolve_reconciliation_without_payment\(uuid,\s*text,\s*text,\s*jsonb,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.admin_resolve_reconciliation_without_payment\(uuid,\s*text,\s*text,\s*jsonb,\s*text\)\s+to\s+service_role;/i
      );
    });
  });

  // ==========================================================================
  // SECTION 2: BEHAVIORAL VERIFICATION OF MILESTONE PAYMENT INVARIANTS (F-01)
  // ==========================================================================
  describe("2. Behavioral Simulation: Milestone Protection Trigger", () => {
    interface Milestone {
      id: string;
      project_id: string;
      status: string;
      amount_minor: bigint;
      currency: string;
      title?: string;
      description?: string;
    }

    interface PaymentIntent {
      id: string;
      milestone_id: string;
      status: string;
      order_creation_lease_expires_at: Date | null;
    }

    function simulateMilestoneTrigger(params: {
      op: "UPDATE" | "DELETE";
      oldRecord: Milestone;
      newRecord?: Milestone;
      intents: PaymentIntent[];
      now?: Date;
    }): { allowed: boolean; error?: string } {
      const now = params.now || new Date();
      const protectedIntents = params.intents.filter((intent) => {
        if (intent.milestone_id !== params.oldRecord.id) return false;
        if (["ORDER_CREATED", "BUYER_APPROVED", "CAPTURING", "RECONCILING", "RECONCILIATION_REQUIRED"].includes(intent.status)) {
          return true;
        }
        if (intent.status === "ORDER_CREATING" && intent.order_creation_lease_expires_at && intent.order_creation_lease_expires_at > now) {
          return true;
        }
        return false;
      });

      const activeCount = protectedIntents.length;

      if (params.op === "DELETE") {
        if (activeCount > 0) {
          return {
            allowed: false,
            error: `Milestone ${params.oldRecord.id} cannot be deleted while an active payment intent, reconciliation, or order-creation lease exists`,
          };
        }
        return { allowed: true };
      }

      if (params.op === "UPDATE" && params.newRecord) {
        const statusChanged = params.oldRecord.status !== params.newRecord.status;
        const amountChanged = params.oldRecord.amount_minor !== params.newRecord.amount_minor;
        const currencyChanged = params.oldRecord.currency !== params.newRecord.currency;

        if (statusChanged || amountChanged || currencyChanged) {
          if (activeCount > 0) {
            if (!["APPROVED", "IN_PROGRESS", "SUBMITTED"].includes(params.newRecord.status)) {
              return {
                allowed: false,
                error: `Milestone ${params.oldRecord.id} cannot be cancelled or moved to non-payable status ${params.newRecord.status} while an active payment operation, reconciliation, or lease is in progress`,
              };
            }

            if (amountChanged || currencyChanged) {
              return {
                allowed: false,
                error: `Milestone ${params.oldRecord.id} financial attributes (amount/currency) cannot be modified while an active payment operation, reconciliation, or lease is in progress`,
              };
            }
          }
        }
        return { allowed: true };
      }

      return { allowed: true };
    }

    const testMilestone: Milestone = {
      id: "m0000000-0000-4000-a000-000000000001",
      project_id: "p0000000-0000-4000-a000-000000000001",
      status: "APPROVED",
      amount_minor: 150000n,
      currency: "USD",
      title: "Initial Milestone",
      description: "Initial description",
    };

    it("rejects milestone deletion when an intent is in RECONCILIATION_REQUIRED", () => {
      const intents: PaymentIntent[] = [
        {
          id: "i0000000-0000-4000-a000-000000000001",
          milestone_id: testMilestone.id,
          status: "RECONCILIATION_REQUIRED",
          order_creation_lease_expires_at: null,
        },
      ];

      const res = simulateMilestoneTrigger({ op: "DELETE", oldRecord: testMilestone, intents });
      expect(res.allowed).toBe(false);
      expect(res.error).toContain("cannot be deleted");
    });

    it("rejects milestone cancellation (status -> CANCELLED) during RECONCILIATION_REQUIRED", () => {
      const intents: PaymentIntent[] = [
        {
          id: "i0000000-0000-4000-a000-000000000001",
          milestone_id: testMilestone.id,
          status: "RECONCILIATION_REQUIRED",
          order_creation_lease_expires_at: null,
        },
      ];

      const updated = { ...testMilestone, status: "CANCELLED" };
      const res = simulateMilestoneTrigger({ op: "UPDATE", oldRecord: testMilestone, newRecord: updated, intents });
      expect(res.allowed).toBe(false);
      expect(res.error).toContain("cannot be cancelled or moved to non-payable status CANCELLED");
    });

    it("rejects milestone financial modification during RECONCILIATION_REQUIRED", () => {
      const intents: PaymentIntent[] = [
        {
          id: "i0000000-0000-4000-a000-000000000001",
          milestone_id: testMilestone.id,
          status: "RECONCILIATION_REQUIRED",
          order_creation_lease_expires_at: null,
        },
      ];

      const updated = { ...testMilestone, amount_minor: 200000n };
      const res = simulateMilestoneTrigger({ op: "UPDATE", oldRecord: testMilestone, newRecord: updated, intents });
      expect(res.allowed).toBe(false);
      expect(res.error).toContain("financial attributes (amount/currency) cannot be modified");
    });

    it("permits non-status, non-financial updates (title, description) during RECONCILIATION_REQUIRED", () => {
      const intents: PaymentIntent[] = [
        {
          id: "i0000000-0000-4000-a000-000000000001",
          milestone_id: testMilestone.id,
          status: "RECONCILIATION_REQUIRED",
          order_creation_lease_expires_at: null,
        },
      ];

      const updated = {
        ...testMilestone,
        title: "Updated Title for Deliverable",
        description: "Updated deliverable description",
      };
      const res = simulateMilestoneTrigger({ op: "UPDATE", oldRecord: testMilestone, newRecord: updated, intents });
      expect(res.allowed).toBe(true);
    });

    it("permits legitimate payable transition (IN_PROGRESS -> SUBMITTED) during RECONCILIATION_REQUIRED", () => {
      const inProgressMilestone: Milestone = { ...testMilestone, status: "IN_PROGRESS" };
      const intents: PaymentIntent[] = [
        {
          id: "i0000000-0000-4000-a000-000000000001",
          milestone_id: inProgressMilestone.id,
          status: "RECONCILIATION_REQUIRED",
          order_creation_lease_expires_at: null,
        },
      ];

      const submitted = { ...inProgressMilestone, status: "SUBMITTED" };
      const res = simulateMilestoneTrigger({ op: "UPDATE", oldRecord: inProgressMilestone, newRecord: submitted, intents });
      expect(res.allowed).toBe(true);
    });

    it("permits milestone cancellation once payment intent has been resolved to FAILED or CANCELLED", () => {
      const intents: PaymentIntent[] = [
        {
          id: "i0000000-0000-4000-a000-000000000001",
          milestone_id: testMilestone.id,
          status: "FAILED", // Terminal state
          order_creation_lease_expires_at: null,
        },
      ];

      const cancelled = { ...testMilestone, status: "CANCELLED" };
      const res = simulateMilestoneTrigger({ op: "UPDATE", oldRecord: testMilestone, newRecord: cancelled, intents });
      expect(res.allowed).toBe(true);
    });
  });

  // ==========================================================================
  // SECTION 3: BEHAVIORAL VERIFICATION OF ADMINISTRATIVE RECOVERY RPC (F-02)
  // ==========================================================================
  describe("3. Behavioral Simulation: admin_resolve_reconciliation_without_payment", () => {
    interface PaymentIntentState {
      id: string;
      milestone_id: string;
      project_id: string;
      status: string;
      provider_order_id: string | null;
      reconciliation_reason: string | null;
      order_creation_lease_expires_at: Date | null;
      order_creation_lease_token: string | null;
    }

    interface ActivityEvent {
      project_id: string;
      actor_label: string;
      event_type: string;
      summary: string;
      metadata: Record<string, unknown>;
    }

    interface LedgerEntry {
      payment_intent_id: string;
      status: string;
      transaction_type: string;
    }

    function simulateAdminRecovery(params: {
      callerRole: "service_role" | "authenticated" | "anon";
      intent: PaymentIntentState;
      targetStatus: string;
      reasonCode: string;
      evidence: Record<string, unknown>;
      notes?: string;
      ledger?: LedgerEntry[];
      now?: Date;
    }): {
      success: boolean;
      error?: string;
      intent?: PaymentIntentState;
      event?: ActivityEvent;
    } {
      if (params.callerRole !== "service_role") {
        return { success: false, error: "PERMISSION_DENIED" };
      }

      const now = params.now || new Date();
      const cleanTargetStatus = params.targetStatus.trim().toUpperCase();

      if (!["FAILED", "CANCELLED"].includes(cleanTargetStatus)) {
        return { success: false, error: "INVALID_TARGET_STATUS" };
      }

      if (params.intent.status !== "RECONCILIATION_REQUIRED") {
        return { success: false, error: "INVALID_INITIAL_STATUS" };
      }

      // Check active worker lease
      if (params.intent.order_creation_lease_expires_at && params.intent.order_creation_lease_expires_at > now) {
        return { success: false, error: "LEASE_ACTIVE" };
      }

      // Check ledger for completed capture
      if (params.ledger && params.ledger.some((l) => l.payment_intent_id === params.intent.id && l.status === "COMPLETED")) {
        return { success: false, error: "COMPLETED_CAPTURE_EXISTS" };
      }

      // Reason sanitization
      const sanitizedReason = params.reasonCode.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
      if (sanitizedReason.length === 0) {
        return { success: false, error: "INVALID_REASON_CODE" };
      }

      // Provider evidence validation
      const evidenceType = typeof params.evidence.evidence_type === "string" ? params.evidence.evidence_type.trim().toUpperCase() : "";
      const confirmedBy = typeof params.evidence.confirmed_by === "string" ? params.evidence.confirmed_by.trim() : "";

      if (!evidenceType || !confirmedBy) {
        return { success: false, error: "INCOMPLETE_EVIDENCE_METADATA" };
      }

      if (evidenceType === "ORDER_NOT_CREATED") {
        if (params.intent.provider_order_id !== null) {
          return { success: false, error: "CONTRADICTORY_EVIDENCE_ORDER_EXISTS" };
        }
      } else if (evidenceType === "ORDER_VERIFIED_INACTIVE") {
        if (!params.intent.provider_order_id) {
          return { success: false, error: "ORDER_ID_MISSING_ON_INTENT" };
        }
        if (params.evidence.order_id !== params.intent.provider_order_id) {
          return { success: false, error: "ORDER_ID_MISMATCH" };
        }
        const paypalStatus = typeof params.evidence.paypal_order_status === "string" ? params.evidence.paypal_order_status.trim().toUpperCase() : "";
        if (!["VOIDED", "EXPIRED", "SAVED"].includes(paypalStatus)) {
          return { success: false, error: "INVALID_PROVIDER_ORDER_STATUS" };
        }
      } else {
        return { success: false, error: "UNSUPPORTED_EVIDENCE_TYPE" };
      }

      // Atomic transition
      const updatedIntent: PaymentIntentState = {
        ...params.intent,
        status: cleanTargetStatus,
        reconciliation_reason: sanitizedReason,
        order_creation_lease_expires_at: null,
        order_creation_lease_token: null,
      };

      const event: ActivityEvent = {
        project_id: params.intent.project_id,
        actor_label: "System Admin",
        event_type: cleanTargetStatus === "CANCELLED" ? "payment.reconciliation_cancelled" : "payment.reconciliation_failed",
        summary: `Payment intent ${params.intent.id} resolved to ${cleanTargetStatus} via administrative reconciliation (${sanitizedReason})`,
        metadata: {
          paymentIntentId: params.intent.id,
          milestoneId: params.intent.milestone_id,
          targetStatus: cleanTargetStatus,
          reasonCode: sanitizedReason,
          notes: params.notes,
          evidence: params.evidence,
        },
      };

      return { success: true, intent: updatedIntent, event };
    }

    const baseIntent: PaymentIntentState = {
      id: "i0000000-0000-4000-a000-000000000001",
      milestone_id: "m0000000-0000-4000-a000-000000000001",
      project_id: "p0000000-0000-4000-a000-000000000001",
      status: "RECONCILIATION_REQUIRED",
      provider_order_id: null,
      reconciliation_reason: "PAYPAL_RETENTION_WINDOW_EXPIRED",
      order_creation_lease_expires_at: null,
      order_creation_lease_token: null,
    };

    it("succeeds with ORDER_NOT_CREATED evidence for an intent with no provider_order_id", () => {
      const res = simulateAdminRecovery({
        callerRole: "service_role",
        intent: baseIntent,
        targetStatus: "FAILED",
        reasonCode: "PROVIDER_ORDER_NEVER_CREATED",
        evidence: {
          evidence_type: "ORDER_NOT_CREATED",
          confirmed_by: "support-agent-42",
          verification_reference: "PAYPAL-LOG-SEARCH-EMPTY",
        },
        notes: "Verified via PayPal REST API logs that request ID was not processed",
      });

      expect(res.success).toBe(true);
      expect(res.intent?.status).toBe("FAILED");
      expect(res.intent?.reconciliation_reason).toBe("PROVIDER_ORDER_NEVER_CREATED");
      expect(res.event?.event_type).toBe("payment.reconciliation_failed");
    });

    it("succeeds with ORDER_VERIFIED_INACTIVE evidence for an expired PayPal order", () => {
      const intentWithOrder: PaymentIntentState = {
        ...baseIntent,
        provider_order_id: "PAYPAL-EXPIRED-ORDER-999",
      };

      const res = simulateAdminRecovery({
        callerRole: "service_role",
        intent: intentWithOrder,
        targetStatus: "CANCELLED",
        reasonCode: "PAYPAL_ORDER_EXPIRED",
        evidence: {
          evidence_type: "ORDER_VERIFIED_INACTIVE",
          confirmed_by: "support-agent-42",
          order_id: "PAYPAL-EXPIRED-ORDER-999",
          paypal_order_status: "EXPIRED",
        },
      });

      expect(res.success).toBe(true);
      expect(res.intent?.status).toBe("CANCELLED");
      expect(res.event?.event_type).toBe("payment.reconciliation_cancelled");
    });

    it("rejects unauthorized execution by non-service_role", () => {
      const res = simulateAdminRecovery({
        callerRole: "authenticated",
        intent: baseIntent,
        targetStatus: "FAILED",
        reasonCode: "MANUAL",
        evidence: { evidence_type: "ORDER_NOT_CREATED", confirmed_by: "user" },
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("PERMISSION_DENIED");
    });

    it("rejects invalid target status (e.g. COMPLETED or ORDER_CREATING)", () => {
      const res = simulateAdminRecovery({
        callerRole: "service_role",
        intent: baseIntent,
        targetStatus: "COMPLETED",
        reasonCode: "UNAUTHORIZED_FASTPATH",
        evidence: { evidence_type: "ORDER_NOT_CREATED", confirmed_by: "admin" },
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("INVALID_TARGET_STATUS");
    });

    it("rejects resolution if an active worker lease is running", () => {
      const leasedIntent: PaymentIntentState = {
        ...baseIntent,
        order_creation_lease_expires_at: new Date(Date.now() + 60000), // Active lease for 60s
      };

      const res = simulateAdminRecovery({
        callerRole: "service_role",
        intent: leasedIntent,
        targetStatus: "FAILED",
        reasonCode: "STALE_ABORT",
        evidence: { evidence_type: "ORDER_NOT_CREATED", confirmed_by: "admin" },
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("LEASE_ACTIVE");
    });

    it("rejects ORDER_NOT_CREATED when intent already has a recorded provider_order_id (contradictory)", () => {
      const intentWithOrder: PaymentIntentState = {
        ...baseIntent,
        provider_order_id: "PAYPAL-ACTIVE-12345",
      };

      const res = simulateAdminRecovery({
        callerRole: "service_role",
        intent: intentWithOrder,
        targetStatus: "FAILED",
        reasonCode: "CONTRADICTORY",
        evidence: {
          evidence_type: "ORDER_NOT_CREATED",
          confirmed_by: "admin",
        },
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("CONTRADICTORY_EVIDENCE_ORDER_EXISTS");
    });

    it("rejects ORDER_VERIFIED_INACTIVE if PayPal order was actually COMPLETED", () => {
      const intentWithOrder: PaymentIntentState = {
        ...baseIntent,
        provider_order_id: "PAYPAL-COMPLETED-12345",
      };

      const res = simulateAdminRecovery({
        callerRole: "service_role",
        intent: intentWithOrder,
        targetStatus: "CANCELLED",
        reasonCode: "ILLEGAL_CANCEL",
        evidence: {
          evidence_type: "ORDER_VERIFIED_INACTIVE",
          order_id: "PAYPAL-COMPLETED-12345",
          paypal_order_status: "COMPLETED", // Completed orders must not be cancelled!
          confirmed_by: "admin",
        },
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("INVALID_PROVIDER_ORDER_STATUS");
    });

    it("rejects without-payment resolution if ledger contains a COMPLETED capture transaction", () => {
      const res = simulateAdminRecovery({
        callerRole: "service_role",
        intent: baseIntent,
        targetStatus: "FAILED",
        reasonCode: "DISREGARD_LEDGER",
        evidence: {
          evidence_type: "ORDER_NOT_CREATED",
          confirmed_by: "admin",
        },
        ledger: [
          {
            payment_intent_id: baseIntent.id,
            status: "COMPLETED",
            transaction_type: "CAPTURE",
          },
        ],
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe("COMPLETED_CAPTURE_EXISTS");
    });

    it("unblocks milestone index so that client can create a new payment intent after recovery", () => {
      // Step 1: Admin marks intent FAILED
      const res = simulateAdminRecovery({
        callerRole: "service_role",
        intent: baseIntent,
        targetStatus: "FAILED",
        reasonCode: "TIMEOUT_PURGED",
        evidence: { evidence_type: "ORDER_NOT_CREATED", confirmed_by: "admin" },
      });

      expect(res.success).toBe(true);
      const resolvedIntent = res.intent!;

      // Step 2: Verify payment_intents_one_active_per_milestone_idx eligibility
      // Index filter: status in ('ORDER_CREATING', 'ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED')
      const activeStatuses = [
        "ORDER_CREATING",
        "ORDER_CREATED",
        "BUYER_APPROVED",
        "CAPTURING",
        "RECONCILING",
        "RECONCILIATION_REQUIRED",
      ];
      const isIndexedAsActive = activeStatuses.includes(resolvedIntent.status);
      expect(isIndexedAsActive).toBe(false); // Resolved intent is NOT active -> unique index allows a new intent!
    });
  });
});
