import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Phase 3A.1.8: Single Purchase-Unit Contract Enforcement", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611030009_single_purchase_unit_contract_enforcement.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC DDL AND ACCESS CONTROL AUDIT [Static SQL Check]
  // ==========================================================================
  describe("1. Static DDL and Access Control Audit [Static SQL Check]", () => {
    it("[Static SQL Check] updates create_client_payment_intent to strictly require exactly 1 purchase unit and revokes public execution", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.create_client_payment_intent\(/i);
      expect(migrationSql).toMatch(/jsonb_array_length\(p_canonical_payload->'purchase_units'\)\s*=\s*0/i);
      expect(migrationSql).toMatch(/jsonb_array_length\(p_canonical_payload->'purchase_units'\)\s*<>\s*1/i);
      expect(migrationSql).toMatch(/Canonical payload purchase_units must contain exactly 1 element/i);
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_client_payment_intent\(text,\s*uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });

    it("[Static SQL Check] updates create_sandbox_demo_payment_intent to strictly require exactly 1 purchase unit with owner check", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.create_sandbox_demo_payment_intent\(/i);
      expect(migrationSql).toMatch(/auth\.uid\(\)\s+is\s+null\s+or\s+v_project\.owner_id\s*<>\s*auth\.uid\(\)/i);
      expect(migrationSql).toMatch(/jsonb_array_length\(p_canonical_payload->'purchase_units'\)\s*<>\s*1/i);
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_sandbox_demo_payment_intent\(uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb\)\s+from\s+public,\s*anon;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.create_sandbox_demo_payment_intent\(uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb\)\s+to\s+authenticated;/i
      );
    });

    it("[Static SQL Check] updates reconcile_and_complete_payment_intent to require exactly 1 purchase unit in order response", () => {
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.reconcile_and_complete_payment_intent\(/i);
      expect(migrationSql).toMatch(/jsonb_array_length\(p_raw_order_response->'purchase_units'\)\s*=\s*0/i);
      expect(migrationSql).toMatch(/jsonb_array_length\(p_raw_order_response->'purchase_units'\)\s*<>\s*1/i);
      expect(migrationSql).toMatch(/Order response purchase_units must contain exactly 1 element/i);
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.reconcile_and_complete_payment_intent\(uuid,\s*text,\s*jsonb,\s*jsonb,\s*text,\s*bigint,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });

    it("[Static SQL Check] enforces SECURITY DEFINER and empty safe search_path across all three RPCs", () => {
      const secDefMatches = migrationSql.match(/security\s+definer\s+set\s+search_path\s*=\s*''/gi);
      expect(secDefMatches).not.toBeNull();
      expect(secDefMatches!.length).toBe(3);
    });
  });

  // ==========================================================================
  // SECTION 2: HIGH-FIDELITY BEHAVIORAL SIMULATION [In-Memory Behavioral Simulation]
  // ==========================================================================
  describe("2. Behavioral Simulation Across All 11 Required Scenarios [In-Memory Behavioral Simulation]", () => {
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

    /**
     * Simulates creation-time validation in create_client_payment_intent
     * and create_sandbox_demo_payment_intent as defined in migration 0009.
     */
    function simulateCreationSinglePurchaseUnit(params: {
      canonicalPayload: unknown;
      milestoneId: string;
      isDemo?: boolean;
      callerRole: "service_role" | "authenticated" | "anon";
      projectOwnerId?: string;
      authUserId?: string | null;
    }): string {
      // 1. Role / Ownership authorization check
      if (params.isDemo) {
        if (params.callerRole !== "authenticated") {
          throw new Error("Forbidden: Only authenticated users can access sandbox demo creation");
        }
        if (!params.authUserId || params.authUserId !== params.projectOwnerId) {
          throw new Error("Forbidden: Only the authenticated project owner can create sandbox demo payment intents");
        }
      } else {
        if (params.callerRole !== "service_role") {
          throw new Error("Permission denied: function create_client_payment_intent can only be executed by service_role");
        }
      }

      // 2. Canonical Payload Object check
      if (!params.canonicalPayload || typeof params.canonicalPayload !== "object") {
        throw new Error("Canonical payload must be a valid JSON object");
      }

      const p = params.canonicalPayload as Record<string, unknown>;
      const puArray = p.purchase_units as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(puArray)) {
        throw new Error("Canonical payload missing mandatory purchase_units array");
      }

      // 3. Strict Single Purchase-Unit requirement (length = 1)
      if (puArray.length === 0) {
        throw new Error("Canonical payload purchase_units array must not be empty");
      }

      if (puArray.length !== 1) {
        throw new Error(`Canonical payload purchase_units must contain exactly 1 element, received ${puArray.length}`);
      }

      const pu = puArray[0];
      if (!pu || typeof pu !== "object") {
        throw new Error("Canonical payload purchase_units[0] must be a valid JSON object");
      }

      // 4. Custom ID (intent UUID) validation
      const customId = typeof pu.custom_id === "string" ? pu.custom_id.trim() : "";
      if (customId.length === 0) {
        throw new Error("Canonical payload purchase_units[0] missing mandatory custom_id");
      }

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customId)) {
        throw new Error(`Canonical payload purchase_units[0].custom_id must be a valid UUID, received ${customId}`);
      }

      // 5. Reference ID (milestone UUID) validation
      const refId = typeof pu.reference_id === "string" ? pu.reference_id.trim() : "";
      if (refId.length === 0) {
        throw new Error("Canonical payload purchase_units[0] missing mandatory reference_id");
      }

      if (refId !== params.milestoneId) {
        throw new Error(`Canonical payload purchase_units[0].reference_id ${refId} does not match milestone ID ${params.milestoneId}`);
      }

      return customId;
    }

    /**
     * Simulates reconciliation-time validation in reconcile_and_complete_payment_intent
     * as defined in migration 0009.
     */
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

      if (ctx.rawOrderResponse.status !== "COMPLETED") {
        throw new Error(`Authoritative PayPal order status must be COMPLETED, received ${ctx.rawOrderResponse.status ?? "<missing>"}`);
      }

      const purchaseUnits = ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(purchaseUnits)) {
        throw new Error("Order response purchase_units must be a valid JSON array");
      }

      // 3. Strict Single Purchase Unit Requirement (length = 1)
      if (purchaseUnits.length === 0) {
        throw new Error("Order response purchase_units array must not be empty");
      }

      if (purchaseUnits.length !== 1) {
        throw new Error(`Order response purchase_units must contain exactly 1 element, received ${purchaseUnits.length}`);
      }

      const targetPu = purchaseUnits[0];
      if (!targetPu || typeof targetPu !== "object") {
        throw new Error("Purchase unit element in order response must be a JSON object");
      }

      // 4. Strict Dual Matching on the Single Purchase Unit
      const puCustomId = typeof targetPu.custom_id === "string" ? targetPu.custom_id.trim() : "";
      const puRefId = typeof targetPu.reference_id === "string" ? targetPu.reference_id.trim() : "";

      if (puCustomId === ctx.intent.id && puRefId !== ctx.intent.milestone_id) {
        throw new Error(`Purchase unit contains correct custom_id ${puCustomId} but contradictory reference_id ${puRefId} (expected milestone ${ctx.intent.milestone_id})`);
      }

      if (puRefId === ctx.intent.milestone_id && puCustomId !== ctx.intent.id) {
        throw new Error(`Purchase unit contains correct reference_id ${puRefId} but contradictory custom_id ${puCustomId} (expected intent ${ctx.intent.id})`);
      }

      if (puCustomId !== ctx.intent.id || puRefId !== ctx.intent.milestone_id) {
        throw new Error(`Purchase unit matching intent ID ${ctx.intent.id} and milestone ID ${ctx.intent.milestone_id} not found in order response`);
      }

      // 5. Financial & Payee checks on the single purchase unit
      const puAmount = targetPu.amount as Record<string, string> | undefined;
      if (!puAmount?.currency_code || puAmount.currency_code !== "USD" || puAmount.currency_code !== ctx.intent.expected_currency) {
        throw new Error("Purchase unit currency does not match intent expected currency");
      }
      if (!puAmount?.value || puAmount.value !== ctx.intent.expected_amount_canonical) {
        throw new Error("Purchase unit amount does not match expected intent amount");
      }

      const puPayee = targetPu.payee as Record<string, string> | undefined;
      if (!puPayee?.merchant_id || puPayee.merchant_id.trim() !== ctx.intent.expected_merchant_id) {
        throw new Error("Purchase unit payee merchant ID does not match expected merchant ID");
      }

      // 6. Mandatory capture linkage inside single purchase unit
      if (!targetPu.payments || typeof targetPu.payments !== "object") {
        throw new Error("Matched purchase unit missing mandatory payments object");
      }

      const puPayments = targetPu.payments as { captures?: Array<Record<string, unknown>> };
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

      // 7. Legacy argument cross-checks
      if (ctx.amountCents !== undefined && ctx.amountCents !== null && ctx.amountCents !== parsedCents) {
        throw new Error(`Contradictory argument: p_amount_cents ${ctx.amountCents} does not match verified provider capture amount ${parsedCents}`);
      }
      if (ctx.payeeMerchantId !== undefined && ctx.payeeMerchantId !== null && ctx.payeeMerchantId.trim() !== payeeObj.merchant_id.trim()) {
        throw new Error(`Contradictory argument: p_payee_merchant_id ${ctx.payeeMerchantId} does not match verified provider capture payee ${payeeObj.merchant_id}`);
      }

      // 8. Append to ledger and complete intent
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
          provider_order_id: "ORD-SINGLE-PU-111",
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
        captureId: "CAP-SINGLE-PU-222",
        rawCaptureResponse: {
          id: "CAP-SINGLE-PU-222",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "250.00" },
          payee: { merchant_id: "MERCHANT_EXACT_999" },
          supplementary_data: {
            related_ids: { order_id: "ORD-SINGLE-PU-111" },
          },
        },
        rawOrderResponse: {
          id: "ORD-SINGLE-PU-111",
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: milestoneId,
              custom_id: intentId,
              amount: { currency_code: "USD", value: "250.00" },
              payee: { merchant_id: "MERCHANT_EXACT_999" },
              payments: {
                captures: [{ id: "CAP-SINGLE-PU-222", status: "COMPLETED" }],
              },
            },
          ],
        },
        resolutionNotes: "Single PU test",
        amountCents: 25000n,
        payeeMerchantId: "MERCHANT_EXACT_999",
        ledger: new Map(),
        activityEvents: [],
        isPrivilegedReconciliationActive: true,
        callerRole: "service_role",
      };
    }

    // ------------------------------------------------------------------------
    // Scenario 1: Exactly one purchase unit accepted during normal intent creation
    // ------------------------------------------------------------------------
    it("1. [In-Memory Behavioral Simulation] Exactly one purchase unit accepted during normal intent creation", () => {
      const milestoneId = "f1e2d3c4-b5a6-9876-5432-abcdef012345";
      const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

      const result = simulateCreationSinglePurchaseUnit({
        canonicalPayload: {
          purchase_units: [{ custom_id: validUuid, reference_id: milestoneId }],
        },
        milestoneId,
        callerRole: "service_role",
      });

      expect(result).toBe(validUuid);
    });

    // ------------------------------------------------------------------------
    // Scenario 2: Empty purchase_units rejected
    // ------------------------------------------------------------------------
    it("2. [In-Memory Behavioral Simulation] Empty purchase_units rejected", () => {
      const milestoneId = "f1e2d3c4-b5a6-9876-5432-abcdef012345";

      expect(() =>
        simulateCreationSinglePurchaseUnit({
          canonicalPayload: {
            purchase_units: [],
          },
          milestoneId,
          callerRole: "service_role",
        })
      ).toThrow("Canonical payload purchase_units array must not be empty");
    });

    // ------------------------------------------------------------------------
    // Scenario 3: Multiple purchase units rejected during normal intent creation
    // ------------------------------------------------------------------------
    it("3. [In-Memory Behavioral Simulation] Multiple purchase units rejected during normal intent creation", () => {
      const milestoneId = "f1e2d3c4-b5a6-9876-5432-abcdef012345";
      const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";

      expect(() =>
        simulateCreationSinglePurchaseUnit({
          canonicalPayload: {
            purchase_units: [
              { custom_id: validUuid, reference_id: milestoneId },
              { custom_id: "00000000-0000-0000-0000-000000000002", reference_id: "extra-ref" },
            ],
          },
          milestoneId,
          callerRole: "service_role",
        })
      ).toThrow("Canonical payload purchase_units must contain exactly 1 element, received 2");
    });

    // ------------------------------------------------------------------------
    // Scenario 4: Exactly one purchase unit accepted during Sandbox intent creation
    // ------------------------------------------------------------------------
    it("4. [In-Memory Behavioral Simulation] Exactly one purchase unit accepted during Sandbox intent creation", () => {
      const milestoneId = "f1e2d3c4-b5a6-9876-5432-abcdef012345";
      const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
      const ownerId = "owner-uuid-111";

      const result = simulateCreationSinglePurchaseUnit({
        canonicalPayload: {
          purchase_units: [{ custom_id: validUuid, reference_id: milestoneId }],
        },
        milestoneId,
        isDemo: true,
        callerRole: "authenticated",
        authUserId: ownerId,
        projectOwnerId: ownerId,
      });

      expect(result).toBe(validUuid);
    });

    // ------------------------------------------------------------------------
    // Scenario 5: Multiple purchase units rejected during Sandbox intent creation
    // ------------------------------------------------------------------------
    it("5. [In-Memory Behavioral Simulation] Multiple purchase units rejected during Sandbox intent creation", () => {
      const milestoneId = "f1e2d3c4-b5a6-9876-5432-abcdef012345";
      const validUuid = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
      const ownerId = "owner-uuid-111";

      expect(() =>
        simulateCreationSinglePurchaseUnit({
          canonicalPayload: {
            purchase_units: [
              { custom_id: validUuid, reference_id: milestoneId },
              { custom_id: "00000000-0000-0000-0000-000000000003", reference_id: "extra-ref-2" },
            ],
          },
          milestoneId,
          isDemo: true,
          callerRole: "authenticated",
          authUserId: ownerId,
          projectOwnerId: ownerId,
        })
      ).toThrow("Canonical payload purchase_units must contain exactly 1 element, received 2");
    });

    // ------------------------------------------------------------------------
    // Scenario 6: Exactly one matching purchase unit accepted during reconciliation
    // ------------------------------------------------------------------------
    it("6. [In-Memory Behavioral Simulation] Exactly one matching purchase unit accepted during reconciliation", () => {
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
      expect(tx.provider_reference_id).toBe("CAP-SINGLE-PU-222");
    });

    // ------------------------------------------------------------------------
    // Scenario 7: Additional unrelated purchase unit rejected
    // ------------------------------------------------------------------------
    it("7. [In-Memory Behavioral Simulation] Additional unrelated purchase unit rejected", () => {
      const ctx = createValidContext();
      // Add a second, unrelated purchase unit
      (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>).push({
        reference_id: "00000000-0000-0000-0000-UNRELATEDMILE",
        custom_id: "00000000-0000-0000-0000-UNRELATEDINTN",
        amount: { currency_code: "USD", value: "250.00" },
        payee: { merchant_id: "MERCHANT_EXACT_999" },
        payments: {
          captures: [{ id: "CAP-OTHER-888", status: "COMPLETED" }],
        },
      });

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Order response purchase_units must contain exactly 1 element, received 2"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 8: Duplicate matching purchase units rejected
    // ------------------------------------------------------------------------
    it("8. [In-Memory Behavioral Simulation] Duplicate matching purchase units rejected", () => {
      const ctx = createValidContext();
      // Add a duplicate matching purchase unit
      (ctx.rawOrderResponse.purchase_units as Array<Record<string, unknown>>).push({
        reference_id: ctx.intent.milestone_id,
        custom_id: ctx.intent.id,
        amount: { currency_code: "USD", value: "250.00" },
        payee: { merchant_id: "MERCHANT_EXACT_999" },
        payments: {
          captures: [{ id: "CAP-SINGLE-PU-222", status: "COMPLETED" }],
        },
      });

      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Order response purchase_units must contain exactly 1 element, received 2"
      );
      expect(ctx.intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ctx.ledger.size).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Scenario 9: Existing strict capture linkage remains enforced
    // ------------------------------------------------------------------------
    it("9. [In-Memory Behavioral Simulation] Existing strict capture linkage remains enforced", () => {
      // 9a. Matched PU missing captures array
      const ctxMissingCaps = createValidContext();
      const pu = (ctxMissingCaps.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu.payments = {};
      expect(() => simulateStrictReconcile(ctxMissingCaps)).toThrow(
        "Matched purchase unit missing mandatory non-empty payments.captures array"
      );

      // 9b. Matched PU capture non-COMPLETED status
      const ctxPendingCap = createValidContext();
      const pu2 = (ctxPendingCap.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu2.payments = { captures: [{ id: "CAP-SINGLE-PU-222", status: "PENDING" }] };
      expect(() => simulateStrictReconcile(ctxPendingCap)).toThrow(
        "Capture CAP-SINGLE-PU-222 in order purchase unit has non-COMPLETED status PENDING"
      );

      // 9c. Duplicate capture occurrences inside the single PU
      const ctxDupCap = createValidContext();
      const pu3 = (ctxDupCap.rawOrderResponse.purchase_units as Array<Record<string, unknown>>)[0];
      pu3.payments = {
        captures: [
          { id: "CAP-SINGLE-PU-222", status: "COMPLETED" },
          { id: "CAP-SINGLE-PU-222", status: "COMPLETED" },
        ],
      };
      expect(() => simulateStrictReconcile(ctxDupCap)).toThrow(
        "Duplicate occurrence of capture ID CAP-SINGLE-PU-222 in matched purchase unit captures"
      );
    });

    // ------------------------------------------------------------------------
    // Scenario 10: Existing idempotency and rollback behavior remains intact
    // ------------------------------------------------------------------------
    it("10. [In-Memory Behavioral Simulation] Existing idempotency and rollback behavior remains intact", () => {
      const ctx = createValidContext();
      // First execution
      const res1 = simulateStrictReconcile(ctx);
      expect(res1).toBe(true);
      expect(ctx.ledger.size).toBe(1);
      expect(ctx.activityEvents.length).toBe(1);

      // Idempotent replay with same capture reference returns true with no duplicate transaction
      const res2 = simulateStrictReconcile(ctx);
      expect(res2).toBe(true);
      expect(ctx.ledger.size).toBe(1);
      expect(ctx.activityEvents.length).toBe(1);

      // Attempting replay with different capture reference fails
      ctx.captureId = "CAP-DIFFERENT-REF-999";
      ctx.rawCaptureResponse.id = "CAP-DIFFERENT-REF-999";
      expect(() => simulateStrictReconcile(ctx)).toThrow(
        "Payment intent is already COMPLETED with a different capture reference"
      );
      expect(ctx.ledger.size).toBe(1);
    });

    // ------------------------------------------------------------------------
    // Scenario 11: Unprivileged callers remain unable to execute privileged functions
    // ------------------------------------------------------------------------
    it("11. [In-Memory Behavioral Simulation] Unprivileged callers remain unable to execute privileged functions", () => {
      // 11a. Normal creation by non-service-role
      expect(() =>
        simulateCreationSinglePurchaseUnit({
          canonicalPayload: {
            purchase_units: [{ custom_id: "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d", reference_id: "f1e2d3c4-b5a6-9876-5432-abcdef012345" }],
          },
          milestoneId: "f1e2d3c4-b5a6-9876-5432-abcdef012345",
          callerRole: "authenticated",
        })
      ).toThrow("Permission denied: function create_client_payment_intent can only be executed by service_role");

      // 11b. Demo creation by non-owner authenticated user
      expect(() =>
        simulateCreationSinglePurchaseUnit({
          canonicalPayload: {
            purchase_units: [{ custom_id: "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d", reference_id: "f1e2d3c4-b5a6-9876-5432-abcdef012345" }],
          },
          milestoneId: "f1e2d3c4-b5a6-9876-5432-abcdef012345",
          isDemo: true,
          callerRole: "authenticated",
          authUserId: "wrong-user-uuid",
          projectOwnerId: "actual-owner-uuid",
        })
      ).toThrow("Forbidden: Only the authenticated project owner can create sandbox demo payment intents");

      // 11c. Reconciliation by unprivileged caller (anon or authenticated)
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
    });
  });
});
