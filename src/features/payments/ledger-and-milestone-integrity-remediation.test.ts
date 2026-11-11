import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  reconcilePaymentIntentServerSide,
} from "@/lib/paypal/reconciliation-service";
import { PayPalClient } from "@/lib/paypal/client";
import { createServiceClient } from "@/lib/supabase/service";
import type { PayPalConfig } from "@/lib/paypal/types";

describe("PayRoost Phase 3B.4.2.2: Critical Ledger and Milestone Integrity Remediation", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611090001_ledger_and_milestone_integrity_remediation.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC DDL AUDIT & TRIGGER CONSTRAINTS
  // ==========================================================================
  describe("1. Static SQL Audit: Ledger Mutation Trigger (F-01)", () => {
    it("disallows DELETE on payment_transactions unconditionally", () => {
      expect(migrationSql).toMatch(/if\s+tg_op\s*=\s*'DELETE'\s+then/i);
      expect(migrationSql).toMatch(/Financial transaction ledger is strictly append-only and records cannot be deleted/i);
    });

    it("enforces dual-layer session_user authorization for UPDATE", () => {
      expect(migrationSql).toMatch(/session_user\s+not\s+in\s+\('service_role',\s*'postgres',\s*'supabase_admin'\)/i);
      expect(migrationSql).toMatch(/Unauthorized:\s*Only service_role can update payment transactions/i);
    });

    it("enforces transaction-local authorization flag payroost.ledger_mutation_authorized", () => {
      expect(migrationSql).toMatch(/current_setting\('payroost\.ledger_mutation_authorized',\s*true\)\s+is\s+distinct\s+from\s+'true'/i);
      expect(migrationSql).toMatch(/Financial transaction ledger is strictly append-only;\s*update not authorized/i);
    });

    it("restricts updates strictly to CAPTURE transactions", () => {
      expect(migrationSql).toMatch(/old\.transaction_type\s*<>\s*'CAPTURE'/i);
      expect(migrationSql).toMatch(/Only CAPTURE transactions can be updated from PENDING to COMPLETED/i);
    });

    it("restricts updates strictly from PENDING to COMPLETED status", () => {
      expect(migrationSql).toMatch(/old\.status\s*<>\s*'PENDING'\s+or\s+new\.status\s*<>\s*'COMPLETED'/i);
      expect(migrationSql).toMatch(/Invalid status transition on payment transaction:.*only PENDING to COMPLETED is permitted/i);
    });

    it("protects immutable financial, relational, and identity attributes during UPDATE", () => {
      expect(migrationSql).toContain("old.id <> new.id");
      expect(migrationSql).toContain("old.payment_intent_id <> new.payment_intent_id");
      expect(migrationSql).toContain("old.parent_transaction_id is distinct from new.parent_transaction_id");
      expect(migrationSql).toContain("old.transaction_type <> new.transaction_type");
      expect(migrationSql).toContain("old.provider <> new.provider");
      expect(migrationSql).toContain("old.provider_reference_id <> new.provider_reference_id");
      expect(migrationSql).toContain("old.amount_cents <> new.amount_cents");
      expect(migrationSql).toContain("old.currency <> new.currency");
      expect(migrationSql).toContain("old.payee_merchant_id <> new.payee_merchant_id");
      expect(migrationSql).toContain("old.created_at <> new.created_at");
      expect(migrationSql).toMatch(/Payment transaction immutable financial, relational, and identity attributes cannot be modified/i);
    });
  });

  describe("2. Static SQL Audit: Milestone Precondition & Invariant Enforcement (F-02)", () => {
    it("strictly requires a verified COMPLETED payment intent before allowing ACCEPTED status", () => {
      expect(migrationSql).toMatch(/new\.status\s*=\s*'ACCEPTED'\s+and\s+old\.status\s+is\s+distinct\s+from\s+'ACCEPTED'/i);
      expect(migrationSql).toMatch(/not\s+exists\s*\(\s*select\s+1\s+from\s+public\.payment_intents\s+where\s+milestone_id\s*=\s*new\.id\s+and\s+status\s*=\s*'COMPLETED'\s*\)/i);
      expect(migrationSql).toMatch(/Milestone % cannot be marked ACCEPTED without a verified COMPLETED payment intent/i);
    });

    it("prohibits deleting milestones with active intents, leases, or completed payments", () => {
      expect(migrationSql).toMatch(/Milestone % cannot be deleted while an active payment intent, reconciliation, or lease exists/i);
      expect(migrationSql).toMatch(/Milestone % cannot be deleted because it has a completed payment/i);
    });

    it("prohibits modifying financial attributes or cancelling after payment completion", () => {
      expect(migrationSql).toMatch(/Milestone % financial attributes cannot be modified after payment completion/i);
      expect(migrationSql).toMatch(/Milestone % cannot be cancelled after payment completion/i);
      expect(migrationSql).toMatch(/Milestone % cannot transition away from ACCEPTED after payment completion/i);
    });

    it("in record_paypal_order_captured, updates payment_intents to COMPLETED before milestones to ACCEPTED", () => {
      const intentUpdateIdx = migrationSql.indexOf("update public.payment_intents\n    set status = 'COMPLETED'");
      const milestoneUpdateIdx = migrationSql.indexOf("update public.milestones\n    set status = 'ACCEPTED'");
      expect(intentUpdateIdx).toBeGreaterThan(0);
      expect(milestoneUpdateIdx).toBeGreaterThan(intentUpdateIdx);
    });

    it("in reconcile_and_complete_payment_intent, updates payment_intents to COMPLETED before milestones to ACCEPTED", () => {
      const lastIntentIdx = migrationSql.lastIndexOf("update public.payment_intents\n  set status = 'COMPLETED'");
      const lastMilestoneIdx = migrationSql.lastIndexOf("update public.milestones\n  set status = 'ACCEPTED'");
      expect(lastIntentIdx).toBeGreaterThan(0);
      expect(lastMilestoneIdx).toBeGreaterThan(lastIntentIdx);
    });
  });

  describe("3. Static SQL Audit: Safe In-Place Capture Updates (F-01)", () => {
    it("record_paypal_order_captured sets payroost.ledger_mutation_authorized when updating PENDING capture", () => {
      expect(migrationSql).toMatch(/perform\s+set_config\('payroost\.ledger_mutation_authorized',\s*'true',\s*true\);/i);
      expect(migrationSql).toMatch(/update\s+public\.payment_transactions\s+set\s+status\s*=\s*'COMPLETED'/i);
    });

    it("record_paypal_order_captured handles PENDING idempotency without duplicate insert", () => {
      expect(migrationSql).toContain("already_recorded");
      expect(migrationSql).toContain("Capture already completed; do not regress to PENDING");
    });

    it("reconcile_and_complete_payment_intent performs authorized in-place update on existing PENDING capture", () => {
      expect(migrationSql).toContain("p_intent_id");
      expect(migrationSql).toContain("v_clean_capture_id");
      expect(migrationSql).toContain("v_existing_capture.status = 'PENDING'");
    });
  });

  describe("4. Static SQL Audit: Dual Lease Checks and CAPTURING Reconciliation (F-04)", () => {
    it("admin_mark_intent_reconciliation_required verifies both order creation and capture leases", () => {
      expect(migrationSql).toContain("v_intent.order_creation_lease_expires_at > clock_timestamp()");
      expect(migrationSql).toContain("v_intent.capture_lease_expires_at > clock_timestamp()");
      expect(migrationSql).toContain("lease_type', 'CAPTURE");
    });

    it("admin_recover_and_bind_paypal_order permits CAPTURING status and verifies capture lease", () => {
      expect(migrationSql).toContain("('RECONCILIATION_REQUIRED', 'ORDER_CREATING', 'CAPTURING')");
      expect(migrationSql).toContain("v_intent.capture_lease_expires_at > clock_timestamp()");
    });

    it("admin_resolve_reconciliation_without_payment permits CAPTURING status and verifies capture lease", () => {
      expect(migrationSql).toContain("('RECONCILIATION_REQUIRED', 'CAPTURING')");
      expect(migrationSql).toContain("v_intent.capture_lease_expires_at > clock_timestamp()");
    });
  });

  // ==========================================================================
  // SECTION 2: SERVER-SIDE RECONCILIATION SERVICE BEHAVIORAL VERIFICATION (F-04)
  // ==========================================================================
  describe("5. Behavioral Verification: Expired CAPTURING Reconciliation (F-04)", () => {
    const validIntentId = "d0000000-0000-4000-a000-000000000001";
    const validOrderId = "5O190127TN364715T";
    const validCaptureId = "7XX1234567890123A";
    const validMerchantId = "MERCHANT_ACME_12345";
    const validMilestoneId = "b0000000-0000-4000-a000-000000000001";

    const mockEnv: PayPalConfig = {
      environment: "sandbox",
      baseUrl: "https://api-m.sandbox.paypal.com",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      expectedMerchantId: validMerchantId,
      paymentMode: "MERCHANT",
    };

    let mockRpc: ReturnType<typeof vi.fn>;
    let mockSelect: ReturnType<typeof vi.fn>;
    let mockFrom: ReturnType<typeof vi.fn>;
    let mockServiceClient: ReturnType<typeof createServiceClient>;
    let mockPayPalGet: ReturnType<typeof vi.fn>;
    let mockPayPalPost: ReturnType<typeof vi.fn>;
    let mockPayPalClient: PayPalClient;

    beforeEach(() => {
      vi.clearAllMocks();

      mockRpc = vi.fn();
      mockSelect = vi.fn();
      mockFrom = vi.fn().mockReturnValue({
        select: mockSelect,
      });

      mockServiceClient = {
        rpc: mockRpc,
        from: mockFrom,
      } as unknown as ReturnType<typeof createServiceClient>;

      mockPayPalGet = vi.fn();
      mockPayPalPost = vi.fn();
      mockPayPalClient = {
        get: mockPayPalGet,
        post: mockPayPalPost,
      } as unknown as PayPalClient;
    });

    it("rejects an active (unexpired) CAPTURING intent with INELIGIBLE_PAYMENT_INTENT_STATUS", async () => {
      const activeLeaseExpiry = new Date(Date.now() + 30000).toISOString(); // 30s in future

      mockSelect.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: validIntentId,
              project_id: "c0000000-0000-4000-a000-000000000001",
              milestone_id: validMilestoneId,
              status: "CAPTURING",
              expected_merchant_id: validMerchantId,
              expected_currency: "USD",
              expected_amount_canonical: "1500.00",
              provider_order_id: validOrderId,
              capture_lease_expires_at: activeLeaseExpiry,
              created_at: new Date(Date.now() - 5000).toISOString(),
            },
            error: null,
          }),
        }),
      });

      const result = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPalClient,
        injectedPayPalEnv: mockEnv,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("INELIGIBLE_PAYMENT_INTENT_STATUS");
      expect(result.previousStatus).toBe("CAPTURING");
      expect(result.resultingStatus).toBe("CAPTURING");
      expect(result.milestoneBlocked).toBe(true);
      expect(mockPayPalGet).not.toHaveBeenCalled();
    });

    it("reconciles expired CAPTURING intent when PayPal order is COMPLETED with capture", async () => {
      const expiredLease = new Date(Date.now() - 10000).toISOString(); // 10s in past

      mockSelect.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: validIntentId,
              project_id: "c0000000-0000-4000-a000-000000000001",
              milestone_id: validMilestoneId,
              status: "CAPTURING",
              expected_merchant_id: validMerchantId,
              expected_currency: "USD",
              expected_amount_canonical: "1500.00",
              provider_order_id: validOrderId,
              capture_lease_expires_at: expiredLease,
              created_at: new Date(Date.now() - 60000).toISOString(),
            },
            error: null,
          }),
        }),
      });

      mockPayPalGet.mockResolvedValueOnce({
        status: 200,
        data: {
          id: validOrderId,
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: validMilestoneId,
              custom_id: validIntentId,
              payee: { merchant_id: validMerchantId },
              payments: {
                captures: [
                  {
                    id: validCaptureId,
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "1500.00" },
                    payee: { merchant_id: validMerchantId },
                  },
                ],
              },
            },
          ],
        },
      });

      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "reconcile_and_complete_payment_intent") {
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const result = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPalClient,
        injectedPayPalEnv: mockEnv,
      });

      expect(result.success).toBe(true);
      expect(result.previousStatus).toBe("CAPTURING");
      expect(result.resultingStatus).toBe("COMPLETED");
      expect(result.recovered).toBe(true);
      expect(result.milestoneBlocked).toBe(false);

      expect(mockRpc).toHaveBeenCalledWith(
        "reconcile_and_complete_payment_intent",
        expect.objectContaining({
          p_intent_id: validIntentId,
          p_provider_capture_id: validCaptureId,
        })
      );
    });

    it("resets expired CAPTURING intent to ORDER_CREATED when PayPal order was never captured (CREATED/APPROVED)", async () => {
      const expiredLease = new Date(Date.now() - 10000).toISOString();

      mockSelect.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: validIntentId,
              project_id: "c0000000-0000-4000-a000-000000000001",
              milestone_id: validMilestoneId,
              status: "CAPTURING",
              expected_merchant_id: validMerchantId,
              expected_currency: "USD",
              expected_amount_canonical: "1500.00",
              provider_order_id: validOrderId,
              capture_lease_expires_at: expiredLease,
              created_at: new Date(Date.now() - 60000).toISOString(),
            },
            error: null,
          }),
        }),
      });

      mockPayPalGet.mockResolvedValueOnce({
        status: 200,
        data: {
          id: validOrderId,
          status: "APPROVED",
          purchase_units: [
            {
              reference_id: validMilestoneId,
              custom_id: validIntentId,
              payee: { merchant_id: validMerchantId },
            },
          ],
        },
      });

      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "admin_recover_and_bind_paypal_order") {
          return Promise.resolve({ data: { success: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const result = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPalClient,
        injectedPayPalEnv: mockEnv,
      });

      expect(result.success).toBe(true);
      expect(result.previousStatus).toBe("CAPTURING");
      expect(result.resultingStatus).toBe("ORDER_CREATED");
      expect(result.recovered).toBe(true);
      expect(result.milestoneBlocked).toBe(true);

      expect(mockRpc).toHaveBeenCalledWith(
        "admin_recover_and_bind_paypal_order",
        expect.objectContaining({
          p_intent_id: validIntentId,
          p_recovered_order_id: validOrderId,
        })
      );
    });

    it("cancels expired CAPTURING intent when PayPal order is VOIDED or EXPIRED", async () => {
      const expiredLease = new Date(Date.now() - 10000).toISOString();

      mockSelect.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: validIntentId,
              project_id: "c0000000-0000-4000-a000-000000000001",
              milestone_id: validMilestoneId,
              status: "CAPTURING",
              expected_merchant_id: validMerchantId,
              expected_currency: "USD",
              expected_amount_canonical: "1500.00",
              provider_order_id: validOrderId,
              capture_lease_expires_at: expiredLease,
              created_at: new Date(Date.now() - 60000).toISOString(),
            },
            error: null,
          }),
        }),
      });

      mockPayPalGet.mockResolvedValueOnce({
        status: 200,
        data: {
          id: validOrderId,
          status: "VOIDED",
        },
      });

      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "admin_resolve_reconciliation_without_payment") {
          return Promise.resolve({ data: { success: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const result = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPalClient,
        injectedPayPalEnv: mockEnv,
      });

      expect(result.success).toBe(true);
      expect(result.previousStatus).toBe("CAPTURING");
      expect(result.resultingStatus).toBe("CANCELLED");
      expect(result.milestoneBlocked).toBe(false);

      expect(mockRpc).toHaveBeenCalledWith(
        "admin_resolve_reconciliation_without_payment",
        expect.objectContaining({
          p_intent_id: validIntentId,
          p_target_status: "CANCELLED",
        })
      );
    });

    it("marks RECONCILIATION_REQUIRED when PayPal GET fails during expired CAPTURING reconciliation", async () => {
      const expiredLease = new Date(Date.now() - 10000).toISOString();

      mockSelect.mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: validIntentId,
              project_id: "c0000000-0000-4000-a000-000000000001",
              milestone_id: validMilestoneId,
              status: "CAPTURING",
              expected_merchant_id: validMerchantId,
              expected_currency: "USD",
              expected_amount_canonical: "1500.00",
              provider_order_id: validOrderId,
              capture_lease_expires_at: expiredLease,
              created_at: new Date(Date.now() - 60000).toISOString(),
            },
            error: null,
          }),
        }),
      });

      mockPayPalGet.mockRejectedValueOnce(new Error("Network connection reset"));

      mockRpc.mockImplementation((rpcName: string) => {
        if (rpcName === "admin_mark_intent_reconciliation_required") {
          return Promise.resolve({ data: { success: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const result = await reconcilePaymentIntentServerSide({
        intentId: validIntentId,
        injectedServiceClient: mockServiceClient,
        injectedPayPalClient: mockPayPalClient,
        injectedPayPalEnv: mockEnv,
      });

      expect(result.success).toBe(false);
      expect(result.previousStatus).toBe("CAPTURING");
      expect(result.resultingStatus).toBe("RECONCILIATION_REQUIRED");
      expect(result.reason).toBe("PROVIDER_INQUIRY_INCONCLUSIVE");
      expect(result.milestoneBlocked).toBe(true);

      expect(mockRpc).toHaveBeenCalledWith(
        "admin_mark_intent_reconciliation_required",
        expect.objectContaining({
          p_payment_intent_id: validIntentId,
          p_reason_code: "PROVIDER_INQUIRY_INCONCLUSIVE",
        })
      );
    });
  });
});
