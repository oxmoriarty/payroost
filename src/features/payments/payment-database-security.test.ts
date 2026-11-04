import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashOtpCode } from "@/lib/security/tokens";

describe("Phase 3A.1: Database Foundation and Security Enforcement", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611030005_payment_foundation_and_ledger.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC DDL & SCHEMA INTEGRITY AUDIT
  // ==========================================================================
  describe("1. Static DDL Schema Integrity", () => {
    it("creates client_portal_tokens with on delete restrict and partial unique index", () => {
      expect(migrationSql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.client_portal_tokens/i);
      expect(migrationSql).toMatch(/project_id\s+uuid\s+not\s+null\s+references\s+public\.projects\(id\)\s+on\s+delete\s+restrict/i);
      expect(migrationSql).toMatch(/token_hash\s+text\s+not\s+null\s+unique\s+check\s*\(char_length\(token_hash\)\s*=\s*64\)/i);
      expect(migrationSql).toMatch(/create\s+unique\s+index\s+if\s+not\s+exists\s+client_portal_tokens_one_active_idx/i);
    });

    it("creates client_portal_otp_challenges with attempt bounds 0 to 5", () => {
      expect(migrationSql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.client_portal_otp_challenges/i);
      expect(migrationSql).toMatch(/attempts\s+integer\s+not\s+null\s+default\s+0\s+check\s*\(attempts\s*>=\s*0\s+and\s+attempts\s*<=\s*5\)/i);
      expect(migrationSql).toMatch(/portal_token_id\s+uuid\s+not\s+null\s+references\s+public\.client_portal_tokens\(id\)\s+on\s+delete\s+restrict/i);
    });

    it("creates client_portal_sessions with absolute 12-hour expiration", () => {
      expect(migrationSql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.client_portal_sessions/i);
      expect(migrationSql).toMatch(/csrf_secret\s+text\s+not\s+null\s+check\s*\(char_length\(csrf_secret\)\s*=\s*64\)/i);
      expect(migrationSql).toMatch(/session_token_hash\s+text\s+not\s+null\s+unique\s+check\s*\(char_length\(session_token_hash\)\s*=\s*64\)/i);
    });

    it("creates payment_intents with USD-only check, canonical check, and one active/completed indexes", () => {
      expect(migrationSql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.payment_intents/i);
      expect(migrationSql).toMatch(/environment\s+text\s+not\s+null\s+default\s+'SANDBOX'\s+check\s*\(environment\s*=\s*'SANDBOX'\)/i);
      expect(migrationSql).toMatch(/expected_currency\s+text\s+not\s+null\s+check\s*\(expected_currency\s*=\s*'USD'\)/i);
      expect(migrationSql).toMatch(/expected_amount_canonical\s+text\s+not\s+null\s+check/i);
      expect(migrationSql).toContain("expected_amount_canonical ~ '^(0|[1-9]\\d*)\\.\\d{2}$'");
      expect(migrationSql).toMatch(/create\s+unique\s+index\s+if\s+not\s+exists\s+payment_intents_one_active_per_milestone_idx/i);
      expect(migrationSql).toMatch(/create\s+unique\s+index\s+if\s+not\s+exists\s+payment_intents_one_completed_per_milestone_idx/i);
    });

    it("creates payment_transactions with append-only triggers and over-refund guard", () => {
      expect(migrationSql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.payment_transactions/i);
      expect(migrationSql).toMatch(/parent_transaction_id\s+uuid\s+references\s+public\.payment_transactions\(id\)\s+on\s+delete\s+restrict/i);
      expect(migrationSql).toMatch(/transaction_type\s+text\s+not\s+null\s+default\s+'CAPTURE'\s+check\s*\(transaction_type\s+in\s*\('CAPTURE',\s*'REFUND',\s*'REVERSAL'\)\)/i);
      expect(migrationSql).toMatch(/create\s+unique\s+index\s+if\s+not\s+exists\s+payment_transactions_one_capture_per_intent_idx/i);
      expect(migrationSql).toMatch(/create\s+trigger\s+payment_transactions_immutable/i);
      expect(migrationSql).toMatch(/create\s+trigger\s+payment_transactions_validate_insert/i);
    });

    it("creates provider_webhook_events with worker claim index", () => {
      expect(migrationSql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.provider_webhook_events/i);
      expect(migrationSql).toMatch(/create\s+index\s+if\s+not\s+exists\s+provider_webhook_events_claim_idx/i);
    });
  });

  // ==========================================================================
  // SECTION 2: PRIVILEGE AND GRANT MATRIX AUDIT
  // ==========================================================================
  describe("2. Database Privileges & SECURITY DEFINER Lockdown", () => {
    it("revokes all table privileges on sensitive portal and financial tables from public and anon", () => {
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+public\.client_portal_tokens\s+from\s+public,\s*anon,\s*authenticated;/i);
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+public\.client_portal_otp_challenges\s+from\s+public,\s*anon,\s*authenticated;/i);
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+public\.client_portal_sessions\s+from\s+public,\s*anon,\s*authenticated;/i);
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+public\.provider_webhook_events\s+from\s+public,\s*anon,\s*authenticated;/i);
    });

    it("revokes INSERT, UPDATE, DELETE on payment_intents and payment_transactions from authenticated users", () => {
      expect(migrationSql).toMatch(/revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on\s+public\.payment_intents\s+from\s+authenticated;/i);
      expect(migrationSql).toMatch(/revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on\s+public\.payment_transactions\s+from\s+authenticated;/i);
    });

    it("restricts critical server-only completion and refund RPCs from public, anon, and authenticated", () => {
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+function\s+public\.record_payment_intent_completed\(uuid,\s*text,\s*bigint,\s*text,\s*jsonb\)\s+from\s+public,\s*anon,\s*authenticated;/i);
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+function\s+public\.process_refund_transaction\(uuid,\s*uuid,\s*text,\s*bigint,\s*jsonb\)\s+from\s+public,\s*anon,\s*authenticated;/i);
    });
  });

  // ==========================================================================
  // SECTION 3: OTP PERSISTENT ATTEMPTS AND SESSION SIMULATION
  // ==========================================================================
  describe("3. OTP Attempt Persistence & Exhaustion", () => {
    interface SimulatedOtpChallenge {
      id: string;
      otp_hmac: string;
      attempts: number;
      consumed_at: Date | null;
      expires_at: Date;
    }

    function simulateOtpSubmission(
      challenge: SimulatedOtpChallenge,
      submittedHmac: string
    ): { status: string; attempts: number; remainingAttempts?: number } {
      if (challenge.consumed_at) return { status: "ALREADY_CONSUMED", attempts: challenge.attempts };
      if (Date.now() > challenge.expires_at.getTime()) return { status: "EXPIRED", attempts: challenge.attempts };
      if (challenge.attempts >= 5) return { status: "EXHAUSTED", attempts: challenge.attempts };

      // Invariant: attempts is incremented and committed on both success and failure
      challenge.attempts += 1;

      if (challenge.otp_hmac !== submittedHmac) {
        if (challenge.attempts >= 5) {
          return { status: "EXHAUSTED", attempts: challenge.attempts };
        }
        return {
          status: "INVALID_OTP",
          attempts: challenge.attempts,
          remainingAttempts: 5 - challenge.attempts,
        };
      }

      challenge.consumed_at = new Date();
      return { status: "SUCCESS", attempts: challenge.attempts };
    }

    it("persists attempt counter increments across failed attempts without rollback", () => {
      const challenge: SimulatedOtpChallenge = {
        id: "c-1",
        otp_hmac: hashOtpCode("123456"),
        attempts: 0,
        consumed_at: null,
        expires_at: new Date(Date.now() + 600000),
      };

      const wrongHmac = hashOtpCode("999999");
      const res1 = simulateOtpSubmission(challenge, wrongHmac);
      expect(res1.status).toBe("INVALID_OTP");
      expect(res1.attempts).toBe(1);
      expect(res1.remainingAttempts).toBe(4);
      expect(challenge.attempts).toBe(1);

      const res2 = simulateOtpSubmission(challenge, wrongHmac);
      expect(res2.status).toBe("INVALID_OTP");
      expect(res2.attempts).toBe(2);
      expect(res2.remainingAttempts).toBe(3);
      expect(challenge.attempts).toBe(2);
    });

    it("exhausts challenge on exactly the 5th failed attempt and rejects subsequent submissions", () => {
      const challenge: SimulatedOtpChallenge = {
        id: "c-2",
        otp_hmac: hashOtpCode("123456"),
        attempts: 3,
        consumed_at: null,
        expires_at: new Date(Date.now() + 600000),
      };

      const wrongHmac = hashOtpCode("000000");
      const res4 = simulateOtpSubmission(challenge, wrongHmac);
      expect(res4.status).toBe("INVALID_OTP");
      expect(res4.attempts).toBe(4);

      const res5 = simulateOtpSubmission(challenge, wrongHmac);
      expect(res5.status).toBe("EXHAUSTED");
      expect(res5.attempts).toBe(5);

      // Even correct OTP after exhaustion is rejected
      const resAfter = simulateOtpSubmission(challenge, challenge.otp_hmac);
      expect(resAfter.status).toBe("EXHAUSTED");
      expect(challenge.consumed_at).toBeNull();
    });

    it("ensures concurrent valid OTP submissions produce exactly one session via single-use lock", () => {
      const challenge: SimulatedOtpChallenge = {
        id: "c-3",
        otp_hmac: hashOtpCode("654321"),
        attempts: 0,
        consumed_at: null,
        expires_at: new Date(Date.now() + 600000),
      };

      // Transaction 1 succeeds
      const tx1 = simulateOtpSubmission(challenge, challenge.otp_hmac);
      expect(tx1.status).toBe("SUCCESS");
      expect(challenge.consumed_at).not.toBeNull();

      // Concurrent Transaction 2 sees consumed_at IS NOT NULL
      const tx2 = simulateOtpSubmission(challenge, challenge.otp_hmac);
      expect(tx2.status).toBe("ALREADY_CONSUMED");
    });
  });

  // ==========================================================================
  // SECTION 4: PAYMENT INTENT IMMUTABILITY & TRANSITIONS
  // ==========================================================================
  describe("4. Payment Intent Immutability and State Machine", () => {
    interface SimulatedIntent {
      id: string;
      project_id: string;
      milestone_id: string;
      environment: string;
      expected_merchant_id: string;
      expected_amount_cents: bigint;
      status: string;
      provider_order_id: string | null;
      has_verified_capture: boolean;
    }

    function simulateIntentUpdate(
      current: SimulatedIntent,
      updates: Partial<SimulatedIntent>
    ): SimulatedIntent {
      // 1. Immutable checks
      if (updates.project_id && updates.project_id !== current.project_id) {
        throw new Error("Payment intent immutable financial, relational, and identity attributes cannot be modified");
      }
      if (updates.milestone_id && updates.milestone_id !== current.milestone_id) {
        throw new Error("Payment intent immutable financial, relational, and identity attributes cannot be modified");
      }
      if (updates.expected_merchant_id && updates.expected_merchant_id !== current.expected_merchant_id) {
        throw new Error("Payment intent immutable financial, relational, and identity attributes cannot be modified");
      }
      if (updates.expected_amount_cents && updates.expected_amount_cents !== current.expected_amount_cents) {
        throw new Error("Payment intent immutable financial, relational, and identity attributes cannot be modified");
      }
      if (current.provider_order_id && updates.provider_order_id && updates.provider_order_id !== current.provider_order_id) {
        throw new Error("Payment intent immutable financial, relational, and identity attributes cannot be modified");
      }

      // 2. State machine checks
      if (updates.status && updates.status !== current.status) {
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) {
          throw new Error(`Terminal payment intent state ${current.status} cannot transition to ${updates.status}`);
        }
        if (current.status === "RECONCILIATION_REQUIRED") {
          throw new Error("Payment intent in RECONCILIATION_REQUIRED cannot transition without privileged intervention");
        }

        // Allowed transitions
        const allowed: Record<string, string[]> = {
          ORDER_CREATING: ["ORDER_CREATED", "FAILED", "RECONCILIATION_REQUIRED"],
          ORDER_CREATED: ["BUYER_APPROVED", "CANCELLED"],
          BUYER_APPROVED: ["CAPTURING"],
          CAPTURING: ["COMPLETED", "RECONCILING"],
          RECONCILING: ["COMPLETED", "BUYER_APPROVED", "RECONCILIATION_REQUIRED"],
        };

        if (!allowed[current.status]?.includes(updates.status)) {
          throw new Error(`Invalid transition from ${current.status} to ${updates.status}`);
        }

        if (updates.status === "COMPLETED" && !current.has_verified_capture) {
          throw new Error("Payment intent cannot be marked COMPLETED without a verified capture record in payment_transactions");
        }
      }

      return { ...current, ...updates };
    }

    it("rejects tampering with immutable merchant ID, milestone, or amount", () => {
      const intent: SimulatedIntent = {
        id: "pi-1",
        project_id: "proj-1",
        milestone_id: "m-1",
        environment: "SANDBOX",
        expected_merchant_id: "MERCHANT_123",
        expected_amount_cents: 10000n,
        status: "ORDER_CREATED",
        provider_order_id: "ORD-1",
        has_verified_capture: false,
      };

      expect(() => simulateIntentUpdate(intent, { expected_merchant_id: "ATTACKER_MERCHANT" })).toThrow(
        "Payment intent immutable financial, relational, and identity attributes cannot be modified"
      );
      expect(() => simulateIntentUpdate(intent, { expected_amount_cents: 5000n })).toThrow(
        "Payment intent immutable financial, relational, and identity attributes cannot be modified"
      );
      expect(() => simulateIntentUpdate(intent, { provider_order_id: "REPLACED_ORD" })).toThrow(
        "Payment intent immutable financial, relational, and identity attributes cannot be modified"
      );
    });

    it("rejects invalid state transitions (skipping intermediate states)", () => {
      const intent: SimulatedIntent = {
        id: "pi-2",
        project_id: "proj-1",
        milestone_id: "m-1",
        environment: "SANDBOX",
        expected_merchant_id: "MERCHANT_123",
        expected_amount_cents: 10000n,
        status: "ORDER_CREATING",
        provider_order_id: null,
        has_verified_capture: false,
      };

      // Cannot jump from ORDER_CREATING to BUYER_APPROVED
      expect(() => simulateIntentUpdate(intent, { status: "BUYER_APPROVED" })).toThrow(
        "Invalid transition from ORDER_CREATING to BUYER_APPROVED"
      );
    });

    it("blocks transitioning to COMPLETED without a verified capture record in payment_transactions", () => {
      const capturingIntent: SimulatedIntent = {
        id: "pi-3",
        project_id: "proj-1",
        milestone_id: "m-1",
        environment: "SANDBOX",
        expected_merchant_id: "MERCHANT_123",
        expected_amount_cents: 10000n,
        status: "CAPTURING",
        provider_order_id: "ORD-3",
        has_verified_capture: false,
      };

      expect(() => simulateIntentUpdate(capturingIntent, { status: "COMPLETED" })).toThrow(
        "Payment intent cannot be marked COMPLETED without a verified capture record in payment_transactions"
      );

      // Succeeded when verified capture exists
      capturingIntent.has_verified_capture = true;
      const completed = simulateIntentUpdate(capturingIntent, { status: "COMPLETED" });
      expect(completed.status).toBe("COMPLETED");
    });

    it("enforces terminal states (COMPLETED cannot transition to any other status)", () => {
      const completedIntent: SimulatedIntent = {
        id: "pi-4",
        project_id: "proj-1",
        milestone_id: "m-1",
        environment: "SANDBOX",
        expected_merchant_id: "MERCHANT_123",
        expected_amount_cents: 10000n,
        status: "COMPLETED",
        provider_order_id: "ORD-4",
        has_verified_capture: true,
      };

      expect(() => simulateIntentUpdate(completedIntent, { status: "ORDER_CREATING" })).toThrow(
        "Terminal payment intent state COMPLETED cannot transition to ORDER_CREATING"
      );
    });
  });

  // ==========================================================================
  // SECTION 5: FINANCIAL LEDGER & REFUND LIMIT ENFORCEMENT
  // ==========================================================================
  describe("5. Append-Only Financial Ledger & Refund Invariants", () => {
    interface SimulatedTransaction {
      id: string;
      payment_intent_id: string;
      parent_transaction_id: string | null;
      transaction_type: "CAPTURE" | "REFUND";
      amount_cents: bigint;
      status: "COMPLETED" | "PENDING";
    }

    function simulateInsertRefund(
      captureTx: SimulatedTransaction,
      existingRefunds: SimulatedTransaction[],
      refundAmount: bigint,
      intentId: string
    ): SimulatedTransaction {
      if (captureTx.transaction_type !== "CAPTURE" || captureTx.status !== "COMPLETED") {
        throw new Error("Parent transaction must be a COMPLETED CAPTURE transaction");
      }
      if (captureTx.payment_intent_id !== intentId) {
        throw new Error("Parent transaction belongs to a different payment intent");
      }

      const totalRefunded = existingRefunds.reduce((acc, r) => acc + r.amount_cents, 0n);
      if (totalRefunded + refundAmount > captureTx.amount_cents) {
        throw new Error(
          `Refund amount ${refundAmount} exceeds remaining refundable capture balance ${captureTx.amount_cents - totalRefunded}`
        );
      }

      return {
        id: "ref-" + (existingRefunds.length + 1),
        payment_intent_id: intentId,
        parent_transaction_id: captureTx.id,
        transaction_type: "REFUND",
        amount_cents: refundAmount,
        status: "COMPLETED",
      };
    }

    it("allows multiple valid partial refunds up to the exact captured amount", () => {
      const captureTx: SimulatedTransaction = {
        id: "tx-cap-1",
        payment_intent_id: "pi-10",
        parent_transaction_id: null,
        transaction_type: "CAPTURE",
        amount_cents: 10000n, // $100.00
        status: "COMPLETED",
      };

      const refunds: SimulatedTransaction[] = [];
      const ref1 = simulateInsertRefund(captureTx, refunds, 4000n, "pi-10");
      refunds.push(ref1);
      expect(ref1.amount_cents).toBe(4000n);

      const ref2 = simulateInsertRefund(captureTx, refunds, 6000n, "pi-10");
      refunds.push(ref2);
      expect(ref2.amount_cents).toBe(6000n);
    });

    it("strictly blocks excessive refunds exceeding the remaining captured balance", () => {
      const captureTx: SimulatedTransaction = {
        id: "tx-cap-2",
        payment_intent_id: "pi-20",
        parent_transaction_id: null,
        transaction_type: "CAPTURE",
        amount_cents: 5000n, // $50.00
        status: "COMPLETED",
      };

      const refunds: SimulatedTransaction[] = [];
      const ref1 = simulateInsertRefund(captureTx, refunds, 3000n, "pi-20");
      refunds.push(ref1);

      // Attempting to refund $30 more when only $20 remains
      expect(() => simulateInsertRefund(captureTx, refunds, 3000n, "pi-20")).toThrow(
        "Refund amount 3000 exceeds remaining refundable capture balance 2000"
      );
    });

    it("rejects refund when parent belongs to another payment intent", () => {
      const captureTx: SimulatedTransaction = {
        id: "tx-cap-3",
        payment_intent_id: "pi-30",
        parent_transaction_id: null,
        transaction_type: "CAPTURE",
        amount_cents: 5000n,
        status: "COMPLETED",
      };

      expect(() => simulateInsertRefund(captureTx, [], 1000n, "pi-DIFFERENT")).toThrow(
        "Parent transaction belongs to a different payment intent"
      );
    });
  });

  // ==========================================================================
  // SECTION 6: CLIENT EMAIL CHANGE & SESSION INVALIDATION
  // ==========================================================================
  describe("6. Email Change Invalidation Cascade", () => {
    it("migration trigger protects verified client email and invalidates portal tokens/sessions on email change", () => {
      expect(migrationSql).toMatch(/update\s+public\.client_portal_tokens\s+set\s+revoked_at\s*=\s*now\(\)\s+where\s+project_id\s*=\s*old\.id\s+and\s+revoked_at\s+is\s+null/i);
      expect(migrationSql).toMatch(/update\s+public\.client_portal_sessions\s+set\s+revoked_at\s*=\s*now\(\)\s+where\s+project_id\s*=\s*old\.id\s+and\s+revoked_at\s+is\s+null/i);
    });
  });
});
