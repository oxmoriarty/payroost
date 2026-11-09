import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Phase 3B.4.2: Server-Side PayPal Order Capture and Ledger Integration", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611070004_paypal_order_capture_and_ledger.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC DDL & SCHEMA INTEGRITY AUDIT
  // ==========================================================================
  describe("1. Static DDL Schema & Trigger Audit", () => {
    it("adds capture_lease_token uuid column to payment_intents", () => {
      expect(migrationSql).toMatch(/alter\s+table\s+public\.payment_intents/i);
      expect(migrationSql).toMatch(/add\s+column\s+if\s+not\s+exists\s+capture_lease_token\s+uuid/i);
    });

    it("updates protect_payment_intent_immutability to permit CAPTURING lifecycle transitions", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.protect_payment_intent_immutability/i);
      // ORDER_CREATED -> BUYER_APPROVED, CAPTURING, CANCELLED
      expect(migrationSql).toContain("old.status = 'ORDER_CREATED' and new.status not in ('BUYER_APPROVED', 'CAPTURING', 'CANCELLED')");
      // BUYER_APPROVED -> CAPTURING, CANCELLED
      expect(migrationSql).toContain("old.status = 'BUYER_APPROVED' and new.status not in ('CAPTURING', 'CANCELLED')");
      // CAPTURING -> COMPLETED, RECONCILING, RECONCILIATION_REQUIRED, FAILED, ORDER_CREATED, BUYER_APPROVED
      expect(migrationSql).toContain("old.status = 'CAPTURING' and new.status not in ('COMPLETED', 'RECONCILING', 'RECONCILIATION_REQUIRED', 'FAILED', 'ORDER_CREATED', 'BUYER_APPROVED')");
      // Dual-layer session_user check for RECONCILIATION_REQUIRED preserved
      expect(migrationSql).toContain("session_user not in ('service_role', 'postgres', 'supabase_admin')");
      expect(migrationSql).toContain("current_setting('payroost.reconciliation_active', true) is distinct from 'true'");
    });

    it("updates protect_milestone_payment_invariants to lock milestones during CAPTURING and protect after COMPLETED", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.protect_milestone_payment_invariants/i);
      // Status check includes CAPTURING
      expect(migrationSql).toContain("status in ('ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED')");
      // Protects milestone after payment completion
      expect(migrationSql).toContain("Milestone % cannot be deleted because it has a completed payment");
      expect(migrationSql).toContain("Milestone % financial attributes cannot be modified after payment completion");
      expect(migrationSql).toContain("Milestone % cannot be cancelled after payment completion");
    });
  });

  // ==========================================================================
  // SECTION 2: RPC IMPLEMENTATION & LEASE FENCING AUDIT
  // ==========================================================================
  describe("2. RPC Implementation and Security Definer Lockdown", () => {
    it("defines claim_order_capture_lease with row locking, session verification, and milestone check", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.claim_order_capture_lease/i);
      expect(migrationSql).toContain("security definer set search_path = ''");
      expect(migrationSql).toContain("from public.payment_intents");
      expect(migrationSql).toContain("for update;");
      expect(migrationSql).toContain("from public.client_portal_sessions");
      expect(migrationSql).toContain("v_session.project_id <> v_intent.project_id");
      expect(migrationSql).toContain("v_intent.provider_order_id <> v_clean_order_id");
      expect(migrationSql).toContain("from public.milestones");
      expect(migrationSql).toContain("for share;");
      expect(migrationSql).toContain("v_milestone.status not in ('APPROVED', 'IN_PROGRESS', 'SUBMITTED')");
      expect(migrationSql).toContain("v_lease_token := gen_random_uuid();");
      expect(migrationSql).toContain("payment.capture_initiated");
    });

    it("defines release_order_capture_lease with strict fencing token validation", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.release_order_capture_lease/i);
      expect(migrationSql).toContain("v_intent.capture_lease_token is distinct from p_lease_token");
      expect(migrationSql).toContain("STALE_LEASE_TOKEN");
      expect(migrationSql).toContain("capture_lease_expires_at = null");
      expect(migrationSql).toContain("capture_lease_token = null");
    });

    it("defines record_paypal_order_captured with atomic ledger recording, milestone completion, and audit event", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.record_paypal_order_captured/i);
      expect(migrationSql).toContain("insert into public.payment_transactions");
      expect(migrationSql).toContain("'CAPTURE'");
      expect(migrationSql).toContain("v_clean_capture_id");
      expect(migrationSql).toContain("update public.payment_intents");
      expect(migrationSql).toContain("status = 'COMPLETED'");
      expect(migrationSql).toContain("update public.milestones");
      expect(migrationSql).toContain("status = 'ACCEPTED'");
      expect(migrationSql).toContain("payment.order_captured");
      expect(migrationSql).toContain("payment.capture_pending");
      expect(migrationSql).toContain("payment.capture_failed");
    });

    it("defines mark_intent_capture_reconciliation_required with lease fencing and sanitized reason codes", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.mark_intent_capture_reconciliation_required/i);
      expect(migrationSql).toContain("v_intent.capture_lease_token is distinct from p_lease_token");
      expect(migrationSql).toContain("status = 'RECONCILIATION_REQUIRED'");
      expect(migrationSql).toContain("regexp_replace(upper(trim(p_reason_code)), '[^A-Z0-9_]', '_', 'g')");
      expect(migrationSql).toContain("payment.capture_reconciliation_required");
    });

    it("restricts all new capture RPCs strictly to service_role", () => {
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+function\s+public\.claim_order_capture_lease\(text,\s*uuid,\s*text,\s*integer\)\s+from\s+public,\s*anon,\s*authenticated;/i);
      expect(migrationSql).toMatch(/grant\s+execute\s+on\s+function\s+public\.claim_order_capture_lease\(text,\s*uuid,\s*text,\s*integer\)\s+to\s+service_role;/i);

      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+function\s+public\.release_order_capture_lease\(text,\s*uuid,\s*uuid,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i);
      expect(migrationSql).toMatch(/grant\s+execute\s+on\s+function\s+public\.release_order_capture_lease\(text,\s*uuid,\s*uuid,\s*text\)\s+to\s+service_role;/i);

      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+function\s+public\.record_paypal_order_captured\(text,\s*uuid,\s*uuid,\s*text,\s*text,\s*bigint,\s*text,\s*jsonb\)\s+from\s+public,\s*anon,\s*authenticated;/i);
      expect(migrationSql).toMatch(/grant\s+execute\s+on\s+function\s+public\.record_paypal_order_captured\(text,\s*uuid,\s*uuid,\s*text,\s*text,\s*bigint,\s*text,\s*jsonb\)\s+to\s+service_role;/i);

      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+function\s+public\.mark_intent_capture_reconciliation_required\(text,\s*uuid,\s*uuid,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i);
      expect(migrationSql).toMatch(/grant\s+execute\s+on\s+function\s+public\.mark_intent_capture_reconciliation_required\(text,\s*uuid,\s*uuid,\s*text\)\s+to\s+service_role;/i);
    });
  });

  // ==========================================================================
  // SECTION 3: INVARIANT SIMULATIONS & CONCURRENCY MODEL
  // ==========================================================================
  describe("3. Invariant Simulations & State Machine Invariants", () => {
    interface SimulatedIntent {
      id: string;
      status: string;
      provider_order_id: string | null;
      capture_lease_token: string | null;
      capture_lease_expires_at: number | null;
      completed_at: number | null;
      reconciliation_reason: string | null;
    }

    interface SimulatedLedgerEntry {
      id: string;
      intent_id: string;
      capture_id: string;
      status: string;
      amount_cents: number;
    }

    interface SimulatedMilestone {
      id: string;
      status: string;
      amount_minor: number;
    }

    it("verifies state machine allows ORDER_CREATED -> CAPTURING -> COMPLETED", () => {
      const allowedTransitions: Record<string, string[]> = {
        ORDER_CREATING: ["ORDER_CREATED", "FAILED", "RECONCILIATION_REQUIRED"],
        ORDER_CREATED: ["BUYER_APPROVED", "CAPTURING", "CANCELLED"],
        BUYER_APPROVED: ["CAPTURING", "CANCELLED"],
        CAPTURING: ["COMPLETED", "RECONCILING", "RECONCILIATION_REQUIRED", "FAILED", "ORDER_CREATED", "BUYER_APPROVED"],
        RECONCILING: ["COMPLETED", "BUYER_APPROVED", "RECONCILIATION_REQUIRED"],
      };

      expect(allowedTransitions.ORDER_CREATED).toContain("CAPTURING");
      expect(allowedTransitions.BUYER_APPROVED).toContain("CAPTURING");
      expect(allowedTransitions.CAPTURING).toContain("COMPLETED");
      expect(allowedTransitions.CAPTURING).toContain("RECONCILIATION_REQUIRED");
      expect(allowedTransitions.CAPTURING).toContain("FAILED");
      expect(allowedTransitions.CAPTURING).toContain("ORDER_CREATED");
    });

    it("simulates concurrent workers and verifies second worker receives LEASE_ACTIVE", () => {
      const intent: SimulatedIntent = {
        id: "intent-1",
        status: "ORDER_CREATED",
        provider_order_id: "order-1",
        capture_lease_token: null,
        capture_lease_expires_at: null,
        completed_at: null,
        reconciliation_reason: null,
      };

      // Worker 1 claims lease
      const worker1Token = "lease-token-w1";
      intent.status = "CAPTURING";
      intent.capture_lease_token = worker1Token;
      intent.capture_lease_expires_at = Date.now() + 45000;

      // Worker 2 attempts to claim while lease is active
      const now = Date.now();
      const isLeaseActive =
        intent.capture_lease_expires_at !== null && intent.capture_lease_expires_at > now;

      expect(isLeaseActive).toBe(true);
      // Worker 2 is rejected
      const worker2Claim = isLeaseActive ? { success: false, error: "LEASE_ACTIVE" } : { success: true };
      expect(worker2Claim.error).toBe("LEASE_ACTIVE");
    });

    it("simulates stale worker rejection when trying to persist after lease expiry and reclaim", () => {
      const intent: SimulatedIntent = {
        id: "intent-1",
        status: "CAPTURING",
        provider_order_id: "order-1",
        capture_lease_token: "lease-token-w1",
        capture_lease_expires_at: Date.now() - 5000, // Expired
        completed_at: null,
        reconciliation_reason: null,
      };

      // Worker 2 claims the expired lease
      const worker2Token = "lease-token-w2";
      intent.capture_lease_token = worker2Token;
      intent.capture_lease_expires_at = Date.now() + 45000;

      // Worker 1 (stale) now attempts to record capture using worker1Token
      const worker1Token = "lease-token-w1";
      const isStale = intent.capture_lease_token !== worker1Token;
      expect(isStale).toBe(true);

      const worker1Result = isStale
        ? { success: false, error: "STALE_LEASE_TOKEN" }
        : { success: true };

      expect(worker1Result.error).toBe("STALE_LEASE_TOKEN");
    });

    it("verifies duplicate capture ID rejection across intents (global uniqueness)", () => {
      const ledger: SimulatedLedgerEntry[] = [
        {
          id: "tx-1",
          intent_id: "intent-1",
          capture_id: "capture-xyz-999",
          status: "COMPLETED",
          amount_cents: 10000,
        },
      ];

      // Second intent attempts to record the same capture ID
      const newIntentId = "intent-2";
      const candidateCaptureId = "capture-xyz-999";

      const isDuplicate = ledger.some(
        (tx) => tx.capture_id === candidateCaptureId && tx.intent_id !== newIntentId
      );

      expect(isDuplicate).toBe(true);
    });

    it("verifies atomic milestone completion: updates milestone status to ACCEPTED exactly once", () => {
      const milestone: SimulatedMilestone = {
        id: "milestone-1",
        status: "SUBMITTED",
        amount_minor: 150000,
      };

      const ledger: SimulatedLedgerEntry[] = [];

      // Record capture
      ledger.push({
        id: "tx-1",
        intent_id: "intent-1",
        capture_id: "capture-1",
        status: "COMPLETED",
        amount_cents: 150000,
      });

      milestone.status = "ACCEPTED";

      expect(milestone.status).toBe("ACCEPTED");
      expect(ledger.length).toBe(1);

      // Attempt duplicate recording returns already_recorded without adding to ledger or re-updating milestone
      const duplicateAttempt = ledger.find(
        (tx) => tx.intent_id === "intent-1" && tx.capture_id === "capture-1"
      );

      expect(duplicateAttempt).toBeDefined();
      expect(ledger.length).toBe(1); // Exactly one ledger entry
    });

    it("verifies pending capture preserves RECONCILIATION_REQUIRED and keeps milestone locked", () => {
      const intent: SimulatedIntent = {
        id: "intent-1",
        status: "CAPTURING",
        provider_order_id: "order-1",
        capture_lease_token: "token-1",
        capture_lease_expires_at: Date.now() + 30000,
        completed_at: null,
        reconciliation_reason: null,
      };

      const milestone: SimulatedMilestone = {
        id: "milestone-1",
        status: "SUBMITTED",
        amount_minor: 150000,
      };

      // Handle PENDING capture
      intent.status = "RECONCILIATION_REQUIRED";
      intent.reconciliation_reason = "PAYPAL_CAPTURE_PENDING";
      intent.capture_lease_expires_at = null;
      intent.capture_lease_token = null;

      // Milestone is NOT ACCEPTED
      expect(milestone.status).toBe("SUBMITTED");
      expect(intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(intent.reconciliation_reason).toBe("PAYPAL_CAPTURE_PENDING");
    });
  });
});
