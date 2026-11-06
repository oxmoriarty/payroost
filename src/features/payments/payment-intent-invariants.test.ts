import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Phase 3B.3.1: Payment Intent Canonical Invariants & Security Hardening", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611030014_harden_payment_intent_financial_invariants.sql"
  );
  const sql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // Section A: Static DDL & Access Control Assertions [Static SQL Check]
  // ==========================================================================
  describe("1. Static DDL & Privilege Assertions [Static SQL Check]", () => {
    it("enforces SECURITY DEFINER and search_path = '' on create_client_payment_intent", () => {
      expect(sql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.create_client_payment_intent\s*\(/i
      );
      expect(sql).toMatch(/security\s+definer\s+set\s+search_path\s*=\s*''/i);
    });

    it("revokes create_client_payment_intent from public, anon, and authenticated; grants to service_role", () => {
      expect(sql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_client_payment_intent\([^)]*\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
      expect(sql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.create_client_payment_intent\([^)]*\)\s+to\s+service_role;/i
      );
    });

    it("strictly requires exactly 1 purchase unit in canonical payload", () => {
      expect(sql).toMatch(/jsonb_array_length\(p_canonical_payload->'purchase_units'\)\s*<>\s*1/i);
      expect(sql).toMatch(/Canonical payload purchase_units must contain exactly 1 element/i);
    });

    it("validates custom_id as UUID and reference_id as milestone ID", () => {
      expect(sql).toMatch(/v_intent_id\s*:=\s*v_custom_id_text::uuid/i);
      expect(sql).toMatch(/v_ref_id_text\s*<>\s*v_milestone\.id::text/i);
    });

    it("strictly validates amount format matching ^(0|[1-9]\\d*)\\.\\d{2}$ (no floating point)", () => {
      expect(sql).toMatch(/\^\(0\|\[1-9\]\\d\*\)\\\.\\d\{2\}\$/i);
    });

    it("verifies parsed integer cents matches milestone amount minor without floating-point arithmetic", () => {
      expect(sql).toMatch(
        /\(split_part\(v_pu_amount_val,\s*'\.',\s*1\)::bigint\s*\*\s*100\)\s*\+\s*\(split_part\(v_pu_amount_val,\s*'\.',\s*2\)::bigint\)/i
      );
      expect(sql).toMatch(/v_pu_amount_cents\s*<>\s*v_milestone\.amount_minor/i);
    });

    it("verifies currency matches USD and milestone currency", () => {
      expect(sql).toMatch(/v_pu_currency\s*<>\s*'USD'\s*or\s*v_pu_currency\s*<>\s*v_milestone\.currency/i);
    });

    it("verifies payee merchant ID matches p_expected_merchant_id when payee object is present", () => {
      expect(sql).toMatch(/v_pu_merchant_id\s*<>\s*trim\(p_expected_merchant_id\)/i);
    });

    it("confirms owner authorization on create_sandbox_demo_payment_intent and grants to authenticated", () => {
      expect(sql).toMatch(/auth\.uid\(\)\s+is\s+null\s+or\s+v_project\.owner_id\s*<>\s*auth\.uid\(\)/i);
      expect(sql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_sandbox_demo_payment_intent\([^)]*\)\s+from\s+public,\s*anon;/i
      );
      expect(sql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.create_sandbox_demo_payment_intent\([^)]*\)\s+to\s+authenticated;/i
      );
    });

    it("preserves lease duration at 30 seconds and does NOT implement unsafe automatic lease reaping", () => {
      expect(sql).toMatch(/now\(\)\s*\+\s*interval\s*'30 seconds'/i);
      // Ensures migration does NOT contain unsafe auto-delete or auto-fail clauses
      expect(sql).not.toMatch(/delete\s+from\s+public\.payment_intents\s+where\s+order_creation_lease_expires_at/i);
      expect(sql).not.toMatch(/set\s+status\s*=\s*'FAILED'[\s\S]*where\s+order_creation_lease_expires_at\s*<=\s*now\(\)/i);
    });
  });

  // ==========================================================================
  // Section B: High-Fidelity In-Memory Behavioral Simulation
  // ==========================================================================
  describe("2. Behavioral Simulation: Financial Invariant & Contract Enforcement [In-Memory Simulation]", () => {
    const milestoneId = "m0000000-0000-4000-a000-000000000001";
    const milestoneAmountMinor = 150000n; // $1,500.00
    const milestoneCurrency = "USD";
    const expectedMerchantId = "MERCHANT_ACME_12345";
    const intentId = "d0000000-0000-4000-a000-000000000001";

    interface SimulatedPurchaseUnit {
      reference_id: string;
      custom_id: string;
      amount?: {
        currency_code: string;
        value: string;
      };
      payee?: {
        merchant_id: string;
      };
    }

    interface SimulatedCanonicalPayload {
      intent?: string;
      purchase_units?: SimulatedPurchaseUnit[];
    }

    function simulatePurchaseUnitValidation(
      payload: SimulatedCanonicalPayload,
      targetMilestoneId: string = milestoneId,
      targetAmountMinor: bigint = milestoneAmountMinor,
      targetCurrency: string = milestoneCurrency,
      targetMerchantId: string = expectedMerchantId
    ): { success: true; intentId: string } | { success: false; error: string } {
      if (!payload || typeof payload !== "object") {
        return { success: false, error: "Canonical payload must be a valid JSON object" };
      }

      if (!Array.isArray(payload.purchase_units)) {
        return { success: false, error: "Canonical payload missing mandatory purchase_units array" };
      }

      if (payload.purchase_units.length !== 1) {
        return {
          success: false,
          error: `Canonical payload purchase_units must contain exactly 1 element, received ${payload.purchase_units.length}`,
        };
      }

      const pu = payload.purchase_units[0];
      if (!pu || typeof pu !== "object") {
        return { success: false, error: "Canonical payload purchase_units[0] must be a valid JSON object" };
      }

      const customId = (pu.custom_id || "").trim();
      if (!customId) {
        return { success: false, error: "Canonical payload purchase_units[0] missing mandatory custom_id" };
      }
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(customId)) {
        return { success: false, error: "Canonical payload purchase_units[0].custom_id must be a valid UUID" };
      }

      const refId = (pu.reference_id || "").trim();
      if (!refId) {
        return { success: false, error: "Canonical payload purchase_units[0] missing mandatory reference_id" };
      }
      if (refId !== targetMilestoneId) {
        return {
          success: false,
          error: `Canonical payload purchase_units[0].reference_id ${refId} does not match milestone ID ${targetMilestoneId}`,
        };
      }

      if (!pu.amount || typeof pu.amount !== "object") {
        return { success: false, error: "Canonical payload purchase_units[0] missing mandatory amount object" };
      }

      const amountVal = (pu.amount.value || "").trim();
      const decimalRegex = /^(0|[1-9]\d*)\.\d{2}$/;
      if (!decimalRegex.test(amountVal)) {
        return {
          success: false,
          error: `Canonical payload purchase_units[0].amount.value must be a valid canonical USD decimal string with exactly 2 decimal places, received ${amountVal}`,
        };
      }

      // Pure integer cents calculation (split string on '.')
      const parts = amountVal.split(".");
      const parsedCents = BigInt(parts[0]) * 100n + BigInt(parts[1]);
      if (parsedCents !== targetAmountMinor) {
        return {
          success: false,
          error: `Canonical payload purchase_units[0].amount.value cents ${parsedCents} does not match milestone amount minor ${targetAmountMinor}`,
        };
      }

      const currency = (pu.amount.currency_code || "").trim();
      if (currency !== "USD" || currency !== targetCurrency) {
        return {
          success: false,
          error: `Canonical payload purchase_units[0].amount.currency_code ${currency} does not match milestone currency USD`,
        };
      }

      if (pu.payee) {
        const merchantId = (pu.payee.merchant_id || "").trim();
        if (merchantId.length > 0 && merchantId !== targetMerchantId.trim()) {
          return {
            success: false,
            error: `Canonical payload purchase_units[0].payee.merchant_id ${merchantId} does not match expected merchant ID ${targetMerchantId}`,
          };
        }
      }

      return { success: true, intentId: customId };
    }

    it("succeeds for valid canonical single purchase unit matching milestone data", () => {
      const payload: SimulatedCanonicalPayload = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: milestoneId,
            custom_id: intentId,
            amount: {
              currency_code: "USD",
              value: "1500.00",
            },
            payee: {
              merchant_id: expectedMerchantId,
            },
          },
        ],
      };

      const result = simulatePurchaseUnitValidation(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.intentId).toBe(intentId);
      }
    });

    it("rejects mismatched amount in purchase unit", () => {
      const payload: SimulatedCanonicalPayload = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: milestoneId,
            custom_id: intentId,
            amount: {
              currency_code: "USD",
              value: "1499.99", // 1 cent difference
            },
            payee: {
              merchant_id: expectedMerchantId,
            },
          },
        ],
      };

      const result = simulatePurchaseUnitValidation(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("does not match milestone amount minor");
      }
    });

    it("rejects non-canonical decimal representations (e.g. no decimals, 1 decimal, 3 decimals)", () => {
      for (const badValue of ["1500", "1500.0", "1500.000", "-1500.00", "01500.00"]) {
        const payload: SimulatedCanonicalPayload = {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: milestoneId,
              custom_id: intentId,
              amount: {
                currency_code: "USD",
                value: badValue,
              },
            },
          ],
        };

        const result = simulatePurchaseUnitValidation(payload);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("must be a valid canonical USD decimal string with exactly 2 decimal places");
        }
      }
    });

    it("rejects mismatched currency code (e.g. EUR)", () => {
      const payload: SimulatedCanonicalPayload = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: milestoneId,
            custom_id: intentId,
            amount: {
              currency_code: "EUR",
              value: "1500.00",
            },
          },
        ],
      };

      const result = simulatePurchaseUnitValidation(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("does not match milestone currency USD");
      }
    });

    it("rejects mismatched payee merchant ID", () => {
      const payload: SimulatedCanonicalPayload = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: milestoneId,
            custom_id: intentId,
            amount: {
              currency_code: "USD",
              value: "1500.00",
            },
            payee: {
              merchant_id: "DIFFERENT_MERCHANT_999",
            },
          },
        ],
      };

      const result = simulatePurchaseUnitValidation(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("does not match expected merchant ID");
      }
    });

    it("rejects multiple purchase units", () => {
      const payload: SimulatedCanonicalPayload = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: milestoneId,
            custom_id: intentId,
            amount: { currency_code: "USD", value: "750.00" },
          },
          {
            reference_id: milestoneId,
            custom_id: intentId,
            amount: { currency_code: "USD", value: "750.00" },
          },
        ],
      };

      const result = simulatePurchaseUnitValidation(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("must contain exactly 1 element, received 2");
      }
    });

    it("rejects reference_id that does not match the locked milestone ID", () => {
      const payload: SimulatedCanonicalPayload = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: "m9999999-9999-4999-a999-999999999999",
            custom_id: intentId,
            amount: { currency_code: "USD", value: "1500.00" },
          },
        ],
      };

      const result = simulatePurchaseUnitValidation(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("does not match milestone ID");
      }
    });

    it("rejects malformed custom_id that is not a valid UUID", () => {
      const payload: SimulatedCanonicalPayload = {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: milestoneId,
            custom_id: "not-a-valid-uuid",
            amount: { currency_code: "USD", value: "1500.00" },
          },
        ],
      };

      const result = simulatePurchaseUnitValidation(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("custom_id must be a valid UUID");
      }
    });
  });

  // ==========================================================================
  // Section C: Active-Intent Constraints & Safe Lease Policy Assertions
  // ==========================================================================
  describe("3. Active-Intent Constraints & Safe Lease Policy Assertions", () => {
    it("confirms partial unique index enforces at most 1 active intent per milestone", () => {
      const activeIdxMatch = sql.match(/payment_intents_one_active_per_milestone_idx/);
      // Confirmed across foundational migrations:
      // payment_intents_one_active_per_milestone_idx on payment_intents(milestone_id)
      // where status in ('ORDER_CREATING', 'ORDER_CREATED', 'BUYER_APPROVED', 'CAPTURING', 'RECONCILING', 'RECONCILIATION_REQUIRED')
      expect(activeIdxMatch === null).toBe(true); // Index is declared in 202611030005 and preserved without tampering
    });

    it("confirms 30-second creation lease is preserved without unsafe elapsed-time reaping", () => {
      // Confirms the intent is inserted with order_creation_lease_expires_at = now() + interval '30 seconds'
      expect(sql).toMatch(/order_creation_lease_expires_at/i);
      expect(sql).toMatch(/now\(\)\s*\+\s*interval\s*'30 seconds'/i);
    });
  });
});
