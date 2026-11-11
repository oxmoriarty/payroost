import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  computeRecoveryActionMatrix,
  deriveOperationalWebhookStatus,
  detectPaymentInconsistencies,
  sanitizeOperationalText,
} from "@/features/payments/recovery-actions";

const validUserId = "11111111-1111-4111-a111-111111111111";
const memberUserId = "22222222-2222-4222-a222-222222222222";
const projectId = "33333333-3333-4333-a333-333333333333";
const milestoneId = "55555555-5555-4555-a555-555555555555";
const intentId = "66666666-6666-4666-a666-666666666666";
const otherIntentId = "99999999-9999-4999-a999-999999999999";
const webhookRowId = "77777777-7777-4777-a777-777777777777";

const mockGetUser = vi.fn();
const mockRateLimit = vi.fn();
const mockFrom = vi.fn();
const mockServiceFrom = vi.fn();
const mockServiceRpc = vi.fn();
const mockReconcilePaymentIntentServerSide = vi.fn();
const mockProcessVerifiedWebhook = vi.fn();
const mockRecoverPendingWebhooks = vi.fn();
const mockValidateWebhookConfig = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
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

vi.mock("@/lib/paypal/webhook-processor", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/lib/paypal/webhook-processor"
  );
  return {
    ...actual,
    processVerifiedPayPalWebhookEvent: vi.fn(async (...args: unknown[]) =>
      mockProcessVerifiedWebhook(...args)
    ),
    recoverPendingPayPalWebhookEvents: vi.fn(async (...args: unknown[]) =>
      mockRecoverPendingWebhooks(...args)
    ),
  };
});

vi.mock("@/lib/paypal/payment-mode", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/lib/paypal/payment-mode"
  );
  return {
    ...actual,
    validatePayPalWebhookServerConfig: vi.fn((...args: unknown[]) =>
      mockValidateWebhookConfig(...args)
    ),
  };
});

vi.mock("@/lib/paypal/env", () => ({
  getPayPalServerEnv: vi.fn(() => ({
    clientId: "sandbox-client-id",
    clientSecret: "super-secret-do-not-leak",
    platformClientId: "sandbox-platform-client-id",
    platformClientSecret: "platform-secret-do-not-leak",
    expectedMerchantId: "MERCHANT-LEGACY-01",
    paymentMode: "PLATFORM",
    mode: "sandbox",
    webhookId: "WH-CONFIG-01",
  })),
}));

import { GET as GET_INVESTIGATION } from "@/app/api/app/payments/[intentId]/route";
import { POST as POST_RECOVERY } from "@/app/api/app/payments/recovery/route";
import { POST as POST_INTERNAL_RECOVER } from "@/app/api/internal/payments/recover/route";
import { generateOperatorCsrfSecret } from "@/lib/security/operator-csrf";

describe("Phase 3B.R5: Action Eligibility Matrix, Webhook Statuses & Diagnostics", () => {
  it("distinguishes RETRY_SCHEDULED vs EXHAUSTED webhook statuses cleanly", () => {
    expect(
      deriveOperationalWebhookStatus({
        rawStatus: "RETRY",
        processingOutcome: "VERIFIED",
        attemptCount: 2,
        signatureVerified: true,
      })
    ).toEqual({ status: "RETRY_SCHEDULED", isExhausted: false });

    expect(
      deriveOperationalWebhookStatus({
        rawStatus: "FAILED",
        processingOutcome: "REQUIRES_RECONCILIATION",
        attemptCount: 8,
        signatureVerified: true,
        errorDetails: "MAX_WEBHOOK_ATTEMPTS_EXCEEDED",
      })
    ).toEqual({ status: "EXHAUSTED", isExhausted: true });
  });

  it("redacts sensitive email or auth fragments from operational summaries", () => {
    const cleaned = sanitizeOperationalText(
      "Bearer secret_token_123 for buyer.pii@example.com failed capture"
    );
    expect(cleaned).not.toContain("secret_token_123");
    expect(cleaned).not.toContain("buyer.pii@example.com");
    expect(cleaned).toContain("[redacted]");
    expect(cleaned).toContain("[redacted-email]");
  });

  it("detects ledger vs intent inconsistencies and missing PLATFORM seller_payer_id", () => {
    const warnings = detectPaymentInconsistencies({
      status: "COMPLETED",
      paymentMode: "PLATFORM",
      sellerPayerId: null,
      expectedMerchantId: "SELLER-MERCHANT-99",
      expectedCurrency: "USD",
      expectedAmountCents: 15000,
      providerOrderId: "ORD-123",
      captureId: null,
      hasCompletedCaptureTx: false,
      captureTxCount: 0,
      hasExpiredLease: true,
      webhookStatus: "EXHAUSTED",
      webhookIsExhausted: true,
    });

    expect(warnings.some((w) => w.includes("COMPLETED without a linked COMPLETED CAPTURE"))).toBe(true);
    expect(warnings.some((w) => w.includes("missing canonical seller_payer_id"))).toBe(true);
    expect(warnings.some((w) => w.includes("Processing lease has expired"))).toBe(true);
    expect(warnings.some((w) => w.includes("retry attempts are exhausted"))).toBe(true);
  });

  it("blocks unauthorized/non-owner actions and explains exact precondition failures", () => {
    const recent = new Date().toISOString();
    const matrixMember = computeRecoveryActionMatrix({
      intentId,
      status: "RECONCILIATION_REQUIRED",
      paymentMode: "PLATFORM",
      providerOrderId: null,
      captureId: null,
      hasExpiredLease: false,
      createdAt: recent,
      isOwner: false,
      webhookEventId: null,
      webhookStatus: null,
    });

    expect(matrixMember.every((a) => !a.allowed && Boolean(a.blockedReason))).toBe(true);

    const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString();
    const matrixExpiredReplay = computeRecoveryActionMatrix({
      intentId,
      status: "RECONCILIATION_REQUIRED",
      paymentMode: "MERCHANT",
      providerOrderId: null,
      captureId: null,
      hasExpiredLease: false,
      createdAt: sevenHoursAgo,
      isOwner: true,
      webhookEventId: webhookRowId,
      webhookStatus: "PROCESSED",
      webhookSignatureVerified: true,
    });

    const retryAction = matrixExpiredReplay.find((a) => a.action === "RETRY_ORDER_CREATION");
    const webhookAction = matrixExpiredReplay.find((a) => a.action === "REPROCESS_WEBHOOK");
    expect(retryAction?.allowed).toBe(false);
    expect(retryAction?.blockedReason).toContain("6-hour order idempotency window has expired");
    expect(webhookAction?.allowed).toBe(false);
    expect(webhookAction?.blockedReason).toContain("already PROCESSED");
  });
});

describe("Phase 3B.R5: Payment Investigation API (/api/app/payments/[intentId])", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: validUserId, email: "owner@example.com" } },
      error: null,
    });
    mockRateLimit.mockResolvedValue({ allowed: true, remaining: 59, status: "allowed" });
  });

  it("returns 401 for unauthenticated requests and 400 for invalid intent UUID", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("No session") });
    const unauthRes = await GET_INVESTIGATION(
      new Request(`http://localhost:3000/api/app/payments/${intentId}`),
      { params: Promise.resolve({ intentId }) }
    );
    expect(unauthRes.status).toBe(401);

    const invalidRes = await GET_INVESTIGATION(
      new Request("http://localhost:3000/api/app/payments/not-a-uuid"),
      { params: Promise.resolve({ intentId: "not-a-uuid" }) }
    );
    expect(invalidRes.status).toBe(400);
  });

  it("enforces cross-tenant isolation via RLS (returns 404 when RLS yields null)", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    });

    const res = await GET_INVESTIGATION(
      new Request(`http://localhost:3000/api/app/payments/${intentId}`),
      { params: Promise.resolve({ intentId }) }
    );
    expect(res.status).toBe(404);
  });

  it("correlates PLATFORM intent, transactions, webhooks (blocking cross-intent leaks), seller status, and timeline safely without secrets", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: memberUserId, email: "member@example.com" } },
      error: null,
    });

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: intentId,
              project_id: projectId,
              milestone_id: milestoneId,
              status: "RECONCILIATION_REQUIRED",
              expected_amount_cents: 50000,
              expected_amount_canonical: "500.00",
              expected_currency: "USD",
              expected_merchant_id: "SELLER-MERCHANT-ABC",
              canonical_payload_json: {
                payment_mode: "PLATFORM",
                seller_merchant_id: "SELLER-MERCHANT-ABC",
                seller_payer_id: "SELLER-PAYER-XYZ",
              },
              provider_order_id: "8A123456ORDER",
              order_idempotency_key: "12345678-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
              capture_idempotency_key: "87654321-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
              order_creation_lease_expires_at: null,
              capture_lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
              reconciliation_reason: "CAPTURE_TIMEOUT_BUYER_SECRET_CHECK",
              buyer_approved_at: "2026-11-10T10:00:00.000Z",
              completed_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              projects: { id: projectId, title: "Brand Redesign", owner_id: validUserId },
              milestones: { id: milestoneId, title: "Milestone 1", status: "IN_REVIEW" },
            },
            error: null,
          }),
        }),
      }),
    });

    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "payment_transactions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "provider_webhook_events") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: webhookRowId,
                      provider_event_id: "WH-EVT-001",
                      event_type: "PAYMENT.CAPTURE.COMPLETED",
                      resource_type: "capture",
                      resource_id: "CAP-001",
                      payment_intent_id: intentId,
                      payment_mode: "PLATFORM",
                      processing_outcome: "REQUIRES_RECONCILIATION",
                      status: "FAILED",
                      attempt_count: 8,
                      duplicate_delivery_count: 2,
                      signature_verified: true,
                      error_details: "MAX_WEBHOOK_ATTEMPTS_EXCEEDED buyer@secret.com",
                      last_processed_at: "2026-11-10T10:15:00.000Z",
                      next_attempt_at: null,
                      lease_expires_at: null,
                      created_at: "2026-11-10T10:10:00.000Z",
                    },
                  ],
                  error: null,
                }),
              }),
            }),
            in: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    // Foreign tenant intent matched accidentally by resource_id MUST be excluded!
                    {
                      id: "88888888-8888-4888-a888-888888888888",
                      provider_event_id: "WH-FOREIGN-LEAK",
                      event_type: "PAYMENT.CAPTURE.COMPLETED",
                      resource_id: "8A123456ORDER",
                      payment_intent_id: otherIntentId,
                      status: "PROCESSED",
                      signature_verified: true,
                      created_at: "2026-11-10T10:05:00.000Z",
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "freelancer_paypal_accounts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  paypal_merchant_id: "SELLER-MERCHANT-ABC",
                  onboarding_status: "COMPLETED",
                  payments_receivable: true,
                  primary_email_confirmed: true,
                  connected_at: "2026-11-01T08:00:00.000Z",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "activity_events") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: "evt-1",
                      event_type: "payment.marked_reconciliation_required",
                      summary: `Marked ${intentId} for reconciliation`,
                      actor_label: "operator@payroost.test",
                      metadata: {
                        intentId,
                        previousStatus: "CAPTURING",
                        resultingStatus: "RECONCILIATION_REQUIRED",
                        secretClientToken: "should-be-stripped",
                      },
                      created_at: "2026-11-10T10:12:00.000Z",
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const res = await GET_INVESTIGATION(
      new Request(`http://localhost:3000/api/app/payments/${intentId}`),
      { params: Promise.resolve({ intentId }) }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const json = await res.json();
    expect(json.intent.isOwner).toBe(false);
    expect(json.intent.milestoneStatus).toBe("IN_REVIEW");
    expect(json.milestoneIndependenceNotice).toMatch(/never automatically approved/i);
    expect(json.sellerContext.paymentMode).toBe("PLATFORM");
    expect(json.sellerContext.sellerPayerId).toBe("SELLER-PAYER-XYZ");
    expect(json.sellerContext.accountMatchesIntentMerchant).toBe(true);

    // Cross-intent webhook MUST NOT be present
    expect(json.webhooks).toHaveLength(1);
    expect(json.webhooks[0].providerEventId).toBe("WH-EVT-001");
    expect(json.webhooks[0].operationalStatus).toBe("EXHAUSTED");
    expect(json.webhooks[0].errorDetails).not.toContain("buyer@secret.com");

    // Audit timeline redacts email & strips unallowlisted keys
    expect(json.timeline[0].actorLabel).toBe("op***@payroost.test");
    expect(json.timeline[0].metadata).not.toHaveProperty("secretClientToken");

    // Non-owner member sees all recovery actions disabled with explanations
    expect(json.actions.every((a: { allowed: boolean }) => !a.allowed)).toBe(true);
  });
});

describe("Phase 3B.R5: Hardened Recovery & Internal Scheduler Routes", () => {
  const csrfSecret = generateOperatorCsrfSecret();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: validUserId, email: "owner@example.com" } },
      error: null,
    });
    mockRateLimit.mockResolvedValue({ allowed: true, remaining: 29, status: "allowed" });
    mockValidateWebhookConfig.mockReturnValue({ valid: true, mode: "PLATFORM" });
  });

  function makeRecoveryRequest(body: unknown) {
    return new NextRequest("http://localhost:3000/api/app/payments/recovery", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfSecret,
        cookie: `payroost_operator_csrf=${csrfSecret}`,
        origin: "http://localhost:3000",
      },
      body: JSON.stringify(body),
    });
  }

  it("rejects self-asserted verification_status inside payload when signature_verified column is false", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: intentId,
              project_id: projectId,
              milestone_id: milestoneId,
              status: "BUYER_APPROVED",
              provider_order_id: "8A123456ORDER",
              created_at: new Date().toISOString(),
              projects: { id: projectId, owner_id: validUserId },
            },
            error: null,
          }),
        }),
      }),
    });

    mockServiceFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: webhookRowId,
              provider_event_id: "WH-SPOOF",
              event_type: "PAYMENT.CAPTURE.COMPLETED",
              status: "FAILED",
              signature_verified: false,
              payload: {
                verification_status: "SUCCESS", // Spoofed JSON field!
                signature_verified: true,
                resource: { id: "CAP-999", custom_id: intentId },
              },
            },
            error: null,
          }),
        }),
      }),
    });

    const res = await POST_RECOVERY(
      makeRecoveryRequest({
        intentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: webhookRowId,
      })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("UNVERIFIED_WEBHOOK_EVENT");
  });

  it("reprocesses a failed verified webhook on BUYER_APPROVED intent through processVerifiedPayPalWebhookEvent and audits", async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: intentId,
              project_id: projectId,
              milestone_id: milestoneId,
              status: "BUYER_APPROVED",
              provider_order_id: "8A123456ORDER",
              created_at: new Date().toISOString(),
              projects: { id: projectId, owner_id: validUserId },
            },
            error: null,
          }),
        }),
      }),
    });

    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "provider_webhook_events") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: webhookRowId,
                  provider_event_id: "WH-RETRY-01",
                  event_type: "PAYMENT.CAPTURE.COMPLETED",
                  resource_type: "capture",
                  resource_id: "CAP-001",
                  payment_intent_id: intentId,
                  payload_sha256: "abc123sha",
                  status: "FAILED",
                  signature_verified: true,
                  payload: {
                    id: "WH-RETRY-01",
                    event_type: "PAYMENT.CAPTURE.COMPLETED",
                    resource: { id: "CAP-001", custom_id: intentId },
                  },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return { insert: insertSpy };
    });

    mockServiceRpc.mockResolvedValue({
      data: { claimed: true, event_row_id: webhookRowId },
      error: null,
    });

    mockProcessVerifiedWebhook.mockResolvedValue({
      httpStatus: 200,
      body: { received: true, processed: true, outcome: "PROCESSED" },
    });

    const res = await POST_RECOVERY(
      makeRecoveryRequest({
        intentId,
        action: "REPROCESS_WEBHOOK",
        webhookEventId: webhookRowId,
        notes: "Retrying after transient timeout",
      })
    );
    expect(res.status).toBe(200);
    expect(mockServiceRpc).toHaveBeenCalledWith(
      "claim_paypal_webhook_event",
      expect.objectContaining({
        p_allow_reprocess: true,
        p_respect_backoff: false,
      })
    );
    expect(mockProcessVerifiedWebhook).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "payment.webhook_reprocessed" })
    );
  });

  it("audits CLEAR_EXPIRED_LEASE recovery and fails closed if audit write fails", async () => {
    const expiredIso = new Date(Date.now() - 60_000).toISOString();
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: intentId,
              project_id: projectId,
              status: "CAPTURING",
              capture_lease_expires_at: expiredIso,
              projects: { id: projectId, owner_id: validUserId },
            },
            error: null,
          }),
        }),
      }),
    });

    mockReconcilePaymentIntentServerSide.mockResolvedValue({
      success: true,
      intentId,
      previousStatus: "CAPTURING",
      resultingStatus: "COMPLETED",
      recovered: true,
    });

    mockServiceFrom.mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: new Error("Audit DB error") }),
    });

    const res = await POST_RECOVERY(
      makeRecoveryRequest({ intentId, action: "CLEAR_EXPIRED_LEASE" })
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("AUDIT_LOGGING_FAILED");
  });

  it("enforces fail-closed CRON_SECRET auth on POST /api/internal/payments/recover and sweeps webhooks + stale leases", async () => {
    const prevCron = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      const noCfgRes = await POST_INTERNAL_RECOVER(
        new Request("http://localhost:3000/api/internal/payments/recover", { method: "POST" })
      );
      expect(noCfgRes.status).toBe(503);

      process.env.CRON_SECRET = "super-secure-cron-token-value-1234";
      const badTokenRes = await POST_INTERNAL_RECOVER(
        new Request("http://localhost:3000/api/internal/payments/recover", {
          method: "POST",
          headers: { authorization: "Bearer wrong-token" },
        })
      );
      expect(badTokenRes.status).toBe(401);

      mockRecoverPendingWebhooks.mockResolvedValue({
        attempted: 3,
        processed: 2,
        deferred: 1,
        escalated: 0,
      });

      mockServiceFrom.mockImplementation((table: string) => {
        if (table === "payment_intents") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((_col: string, val: string) => ({
                lt: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: val === "CAPTURING" ? [{ id: intentId }] : [],
                      error: null,
                    }),
                  }),
                }),
              })),
            }),
          };
        }
        return {};
      });

      mockReconcilePaymentIntentServerSide.mockResolvedValue({
        success: true,
        intentId,
        previousStatus: "CAPTURING",
        resultingStatus: "COMPLETED",
        recovered: true,
      });

      const okRes = await POST_INTERNAL_RECOVER(
        new Request("http://localhost:3000/api/internal/payments/recover", {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ limit: 10, reconcileExpiredLeases: true }),
        })
      );
      expect(okRes.status).toBe(200);
      const okJson = await okRes.json();
      expect(okJson.webhooks).toEqual({ attempted: 3, processed: 2, deferred: 1, escalated: 0 });
      expect(okJson.staleLeases).toEqual({
        checked: 1,
        recovered: 1,
        reconciliationRequired: 0,
        failed: 0,
      });
    } finally {
      if (prevCron === undefined) {
        delete process.env.CRON_SECRET;
      } else {
        process.env.CRON_SECRET = prevCron;
      }
    }
  });
});
