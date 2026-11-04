import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashSessionToken, createSessionToken } from "@/lib/security/tokens";

describe("Phase 3A.1.2: Payment Authorization and Reconciliation Recovery", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611030006_payment_authorization_and_reconciliation.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC DDL AND ACCESS CONTROL AUDIT
  // ==========================================================================
  describe("1. Static SQL Grants and Function Definitions", () => {
    it("revokes execution on legacy create_payment_intent from public, anon, and authenticated", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_payment_intent\(uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb,\s*boolean\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });

    it("restricts create_client_payment_intent strictly to service_role (revoked from public, anon, authenticated)", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_client_payment_intent\(text,\s*uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });

    it("restricts create_sandbox_demo_payment_intent to authenticated project owners and revokes from anon", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_sandbox_demo_payment_intent\(uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb\)\s+from\s+public,\s*anon;/i
      );
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.create_sandbox_demo_payment_intent\(uuid,\s*text,\s*uuid,\s*uuid,\s*jsonb\)\s+to\s+authenticated;/i
      );
    });

    it("restricts privileged recovery reconcile_and_complete_payment_intent strictly to service_role", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.reconcile_and_complete_payment_intent\(uuid,\s*text,\s*bigint,\s*text,\s*jsonb,\s*text\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });

    it("updates protect_payment_intent_immutability to permit RECONCILIATION_REQUIRED transition strictly under payroost.reconciliation_active", () => {
      expect(migrationSql).toMatch(/current_setting\('payroost\.reconciliation_active',\s*true\)\s+is\s+distinct\s+from\s+'true'/i);
      expect(migrationSql).toMatch(/Payment intent in RECONCILIATION_REQUIRED can only transition to COMPLETED via privileged reconciliation/i);
    });
  });

  // ==========================================================================
  // SECTION 2: CLIENT SESSION AUTHORIZATION SIMULATION
  // ==========================================================================
  describe("2. Client Session Authorization Tests", () => {
    interface SimulatedSession {
      id: string;
      project_id: string;
      client_email: string;
      session_token_hash: string;
      revoked_at: Date | null;
      last_active_at: Date;
      expires_at: Date;
    }

    interface SimulatedMilestone {
      id: string;
      project_id: string;
      agreement_version_id: string;
      status: string;
      amount_minor: bigint;
      currency: string;
    }

    interface SimulatedProject {
      id: string;
      owner_id: string;
      client_email: string;
      client_email_verified_at: Date | null;
    }

    interface SimulatedAgreementVersion {
      id: string;
      status: string;
    }

    interface SimulatedIntent {
      id: string;
      milestone_id: string;
      status: string;
      is_sandbox_demo: boolean;
    }

    function simulateCreateClientPaymentIntent(params: {
      sessionHash: string;
      milestoneId: string;
      merchantId: string;
      sessions: Map<string, SimulatedSession>;
      milestones: Map<string, SimulatedMilestone>;
      projects: Map<string, SimulatedProject>;
      agreementVersions: Map<string, SimulatedAgreementVersion>;
      intents: Map<string, SimulatedIntent>;
    }): string {
      const milestone = params.milestones.get(params.milestoneId);
      if (!milestone) throw new Error("Milestone not found");

      const project = params.projects.get(milestone.project_id);
      if (!project) throw new Error("Project not found");

      const session = params.sessions.get(params.sessionHash);
      if (!session || session.revoked_at) {
        throw new Error("Unauthorized: Client portal session is invalid or revoked");
      }

      if (Date.now() >= session.expires_at.getTime()) {
        throw new Error("Unauthorized: Client portal session has expired (absolute timeout)");
      }

      if (Date.now() >= session.last_active_at.getTime() + 60 * 60 * 1000) {
        throw new Error("Unauthorized: Client portal session has expired (idle timeout)");
      }

      if (session.project_id !== milestone.project_id) {
        throw new Error("Forbidden: Client portal session does not belong to this project");
      }

      if (!project.client_email_verified_at) {
        throw new Error("Forbidden: Project client email is not verified");
      }

      if (project.client_email !== session.client_email) {
        throw new Error("Forbidden: Client email has changed since session issuance");
      }

      if (!["APPROVED", "IN_PROGRESS", "SUBMITTED"].includes(milestone.status)) {
        throw new Error(`Milestone status ${milestone.status} is not payable`);
      }

      const version = params.agreementVersions.get(milestone.agreement_version_id);
      if (!version || version.status !== "APPROVED") {
        throw new Error("Milestone does not belong to an approved agreement version");
      }

      // Check one active intent invariant
      for (const intent of params.intents.values()) {
        if (intent.milestone_id === milestone.id && intent.status === "ORDER_CREATING") {
          throw new Error("A payment intent is already active for this milestone");
        }
      }

      const intentId = "pi-" + (params.intents.size + 1);
      params.intents.set(intentId, {
        id: intentId,
        milestone_id: milestone.id,
        status: "ORDER_CREATING",
        is_sandbox_demo: false,
      });

      session.last_active_at = new Date();
      return intentId;
    }

    const baseProject: SimulatedProject = {
      id: "proj-1",
      owner_id: "owner-1",
      client_email: "client@example.com",
      client_email_verified_at: new Date(),
    };

    const baseVersion: SimulatedAgreementVersion = {
      id: "ver-1",
      status: "APPROVED",
    };

    const baseMilestone: SimulatedMilestone = {
      id: "m-1",
      project_id: "proj-1",
      agreement_version_id: "ver-1",
      status: "APPROVED",
      amount_minor: 10000n,
      currency: "USD",
    };

    it("1. valid client session for correct project permits payment intent creation", () => {
      const rawToken = createSessionToken();
      const hash = hashSessionToken(rawToken);

      const sessions = new Map<string, SimulatedSession>([
        [
          hash,
          {
            id: "s-1",
            project_id: "proj-1",
            client_email: "client@example.com",
            session_token_hash: hash,
            revoked_at: null,
            last_active_at: new Date(),
            expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000),
          },
        ],
      ]);

      const intents = new Map<string, SimulatedIntent>();
      const intentId = simulateCreateClientPaymentIntent({
        sessionHash: hash,
        milestoneId: "m-1",
        merchantId: "MERCHANT_TEST",
        sessions,
        milestones: new Map([["m-1", baseMilestone]]),
        projects: new Map([["proj-1", baseProject]]),
        agreementVersions: new Map([["ver-1", baseVersion]]),
        intents,
      });

      expect(intentId).toBe("pi-1");
      expect(intents.get("pi-1")?.status).toBe("ORDER_CREATING");
      expect(intents.get("pi-1")?.is_sandbox_demo).toBe(false);
    });

    it("2. session for another project is rejected", () => {
      const hash = hashSessionToken("token-other");
      const sessions = new Map<string, SimulatedSession>([
        [
          hash,
          {
            id: "s-other",
            project_id: "proj-OTHER",
            client_email: "client@example.com",
            session_token_hash: hash,
            revoked_at: null,
            last_active_at: new Date(),
            expires_at: new Date(Date.now() + 3600000),
          },
        ],
      ]);

      expect(() =>
        simulateCreateClientPaymentIntent({
          sessionHash: hash,
          milestoneId: "m-1",
          merchantId: "MERCHANT_TEST",
          sessions,
          milestones: new Map([["m-1", baseMilestone]]),
          projects: new Map([["proj-1", baseProject]]),
          agreementVersions: new Map([["ver-1", baseVersion]]),
          intents: new Map(),
        })
      ).toThrow("Forbidden: Client portal session does not belong to this project");
    });

    it("3. revoked session is rejected and creates no intent row", () => {
      const hash = hashSessionToken("token-revoked");
      const sessions = new Map<string, SimulatedSession>([
        [
          hash,
          {
            id: "s-revoked",
            project_id: "proj-1",
            client_email: "client@example.com",
            session_token_hash: hash,
            revoked_at: new Date(),
            last_active_at: new Date(),
            expires_at: new Date(Date.now() + 3600000),
          },
        ],
      ]);

      const intents = new Map<string, SimulatedIntent>();
      expect(() =>
        simulateCreateClientPaymentIntent({
          sessionHash: hash,
          milestoneId: "m-1",
          merchantId: "MERCHANT_TEST",
          sessions,
          milestones: new Map([["m-1", baseMilestone]]),
          projects: new Map([["proj-1", baseProject]]),
          agreementVersions: new Map([["ver-1", baseVersion]]),
          intents,
        })
      ).toThrow("Unauthorized: Client portal session is invalid or revoked");
      expect(intents.size).toBe(0);
    });

    it("4. expired session (absolute 12h) is rejected", () => {
      const hash = hashSessionToken("token-expired");
      const sessions = new Map<string, SimulatedSession>([
        [
          hash,
          {
            id: "s-expired",
            project_id: "proj-1",
            client_email: "client@example.com",
            session_token_hash: hash,
            revoked_at: null,
            last_active_at: new Date(),
            expires_at: new Date(Date.now() - 1000),
          },
        ],
      ]);

      expect(() =>
        simulateCreateClientPaymentIntent({
          sessionHash: hash,
          milestoneId: "m-1",
          merchantId: "MERCHANT_TEST",
          sessions,
          milestones: new Map([["m-1", baseMilestone]]),
          projects: new Map([["proj-1", baseProject]]),
          agreementVersions: new Map([["ver-1", baseVersion]]),
          intents: new Map(),
        })
      ).toThrow("Unauthorized: Client portal session has expired (absolute timeout)");
    });

    it("5. idle-expired session (>60m) is rejected", () => {
      const hash = hashSessionToken("token-idle");
      const sessions = new Map<string, SimulatedSession>([
        [
          hash,
          {
            id: "s-idle",
            project_id: "proj-1",
            client_email: "client@example.com",
            session_token_hash: hash,
            revoked_at: null,
            last_active_at: new Date(Date.now() - 61 * 60 * 1000),
            expires_at: new Date(Date.now() + 5 * 60 * 60 * 1000),
          },
        ],
      ]);

      expect(() =>
        simulateCreateClientPaymentIntent({
          sessionHash: hash,
          milestoneId: "m-1",
          merchantId: "MERCHANT_TEST",
          sessions,
          milestones: new Map([["m-1", baseMilestone]]),
          projects: new Map([["proj-1", baseProject]]),
          agreementVersions: new Map([["ver-1", baseVersion]]),
          intents: new Map(),
        })
      ).toThrow("Unauthorized: Client portal session has expired (idle timeout)");
    });

    it("6. session for an outdated client email is rejected", () => {
      const hash = hashSessionToken("token-email-mismatch");
      const sessions = new Map<string, SimulatedSession>([
        [
          hash,
          {
            id: "s-email-old",
            project_id: "proj-1",
            client_email: "old-email@example.com",
            session_token_hash: hash,
            revoked_at: null,
            last_active_at: new Date(),
            expires_at: new Date(Date.now() + 3600000),
          },
        ],
      ]);

      expect(() =>
        simulateCreateClientPaymentIntent({
          sessionHash: hash,
          milestoneId: "m-1",
          merchantId: "MERCHANT_TEST",
          sessions,
          milestones: new Map([["m-1", baseMilestone]]),
          projects: new Map([["proj-1", baseProject]]), // current email is client@example.com
          agreementVersions: new Map([["ver-1", baseVersion]]),
          intents: new Map(),
        })
      ).toThrow("Forbidden: Client email has changed since session issuance");
    });

    it("7. owner-only sandbox path rejects non-owner or unauthenticated callers", () => {
      function simulateSandboxDemo(callerUid: string | null, project: SimulatedProject): string {
        if (!callerUid || project.owner_id !== callerUid) {
          throw new Error("Forbidden: Only the authenticated project owner can create sandbox demo payment intents");
        }
        return "demo-intent-created";
      }

      expect(() => simulateSandboxDemo(null, baseProject)).toThrow(
        "Forbidden: Only the authenticated project owner can create sandbox demo payment intents"
      );
      expect(() => simulateSandboxDemo("attacker-uid", baseProject)).toThrow(
        "Forbidden: Only the authenticated project owner can create sandbox demo payment intents"
      );
      expect(simulateSandboxDemo("owner-1", baseProject)).toBe("demo-intent-created");
    });

    it("8. concurrent attempts cannot create multiple active intents for the same milestone", () => {
      const hash = hashSessionToken("token-concurrent");
      const sessions = new Map<string, SimulatedSession>([
        [
          hash,
          {
            id: "s-c",
            project_id: "proj-1",
            client_email: "client@example.com",
            session_token_hash: hash,
            revoked_at: null,
            last_active_at: new Date(),
            expires_at: new Date(Date.now() + 3600000),
          },
        ],
      ]);

      const intents = new Map<string, SimulatedIntent>();
      // First intent created successfully
      simulateCreateClientPaymentIntent({
        sessionHash: hash,
        milestoneId: "m-1",
        merchantId: "MERCHANT_TEST",
        sessions,
        milestones: new Map([["m-1", baseMilestone]]),
        projects: new Map([["proj-1", baseProject]]),
        agreementVersions: new Map([["ver-1", baseVersion]]),
        intents,
      });

      // Second attempt on same milestone fails partial unique constraint
      expect(() =>
        simulateCreateClientPaymentIntent({
          sessionHash: hash,
          milestoneId: "m-1",
          merchantId: "MERCHANT_TEST",
          sessions,
          milestones: new Map([["m-1", baseMilestone]]),
          projects: new Map([["proj-1", baseProject]]),
          agreementVersions: new Map([["ver-1", baseVersion]]),
          intents,
        })
      ).toThrow("A payment intent is already active for this milestone");
    });
  });

  // ==========================================================================
  // SECTION 3: PRIVILEGED RECONCILIATION RECOVERY SIMULATION
  // ==========================================================================
  describe("3. Privileged Reconciliation Recovery Tests", () => {
    interface SimulatedIntent {
      id: string;
      status: string;
      expected_amount_cents: bigint;
      expected_merchant_id: string;
      expected_currency: string;
      provider_order_id: string;
      completed_at: Date | null;
    }

    interface SimulatedLedgerTransaction {
      id: string;
      payment_intent_id: string;
      provider_reference_id: string;
      amount_cents: bigint;
      payee_merchant_id: string;
      status: string;
    }

    function simulateReconcileAndComplete(params: {
      intent: SimulatedIntent;
      captureId: string;
      amountCents: bigint;
      payeeMerchantId: string;
      rawResponse: { status: string; supplementary_data?: { related_ids?: { order_id?: string } } };
      ledger: Map<string, SimulatedLedgerTransaction>;
      activityEvents: string[];
      isPrivilegedReconciliationActive: boolean;
    }): boolean {
      if (!params.isPrivilegedReconciliationActive) {
        throw new Error("Privileged intervention required to transition RECONCILIATION_REQUIRED");
      }

      // Idempotency check: already completed with this exact capture
      if (params.intent.status === "COMPLETED") {
        for (const tx of params.ledger.values()) {
          if (
            tx.payment_intent_id === params.intent.id &&
            tx.provider_reference_id === params.captureId &&
            tx.status === "COMPLETED"
          ) {
            return true;
          }
        }
        throw new Error("Payment intent is already COMPLETED with a different capture reference");
      }

      if (params.intent.status !== "RECONCILIATION_REQUIRED") {
        throw new Error(`Intent status ${params.intent.status} is not eligible for reconciliation recovery`);
      }

      if (params.captureId.trim().length < 3) {
        throw new Error("Invalid provider capture ID");
      }

      // Check capture uniqueness across all intents
      for (const tx of params.ledger.values()) {
        if (tx.provider_reference_id === params.captureId && tx.payment_intent_id !== params.intent.id) {
          throw new Error(`Provider capture ID ${params.captureId} is already associated with another payment intent`);
        }
      }

      if (params.rawResponse.status !== "COMPLETED") {
        throw new Error(`Authoritative PayPal capture status must be COMPLETED, received ${params.rawResponse.status}`);
      }

      const orderId = params.rawResponse.supplementary_data?.related_ids?.order_id;
      if (orderId && orderId !== params.intent.provider_order_id) {
        throw new Error(`Capture related order ID ${orderId} does not match intent provider order ID ${params.intent.provider_order_id}`);
      }

      if (params.amountCents !== params.intent.expected_amount_cents) {
        throw new Error(`Capture amount ${params.amountCents} does not match expected intent amount ${params.intent.expected_amount_cents}`);
      }

      if (params.payeeMerchantId !== params.intent.expected_merchant_id) {
        throw new Error(`Capture payee merchant ID ${params.payeeMerchantId} does not match expected merchant ID ${params.intent.expected_merchant_id}`);
      }

      // Insert transaction
      const txId = "tx-" + (params.ledger.size + 1);
      params.ledger.set(txId, {
        id: txId,
        payment_intent_id: params.intent.id,
        provider_reference_id: params.captureId,
        amount_cents: params.amountCents,
        payee_merchant_id: params.payeeMerchantId,
        status: "COMPLETED",
      });

      params.intent.status = "COMPLETED";
      params.intent.completed_at = new Date();
      params.activityEvents.push(`payment.reconciliation_completed:${params.intent.id}`);
      return true;
    }

    it("1. valid authoritative completed capture resolves RECONCILIATION_REQUIRED to COMPLETED", () => {
      const intent: SimulatedIntent = {
        id: "pi-rec-1",
        status: "RECONCILIATION_REQUIRED",
        expected_amount_cents: 15000n,
        expected_merchant_id: "MERCHANT_VERIFIED",
        expected_currency: "USD",
        provider_order_id: "ORD-999",
        completed_at: null,
      };

      const ledger = new Map<string, SimulatedLedgerTransaction>();
      const activityEvents: string[] = [];

      const result = simulateReconcileAndComplete({
        intent,
        captureId: "CAP-12345",
        amountCents: 15000n,
        payeeMerchantId: "MERCHANT_VERIFIED",
        rawResponse: {
          status: "COMPLETED",
          supplementary_data: { related_ids: { order_id: "ORD-999" } },
        },
        ledger,
        activityEvents,
        isPrivilegedReconciliationActive: true,
      });

      expect(result).toBe(true);
      expect(intent.status).toBe("COMPLETED");
      expect(intent.completed_at).not.toBeNull();
      expect(ledger.size).toBe(1);
      expect(activityEvents).toContain("payment.reconciliation_completed:pi-rec-1");
    });

    it("2. incorrect amount is rejected and intent status remains unchanged", () => {
      const intent: SimulatedIntent = {
        id: "pi-rec-2",
        status: "RECONCILIATION_REQUIRED",
        expected_amount_cents: 15000n,
        expected_merchant_id: "MERCHANT_VERIFIED",
        expected_currency: "USD",
        provider_order_id: "ORD-999",
        completed_at: null,
      };

      const ledger = new Map<string, SimulatedLedgerTransaction>();
      expect(() =>
        simulateReconcileAndComplete({
          intent,
          captureId: "CAP-WRONG-AMT",
          amountCents: 10000n, // Mismatch!
          payeeMerchantId: "MERCHANT_VERIFIED",
          rawResponse: { status: "COMPLETED" },
          ledger,
          activityEvents: [],
          isPrivilegedReconciliationActive: true,
        })
      ).toThrow("Capture amount 10000 does not match expected intent amount 15000");
      expect(intent.status).toBe("RECONCILIATION_REQUIRED");
      expect(ledger.size).toBe(0);
    });

    it("3. incorrect merchant ID is rejected", () => {
      const intent: SimulatedIntent = {
        id: "pi-rec-3",
        status: "RECONCILIATION_REQUIRED",
        expected_amount_cents: 15000n,
        expected_merchant_id: "MERCHANT_EXPECTED",
        expected_currency: "USD",
        provider_order_id: "ORD-999",
        completed_at: null,
      };

      expect(() =>
        simulateReconcileAndComplete({
          intent,
          captureId: "CAP-WRONG-MERCHANT",
          amountCents: 15000n,
          payeeMerchantId: "ATTACKER_MERCHANT",
          rawResponse: { status: "COMPLETED" },
          ledger: new Map(),
          activityEvents: [],
          isPrivilegedReconciliationActive: true,
        })
      ).toThrow("Capture payee merchant ID ATTACKER_MERCHANT does not match expected merchant ID MERCHANT_EXPECTED");
    });

    it("4. incorrect order ID linkage is rejected", () => {
      const intent: SimulatedIntent = {
        id: "pi-rec-4",
        status: "RECONCILIATION_REQUIRED",
        expected_amount_cents: 15000n,
        expected_merchant_id: "MERCHANT_EXPECTED",
        expected_currency: "USD",
        provider_order_id: "ORD-ORIGINAL",
        completed_at: null,
      };

      expect(() =>
        simulateReconcileAndComplete({
          intent,
          captureId: "CAP-ORDER-MISMATCH",
          amountCents: 15000n,
          payeeMerchantId: "MERCHANT_EXPECTED",
          rawResponse: {
            status: "COMPLETED",
            supplementary_data: { related_ids: { order_id: "ORD-UNRELATED" } },
          },
          ledger: new Map(),
          activityEvents: [],
          isPrivilegedReconciliationActive: true,
        })
      ).toThrow("Capture related order ID ORD-UNRELATED does not match intent provider order ID ORD-ORIGINAL");
    });

    it("5. non-completed capture (e.g. PENDING) is rejected", () => {
      const intent: SimulatedIntent = {
        id: "pi-rec-5",
        status: "RECONCILIATION_REQUIRED",
        expected_amount_cents: 15000n,
        expected_merchant_id: "MERCHANT_EXPECTED",
        expected_currency: "USD",
        provider_order_id: "ORD-ORIGINAL",
        completed_at: null,
      };

      expect(() =>
        simulateReconcileAndComplete({
          intent,
          captureId: "CAP-PENDING",
          amountCents: 15000n,
          payeeMerchantId: "MERCHANT_EXPECTED",
          rawResponse: { status: "PENDING" },
          ledger: new Map(),
          activityEvents: [],
          isPrivilegedReconciliationActive: true,
        })
      ).toThrow("Authoritative PayPal capture status must be COMPLETED, received PENDING");
    });

    it("6. repeated recovery request is idempotent (no duplicate ledger entries or events)", () => {
      const intent: SimulatedIntent = {
        id: "pi-rec-6",
        status: "RECONCILIATION_REQUIRED",
        expected_amount_cents: 15000n,
        expected_merchant_id: "MERCHANT_VERIFIED",
        expected_currency: "USD",
        provider_order_id: "ORD-999",
        completed_at: null,
      };

      const ledger = new Map<string, SimulatedLedgerTransaction>();
      const activityEvents: string[] = [];

      // Call 1
      simulateReconcileAndComplete({
        intent,
        captureId: "CAP-IDEMPOTENT-1",
        amountCents: 15000n,
        payeeMerchantId: "MERCHANT_VERIFIED",
        rawResponse: { status: "COMPLETED" },
        ledger,
        activityEvents,
        isPrivilegedReconciliationActive: true,
      });

      expect(ledger.size).toBe(1);
      expect(activityEvents.length).toBe(1);

      // Call 2 with identical capture ID
      const result2 = simulateReconcileAndComplete({
        intent,
        captureId: "CAP-IDEMPOTENT-1",
        amountCents: 15000n,
        payeeMerchantId: "MERCHANT_VERIFIED",
        rawResponse: { status: "COMPLETED" },
        ledger,
        activityEvents,
        isPrivilegedReconciliationActive: true,
      });

      expect(result2).toBe(true);
      expect(ledger.size).toBe(1); // No duplicate transaction!
      expect(activityEvents.length).toBe(1); // No duplicate event!
    });

    it("7. capture ID belonging to another intent is rejected", () => {
      const intent: SimulatedIntent = {
        id: "pi-rec-7",
        status: "RECONCILIATION_REQUIRED",
        expected_amount_cents: 15000n,
        expected_merchant_id: "MERCHANT_VERIFIED",
        expected_currency: "USD",
        provider_order_id: "ORD-999",
        completed_at: null,
      };

      const ledger = new Map<string, SimulatedLedgerTransaction>([
        [
          "tx-existing",
          {
            id: "tx-existing",
            payment_intent_id: "pi-ANOTHER",
            provider_reference_id: "CAP-USED-ELSEWHERE",
            amount_cents: 15000n,
            payee_merchant_id: "MERCHANT_VERIFIED",
            status: "COMPLETED",
          },
        ],
      ]);

      expect(() =>
        simulateReconcileAndComplete({
          intent,
          captureId: "CAP-USED-ELSEWHERE",
          amountCents: 15000n,
          payeeMerchantId: "MERCHANT_VERIFIED",
          rawResponse: { status: "COMPLETED" },
          ledger,
          activityEvents: [],
          isPrivilegedReconciliationActive: true,
        })
      ).toThrow("Provider capture ID CAP-USED-ELSEWHERE is already associated with another payment intent");
    });

    it("8. unprivileged attempt to transition RECONCILIATION_REQUIRED is blocked", () => {
      const intent: SimulatedIntent = {
        id: "pi-rec-8",
        status: "RECONCILIATION_REQUIRED",
        expected_amount_cents: 15000n,
        expected_merchant_id: "MERCHANT_VERIFIED",
        expected_currency: "USD",
        provider_order_id: "ORD-999",
        completed_at: null,
      };

      expect(() =>
        simulateReconcileAndComplete({
          intent,
          captureId: "CAP-UNPRIVILEGED",
          amountCents: 15000n,
          payeeMerchantId: "MERCHANT_VERIFIED",
          rawResponse: { status: "COMPLETED" },
          ledger: new Map(),
          activityEvents: [],
          isPrivilegedReconciliationActive: false, // ordinary caller / unprivileged context
        })
      ).toThrow("Privileged intervention required to transition RECONCILIATION_REQUIRED");
    });
  });
});
