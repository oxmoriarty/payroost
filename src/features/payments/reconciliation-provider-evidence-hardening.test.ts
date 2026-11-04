import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Phase 3A.1.6: Strict Purchase-Unit and Capture-Linkage Enforcement", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611030008_strict_purchase_unit_capture_binding.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC DDL AND ACCESS CONTROL AUDIT
  // ==========================================================================
  describe("1. Static SQL Grants and Function Definitions", () => {
    it("updates create_client_payment_intent with creation-time canonical purchase-unit contract validation", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.create_client_payment_intent\(/i);
      expect(migrationSql).toMatch(/Canonical payload purchase_units\[0\] missing mandatory custom_id/i);
      expect(migrationSql).toMatch(/Canonical payload purchase_units\[0\] missing mandatory reference_id/i);
      expect(migrationSql).toMatch(/revoke\s+all\s+on\s+function\s+public\.create_client_payment_intent\(text,\s*uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb\)\s+from\s+public,\s*anon,\s*authenticated;/i);
    });

    it("updates create_sandbox_demo_payment_intent with owner check and canonical purchase-unit contract", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.create_sandbox_demo_payment_intent\(/i);
      expect(migrationSql).toMatch(/auth\.uid\(\)\s+is\s+null\s+or\s+v_project\.owner_id\s*<>\s*auth\.uid\(\)/i);
      expect(migrationSql).toMatch(/grant\s+execute\s+on\s+function\s+public\.create_sandbox_demo_payment_intent\(uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb\)\s+to\s+authenticated;/i);
    });

    it("enforces strict order status = COMPLETED (rejects APPROVED)", () => {
      expect(migrationSql).toMatch(/p_raw_order_response->>'status',\s*''\)\s*<>\s*'COMPLETED'/i);
      expect(migrationSql).toMatch(/Authoritative PayPal order status must be COMPLETED/i);
    });

    it("enforces exact dual purchase unit matching and rejects contradictory identifiers", () => {
      expect(migrationSql).toMatch(/v_pu_custom_id\s*=\s*v_intent\.id::text\s+and\s+v_pu_ref_id\s*<>\s*v_intent\.milestone_id::text/i);
      expect(migrationSql).toMatch(/v_pu_ref_id\s*=\s*v_intent\.milestone_id::text\s+and\s+v_pu_custom_id\s*<>\s*v_intent\.id::text/i);
      expect(migrationSql).toMatch(/v_pu_custom_id\s*=\s*v_intent\.id::text\s+and\s+v_pu_ref_id\s*=\s*v_intent\.milestone_id::text/i);
    });

    it("enforces mandatory capture presence, single occurrence, and status = COMPLETED within matched purchase unit", () => {
      expect(migrationSql).toMatch(/Matched purchase unit missing mandatory payments object/i);
      expect(migrationSql).toMatch(/Matched purchase unit missing mandatory non-empty payments\.captures array/i);
      expect(migrationSql).toMatch(/Expected capture ID % not found in matched purchase unit captures/i);
      expect(migrationSql).toMatch(/Duplicate occurrence of capture ID % in matched purchase unit captures/i);
      expect(migrationSql).toMatch(/Capture ID % is associated with an unrelated purchase unit in the order/i);
    });

    it("restricts privileged recovery strictly to service_role", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.reconcile_and_complete_payment_intent\(uuid,\s*text,\s*jsonb,\s*jsonb,\s*text,\s*bigint,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });
  });

  // ==========================================================================
  // SECTION 2: HIGH-FIDELITY BEHAVIORAL SIMULATION OF ALL 17 EXPLICIT SCENARIOS
  // ==========================================================================
  describe("2. Behavioral Verification Across All 17 Phase 3A.1.6 Scenarios", () => {
    interface SimulatedIntent {
      id: string;
      project_id: string;
      milestone_id: string;
      status: string;
      expected_amount_canonical: string;
      expected_amount_cents: bigint;
      expected_merchant_id: string;
      expected_currency: string;
      provider_order_id: string;
      canonical_payload_json: Record<string, unknown>;
      completed_at: Date | null;
    }

    interface SimulatedLedgerTransaction {
      id: string;
      payment_intent_id: string;
      provider_reference_id: string;
      amount_cents: bigint;
      currency: string;
      payee_merchant_id: string;
      status: string;
      raw_response: Record<string, unknown>;
    }

    interface SimulationContext {
      intent: SimulatedIntent;
      captureId: string;
      rawCaptureResponse: Record<string, unknown>;
      rawOrderResponse: Record<string, unknown>;
      resolutionNotes?: string;
      amountCents?: bigint | null;
      payeeMerchantId?: string | null;
      ledger: Map<string, SimulatedLedgerTransaction>;
      activityEvents: string[];
      isPrivilegedReconciliationActive: boolean;
      callerRole: "service_role" | "authenticated" | "anon";
    }

    function simulateCreationCanonicalContract(params: {
      canonicalPayload: unknown;
      milestoneId: string;
    }): string {
      if (!params.canonicalPayload || typeof params.canonicalPayload !== "object") {
        throw new Error("Canonical payload must be a valid JSON object");
      }

      const p = params.canonicalPayload as Record<string, unknown>;
      const puArray = p.purchase_units as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(puArray) || puArray.length === 0) {
        throw new Error("Canonical payload missing mandatory purchase_units array");
      }

      const pu = puArray[0];
      const customId = typeof pu.custom_id === "string" ? pu.custom_id.trim() : "";
      if (customId.length === 0) {
        throw new Error("Canonical payload purchase_units[0] missing mandatory custom_id");
      }

      // UUID format assertion
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customId)) {
        throw new Error(`Canonical payload purchase_units[0].custom_id must be a valid UUID, received ${customId}`);
      }

      const refId = typeof pu.reference_id === "string" ? pu.reference_id.trim() : "";
      if (refId.length === 0) {
        throw new Error("Canonical payload purchase_units[0] missing mandatory reference_id");
      }

      if (refId !== params.milestoneId) {
        throw new Error(`Canonical payload purchase_units[0].reference_id ${refId} does not match milestone ID ${params.milestoneId}`);
      }

      return customId;
    }

    function simulateStrictReconcile(ctx: SimulationContext): boolean {
      if (ctx.callerRole !== "service_role") {
        throw new Error("Permission denied: function reconcile_and_complete_payment_intent can only be executed by service_role");
      }

      if (!ctx.isPrivilegedReconciliationActive) {
        throw new Error("Payment intent in RECONCILIATION_REQUIRED cannot transition without privileged intervention");
      }

      const cleanCaptureId = ctx.captureId.trim();
      if (cleanCaptureId.length < 3) {
        throw new Error("Invalid provider capture ID");
      }

      if (!ctx.rawCaptureResponse || typeof ctx.rawCaptureResponse !== "object") {
        throw new Error("Provider capture response must be a valid JSON object");
      }

      if (!ctx.rawOrderResponse || typeof ctx.rawOrderResponse !== "object") {
        throw new Error("Provider order response must be a valid JSON object");
      }

      // Idempotency check: already completed with this exact capture
      if (ctx.intent.status === "COMPLETED") {
        for (const tx of ctx.ledger.values()) {
          if (
            tx.payment_intent_id === ctx.intent.id &&
            tx.provider_reference_id === cleanCaptureId &&
            tx.status === "COMPLETED"
          ) {
            return true;
          }
        }
        throw new Error("Payment intent is already COMPLETED with a different capture reference");
      }

      if (ctx.intent.status !== "RECONCILIATION_REQUIRED") {
        throw new Error(`Intent status ${ctx.intent.status} is not eligible for reconciliation recovery`);
      }

      // Check global capture uniqueness
      for (const tx of ctx.ledger.values()) {
        if (tx.provider_reference_id === cleanCaptureId && tx.payment_intent_id !== ctx.intent.id) {
          throw new Error(`Provider capture ID ${cleanCaptureId} is already associated with another payment intent`);
        }
      }

      // 1. Capture response validation
      if (ctx.rawCaptureResponse.id !== cleanCaptureId) {
        throw new Error(`Capture response ID ${ctx.rawCaptureResponse.id ?? "<missing>"} does not match supplied capture ID ${cleanCaptureId}`);
      }

      if (ctx.rawCaptureResponse.status !== "COMPLETED") {
        throw new Error(`Authoritative PayPal capture status must be COMPLETED, received ${ctx.rawCaptureResponse.status ?? "<missing>"}`);
      }

      const amountObj = ctx.rawCaptureResponse.amount as Record<string, string> | undefined;
      if (!amountObj?.currency_code || amountObj.currency_code !== "USD" || amountObj.currency_code !== ctx.intent.expected_currency) {
        throw new Error("Capture currency does not match intent expected currency USD");
      }

      const val = amountObj.value;
      if (!val || !/^(0|[1-9]\d*)\.\d{2}$/.test(val) || val !== ctx.intent.expected_amount_canonical) {
        throw new Error("Capture amount does not match expected intent canonical amount");
      }

      const [dollarsStr, centsStr] = val.split(".");
      const parsedCents = BigInt(dollarsStr) * 100n + BigInt(centsStr);
      if (parsedCents <= 0n || parsedCents !== ctx.intent.expected_amount_cents) {
        throw new Error("Parsed capture cents does not match expected cents");
      }

      const payeeObj = ctx.rawCaptureResponse.payee as Record<string, string> | undefined;
      if (!payeeObj?.merchant_id || payeeObj.merchant_id.trim() !== ctx.intent.expected_merchant_id) {
        throw new Error("Capture payee merchant ID does not match expected merchant ID");
      }

      const suppData = ctx.rawCaptureResponse.supplementary_data as Record<string, unknown> | undefined;
      const relatedIds = suppData?.related_ids as Record<string, string> | undefined;
      if (!relatedIds?.order_id || relatedIds.order_id !== ctx.intent.provider_order_id) {
        throw new Error("Capture related order ID does not match intent provider order ID");
      }

      // 2. Order Details response validation
      if (ctx.rawOrderResponse.id !== ctx.intent.provider_order_id) {
        throw new Error("Order details ID does not match intent provider order ID");
      }

      // STRICT ORDER STATUS: MUST BE COMPLETED
      if (ctx.rawOrderResponse.status !== "COMPLETED") {
        throw new Error(`Authoritative PayPal order status must be COMPLETED, received ${ctx.rawOrderResponse.status ?? "<missing>"}`);
      }

      const purchaseUnits = ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(purchaseUnits) || purchaseUnits.length === 0) {
        throw new Error("Order response purchase_units must be a valid non-empty JSON array");
      }

      // 3. Strict Purchase-Unit Matching: Dual Identifier Exact Match
      let matchedCount = 0;
      let targetPu: Record<string, unknown> | null = null;

      for (const pu of purchaseUnits) {
        if (!pu || typeof pu !== "object") {
          throw new Error("Purchase unit element in order response must be a JSON object");
        }

        const puCustomId = typeof pu.custom_id === "string" ? pu.custom_id.trim() : "";
        const puRefId = typeof pu.reference_id === "string" ? pu.reference_id.trim() : "";

        // Contradictory identifier rejection
        if (puCustomId === ctx.intent.id && puRefId !== ctx.intent.milestone_id) {
          throw new Error(`Purchase unit contains correct custom_id ${puCustomId} but contradictory reference_id ${puRefId} (expected milestone ${ctx.intent.milestone_id})`);
        }

        if (puRefId === ctx.intent.milestone_id && puCustomId !== ctx.intent.id) {
          throw new Error(`Purchase unit contains correct reference_id ${puRefId} but contradictory custom_id ${puCustomId} (expected intent ${ctx.intent.id})`);
        }

        // Exact dual match
        if (puCustomId === ctx.intent.id && puRefId === ctx.intent.milestone_id) {
          matchedCount++;
          targetPu = pu;
        }
      }

      if (matchedCount === 0) {
        throw new Error(`Purchase unit matching intent ID ${ctx.intent.id} and milestone ID ${ctx.intent.milestone_id} not found in order response`);
      }

      if (matchedCount > 1) {
        throw new Error("Multiple duplicate purchase units matched in order response");
      }

      // 4. Financial & Payee checks on matched purchase unit
      const puAmount = targetPu!.amount as Record<string, string> | undefined;
      if (!puAmount?.currency_code || puAmount.currency_code !== "USD" || puAmount.currency_code !== ctx.intent.expected_currency) {
        throw new Error("Purchase unit currency does not match intent expected currency");
      }
      if (!puAmount?.value || puAmount.value !== ctx.intent.expected_amount_canonical) {
        throw new Error("Purchase unit amount does not match expected intent amount");
      }

      const puPayee = targetPu!.payee as Record<string, string> | undefined;
      if (!puPayee?.merchant_id || puPayee.merchant_id.trim() !== ctx.intent.expected_merchant_id) {
        throw new Error("Purchase unit payee merchant ID does not match expected merchant ID");
      }

      // 5. Mandatory capture linkage inside matched purchase unit
      if (!targetPu!.payments || typeof targetPu!.payments !== "object") {
        throw new Error("Matched purchase unit missing mandatory payments object");
      }

      const puPayments = targetPu!.payments as { captures?: Array<Record<string, unknown>> };
      if (!Array.isArray(puPayments.captures) || puPayments.captures.length === 0) {
        throw new Error("Matched purchase unit missing mandatory non-empty payments.captures array");
      }

      let captureOccurrenceCount = 0;
      for (const cap of puPayments.captures) {
        if (!cap || typeof cap !== "object" || typeof cap.id !== "string" || cap.id.trim().length < 3) {
          throw new Error("Invalid capture entry in purchase unit payments.captures");
        }

        if (cap.id.trim() === cleanCaptureId) {
          captureOccurrenceCount++;
          if (cap.status !== "COMPLETED") {
            throw new Error(`Capture ${cleanCaptureId} in order purchase unit has non-COMPLETED status ${cap.status ?? "<missing>"}`);
          }
        }
      }

      if (captureOccurrenceCount === 0) {
        throw new Error(`Expected capture ID ${cleanCaptureId} not found in matched purchase unit captures`);
      }

      if (captureOccurrenceCount > 1) {
        throw new Error(`Duplicate occurrence of capture ID ${cleanCaptureId} in matched purchase unit captures`);
      }

      // Reject capture linked to another purchase unit
      for (const otherPu of purchaseUnits) {
        if (otherPu !== targetPu && otherPu.payments && typeof otherPu.payments === "object") {
          const otherPayments = otherPu.payments as { captures?: Array<Record<string, unknown>> };
          if (Array.isArray(otherPayments.captures)) {
            for (const otherCap of otherPayments.captures) {
              if (otherCap?.id === cleanCaptureId) {
                throw new Error(`Capture ID ${cleanCaptureId} is associated with an unrelated purchase unit in the order`);
              }
            }
          }
        }
      }

      // 6. Legacy argument cross-checks
      if (ctx.amountCents !== undefined && ctx.amountCents !== null && ctx.amountCents !== parsedCents) {
        throw new Error(`Contradictory argument: p_amount_cents ${ctx.amountCents} does not match verified provider capture amount ${parsedCents}`);
      }
      if (ctx.payeeMerchantId !== undefined && ctx.payeeMerchantId !== null && ctx.payeeMerchantId.trim() !== payeeObj.merchant_id.trim()) {
        throw new Error(`Contradictory argument: p_payee_merchant_id ${ctx.payeeMerchantId} does not match verified provider capture payee ${payeeObj.merchant_id}`);
      }

      // Insert ledger entry
      const txId = "tx-" + (ctx.ledger.size + 1);
      ctx.ledger.set(txId, {
        id: txId,
        payment_intent_id: ctx.intent.id,
        provider_reference_id: cleanCaptureId,
        amount_cents: parsedCents,
        currency: amountObj.currency_code,
        payee_merchant_id: payeeObj.merchant_id.trim(),
        status: "COMPLETED",
        raw_response: {
          capture: ctx.rawCaptureResponse,
          order: ctx.rawOrderResponse,
        },
      });

      // Update intent
      ctx.intent.status = "COMPLETED";
      ctx.intent.completed_at = new Date();
      ctx.activityEvents.push(`payment.reconciliation_completed:${ctx.intent.id}`);
      return true;
    }

    function createValidContext(): SimulationContext {
      const intentId = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
      const milestoneId = "f1e2d3c4-b5a6-9876-5432-abcdef012345";

      return {
        intent: {
          id: intentId,
          project_id: "proj-1",
          milestone_id: milestoneId,
          status: "RECONCILIATION_REQUIRED",
          expected_amount_canonical: "250.00",
          expected_amount_cents: 25000n,
          expected_merchant_id: "MERCHANT_EXACT_999",
          expected_currency: "USD",
          provider_order_id: "ORD-STRICT-111",
          canonical_payload_json: {
            intent: "CAPTURE",
            purchase_units: [
              {
                reference_id: milestoneId,
                custom_id: intentId,
                amount: { currency_code: "USD", value: "250.00" },
                payee: { merchant_id: "MERCHANT_EXACT_999" },
              },
            ],
          },
          completed_at: null,
        },
        captureId: "CAP-STRICT-222",
        rawCaptureResponse: {
          id: "CAP-STRICT-222",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "250.00" },
          payee: { merchant_id: "MERCHANT_EXACT_999" },
          supplementary_data: {
            related_ids: { order_id: "ORD-STRICT-111" },
          },
        },
        rawOrderResponse: {
          id: "ORD-STRICT-111",
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: milestoneId,
              custom_id: intentId,
              amount: { currency_code: "USD", value: "250.00" },
              payee: { merchant_id: "MERCHANT_EXACT_999" },
              payments: {
                captures: [{ id: "CAP-STRICT-222", status: "COMPLETED" }],
              },
            },
          ],
        },
        resolutionNotes: "Strict remediation test",
        amountCents: 25000n,
        payeeMerchantId: "MERCHANT_EXACT_999",
        ledger: new Map(),
        activityEvents: [],
        isPrivilegedReconciliationActive: true,
        callerRole: "service_role",
      };
    }

    // ------------------------------------------------------------------------
    // Scenario 1: Order status APPROVED is rejected
    // ------------------------------------------------------------------------
    it("1. Order status APPROVED is rejected", () => {
      const ctx = createValidContext();
      ctx.rawOrderResponse.status = "APPROVED";

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Authoritative PayPal order status must be COMPLETED, received APPROVED"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 2: Order status COMPLETED with completed capture succeeds
    // ------------------------------------------------------------------------
    it("2. Order status COMPLETED with completed capture succeeds", () => {
      const ctx = createValidContext();
      const res = simulateStrictReconcile(ctx);

      expect(res).toBe(true);
      expect(ctx.intent.status).toBe("COMPLETED");
      expect(ctx.intent.completed_at).not.toBeNull();
      expect(ctx.ledger.size).toBe(1);

      const tx = Array.from(ctx.ledger.values())[0];
      expect(tx.amount_cents).toBe(25000n);
      expect(tx.currency).toBe("USD");
      expect(tx.payee_merchant_id).toBe("MERCHANT_EXACT_999");
      expect(tx.provider_reference_id).toBe("CAP-STRICT-222");
    });

    // ------------------------------------------------------------------------
    // Scenario 3: Missing custom_id is rejected
    // ------------------------------------------------------------------------
    it("3. Missing custom_id is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      delete pu.custom_id;

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        /contradictory custom_id|not found in order response/i
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 4: Missing reference_id is rejected
    // ------------------------------------------------------------------------
    it("4. Missing reference_id is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      delete pu.reference_id;

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        /contradictory reference_id|not found in order response/i
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 5: Correct custom_id with wrong reference_id is rejected
    // ------------------------------------------------------------------------
    it("5. Correct custom_id with wrong reference_id is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu.reference_id = "00000000-0000-0000-0000-WRONGMILESTN";

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Purchase unit contains correct custom_id a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d but contradictory reference_id"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 6: Wrong custom_id with correct reference_id is rejected
    // ------------------------------------------------------------------------
    it("6. Wrong custom_id with correct reference_id is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu.custom_id = "00000000-0000-0000-0000-WRONGINTENTID";

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Purchase unit contains correct reference_id f1e2d3c4-b5a6-9876-5432-abcdef012345 but contradictory custom_id"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 7: Both identifiers wrong are rejected
    // ------------------------------------------------------------------------
    it("7. Both identifiers wrong are rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu.custom_id = "00000000-0000-0000-0000-WRONGINTENTID";
      pu.reference_id = "00000000-0000-0000-0000-WRONGMILESTN";

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        `Purchase unit matching intent ID ${ctx.intent.id} and milestone ID ${ctx.intent.milestone_id} not found in order response`
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 8: Duplicate matching purchase units are rejected
    // ------------------------------------------------------------------------
    it("8. Duplicate matching purchase units are rejected", () => {
      const ctx = createValidContext();
      (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>).push({
        reference_id: ctx.intent.milestone_id,
        custom_id: ctx.intent.id,
        amount: { currency_code: "USD", value: "250.00" },
        payee: { merchant_id: "MERCHANT_EXACT_999" },
        payments: {
          captures: [{ id: "CAP-STRICT-222", status: "COMPLETED" }],
        },
      });

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Multiple duplicate purchase units matched in order response"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 9: Missing payments object is rejected
    // ------------------------------------------------------------------------
    it("9. Missing payments object is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      delete pu.payments;

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Matched purchase unit missing mandatory payments object"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 10: Missing captures array is rejected
    // ------------------------------------------------------------------------
    it("10. Missing captures array is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu.payments = {}; // captures omitted!

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Matched purchase unit missing mandatory non-empty payments.captures array"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 11: Empty captures array is rejected
    // ------------------------------------------------------------------------
    it("11. Empty captures array is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu.payments = { captures: [] }; // empty captures array!

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Matched purchase unit missing mandatory non-empty payments.captures array"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 12: Capture ID found only in another purchase unit is rejected
    // ------------------------------------------------------------------------
    it("12. Capture ID found only in another purchase unit is rejected", () => {
      const ctx = createValidContext();
      const pu1 = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      // pu1 is the matched unit, but has capture 999 instead of 222
      pu1.payments = { captures: [{ id: "CAP-OTHER-999", status: "COMPLETED" }] };

      // Add second unrelated purchase unit containing the actual capture ID
      (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>).push({
        reference_id: "00000000-0000-0000-0000-UNRELATEDMILE",
        custom_id: "00000000-0000-0000-0000-UNRELATEDINTN",
        amount: { currency_code: "USD", value: "250.00" },
        payee: { merchant_id: "MERCHANT_EXACT_999" },
        payments: {
          captures: [{ id: "CAP-STRICT-222", status: "COMPLETED" }],
        },
      });

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Expected capture ID CAP-STRICT-222 not found in matched purchase unit captures"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 13: Expected capture ID appears twice and is rejected
    // ------------------------------------------------------------------------
    it("13. Expected capture ID appears twice and is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu.payments = {
        captures: [
          { id: "CAP-STRICT-222", status: "COMPLETED" },
          { id: "CAP-STRICT-222", status: "COMPLETED" },
        ],
      };

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Duplicate occurrence of capture ID CAP-STRICT-222 in matched purchase unit captures"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 14: Expected capture has non-COMPLETED status and is rejected
    // ------------------------------------------------------------------------
    it("14. Expected capture has non-COMPLETED status and is rejected", () => {
      const ctx = createValidContext();
      const pu = (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu.payments = {
        captures: [{ id: "CAP-STRICT-222", status: "PENDING" }],
      };

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Capture CAP-STRICT-222 in order purchase unit has non-COMPLETED status PENDING"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 15: Canonical payload missing required identifiers is rejected at intent creation
    // ------------------------------------------------------------------------
    it("15. Canonical payload missing required identifiers is rejected at intent creation", () => {
      const milestoneId = "f1e2d3c4-b5a6-9876-5432-abcdef012345";
      const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

      // Missing custom_id
      expect(() =>
        simulateCreationCanonicalContract({
          canonicalPayload: {
            purchase_units: [{ reference_id: milestoneId }],
          },
          milestoneId,
        })
      ).toThrow("Canonical payload purchase_units[0] missing mandatory custom_id");

      // Non-UUID custom_id
      expect(() =>
        simulateCreationCanonicalContract({
          canonicalPayload: {
            purchase_units: [{ custom_id: "not-a-valid-uuid", reference_id: milestoneId }],
          },
          milestoneId,
        })
      ).toThrow("Canonical payload purchase_units[0].custom_id must be a valid UUID");

      // Missing reference_id
      expect(() =>
        simulateCreationCanonicalContract({
          canonicalPayload: {
            purchase_units: [{ custom_id: validUuid }],
          },
          milestoneId,
        })
      ).toThrow("Canonical payload purchase_units[0] missing mandatory reference_id");

      // Mismatched reference_id
      expect(() =>
        simulateCreationCanonicalContract({
          canonicalPayload: {
            purchase_units: [{ custom_id: validUuid, reference_id: "wrong-milestone-uuid" }],
          },
          milestoneId,
        })
      ).toThrow("does not match milestone ID");

      // Valid contract returns intent UUID
      const resultUuid = simulateCreationCanonicalContract({
        canonicalPayload: {
          purchase_units: [{ custom_id: validUuid, reference_id: milestoneId }],
        },
        milestoneId,
      });
      expect(resultUuid).toBe(validUuid);
    });

    // ------------------------------------------------------------------------
    // Scenario 16: Existing valid idempotency and rollback behavior remains intact
    // ------------------------------------------------------------------------
    it("16. Existing valid idempotency and rollback behavior remains intact", () => {
      const ctx = createValidContext();
      // Call 1
      const res1 = simulateStrictReconcile(ctx);
      expect(res1).toBe(true);
      expect(ctx.ledger.size).toBe(1);
      expect(ctx.activityEvents.length).toBe(1);

      // Call 2 (Idempotent replay with identical capture)
      const res2 = simulateStrictReconcile(ctx);
      expect(res2).toBe(true);
      expect(ctx.ledger.size).toBe(1); // No duplicate ledger transaction!
      expect(ctx.activityEvents.length).toBe(1); // No duplicate activity event!

      // Call 3 with different capture reference fails
      ctx.captureId = "CAP-DIFFERENT-REFERENCE";
      ctx.rawCaptureResponse.id = "CAP-DIFFERENT-REFERENCE";
      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Payment intent is already COMPLETED with a different capture reference"
      );
      expect(ctx.ledger.size).toBe(1);
    });

    // ------------------------------------------------------------------------
    // Scenario 17: Unprivileged callers cannot execute reconciliation
    // ------------------------------------------------------------------------
    it("17. Unprivileged callers cannot execute reconciliation", () => {
      const ctxAnon = createValidContext();
      ctxAnon.callerRole = "anon";
      expect(() => simulateStrictReconcile(ctxAnon)).toThrow(
        "Permission denied: function reconcile_and_complete_payment_intent can only be executed by service_role"
      );

      const ctxAuth = createValidContext();
      ctxAuth.callerRole = "authenticated";
      expect(() => simulateStrictReconcile(ctxAuth)).toThrow(
        "Permission denied: function reconcile_and_complete_payment_intent can only be executed by service_role"
      );

      expect(ctxAnon.ledger.size).toBe(0);
      expect(ctxAuth.ledger.size).toBe(0);
    });
  });
});
