import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/app/payments/recovery/route";
import {
  validateOperatorCsrf,
  generateOperatorCsrfSecret,
  getOperatorCsrfCookieName,
  getOperatorCsrfCookieOptions,
} from "@/lib/security/operator-csrf";

// ----------------------------------------------------------------------------
// Mocks for Route & Service Testing
// ----------------------------------------------------------------------------

const validUserId = "11111111-1111-4111-a111-111111111111";
const otherUserId = "22222222-2222-4222-a222-222222222222";
const validProjectId = "33333333-3333-4333-a333-333333333333";
const otherProjectId = "44444444-4444-4444-a444-444444444444";
const validMilestoneId = "55555555-5555-4555-a555-555555555555";
const validIntentId = "66666666-6666-4666-a666-666666666666";
const validWebhookEventId = "77777777-7777-4777-a777-777777777777";

const mockGetUser = vi.fn();
const mockRateLimit = vi.fn();
const mockRpc = vi.fn();
const mockServiceRpc = vi.fn();
const mockFrom = vi.fn();
const mockServiceFrom = vi.fn();
const mockReconcilePaymentIntentServerSide = vi.fn();
const mockPayPalGet = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
    },
    from: mockFrom,
    rpc: mockRpc,
  })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => ({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
  })),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: vi.fn(async (...args: unknown[]) => mockRateLimit(...args)),
}));

vi.mock("@/lib/paypal/reconciliation-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/lib/paypal/reconciliation-service"
  );
  return {
    ...actual,
    reconcilePaymentIntentServerSide: vi.fn(async (...args: unknown[]) =>
      mockReconcilePaymentIntentServerSide(...args)
    ),
  };
});

vi.mock("@/lib/paypal/client", () => ({
  PayPalClient: class {
    get(...args: unknown[]) {
      return mockPayPalGet(...args);
    }
  },
}));

vi.mock("@/lib/paypal/env", () => ({
  getPayPalServerEnv: vi.fn(() => ({
    clientId: "sandbox-client-id",
    clientSecret: "sandbox-client-secret",
    expectedMerchantId: "SANDBOX-MERCHANT-01",
    paymentMode: "MERCHANT",
    mode: "sandbox",
  })),
}));

// ----------------------------------------------------------------------------
// 1. Static SQL & Migration Analysis Tests
// ----------------------------------------------------------------------------

describe("Phase 3B.4.4: Static SQL Migration Analysis (202611100001)", () => {
  const migrationPath = join(
    process.cwd(),
    "supabase/migrations/202611100001_payment_operations_and_recovery.sql"
  );
  const sql = readFileSync(migrationPath, "utf-8");

  it("1. drops obsolete overloads of admin recovery functions", () => {
    expect(sql).toMatch(/drop\s+function\s+if\s+exists\s+public\.admin_mark_intent_reconciliation_required/i);
    expect(sql).toMatch(/drop\s+function\s+if\s+exists\s+public\.admin_clear_expired_lease/i);
  });

  it("2. hardens protect_payment_intent_immutability to allow ORDER_CREATED and BUYER_APPROVED -> RECONCILIATION_REQUIRED", () => {
    expect(sql).toMatch(/old\.status\s*=\s*'ORDER_CREATED'\s+and\s+new\.status\s+not\s+in\s*\([^)]*'RECONCILIATION_REQUIRED'/i);
    expect(sql).toMatch(/old\.status\s*=\s*'BUYER_APPROVED'\s+and\s+new\.status\s+not\s+in\s*\([^)]*'RECONCILIATION_REQUIRED'/i);
  });

  it("3. preserves terminal state protection in protect_payment_intent_immutability", () => {
    expect(sql).toMatch(/old\.status\s+in\s*\('COMPLETED',\s*'FAILED',\s*'CANCELLED'\)/i);
    expect(sql).toMatch(/Terminal\s+payment\s+intent\s+state\s+%\s+cannot\s+transition\s+to\s+%/i);
  });

  it("4. defines admin_mark_intent_reconciliation_required with dual-layer service_role assertion and json claims fallback", () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.admin_mark_intent_reconciliation_required/i);
    expect(sql).toMatch(/(coalesce\()?current_setting\('request\.jwt\.claim\.role',\s*true\)/i);
    expect(sql).toMatch(/current_setting\('request\.jwt\.claims',\s*true\)/i);
    expect(sql).toMatch(/\(current_setting\('request\.jwt\.claims',\s*true\)::jsonb\s*->>\s*'role'\)\s*=\s*'service_role'/i);
  });

  it("5. rejects active unexpired worker leases in admin_mark_intent_reconciliation_required", () => {
    expect(sql).toMatch(/v_intent\.order_creation_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
    expect(sql).toMatch(/v_intent\.capture_lease_expires_at\s*>\s*clock_timestamp\(\)/i);
    expect(sql).toMatch(/'LEASE_ACTIVE'/i);
  });

  it("6. inserts durable activity_events audit log in admin_mark_intent_reconciliation_required", () => {
    expect(sql).toMatch(/insert\s+into\s+public\.activity_events/i);
    expect(sql).toMatch(/'payment\.marked_reconciliation_required'/i);
  });

  it("7. defines admin_clear_expired_lease with expiry verification against clock_timestamp()", () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.admin_clear_expired_lease/i);
    expect(sql).toMatch(/order_creation_lease_expires_at\s*<=\s*clock_timestamp\(\)/i);
    expect(sql).toMatch(/capture_lease_expires_at\s*<=\s*clock_timestamp\(\)/i);
    expect(sql).toMatch(/'NO_EXPIRED_LEASE_FOUND'/i);
  });

  it("8. revokes public/anon/authenticated execution and grants only service_role", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.admin_mark_intent_reconciliation_required.*from\s+public,\s*anon,\s*authenticated/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.admin_mark_intent_reconciliation_required.*to\s+service_role/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.admin_clear_expired_lease.*from\s+public,\s*anon,\s*authenticated/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.admin_clear_expired_lease.*to\s+service_role/i);
  });
});

describe("Phase 3B.4.4.1: Remediation SQL Migration Analysis (202611100002)", () => {
  const remediationPath = join(
    process.cwd(),
    "supabase/migrations/202611100002_remediation_recovery_hardening.sql"
  );
  const sql = readFileSync(remediationPath, "utf-8");

  it("1. adds signature_verified column to public.provider_webhook_events with index", () => {
    expect(sql).toMatch(/alter\s+table\s+public\.provider_webhook_events\s+add\s+column\s+if\s+not\s+exists\s+signature_verified\s+boolean\s+not\s+null\s+default\s+false/i);
    expect(sql).toMatch(/create\s+index\s+if\s+not\s+exists\s+provider_webhook_events_verification_idx/i);
  });

  it("2. removes MANUAL_OPERATOR_VERIFICATION evidence type from admin_resolve_reconciliation_without_payment (AUDIT-3B44-01)", () => {
    // Must strictly allow only provider evidence types
    expect(sql).toMatch(/v_evidence_type\s+not\s+in\s*\('ORDER_NOT_FOUND_ON_PROVIDER',\s*'ORDER_VERIFIED_INACTIVE'\)/i);
    expect(sql).not.toMatch(/'MANUAL_OPERATOR_VERIFICATION'/);
  });

  it("3. preserves completed-capture guard in admin_resolve_reconciliation_without_payment", () => {
    expect(sql).toMatch(/pt\.transaction_type\s*=\s*'CAPTURE'/i);
    expect(sql).toMatch(/pt\.status\s*=\s*'COMPLETED'/i);
    expect(sql).toMatch(/'COMPLETED_CAPTURE_EXISTS'/i);
  });

  it("4. defines admin_reprocess_webhook_event with dual-layer service_role check and claims fallback", () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.admin_reprocess_webhook_event/i);
    expect(sql).toMatch(/(coalesce\()?current_setting\('request\.jwt\.claim\.role',\s*true\)/i);
    expect(sql).toMatch(/current_setting\('request\.jwt\.claims',\s*true\)/i);
  });

  it("5. enforces signature verification guard in admin_reprocess_webhook_event (fail-closed)", () => {
    expect(sql).toMatch(/if\s+not\s+v_event\.signature_verified\s+then/i);
    expect(sql).toMatch(/'UNVERIFIED_WEBHOOK_EVENT'/i);
  });

  it("6. commits webhook status update and activity_events audit log atomically in admin_reprocess_webhook_event (AUDIT-3B44-04)", () => {
    expect(sql).toMatch(/update\s+public\.provider_webhook_events/i);
    expect(sql).toMatch(/insert\s+into\s+public\.activity_events/i);
    expect(sql).toMatch(/'payment\.webhook_reprocessed'/i);
  });

  it("7. revokes public/anon/authenticated and grants only service_role on admin_reprocess_webhook_event", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.admin_reprocess_webhook_event.*from\s+public,\s*anon,\s*authenticated/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.admin_reprocess_webhook_event.*to\s+service_role/i);
  });
});

// ----------------------------------------------------------------------------
// 2. Operator CSRF Security Tests
// ----------------------------------------------------------------------------

describe("Phase 3B.4.4: Operator CSRF Protection", () => {
  it("generates a 64-character high-entropy hex CSRF secret", () => {
    const secret = generateOperatorCsrfSecret();
    expect(secret).toHaveLength(64);
    expect(secret).toMatch(/^[0-9a-f]{64}$/i);
  });

  it("uses environment-appropriate cookie names", () => {
    const devCookieName = getOperatorCsrfCookieName();
    expect(devCookieName).toBe("payroost_operator_csrf");
  });

  it("validates cookie options", () => {
    const opts = getOperatorCsrfCookieOptions();
    expect(opts.httpOnly).toBe(false);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(43200);
  });

  it("rejects request when x-csrf-token header is missing", async () => {
    const req = new Request("http://localhost:3000/api/app/payments/recovery", {
      method: "POST",
      headers: {
        cookie: `payroost_operator_csrf=${generateOperatorCsrfSecret()}`,
      },
    });

    const result = await validateOperatorCsrf(req);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("MISSING_HEADER");
  });

  it("rejects request when CSRF cookie is missing", async () => {
    const secret = generateOperatorCsrfSecret();
    const req = new Request("http://localhost:3000/api/app/payments/recovery", {
      method: "POST",
      headers: {
        "x-csrf-token": secret,
      },
    });

    const result = await validateOperatorCsrf(req);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("MISSING_COOKIE");
  });

  it("rejects request when submitted token does not match cookie", async () => {
    const secret = generateOperatorCsrfSecret();
    const wrongSecret = generateOperatorCsrfSecret();
    const req = new Request("http://localhost:3000/api/app/payments/recovery", {
      method: "POST",
      headers: {
        "x-csrf-token": wrongSecret,
        cookie: `payroost_operator_csrf=${secret}`,
      },
    });

    const result = await validateOperatorCsrf(req);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("CSRF_MISMATCH");
  });

  it("accepts request when x-csrf-token matches cookie exactly", async () => {
    const secret = generateOperatorCsrfSecret();
    const req = new Request("http://localhost:3000/api/app/payments/recovery", {
      method: "POST",
      headers: {
        "x-csrf-token": secret,
        cookie: `payroost_operator_csrf=${secret}`,
        origin: "http://localhost:3000",
      },
    });

    const result = await validateOperatorCsrf(req);
    expect(result.valid).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// 3. Operator Authorization & Route Tests
// ----------------------------------------------------------------------------

describe("Phase 3B.4.4.1: Operator Recovery API Route & Remediation", () => {
  const csrfSecret = generateOperatorCsrfSecret();

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetUser.mockResolvedValue({
      data: {
        user: { id: validUserId, email: "owner@example.com" },
      },
      error: null,
    });

    mockRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 29,
      status: "allowed",
    });

    // Default mockFrom for payment_intents
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: validIntentId,
              project_id: validProjectId,
              milestone_id: validMilestoneId,
              status: "RECONCILIATION_REQUIRED",
              provider_order_id: "8A123456BC789012D",
              order_idempotency_key: "77777777-7777-4777-a777-777777777777",
              capture_idempotency_key: "88888888-8888-4888-a888-888888888888",
              order_creation_lease_expires_at: null,
              capture_lease_expires_at: null,
              expected_merchant_id: "SANDBOX-MERCHANT-01",
              expected_amount_canonical: "1500.00",
              expected_amount_cents: 150000,
              created_at: new Date().toISOString(),
              projects: { id: validProjectId, owner_id: validUserId },
            },
            error: null,
          }),
        }),
      }),
    });

    mockServiceFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    });
  });

  function makeRequest(body: unknown, customHeaders?: Record<string, string>) {
    return new NextRequest("http://localhost:3000/api/app/payments/recovery", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
        cookie: `payroost_operator_csrf=${csrfSecret}`,
        origin: "http://localhost:3000",
        ...customHeaders,
      },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 UNAUTHORIZED when caller session is unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error("No session") });

    const req = makeRequest({ intentId: validIntentId, action: "RECONCILE" });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 INVALID_CSRF_TOKEN when CSRF header is invalid", async () => {
    const req = makeRequest(
      { intentId: validIntentId, action: "RECONCILE" },
      { "x-csrf-token": "invalid-token" }
    );
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("INVALID_CSRF_TOKEN");
  });

  it("returns 429 RATE_LIMITED when operator rate limit is exceeded", async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, remaining: 0, status: "rate_limited" });

    const req = makeRequest({ intentId: validIntentId, action: "RECONCILE" });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toBe("RATE_LIMITED");
  });

  it("returns 400 VALIDATION_ERROR on malformed or extraneous payload fields", async () => {
    const req = makeRequest({
      intentId: validIntentId,
      action: "RECONCILE",
      unknownField: "malicious",
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 404 NOT_FOUND_OR_FORBIDDEN when payment intent does not exist", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    });

    const req = makeRequest({ intentId: validIntentId, action: "RECONCILE" });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe("NOT_FOUND_OR_FORBIDDEN");
  });

  it("returns 403 FORBIDDEN when authenticated user is NOT the project owner (Cross-Project Protection)", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: validIntentId,
              project_id: otherProjectId,
              projects: { id: otherProjectId, owner_id: otherUserId },
            },
            error: null,
          }),
        }),
      }),
    });

    const req = makeRequest({ intentId: validIntentId, action: "RECONCILE" });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  // ==========================================================================
  // AUDIT-3B44-01: Ghost-Order Cancellation & Financial Verification
  // ==========================================================================

  describe("AUDIT-3B44-01: Ghost-Order Cancellation Remediation", () => {
    it("rejects CANCEL_INACTIVE on ghost order (null provider_order_id) even when caller provides support ticket notes", async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validIntentId,
                project_id: validProjectId,
                status: "RECONCILIATION_REQUIRED",
                provider_order_id: null, // Ghost order!
                created_at: new Date(Date.now() - 3600_000).toISOString(), // 1h ago
                projects: { id: validProjectId, owner_id: validUserId },
              },
              error: null,
            }),
          }),
        }),
      });

      // Mock reconciliation replay returning inconclusive/failure
      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: false,
        intentId: validIntentId,
        previousStatus: "RECONCILIATION_REQUIRED",
        resultingStatus: "RECONCILIATION_REQUIRED",
        providerOrderId: null,
        recovered: false,
        reason: "PROVIDER_REPLAY_INCONCLUSIVE",
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "CANCEL_INACTIVE",
        notes: "Support Ticket #12345: User requested cancellation",
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.error).toBe("CANNOT_CANCEL_UNVERIFIED_GHOST_ORDER");
      // Must NOT invoke admin_resolve_reconciliation_without_payment!
      expect(mockServiceRpc).not.toHaveBeenCalledWith("admin_resolve_reconciliation_without_payment", expect.anything());
    });

    it("rejects CANCEL_INACTIVE when idempotency replay recovers and binds the original order", async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validIntentId,
                project_id: validProjectId,
                status: "RECONCILIATION_REQUIRED",
                provider_order_id: null,
                created_at: new Date(Date.now() - 3600_000).toISOString(),
                projects: { id: validProjectId, owner_id: validUserId },
              },
              error: null,
            }),
          }),
        }),
      });

      // Replay succeeded in recovering order!
      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: true,
        intentId: validIntentId,
        previousStatus: "RECONCILIATION_REQUIRED",
        resultingStatus: "ORDER_CREATED",
        providerOrderId: "8A123456BC789012D",
        recovered: true,
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "CANCEL_INACTIVE",
        notes: "Cancel attempt",
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.error).toBe("CANNOT_CANCEL_RECOVERED_ORDER");
    });

    it("rejects CANCEL_INACTIVE on ghost order when 5-hour automated retry cutoff has expired", async () => {
      const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString();

      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validIntentId,
                project_id: validProjectId,
                status: "RECONCILIATION_REQUIRED",
                provider_order_id: null,
                created_at: sixHoursAgo, // > 5h cutoff!
                projects: { id: validProjectId, owner_id: validUserId },
              },
              error: null,
            }),
          }),
        }),
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "CANCEL_INACTIVE",
        notes: "Cancel stale ghost order",
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.error).toBe("IDEMPOTENCY_RETENTION_EXPIRED_MANUAL_ESCALATION_REQUIRED");
      // Must NOT attempt replay or cancellation
      expect(mockReconcilePaymentIntentServerSide).not.toHaveBeenCalled();
    });

    it("rejects CANCEL_INACTIVE when completed capture exists on the ledger", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: "tx-completed-001" },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      });

      const req = makeRequest({ intentId: validIntentId, action: "CANCEL_INACTIVE" });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.error).toBe("COMPLETED_CAPTURE_EXISTS");
    });

    it("permits CANCEL_INACTIVE when PayPal inquiry confirms order is VOIDED on provider", async () => {
      mockPayPalGet.mockResolvedValue({
        data: {
          id: "8A123456BC789012D",
          status: "VOIDED",
        },
      });

      mockServiceRpc.mockResolvedValue({
        data: { success: true, status: "CANCELLED" },
        error: null,
      });

      const req = makeRequest({ intentId: validIntentId, action: "CANCEL_INACTIVE", notes: "Order voided" });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.resultingStatus).toBe("CANCELLED");
      expect(mockServiceRpc).toHaveBeenCalledWith("admin_resolve_reconciliation_without_payment", expect.objectContaining({
        p_intent_id: validIntentId,
        p_target_status: "CANCELLED",
        p_reason_code: "PAYPAL_ORDER_VOIDED",
        p_evidence: expect.objectContaining({
          evidence_type: "ORDER_VERIFIED_INACTIVE",
          order_id: "8A123456BC789012D",
          paypal_order_status: "VOIDED",
        }),
      }));
    });
  });

  // ==========================================================================
  // AUDIT-3B44-02: Webhook Reprocessing Hardening
  // ==========================================================================

  describe("AUDIT-3B44-02: Webhook Reprocessing Remediation", () => {
    it("rejects REPROCESS_WEBHOOK when webhookEventId is missing", async () => {
      const req = makeRequest({ intentId: validIntentId, action: "REPROCESS_WEBHOOK" });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe("MISSING_WEBHOOK_EVENT_ID");
    });

    it("rejects REPROCESS_WEBHOOK when webhook event is not found", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: validWebhookEventId,
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.error).toBe("WEBHOOK_EVENT_NOT_FOUND");
    });

    it("rejects unverified webhook event (signature_verified = false) with 422 UNVERIFIED_WEBHOOK_EVENT", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validWebhookEventId,
                provider_event_id: "WH-12345",
                event_type: "CHECKOUT.ORDER.APPROVED",
                status: "RECEIVED",
                signature_verified: false, // Unverified!
                payload: { resource: { id: "8A123456BC789012D" } },
              },
              error: null,
            }),
          }),
        }),
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: validWebhookEventId,
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(422);
      expect(json.error).toBe("UNVERIFIED_WEBHOOK_EVENT");
      expect(mockReconcilePaymentIntentServerSide).not.toHaveBeenCalled();
    });

    it("returns idempotent duplicate response when webhook event is already PROCESSED", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validWebhookEventId,
                provider_event_id: "WH-12345",
                event_type: "CHECKOUT.ORDER.APPROVED",
                status: "PROCESSED", // Already processed!
                signature_verified: true,
                payload: { resource: { id: "8A123456BC789012D", custom_id: validIntentId } },
              },
              error: null,
            }),
          }),
        }),
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: validWebhookEventId,
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.alreadyProcessed).toBe(true);
      expect(mockReconcilePaymentIntentServerSide).not.toHaveBeenCalled();
    });

    it("rejects webhook event when custom_id points to a different intent (AUDIT-3B44-02 Cross-Intent)", async () => {
      const differentIntentId = "99999999-9999-4999-a999-999999999999";

      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validWebhookEventId,
                provider_event_id: "WH-CROSS-INTENT",
                event_type: "CHECKOUT.ORDER.APPROVED",
                status: "RECEIVED",
                signature_verified: true,
                payload: {
                  resource: {
                    id: "8A123456BC789012D",
                    custom_id: differentIntentId, // Different intent!
                  },
                },
              },
              error: null,
            }),
          }),
        }),
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: validWebhookEventId,
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toBe("WEBHOOK_INTENT_MISMATCH");
      expect(mockReconcilePaymentIntentServerSide).not.toHaveBeenCalled();
    });

    it("rejects webhook event when resource ID does not match intent provider_order_id", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validWebhookEventId,
                provider_event_id: "WH-MISMATCH-ORDER",
                event_type: "CHECKOUT.ORDER.APPROVED",
                status: "RECEIVED",
                signature_verified: true,
                payload: {
                  resource: {
                    id: "DIFFERENT-ORDER-ID-999", // Unrelated order!
                  },
                },
              },
              error: null,
            }),
          }),
        }),
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: validWebhookEventId,
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toBe("WEBHOOK_INTENT_MISMATCH");
    });

    it("marks webhook event FAILED when reconciliation fails (never marks PROCESSED prematurely)", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validWebhookEventId,
                provider_event_id: "WH-RECON-FAIL",
                event_type: "PAYMENT.CAPTURE.COMPLETED",
                status: "RECEIVED",
                signature_verified: true,
                payload: {
                  resource: {
                    id: "CAP-001",
                    custom_id: validIntentId,
                  },
                },
              },
              error: null,
            }),
          }),
        }),
      });

      // Reconciliation fails
      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: false,
        intentId: validIntentId,
        previousStatus: "RECONCILIATION_REQUIRED",
        resultingStatus: "RECONCILIATION_REQUIRED",
        providerOrderId: "8A123456BC789012D",
        recovered: false,
        error: "PROVIDER_INQUIRY_FAILED",
      });

      mockServiceRpc.mockResolvedValue({
        data: { success: true, status: "FAILED" },
        error: null,
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: validWebhookEventId,
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.error).toBe("PROVIDER_INQUIRY_FAILED");

      // Verify atomic RPC was called with status FAILED, NOT PROCESSED!
      expect(mockServiceRpc).toHaveBeenCalledWith("admin_reprocess_webhook_event", expect.objectContaining({
        p_webhook_event_id: validWebhookEventId,
        p_payment_intent_id: validIntentId,
        p_status: "FAILED",
        p_actor: "owner@example.com",
      }));
    });

    it("marks webhook event PROCESSED via atomic RPC when reconciliation successfully completes", async () => {
      mockServiceFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validWebhookEventId,
                provider_event_id: "WH-SUCCESS",
                event_type: "PAYMENT.CAPTURE.COMPLETED",
                status: "RECEIVED",
                signature_verified: true,
                payload: {
                  resource: {
                    id: "CAP-001",
                    custom_id: validIntentId,
                  },
                },
              },
              error: null,
            }),
          }),
        }),
      });

      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: true,
        intentId: validIntentId,
        previousStatus: "RECONCILIATION_REQUIRED",
        resultingStatus: "COMPLETED",
        providerOrderId: "8A123456BC789012D",
        recovered: true,
      });

      mockServiceRpc.mockResolvedValue({
        data: { success: true, status: "PROCESSED" },
        error: null,
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: validWebhookEventId,
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.resultingStatus).toBe("COMPLETED");

      // Verify atomic RPC was called with status PROCESSED
      expect(mockServiceRpc).toHaveBeenCalledWith("admin_reprocess_webhook_event", expect.objectContaining({
        p_webhook_event_id: validWebhookEventId,
        p_payment_intent_id: validIntentId,
        p_status: "PROCESSED",
        p_actor: "owner@example.com",
      }));
    });
  });

  // ==========================================================================
  // AUDIT-3B44-03: Expired Lease Recovery Hardening
  // ==========================================================================

  describe("AUDIT-3B44-03: CLEAR_EXPIRED_LEASE Remediation", () => {
    it("returns immediate 200 success when CAPTURING intent is reconciled to ORDER_CREATED (no false 409)", async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();

      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validIntentId,
                project_id: validProjectId,
                status: "CAPTURING",
                capture_lease_expires_at: pastDate, // Expired lease!
                projects: { id: validProjectId, owner_id: validUserId },
              },
              error: null,
            }),
          }),
        }),
      });

      // Reconciliation recovers order back to ORDER_CREATED
      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: true,
        intentId: validIntentId,
        previousStatus: "CAPTURING",
        resultingStatus: "ORDER_CREATED",
        providerOrderId: "8A123456BC789012D",
        recovered: true,
      });

      const req = makeRequest({ intentId: validIntentId, action: "CLEAR_EXPIRED_LEASE" });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.resultingStatus).toBe("ORDER_CREATED");
      expect(json.recovered).toBe(true);
      // Must NOT invoke admin_clear_expired_lease afterwards since lease was already cleared!
      expect(mockServiceRpc).not.toHaveBeenCalledWith("admin_clear_expired_lease", expect.anything());
    });

    it("returns immediate 200 success when CAPTURING intent is reconciled to COMPLETED", async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();

      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validIntentId,
                project_id: validProjectId,
                status: "CAPTURING",
                capture_lease_expires_at: pastDate,
                projects: { id: validProjectId, owner_id: validUserId },
              },
              error: null,
            }),
          }),
        }),
      });

      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: true,
        intentId: validIntentId,
        previousStatus: "CAPTURING",
        resultingStatus: "COMPLETED",
        providerOrderId: "8A123456BC789012D",
        recovered: true,
      });

      const req = makeRequest({ intentId: validIntentId, action: "CLEAR_EXPIRED_LEASE" });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.resultingStatus).toBe("COMPLETED");
      expect(mockServiceRpc).not.toHaveBeenCalledWith("admin_clear_expired_lease", expect.anything());
    });

    it("returns truthful 409 error when reconciliation fails during CLEAR_EXPIRED_LEASE on CAPTURING intent", async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();

      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: validIntentId,
                project_id: validProjectId,
                status: "CAPTURING",
                capture_lease_expires_at: pastDate,
                projects: { id: validProjectId, owner_id: validUserId },
              },
              error: null,
            }),
          }),
        }),
      });

      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: false,
        intentId: validIntentId,
        previousStatus: "CAPTURING",
        resultingStatus: "CAPTURING",
        providerOrderId: "8A123456BC789012D",
        recovered: false,
        error: "PROVIDER_TIMEOUT",
      });

      const req = makeRequest({ intentId: validIntentId, action: "CLEAR_EXPIRED_LEASE" });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.error).toBe("PROVIDER_TIMEOUT");
    });
  });

  // ==========================================================================
  // AUDIT-3B44-04: Audit Logging Reliability & Error Propagation
  // ==========================================================================

  describe("AUDIT-3B44-04: Activity Audit Logging Reliability", () => {
    it("fails closed with 500 AUDIT_LOGGING_FAILED if activity_events insert fails during RECONCILE", async () => {
      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: true,
        intentId: validIntentId,
        previousStatus: "RECONCILIATION_REQUIRED",
        resultingStatus: "ORDER_CREATED",
        providerOrderId: "8A123456BC789012D",
        recovered: true,
      });

      // Simulate insert error on activity_events
      mockServiceFrom.mockReturnValue({
        insert: vi.fn().mockResolvedValue({ error: new Error("DB Disk Full") }),
      });

      const req = makeRequest({ intentId: validIntentId, action: "RECONCILE" });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json.error).toBe("AUDIT_LOGGING_FAILED");
    });

    it("derives actor identity from authenticated user context, never trusting caller body", async () => {
      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: true,
        intentId: validIntentId,
        previousStatus: "RECONCILIATION_REQUIRED",
        resultingStatus: "ORDER_CREATED",
        providerOrderId: "8A123456BC789012D",
        recovered: true,
      });

      const insertSpy = vi.fn().mockResolvedValue({ error: null });
      mockServiceFrom.mockReturnValue({
        insert: insertSpy,
      });

      const req = makeRequest({
        intentId: validIntentId,
        action: "RECONCILE",
      });
      await POST(req);

      expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
        actor_label: "owner@example.com", // Authenticated user!
        actor_user_id: validUserId,
      }));
    });
  });
});
