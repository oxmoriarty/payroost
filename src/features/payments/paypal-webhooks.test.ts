import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PayPalConfig } from "@/lib/paypal/types";
import { PayPalClient } from "@/lib/paypal/client";
import { PayPalError } from "@/lib/paypal/types";
import {
  extractPayPalWebhookHeaders,
  parsePayPalWebhookEnvelope,
  verifyPayPalWebhookSignature,
  sanitizePayPalWebhookPayload,
} from "@/lib/paypal/webhooks";
import {
  handleIncomingPayPalWebhook,
  recoverPendingPayPalWebhookEvents,
} from "@/lib/paypal/webhook-processor";

// ---------------------------------------------------------------------------
// Module Mocks for Route & Operations Data Tests
// ---------------------------------------------------------------------------

const mockCheckRateLimit = vi.fn();
const mockGetUser = vi.fn();
const mockServerFrom = vi.fn();
const mockServiceFrom = vi.fn();
const mockServiceRpc = vi.fn();
const mockGetPayPalServerEnv = vi.fn();

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: vi.fn(async (...args: unknown[]) => mockCheckRateLimit(...args)),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockServerFrom,
  })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => ({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
  })),
}));

vi.mock("@/lib/paypal/env", () => ({
  getPayPalServerEnv: () => mockGetPayPalServerEnv(),
}));

import { POST as paypalWebhookPost } from "@/app/api/webhooks/paypal/route";
import { getPaymentOperationsData } from "@/features/payments/operations-data";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTENT_ID = "11111111-1111-4111-a111-111111111111";
const OTHER_INTENT_ID = "22222222-2222-4222-a222-222222222222";
const PROJECT_ID = "33333333-3333-4333-a333-333333333333";
const MILESTONE_ID = "44444444-4444-4444-a444-444444444444";
const EVENT_ROW_ID = "55555555-5555-4555-a555-555555555555";
const TX_ROW_ID = "66666666-6666-4666-a666-666666666666";
const ORDER_ID = "8A123456BC789012D";
const CAPTURE_ID = "2XY12345AB678901C";
const SELLER_MERCHANT_ID = "SELLER-MERCHANT-01";
const SELLER_PAYER_ID = "SELLER-PAYER-01";
const PARTNER_MERCHANT_ID = "PARTNER-PLATFORM-MERCHANT";

const basePlatformEnv: PayPalConfig = {
  environment: "sandbox",
  clientId: "merchant-client-id",
  clientSecret: "merchant-client-secret",
  platformClientId: "platform-client-id",
  platformClientSecret: "platform-client-secret",
  partnerMerchantId: PARTNER_MERCHANT_ID,
  expectedMerchantId: PARTNER_MERCHANT_ID,
  partnerAttributionId: "TEST_BN_CODE_123",
  webhookId: "WH-CONFIG-SANDBOX-001",
  paymentMode: "PLATFORM",
  baseUrl: "https://api-m.sandbox.paypal.com",
};

const baseMerchantEnv: PayPalConfig = {
  environment: "sandbox",
  clientId: "merchant-client-id",
  clientSecret: "merchant-client-secret",
  expectedMerchantId: "LEGACY-MERCHANT-01",
  webhookId: "WH-CONFIG-SANDBOX-001",
  paymentMode: "MERCHANT",
  baseUrl: "https://api-m.sandbox.paypal.com",
};

function makePlatformIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    project_id: PROJECT_ID,
    milestone_id: MILESTONE_ID,
    status: "ORDER_CREATED",
    provider_order_id: ORDER_ID,
    expected_amount_cents: 10000,
    expected_amount_canonical: "100.00",
    expected_currency: "USD",
    expected_merchant_id: SELLER_MERCHANT_ID,
    canonical_payload_json: {
      payment_mode: "PLATFORM",
      seller_merchant_id: SELLER_MERCHANT_ID,
      seller_payer_id: SELLER_PAYER_ID,
      purchase_units: [
        {
          reference_id: MILESTONE_ID,
          custom_id: INTENT_ID,
          payee: { merchant_id: SELLER_MERCHANT_ID },
          amount: { currency_code: "USD", value: "100.00" },
        },
      ],
    },
    ...overrides,
  };
}

function makeMerchantIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    project_id: PROJECT_ID,
    milestone_id: MILESTONE_ID,
    status: "ORDER_CREATED",
    provider_order_id: ORDER_ID,
    expected_amount_cents: 10000,
    expected_amount_canonical: "100.00",
    expected_currency: "USD",
    expected_merchant_id: "LEGACY-MERCHANT-01",
    canonical_payload_json: {
      payment_mode: "MERCHANT",
      purchase_units: [
        {
          reference_id: MILESTONE_ID,
          custom_id: INTENT_ID,
          payee: { merchant_id: "LEGACY-MERCHANT-01" },
          amount: { currency_code: "USD", value: "100.00" },
        },
      ],
    },
    ...overrides,
  };
}

function makeWebhookHeaders(overrides: Record<string, string | null> = {}): Headers {
  const defaults: Record<string, string> = {
    "paypal-transmission-id": "tx-id-0001",
    "paypal-transmission-time": "2026-11-11T12:00:00Z",
    "paypal-transmission-sig": "base64-sig-abc123==",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
    "paypal-auth-algo": "SHA256withRSA",
  };
  const h = new Headers();
  for (const [key, val] of Object.entries({ ...defaults, ...overrides })) {
    if (val !== null) {
      h.set(key, val);
    }
  }
  return h;
}

function makeCaptureWebhookPayload(
  eventType:
    | "PAYMENT.CAPTURE.COMPLETED"
    | "PAYMENT.CAPTURE.PENDING"
    | "PAYMENT.CAPTURE.DENIED",
  overrides: Record<string, unknown> = {}
) {
  return {
    id: `WH-${eventType}-001`,
    event_type: eventType,
    event_version: "1.0",
    resource_type: "capture",
    create_time: "2026-11-11T12:00:05Z",
    resource: {
      id: CAPTURE_ID,
      status: eventType.split(".")[2],
      amount: { currency_code: "USD", value: "100.00" },
      custom_id: INTENT_ID,
      payee: {
        merchant_id: SELLER_MERCHANT_ID,
        email_address: "seller-private@example.com",
      },
      payer: {
        email_address: "buyer-private@example.com",
        name: { given_name: "Alice", surname: "Buyer" },
      },
      supplementary_data: {
        related_ids: {
          order_id: ORDER_ID,
        },
      },
    },
    ...overrides,
  };
}

function makeOrderApprovedPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "WH-ORDER-APPROVED-001",
    event_type: "CHECKOUT.ORDER.APPROVED",
    event_version: "1.0",
    resource_type: "checkout-order",
    create_time: "2026-11-11T12:00:02Z",
    resource: {
      id: ORDER_ID,
      status: "APPROVED",
      intent: "CAPTURE",
      payer: {
        email_address: "buyer-private@example.com",
        name: { given_name: "Alice", surname: "Buyer" },
      },
      purchase_units: [
        {
          reference_id: MILESTONE_ID,
          custom_id: INTENT_ID,
          payee: { merchant_id: SELLER_MERCHANT_ID },
          amount: { currency_code: "USD", value: "100.00" },
          shipping: {
            address: { address_line_1: "123 Secret Street", postal_code: "90210" },
          },
        },
      ],
    },
    ...overrides,
  };
}

function createServiceClientMock(options: {
  intentByOrderId?: Record<string, unknown> | null;
  intentById?: Record<string, unknown> | null;
  txByCaptureId?: { payment_intent_id: string } | null;
  existingCompletedTx?: { id: string; provider_reference_id: string; status: string } | null;
  queuedWebhookRows?: Array<Record<string, unknown>>;
  rpcHandler?: (fnName: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
}) {
  const finalizeCalls: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ fnName: string; params: Record<string, unknown> }> = [];

  const client = {
    from: vi.fn((table: string) => {
      if (table === "payment_intents") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn((col: string, val: unknown) => ({
              maybeSingle: vi.fn(async () => {
                if (col === "provider_order_id") {
                  if (options.intentByOrderId && (options.intentByOrderId as { provider_order_id?: string }).provider_order_id === val) {
                    return { data: options.intentByOrderId, error: null };
                  }
                  return { data: null, error: null };
                }
                if (col === "id") {
                  if (options.intentById && (options.intentById as { id?: string }).id === val) {
                    return { data: options.intentById, error: null };
                  }
                  if (options.intentByOrderId && (options.intentByOrderId as { id?: string }).id === val) {
                    return { data: options.intentByOrderId, error: null };
                  }
                  return { data: null, error: null };
                }
                return { data: null, error: null };
              }),
            })),
          }),
        };
      }

      if (table === "payment_transactions") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn((col1: string) => {
              if (col1 === "payment_intent_id") {
                return {
                  eq: vi.fn(() => ({
                    eq: vi.fn((col3: string, val3: unknown) => ({
                      maybeSingle: vi.fn(async () => {
                        if (col3 === "status" && val3 === "COMPLETED") {
                          return { data: options.existingCompletedTx ?? null, error: null };
                        }
                        if (col3 === "provider_reference_id") {
                          return {
                            data: val3 === CAPTURE_ID ? { id: TX_ROW_ID } : null,
                            error: null,
                          };
                        }
                        return { data: null, error: null };
                      }),
                    })),
                  })),
                };
              }
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn((_col3: string, val3: unknown) => ({
                    maybeSingle: vi.fn(async () => ({
                      data:
                        options.txByCaptureId && val3 === CAPTURE_ID
                          ? options.txByCaptureId
                          : null,
                      error: null,
                    })),
                  })),
                })),
              };
            }),
          }),
        };
      }

      if (table === "provider_webhook_events") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                in: vi.fn(() => ({
                  order: vi.fn(() => ({
                    limit: vi.fn(async () => ({
                      data: options.queuedWebhookRows ?? [],
                      error: null,
                    })),
                  })),
                })),
              })),
            })),
          }),
        };
      }

      return { select: vi.fn() };
    }),
    rpc: vi.fn(async (fnName: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fnName, params });
      if (fnName === "finalize_paypal_webhook_event") {
        finalizeCalls.push(params);
        return { data: { success: true }, error: null };
      }
      if (options.rpcHandler) {
        const handled = await options.rpcHandler(fnName, params);
        if (handled.data !== null || handled.error !== null) {
          return handled;
        }
      }
      if (fnName === "claim_paypal_webhook_event") {
        return {
          data: { success: true, claimed: true, event_row_id: EVENT_ROW_ID, attempt_count: 1 },
          error: null,
        };
      }
      return { data: { success: true }, error: null };
    }),
  };

  return { client: client as never, rpcCalls, finalizeCalls };
}

// ---------------------------------------------------------------------------
// 1. Static SQL Migration Verification
// ---------------------------------------------------------------------------

describe("Phase 3B.R4: Static SQL Migration Analysis (202611110003)", () => {
  const migrationPath = join(
    process.cwd(),
    "supabase/migrations/202611110003_paypal_platform_webhooks.sql"
  );
  const sql = readFileSync(migrationPath, "utf-8");

  it("extends provider_webhook_events with tracking columns, outcomes, and indexes", () => {
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+resource_id\s+text/i);
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+payment_intent_id\s+uuid/i);
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+payment_transaction_id\s+uuid/i);
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+payment_mode\s+text/i);
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+processing_outcome\s+text/i);
    expect(sql).toMatch(/'RECEIVED',\s*'VERIFIED',\s*'PROCESSING',\s*'PROCESSED',\s*'DUPLICATE',\s*'FAILED',\s*'REQUIRES_RECONCILIATION'/is);
    expect(sql).toMatch(/revoke\s+all\s+on\s+public\.provider_webhook_events\s+from\s+public,\s*anon,\s*authenticated/i);
  });

  it("defines all service_role-only webhook RPCs with dual-layer role assertion and signature_verified guard", () => {
    for (const fnName of [
      "claim_paypal_webhook_event",
      "finalize_paypal_webhook_event",
      "record_paypal_webhook_order_approved",
      "record_paypal_webhook_capture_state",
      "admin_reprocess_webhook_event",
    ]) {
      expect(sql).toMatch(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fnName}`, "i"));
      expect(sql).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fnName}.*from\\s+public,\\s*anon,\\s*authenticated`, "is"));
      expect(sql).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fnName}.*to\\s+service_role`, "is"));
    }

    expect(sql).toMatch(/if\s+p_signature_verified\s+is\s+distinct\s+from\s+true\s+then/i);
    expect(sql).toMatch(/on\s+conflict\s*\(provider_event_id\)\s+do\s+nothing/i);
    expect(sql).toMatch(/v_event\.payload_sha256\s*<>\s*v_clean_sha256/i);
  });

  it("hardens protect_payment_intent_immutability without ever mutating milestones.status", () => {
    expect(sql).toMatch(/old\.status\s+in\s*\('COMPLETED',\s*'FAILED',\s*'CANCELLED'\)/i);
    expect(sql).toMatch(/v_is_privileged_service\s+and\s+v_is_reconciliation_active/i);
    expect(sql).not.toMatch(/update\s+public\.milestones/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Configuration, Header, & Envelope Validation + Header Scoping
// ---------------------------------------------------------------------------

describe("Phase 3B.R4: Configuration, Envelope, & PayPal Verification Header Scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, isUnavailable: false });
  });

  it("fails closed with 500 CONFIGURATION_ERROR when PAYPAL_WEBHOOK_ID is missing", async () => {
    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedPayPalEnv: { ...basePlatformEnv, webhookId: undefined },
    });

    expect(res.httpStatus).toBe(500);
    expect(res.body.error).toBe("CONFIGURATION_ERROR");
  });

  it("fails closed with 500 CONFIGURATION_ERROR when Platform credentials are incomplete (no MERCHANT fallback)", async () => {
    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedPayPalEnv: {
        ...basePlatformEnv,
        platformClientSecret: undefined,
      },
    });

    expect(res.httpStatus).toBe(500);
    expect(res.body.error).toBe("CONFIGURATION_ERROR");
  });

  it("rejects live environment webhook calls cleanly in Sandbox phase", async () => {
    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedPayPalEnv: {
        ...basePlatformEnv,
        environment: "live" as unknown as "sandbox",
        baseUrl: "https://api-m.paypal.com",
      },
    });

    expect(res.httpStatus).toBe(500);
    expect(res.body.error).toBe("CONFIGURATION_ERROR");
  });

  it("rejects missing transmission headers, non-PayPal cert URLs, and malformed JSON", async () => {
    const missingHdr = extractPayPalWebhookHeaders(
      makeWebhookHeaders({ "paypal-transmission-sig": null })
    );
    expect(missingHdr.ok).toBe(false);
    if (!missingHdr.ok) expect(missingHdr.error).toBe("MISSING_WEBHOOK_HEADERS");

    const badCert = extractPayPalWebhookHeaders(
      makeWebhookHeaders({ "paypal-cert-url": "https://attacker.example/cert.pem" })
    );
    expect(badCert.ok).toBe(false);
    if (!badCert.ok) expect(badCert.error).toBe("INVALID_WEBHOOK_HEADERS");

    const badJson = parsePayPalWebhookEnvelope("{bad-json");
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error).toBe("MALFORMED_JSON");
  });

  it("strictly omits PayPal-Auth-Assertion and PayPal-Partner-Attribution-Id on verify-webhook-signature", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "platform-token-1", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
        const hdrs = new Headers(init?.headers);
        expect(hdrs.get("PayPal-Auth-Assertion")).toBeNull();
        expect(hdrs.get("PayPal-Partner-Attribution-Id")).toBeNull();
        expect(hdrs.get("Authorization")).toBe("Bearer platform-token-1");

        const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(sentBody.webhook_id).toBe("WH-CONFIG-SANDBOX-001");
        expect(sentBody.webhook_event).toBeTruthy();

        return new Response(JSON.stringify({ verification_status: "SUCCESS" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const realClient = new PayPalClient(basePlatformEnv);
      const envelope = makeOrderApprovedPayload();
      const hdrs = extractPayPalWebhookHeaders(makeWebhookHeaders());
      expect(hdrs.ok).toBe(true);
      if (!hdrs.ok) return;

      const sig = await verifyPayPalWebhookSignature({
        paypalClient: realClient,
        config: basePlatformEnv,
        webhookId: basePlatformEnv.webhookId!,
        headers: hdrs.headers,
        rawEnvelope: envelope,
      });

      expect(sig.verified).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects invalid webhook signature with 401 and does not write to provider_webhook_events", async () => {
    const { client, rpcCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent(),
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "FAILURE" }, status: 200 }),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(401);
    expect(res.body.error).toBe("INVALID_WEBHOOK_SIGNATURE");
    expect(rpcCalls).toHaveLength(0);
    expect(mockPayPal.get).not.toHaveBeenCalled();
  });

  it("returns 503 with Retry-After when verification endpoint fails transiently", async () => {
    const { client, rpcCalls } = createServiceClientMock({});
    const mockPayPal = {
      post: vi.fn().mockRejectedValue(new PayPalError({ message: "PayPal 503", status: 503 })),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(503);
    expect(res.body.error).toBe("WEBHOOK_VERIFICATION_UNAVAILABLE");
    expect(res.headers?.["Retry-After"]).toBeTruthy();
    expect(rpcCalls).toHaveLength(0);
  });

  it("strips buyer and seller PII when sanitizing webhook payload for storage", () => {
    const raw = makeOrderApprovedPayload();
    const sanitized = sanitizePayPalWebhookPayload(raw);
    const jsonText = JSON.stringify(sanitized);

    expect(jsonText).not.toContain("buyer-private@example.com");
    expect(jsonText).not.toContain("123 Secret Street");
    expect(jsonText).not.toContain("Alice");
    expect(jsonText).toContain(ORDER_ID);
    expect(jsonText).toContain(SELLER_MERCHANT_ID);
  });
});

// ---------------------------------------------------------------------------
// 3. Supported Events, Deduplication, Concurrency, & State Safety
// ---------------------------------------------------------------------------

describe("Phase 3B.R4: Verified Event Processing, Idempotency, & Races", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acknowledges unsupported verified events cleanly without mutating payments", async () => {
    const { client, rpcCalls, finalizeCalls } = createServiceClientMock({});
    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const envelope = {
      id: "WH-ONBOARD-001",
      event_type: "MERCHANT.ONBOARDING.COMPLETED",
      resource_type: "merchant-onboarding",
      resource: { merchant_id: SELLER_MERCHANT_ID },
    };

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(envelope),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.processed).toBe(false);
    expect(res.body.outcome).toBe("PROCESSED");
    expect(mockPayPal.get).not.toHaveBeenCalled();
    expect(finalizeCalls[0]?.p_status).toBe("PROCESSED");
    expect(rpcCalls.map((c) => c.fnName)).toEqual([
      "claim_paypal_webhook_event",
      "finalize_paypal_webhook_event",
    ]);
  });

  it("processes valid CHECKOUT.ORDER.APPROVED in PLATFORM mode using seller_payer_id Auth Assertion", async () => {
    const { client, rpcCalls, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent(),
      rpcHandler: async (fnName) => {
        if (fnName === "record_paypal_webhook_order_approved") {
          return {
            data: { success: true, transitioned: true, current_status: "BUYER_APPROVED" },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn().mockResolvedValue({
        data: {
          id: ORDER_ID,
          status: "APPROVED",
          purchase_units: [
            {
              reference_id: MILESTONE_ID,
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID },
              amount: { currency_code: "USD", value: "100.00" },
            },
          ],
        },
        status: 200,
      }),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.outcome).toBe("PROCESSED");
    expect(res.body.paymentMode).toBe("PLATFORM");

    expect(mockPayPal.get).toHaveBeenCalledWith(
      `/v2/checkout/orders/${ORDER_ID}`,
      expect.objectContaining({
        authAssertion: { payerId: SELLER_PAYER_ID },
      })
    );

    expect(rpcCalls.some((c) => c.fnName === "record_paypal_webhook_order_approved")).toBe(true);
    expect(finalizeCalls[0]).toMatchObject({
      p_status: "PROCESSED",
      p_processing_outcome: "PROCESSED",
      p_payment_mode: "PLATFORM",
      p_payment_intent_id: INTENT_ID,
    });
  });

  it("processes PAYMENT.CAPTURE.COMPLETED in PLATFORM mode cleanly without duplicates or milestone mutation", async () => {
    const { client, rpcCalls, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent({ status: "BUYER_APPROVED" }),
      rpcHandler: async (fnName) => {
        if (fnName === "reconcile_and_complete_payment_intent") {
          return { data: true, error: null };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(async (path: string) => {
        if (path === `/v2/payments/captures/${CAPTURE_ID}`) {
          return {
            data: {
              id: CAPTURE_ID,
              status: "COMPLETED",
              amount: { currency_code: "USD", value: "100.00" },
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID, email_address: "pii@example.com" },
              supplementary_data: { related_ids: { order_id: ORDER_ID } },
            },
            status: 200,
          };
        }
        if (path === `/v2/checkout/orders/${ORDER_ID}`) {
          return {
            data: {
              id: ORDER_ID,
              status: "COMPLETED",
              payer: { email_address: "buyer@example.com" },
              purchase_units: [
                {
                  reference_id: MILESTONE_ID,
                  custom_id: INTENT_ID,
                  payee: { merchant_id: SELLER_MERCHANT_ID },
                  amount: { currency_code: "USD", value: "100.00" },
                  payments: {
                    captures: [
                      {
                        id: CAPTURE_ID,
                        status: "COMPLETED",
                        amount: { currency_code: "USD", value: "100.00" },
                        payee: { merchant_id: SELLER_MERCHANT_ID },
                      },
                    ],
                  },
                },
              ],
            },
            status: 200,
          };
        }
        throw new Error(`Unexpected GET ${path}`);
      }),
    } as unknown as PayPalClient;

    const rawBody = JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.COMPLETED"));
    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody,
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.outcome).toBe("PROCESSED");
    expect(res.body.paymentMode).toBe("PLATFORM");

    // Verify BOTH Capture GET and Order GET carried Auth Assertion with sellerPayerId
    expect(mockPayPal.get).toHaveBeenNthCalledWith(
      1,
      `/v2/payments/captures/${CAPTURE_ID}`,
      expect.objectContaining({ authAssertion: { payerId: SELLER_PAYER_ID } })
    );
    expect(mockPayPal.get).toHaveBeenNthCalledWith(
      2,
      `/v2/checkout/orders/${ORDER_ID}`,
      expect.objectContaining({ authAssertion: { payerId: SELLER_PAYER_ID } })
    );

    const reconcileCall = rpcCalls.find(
      (c) => c.fnName === "reconcile_and_complete_payment_intent"
    );
    expect(reconcileCall).toBeTruthy();
    expect(JSON.stringify(reconcileCall?.params)).not.toContain("pii@example.com");
    expect(JSON.stringify(reconcileCall?.params)).not.toContain("buyer@example.com");

    expect(finalizeCalls[0]).toMatchObject({
      p_status: "PROCESSED",
      p_processing_outcome: "PROCESSED",
      p_payment_mode: "PLATFORM",
      p_payment_transaction_id: TX_ROW_ID,
    });
  });

  it("handles PAYMENT.CAPTURE.PENDING and escalates to RECONCILIATION_REQUIRED cleanly", async () => {
    const { client, rpcCalls, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent({ status: "CAPTURING" }),
      rpcHandler: async (fnName) => {
        if (fnName === "record_paypal_webhook_capture_state") {
          return {
            data: {
              success: true,
              transitioned: true,
              current_status: "RECONCILIATION_REQUIRED",
              payment_transaction_id: TX_ROW_ID,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(async (path: string) => {
        if (path.includes("/captures/")) {
          return {
            data: {
              id: CAPTURE_ID,
              status: "PENDING",
              amount: { currency_code: "USD", value: "100.00" },
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID },
              supplementary_data: { related_ids: { order_id: ORDER_ID } },
            },
            status: 200,
          };
        }
        return {
          data: {
            id: ORDER_ID,
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: MILESTONE_ID,
                custom_id: INTENT_ID,
                payee: { merchant_id: SELLER_MERCHANT_ID },
                amount: { currency_code: "USD", value: "100.00" },
              },
            ],
          },
          status: 200,
        };
      }),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.PENDING")),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.outcome).toBe("REQUIRES_RECONCILIATION");
    expect(rpcCalls.some((c) => c.fnName === "record_paypal_webhook_capture_state")).toBe(true);
    expect(finalizeCalls[0]?.p_processing_outcome).toBe("REQUIRES_RECONCILIATION");
  });

  it("handles PAYMENT.CAPTURE.DENIED by recording failure without touching milestone", async () => {
    const { client, rpcCalls, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent({ status: "CAPTURING" }),
      rpcHandler: async (fnName) => {
        if (fnName === "record_paypal_webhook_capture_state") {
          return {
            data: {
              success: true,
              transitioned: true,
              current_status: "FAILED",
              payment_transaction_id: TX_ROW_ID,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(async (path: string) => {
        if (path.includes("/captures/")) {
          return {
            data: {
              id: CAPTURE_ID,
              status: "DECLINED",
              amount: { currency_code: "USD", value: "100.00" },
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID },
              supplementary_data: { related_ids: { order_id: ORDER_ID } },
            },
            status: 200,
          };
        }
        return {
          data: {
            id: ORDER_ID,
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: MILESTONE_ID,
                custom_id: INTENT_ID,
                payee: { merchant_id: SELLER_MERCHANT_ID },
                amount: { currency_code: "USD", value: "100.00" },
              },
            ],
          },
          status: 200,
        };
      }),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.DENIED")),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.outcome).toBe("PROCESSED");
    expect(rpcCalls.find((c) => c.fnName === "record_paypal_webhook_capture_state")?.params).toMatchObject({
      p_capture_status: "DENIED",
    });
    expect(finalizeCalls[0]?.p_processing_outcome).toBe("PROCESSED");
  });

  it("suppresses duplicate delivered events and concurrent in-flight deliveries cleanly", async () => {
    const dupClient = createServiceClientMock({
      rpcHandler: async (fnName) => {
        if (fnName === "claim_paypal_webhook_event") {
          return {
            data: {
              success: true,
              claimed: false,
              duplicate: true,
              processing_outcome: "PROCESSED",
              event_row_id: EVENT_ROW_ID,
              payment_intent_id: INTENT_ID,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const dupRes = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.COMPLETED")),
      injectedServiceClient: dupClient.client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(dupRes.httpStatus).toBe(200);
    expect(dupRes.body.duplicate).toBe(true);
    expect(mockPayPal.get).not.toHaveBeenCalled();

    const concurrentClient = createServiceClientMock({
      rpcHandler: async (fnName) => {
        if (fnName === "claim_paypal_webhook_event") {
          return {
            data: {
              success: true,
              claimed: false,
              in_progress: true,
              event_row_id: EVENT_ROW_ID,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });

    const concurrentRes = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.COMPLETED")),
      injectedServiceClient: concurrentClient.client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(concurrentRes.httpStatus).toBe(409);
    expect(concurrentRes.body.inProgress).toBe(true);
    expect(concurrentRes.headers?.["Retry-After"]).toBeTruthy();
    expect(mockPayPal.get).not.toHaveBeenCalled();
  });

  it("defers safely on active synchronous capture lease race without creating duplicate ledger rows", async () => {
    const { client, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent({ status: "CAPTURING" }),
      rpcHandler: async (fnName) => {
        if (fnName === "reconcile_and_complete_payment_intent") {
          return {
            data: null,
            error: { message: "Cannot reconcile CAPTURING intent while an active worker lease is held" },
          };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(async (path: string) => {
        if (path.includes("/captures/")) {
          return {
            data: {
              id: CAPTURE_ID,
              status: "COMPLETED",
              amount: { currency_code: "USD", value: "100.00" },
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID },
              supplementary_data: { related_ids: { order_id: ORDER_ID } },
            },
            status: 200,
          };
        }
        return {
          data: {
            id: ORDER_ID,
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: MILESTONE_ID,
                custom_id: INTENT_ID,
                payee: { merchant_id: SELLER_MERCHANT_ID },
                amount: { currency_code: "USD", value: "100.00" },
                payments: {
                  captures: [{ id: CAPTURE_ID, status: "COMPLETED" }],
                },
              },
            ],
          },
          status: 200,
        };
      }),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.COMPLETED")),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(503);
    expect(res.body.outcome).toBe("RETRY");
    expect(res.body.error).toBe("CAPTURE_LEASE_ACTIVE");
    expect(finalizeCalls[0]?.p_status).toBe("RETRY");
  });

  it("handles webhook arriving after synchronous capture already completed without duplicate capture", async () => {
    const { client, rpcCalls, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent({ status: "COMPLETED" }),
      existingCompletedTx: {
        id: TX_ROW_ID,
        provider_reference_id: CAPTURE_ID,
        status: "COMPLETED",
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(async (path: string) => {
        if (path.includes("/captures/")) {
          return {
            data: {
              id: CAPTURE_ID,
              status: "COMPLETED",
              amount: { currency_code: "USD", value: "100.00" },
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID },
              supplementary_data: { related_ids: { order_id: ORDER_ID } },
            },
            status: 200,
          };
        }
        return {
          data: {
            id: ORDER_ID,
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: MILESTONE_ID,
                custom_id: INTENT_ID,
                payee: { merchant_id: SELLER_MERCHANT_ID },
                amount: { currency_code: "USD", value: "100.00" },
                payments: {
                  captures: [{ id: CAPTURE_ID, status: "COMPLETED" }],
                },
              },
            ],
          },
          status: 200,
        };
      }),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.COMPLETED")),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.outcome).toBe("DUPLICATE");
    expect(rpcCalls.some((c) => c.fnName === "reconcile_and_complete_payment_intent")).toBe(false);
    expect(finalizeCalls[0]?.p_processing_outcome).toBe("DUPLICATE");
  });

  it("handles out-of-order CHECKOUT.ORDER.APPROVED arriving after order already COMPLETED", async () => {
    const { client, rpcCalls, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent({ status: "COMPLETED" }),
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn().mockResolvedValue({
        data: {
          id: ORDER_ID,
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: MILESTONE_ID,
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID },
              amount: { currency_code: "USD", value: "100.00" },
            },
          ],
        },
        status: 200,
      }),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(rpcCalls.some((c) => c.fnName === "record_paypal_webhook_order_approved")).toBe(false);
    expect(finalizeCalls[0]?.p_processing_outcome).toBe("DUPLICATE");
  });

  it("rejects PAYLOAD_HASH_MISMATCH conflicts and returns 503 on transient DB claim failure", async () => {
    const hashConflictClient = createServiceClientMock({
      rpcHandler: async (fnName) => {
        if (fnName === "claim_paypal_webhook_event") {
          return {
            data: { success: true, claimed: false, duplicate: true, conflict: true },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });
    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const conflictRes = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: hashConflictClient.client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(conflictRes.httpStatus).toBe(409);
    expect(conflictRes.body.error).toBe("PAYLOAD_HASH_MISMATCH");

    const dbFailClient = createServiceClientMock({
      rpcHandler: async (fnName) => {
        if (fnName === "claim_paypal_webhook_event") {
          return { data: null, error: { message: "connection timeout" } };
        }
        return { data: null, error: null };
      },
    });

    const dbFailRes = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: dbFailClient.client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(dbFailRes.httpStatus).toBe(503);
    expect(dbFailRes.body.error).toBe("DATABASE_UNAVAILABLE");
  });

  it("prevents out-of-order PENDING webhook from regressing an already COMPLETED payment", async () => {
    const { client, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent({ status: "COMPLETED" }),
      rpcHandler: async (fnName) => {
        if (fnName === "record_paypal_webhook_capture_state") {
          return {
            data: {
              success: true,
              transitioned: false,
              stale_event: true,
              current_status: "COMPLETED",
              payment_transaction_id: TX_ROW_ID,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(async (path: string) => {
        if (path.includes("/captures/")) {
          return {
            data: {
              id: CAPTURE_ID,
              status: "PENDING",
              amount: { currency_code: "USD", value: "100.00" },
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID },
              supplementary_data: { related_ids: { order_id: ORDER_ID } },
            },
            status: 200,
          };
        }
        return {
          data: {
            id: ORDER_ID,
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: MILESTONE_ID,
                custom_id: INTENT_ID,
                payee: { merchant_id: SELLER_MERCHANT_ID },
                amount: { currency_code: "USD", value: "100.00" },
              },
            ],
          },
          status: 200,
        };
      }),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.PENDING")),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.outcome).toBe("DUPLICATE");
    expect(finalizeCalls[0]?.p_processing_outcome).toBe("DUPLICATE");
  });

  it("stops infinite retry loops after maxAttempts and flags REQUIRES_RECONCILIATION", async () => {
    const { client } = createServiceClientMock({
      rpcHandler: async (fnName) => {
        if (fnName === "claim_paypal_webhook_event") {
          return {
            data: {
              success: true,
              claimed: false,
              max_attempts_exceeded: true,
              event_row_id: EVENT_ROW_ID,
              payment_intent_id: INTENT_ID,
              processing_outcome: "REQUIRES_RECONCILIATION",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.COMPLETED")),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.outcome).toBe("REQUIRES_RECONCILIATION");
    expect(res.body.error).toBe("MAX_WEBHOOK_ATTEMPTS_EXCEEDED");
    expect(mockPayPal.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Security Mismatch, Mode Isolation, & Spoofing Attacks
// ---------------------------------------------------------------------------

describe("Phase 3B.R4: Security Mismatch, Mode Parity, & Spoofing Defense", () => {
  it("fails closed on amount mismatch, currency mismatch, and payee merchant mismatch", async () => {
    for (const scenario of [
      { name: "wrong amount", capValue: "99.00", capCurr: "USD", payee: SELLER_MERCHANT_ID, err: "AMOUNT_MISMATCH" },
      { name: "wrong currency", capValue: "100.00", capCurr: "EUR", payee: SELLER_MERCHANT_ID, err: "CURRENCY_MISMATCH" },
      { name: "partner merchant payee", capValue: "100.00", capCurr: "USD", payee: PARTNER_MERCHANT_ID, err: "MERCHANT_MISMATCH" },
    ]) {
      const { client, rpcCalls, finalizeCalls } = createServiceClientMock({
        intentByOrderId: makePlatformIntent(),
      });

      const mockPayPal = {
        post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
        get: vi.fn().mockResolvedValue({
          data: {
            id: CAPTURE_ID,
            status: "COMPLETED",
            amount: { currency_code: scenario.capCurr, value: scenario.capValue },
            custom_id: INTENT_ID,
            payee: { merchant_id: scenario.payee },
            supplementary_data: { related_ids: { order_id: ORDER_ID } },
          },
          status: 200,
        }),
      } as unknown as PayPalClient;

      const res = await handleIncomingPayPalWebhook({
        headers: makeWebhookHeaders(),
        rawBody: JSON.stringify(makeCaptureWebhookPayload("PAYMENT.CAPTURE.COMPLETED")),
        injectedServiceClient: client,
        injectedPayPalClient: mockPayPal,
        injectedPayPalEnv: basePlatformEnv,
      });

      expect(res.httpStatus, scenario.name).toBe(200);
      expect(res.body.outcome, scenario.name).toBe("REQUIRES_RECONCILIATION");
      expect(res.body.error, scenario.name).toBe(scenario.err);
      expect(rpcCalls.some((c) => c.fnName === "reconcile_and_complete_payment_intent")).toBe(false);
      expect(finalizeCalls[0]?.p_processing_outcome).toBe("REQUIRES_RECONCILIATION");
    }
  });

  it("blocks cross-project / cross-intent reference conflicts", async () => {
    const { client, rpcCalls, finalizeCalls } = createServiceClientMock({
      intentByOrderId: makePlatformIntent({ id: INTENT_ID }),
      intentById: makePlatformIntent({ id: OTHER_INTENT_ID, project_id: "77777777-7777-4777-a777-777777777777" }),
    });

    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const spoofedPayload = makeCaptureWebhookPayload("PAYMENT.CAPTURE.COMPLETED");
    spoofedPayload.resource.custom_id = OTHER_INTENT_ID;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(spoofedPayload),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.error).toBe("CROSS_INTENT_REFERENCE_CONFLICT");
    expect(res.body.outcome).toBe("REQUIRES_RECONCILIATION");
    expect(rpcCalls.some((c) => c.fnName === "reconcile_and_complete_payment_intent")).toBe(false);
    expect(finalizeCalls[0]?.p_error_details).toBe("CROSS_INTENT_REFERENCE_CONFLICT");
  });

  it("isolates historical MERCHANT records from PLATFORM mode and vice versa", async () => {
    // Case 1: MERCHANT intent arriving when server runs PLATFORM -> fail closed
    const platformServerClient = createServiceClientMock({
      intentByOrderId: makeMerchantIntent(),
    });
    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const mismatchRes = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: platformServerClient.client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(mismatchRes.httpStatus).toBe(200);
    expect(mismatchRes.body.error).toBe("PAYMENT_MODE_MISMATCH");
    expect(mockPayPal.get).not.toHaveBeenCalled();

    // Case 2: MERCHANT intent when server is MERCHANT -> succeeds WITHOUT Auth Assertion
    const merchantServerClient = createServiceClientMock({
      intentByOrderId: makeMerchantIntent(),
      rpcHandler: async (fnName) => {
        if (fnName === "record_paypal_webhook_order_approved") {
          return {
            data: { success: true, transitioned: true, current_status: "BUYER_APPROVED" },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });
    mockPayPal.get = vi.fn().mockResolvedValue({
      data: {
        id: ORDER_ID,
        status: "APPROVED",
        purchase_units: [
          {
            reference_id: MILESTONE_ID,
            custom_id: INTENT_ID,
            payee: { merchant_id: "LEGACY-MERCHANT-01" },
            amount: { currency_code: "USD", value: "100.00" },
          },
        ],
      },
      status: 200,
    });

    const okMerchantRes = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: merchantServerClient.client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: baseMerchantEnv,
    });

    expect(okMerchantRes.httpStatus).toBe(200);
    expect(okMerchantRes.body.paymentMode).toBe("MERCHANT");
    expect(mockPayPal.get).toHaveBeenCalledWith(`/v2/checkout/orders/${ORDER_ID}`);
  });

  it("fails closed if PLATFORM intent is missing seller_payer_id (no silent fallback to expected_merchant_id)", async () => {
    const brokenPlatformIntent = makePlatformIntent({
      canonical_payload_json: {
        payment_mode: "PLATFORM",
        seller_merchant_id: SELLER_MERCHANT_ID,
        // seller_payer_id intentionally omitted
      },
    });

    const { client } = createServiceClientMock({
      intentByOrderId: brokenPlatformIntent,
    });
    const mockPayPal = {
      post: vi.fn().mockResolvedValue({ data: { verification_status: "SUCCESS" }, status: 200 }),
      get: vi.fn(),
    } as unknown as PayPalClient;

    const res = await handleIncomingPayPalWebhook({
      headers: makeWebhookHeaders(),
      rawBody: JSON.stringify(makeOrderApprovedPayload()),
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(res.httpStatus).toBe(200);
    expect(res.body.error).toBe("SELLER_PAYER_ID_MISSING");
    expect(mockPayPal.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Pending Recovery Worker, Public Route Handler, & Operations Visibility
// ---------------------------------------------------------------------------

describe("Phase 3B.R4: Route Handler, Retry Recovery Worker, & Operations Visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, isUnavailable: false });
    mockGetPayPalServerEnv.mockReturnValue(basePlatformEnv);
  });

  it("POST /api/webhooks/paypal handles oversized body, malformed JSON, rate limits cleanly, and returns 401 on invalid signatures", async () => {
    const oversizedRes = await paypalWebhookPost(
      new Request("http://localhost:3000/api/webhooks/paypal", {
        method: "POST",
        headers: { "content-length": String(600 * 1024) },
        body: "{}",
      })
    );
    expect(oversizedRes.status).toBe(413);

    const malformedRes = await paypalWebhookPost(
      new Request("http://localhost:3000/api/webhooks/paypal", {
        method: "POST",
        headers: makeWebhookHeaders(),
        body: "{not-json",
      })
    );
    expect(malformedRes.status).toBe(400);

    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      isUnavailable: false,
      resetAt: Date.now() + 20_000,
    });

    const rlRes = await paypalWebhookPost(
      new Request("http://localhost:3000/api/webhooks/paypal", {
        method: "POST",
        body: JSON.stringify(makeOrderApprovedPayload()),
      })
    );
    expect(rlRes.status).toBe(429);

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ verification_status: "FAILURE" }), {
        status: 200,
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const rawBody = JSON.stringify(makeOrderApprovedPayload());
      const req = new Request("http://localhost:3000/api/webhooks/paypal", {
        method: "POST",
        headers: makeWebhookHeaders(),
        body: rawBody,
      });

      const res = await paypalWebhookPost(req);
      const json = await res.json();
      expect(res.status).toBe(401);
      expect(json.error).toBe("INVALID_WEBHOOK_SIGNATURE");
      expect(JSON.stringify(json)).not.toContain("platform-client-secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recoverPendingPayPalWebhookEvents processes due RETRY events and respects backoff/lease windows", async () => {
    const dueEnvelope = makeOrderApprovedPayload();
    const sha = createHash("sha256")
      .update(JSON.stringify(dueEnvelope), "utf8")
      .digest("hex");

    const futureIso = new Date(Date.now() + 120_000).toISOString();
    const pastIso = new Date(Date.now() - 10_000).toISOString();

    const { client } = createServiceClientMock({
      intentByOrderId: makePlatformIntent(),
      queuedWebhookRows: [
        {
          id: "wh-backoff-skip",
          provider_event_id: "WH-BACKOFF",
          event_type: "CHECKOUT.ORDER.APPROVED",
          payload_sha256: sha,
          payload: dueEnvelope,
          status: "RETRY",
          next_attempt_at: futureIso,
          signature_verified: true,
        },
        {
          id: EVENT_ROW_ID,
          provider_event_id: dueEnvelope.id,
          event_type: dueEnvelope.event_type,
          resource_type: dueEnvelope.resource_type,
          resource_id: ORDER_ID,
          payload_sha256: sha,
          payload: dueEnvelope,
          status: "RETRY",
          next_attempt_at: pastIso,
          signature_verified: true,
        },
      ],
      rpcHandler: async (fnName) => {
        if (fnName === "record_paypal_webhook_order_approved") {
          return {
            data: { success: true, transitioned: true, current_status: "BUYER_APPROVED" },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    });

    const mockPayPal = {
      post: vi.fn(),
      get: vi.fn().mockResolvedValue({
        data: {
          id: ORDER_ID,
          status: "APPROVED",
          purchase_units: [
            {
              reference_id: MILESTONE_ID,
              custom_id: INTENT_ID,
              payee: { merchant_id: SELLER_MERCHANT_ID },
              amount: { currency_code: "USD", value: "100.00" },
            },
          ],
        },
        status: 200,
      }),
    } as unknown as PayPalClient;

    const summary = await recoverPendingPayPalWebhookEvents({
      limit: 10,
      injectedServiceClient: client,
      injectedPayPalClient: mockPayPal,
      injectedPayPalEnv: basePlatformEnv,
    });

    expect(summary).toEqual({
      attempted: 1,
      processed: 1,
      deferred: 0,
      escalated: 0,
    });
  });

  it("surfaces R4 webhook processing outcomes cleanly in Payment Operations while isolating tenants", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "owner-123" } },
      error: null,
    });

    mockServerFrom.mockImplementation((table: string) => {
      if (table === "payment_intents") {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: INTENT_ID,
                  project_id: PROJECT_ID,
                  milestone_id: MILESTONE_ID,
                  status: "COMPLETED",
                  expected_amount_cents: 10000,
                  expected_amount_canonical: "100.00",
                  expected_currency: "USD",
                  expected_merchant_id: SELLER_MERCHANT_ID,
                  canonical_payload_json: makePlatformIntent().canonical_payload_json,
                  provider_order_id: ORDER_ID,
                  order_creation_lease_expires_at: null,
                  capture_lease_expires_at: null,
                  reconciliation_reason: null,
                  buyer_approved_at: null,
                  completed_at: "2026-11-11T12:01:00Z",
                  created_at: "2026-11-11T12:00:00Z",
                  updated_at: "2026-11-11T12:01:00Z",
                  projects: {
                    id: PROJECT_ID,
                    title: "Platform Project",
                    client_name: "Client A",
                    client_email: "c@example.com",
                    owner_id: "owner-123",
                  },
                  milestones: { id: MILESTONE_ID, title: "M1", status: "APPROVED" },
                },
              ],
              error: null,
            }),
          }),
        };
      }
      if (table === "payment_transactions") {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [
                {
                  id: TX_ROW_ID,
                  payment_intent_id: INTENT_ID,
                  provider_reference_id: CAPTURE_ID,
                  transaction_type: "CAPTURE",
                  status: "COMPLETED",
                  amount_cents: 10000,
                  currency: "USD",
                  captured_at: "2026-11-11T12:01:00Z",
                },
              ],
              error: null,
            }),
          }),
        };
      }
      return { select: vi.fn() };
    });

    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "provider_webhook_events") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: "wh-foreign-tenant",
                      provider_event_id: "WH-FOREIGN",
                      event_type: "PAYMENT.CAPTURE.COMPLETED",
                      resource_id: "FOREIGN-CAPTURE",
                      payment_intent_id: OTHER_INTENT_ID,
                      status: "FAILED",
                      processing_outcome: "REQUIRES_RECONCILIATION",
                      attempt_count: 5,
                      duplicate_delivery_count: 0,
                      signature_verified: true,
                      last_processed_at: "2026-11-11T12:02:00Z",
                      payload: {},
                    },
                    {
                      id: EVENT_ROW_ID,
                      provider_event_id: "WH-OWN-01",
                      event_type: "PAYMENT.CAPTURE.COMPLETED",
                      resource_id: CAPTURE_ID,
                      payment_intent_id: INTENT_ID,
                      status: "PROCESSED",
                      processing_outcome: "PROCESSED",
                      attempt_count: 1,
                      duplicate_delivery_count: 0,
                      signature_verified: true,
                      last_processed_at: "2026-11-11T12:01:05Z",
                      payload: {},
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return { select: vi.fn() };
    });

    const opsData = await getPaymentOperationsData();
    expect(opsData.rows).toHaveLength(1);
    expect(opsData.rows[0].webhookStatus).toBe("PROCESSED");
    expect(opsData.rows[0].webhookEventId).toBe(EVENT_ROW_ID);
    expect(opsData.rows[0].webhookEventType).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect(opsData.rows[0].webhookProviderEventId).toBe("WH-OWN-01");
  });
});
