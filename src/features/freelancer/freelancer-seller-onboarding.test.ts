import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getPayPalServerEnv } from "@/lib/paypal/env";
import { PayPalClient } from "@/lib/paypal/client";
import { PayPalAuthManager } from "@/lib/paypal/auth";

// Mock Supabase Server and Service
const mockRequireUser = vi.fn();
vi.mock("@/lib/auth/require-user", () => ({
  requireUser: () => mockRequireUser(),
}));

const mockCheckRateLimit = vi.fn().mockResolvedValue({ allowed: true, status: "allowed" });
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

let mockQueryResult: Record<string, unknown> | null = null;
let mockUpdateFn = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ id: "acc_1" }),
      }),
    }),
    select: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({ id: "acc_1" }),
    }),
  }),
});
let mockUpsertFn = vi.fn().mockResolvedValue({ error: null });
let mockRpcFn = vi.fn().mockResolvedValue({ data: [{ claimed: true }], error: null });

const mockQueryBuilder = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockImplementation(() => Promise.resolve({ data: mockQueryResult, error: null })),
  single: vi.fn().mockImplementation(() => Promise.resolve({ data: mockQueryResult, error: null })),
  upsert: vi.fn().mockImplementation((...args) => mockUpsertFn(...args)),
  update: vi.fn().mockImplementation((...args) => mockUpdateFn(...args)),
};

const mockServiceClient = {
  from: vi.fn().mockReturnValue(mockQueryBuilder),
  rpc: vi.fn().mockImplementation((...args) => mockRpcFn(...args)),
};
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => mockServiceClient,
}));

const mockSupabaseClient = {
  from: vi.fn().mockReturnValue(mockQueryBuilder),
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(mockSupabaseClient),
}));

describe("Phase 3B.R1.1: PayPal Onboarding Contract Verification & Hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYPAL_ENV = "sandbox";
    process.env.PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";
    process.env.PAYPAL_CLIENT_ID = "mock_client_id_123";
    process.env.PAYPAL_CLIENT_SECRET = "mock_client_secret_xyz";
    process.env.PAYPAL_EXPECTED_MERCHANT_ID = "MOCK_MERCHANT_ID_ABC";
    process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNER_MERCHANT_999";
    process.env.PAYPAL_PARTNER_ATTRIBUTION_ID = "PayRoost_Platform_PPCP";
    mockQueryResult = null;
    mockUpdateFn = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ id: "acc_1" }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ id: "acc_1" }),
        }),
      }),
    });
    mockUpsertFn = vi.fn().mockResolvedValue({ error: null });
    mockRpcFn = vi.fn().mockResolvedValue({ data: [{ claimed: true }], error: null });
    mockServiceClient.from.mockReturnValue(mockQueryBuilder);
    mockSupabaseClient.from.mockReturnValue(mockQueryBuilder);
  });

  // ==========================================================================
  // 1. Database Foundation & Hardening Migrations
  // ==========================================================================
  describe("1. Database Schema & Hardening Migrations", () => {
    const migrationR1Path = path.resolve(
      process.cwd(),
      "supabase/migrations/202611100003_freelancer_paypal_seller_accounts.sql"
    );
    const sqlR1 = fs.readFileSync(migrationR1Path, "utf8");

    const migrationR11Path = path.resolve(
      process.cwd(),
      "supabase/migrations/202611100004_freelancer_paypal_onboarding_hardening.sql"
    );
    const sqlR11 = fs.readFileSync(migrationR11Path, "utf8");

    it("verifies R1 foundation migration constraints and policies", () => {
      expect(sqlR1).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.freelancer_paypal_accounts/i);
      expect(sqlR1).toMatch(/user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\(id\)\s+on\s+delete\s+cascade\s+unique/i);
      expect(sqlR1).toMatch(/tracking_id\s+text\s+not\s+null\s+unique/i);
      expect(sqlR1).toMatch(/alter\s+table\s+public\.freelancer_paypal_accounts\s+enable\s+row\s+level\s+security;/i);
      expect(sqlR1).toMatch(/grant\s+select\s+on\s+public\.freelancer_paypal_accounts\s+to\s+authenticated;/i);
      expect(sqlR1).toMatch(/grant\s+all\s+on\s+public\.freelancer_paypal_accounts\s+to\s+service_role;/i);
    });

    it("verifies R1.1 hardening migration updates status constraint to include PROCESSING", () => {
      expect(sqlR11).toMatch(/freelancer_paypal_accounts_onboarding_status_check/i);
      expect(sqlR11).toMatch(/check\s*\(\s*onboarding_status\s+in\s*\(\s*'INITIATED',\s*'PROCESSING',\s*'COMPLETED',\s*'REVOKED',\s*'FAILED'\s*\)\s*\)/i);
    });

    it("verifies R1.1 hardening migration defines claim_freelancer_paypal_onboarding_callback RPC with row lock", () => {
      expect(sqlR11).toMatch(/create\s+or\s+replace\s+function\s+public\.claim_freelancer_paypal_onboarding_callback/i);
      expect(sqlR11).toMatch(/for\s+update/i);
      expect(sqlR11).toMatch(/grant\s+execute\s+on\s+function\s+public\.claim_freelancer_paypal_onboarding_callback\(uuid,\s*text\)\s+to\s+service_role;/i);
      expect(sqlR11).toMatch(/revoke\s+all\s+on\s+function\s+public\.claim_freelancer_paypal_onboarding_callback\(uuid,\s*text\)\s+from\s+public;/i);
    });
  });

  // ==========================================================================
  // 2. PayPal Platform Configuration & Partner Merchant ID Invariants
  // ==========================================================================
  describe("2. PayPal Configuration & Partner Merchant ID Invariants", () => {
    it("parses platform partner credentials and attribution ID cleanly", () => {
      const config = getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client_platform_123",
        PAYPAL_CLIENT_SECRET: "secret_platform_xyz",
        PAYPAL_EXPECTED_MERCHANT_ID: "MERCHANT_PLATFORM_ABC",
        PAYPAL_PARTNER_ATTRIBUTION_ID: "PayRoost_Platform_PPCP",
        PAYPAL_PARTNER_MERCHANT_ID: "PARTNER_MERCHANT_999",
      });
      expect(config.environment).toBe("sandbox");
      expect(config.partnerMerchantId).toBe("PARTNER_MERCHANT_999");
      expect(config.partnerAttributionId).toBe("PayRoost_Platform_PPCP");
    });

    it("removes silent fallback: partnerMerchantId is undefined when PAYPAL_PARTNER_MERCHANT_ID is absent", () => {
      const config = getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client_standard_123",
        PAYPAL_CLIENT_SECRET: "secret_standard_xyz",
        PAYPAL_EXPECTED_MERCHANT_ID: "MERCHANT_STANDARD_ABC",
        // PAYPAL_PARTNER_MERCHANT_ID is omitted
      });
      // Invariant: partnerMerchantId MUST NOT fall back to expectedMerchantId or clientId
      expect(config.partnerMerchantId).toBeUndefined();
      expect(config.expectedMerchantId).toBe("MERCHANT_STANDARD_ABC");
    });

    it("injects PayPal-Partner-Attribution-Id header when configured and strips when omitted", async () => {
      const configWithAttribution = getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client_1",
        PAYPAL_CLIENT_SECRET: "secret_1",
        PAYPAL_EXPECTED_MERCHANT_ID: "MCH_1",
        PAYPAL_PARTNER_ATTRIBUTION_ID: "PayRoost_BN_Code",
      });
      const mockAuth = { getAccessToken: vi.fn().mockResolvedValue("mock_token") };
      const client = new PayPalClient(configWithAttribution, mockAuth as unknown as PayPalAuthManager);

      let capturedHeaders: Headers | undefined;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url, init) => {
        capturedHeaders = new Headers(init.headers);
        return Promise.resolve(new Response(JSON.stringify({ links: [] }), { status: 200 }));
      }));

      await client.post("/v2/customer/partner-referrals", { test: true });
      expect(capturedHeaders?.get("PayPal-Partner-Attribution-Id")).toBe("PayRoost_BN_Code");

      // Without attribution ID configured
      const configWithoutAttribution = getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "client_1",
        PAYPAL_CLIENT_SECRET: "secret_1",
        PAYPAL_EXPECTED_MERCHANT_ID: "MCH_1",
      });
      const client2 = new PayPalClient(configWithoutAttribution, mockAuth as unknown as PayPalAuthManager);
      await client2.post("/v2/customer/partner-referrals", { test: true });
      expect(capturedHeaders?.get("PayPal-Partner-Attribution-Id")).toBeNull();

      vi.unstubAllGlobals();
    });

    it("attaches unencrypted JWT PayPal-Auth-Assertion with alg: none, iss: platformClientId, payer_id: sellerMerchantId", async () => {
      const config = getPayPalServerEnv({
        PAYPAL_ENV: "sandbox",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
        PAYPAL_CLIENT_ID: "standard_client_id",
        PAYPAL_CLIENT_SECRET: "standard_secret",
        PAYPAL_PLATFORM_CLIENT_ID: "platform_app_client_id",
        PAYPAL_EXPECTED_MERCHANT_ID: "MCH_1",
      });
      const mockAuth = { getAccessToken: vi.fn().mockResolvedValue("mock_token") };
      const client = new PayPalClient(config, mockAuth as unknown as PayPalAuthManager);

      let capturedHeaders: Headers | undefined;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url, init) => {
        capturedHeaders = new Headers(init.headers);
        return Promise.resolve(new Response(JSON.stringify({ status: "OK" }), { status: 200 }));
      }));

      await client.get("/v1/customer/partners/123/merchant-integrations/456", {
        authAssertion: { payerId: "SELLER_PAYER_ID_XYZ" },
      });

      const assertion = capturedHeaders?.get("PayPal-Auth-Assertion");
      expect(assertion).toBeDefined();
      const parts = assertion!.split(".");
      expect(parts.length).toBe(3);
      const headerObj = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      const payloadObj = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      expect(headerObj.alg).toBe("none");
      expect(payloadObj.payer_id).toBe("SELLER_PAYER_ID_XYZ");
      expect(payloadObj.iss).toBe("platform_app_client_id");

      vi.unstubAllGlobals();
    });
  });

  // ==========================================================================
  // 3. POST /api/app/freelancer/paypal/onboard Contract Verification
  // ==========================================================================
  describe("3. Seller Onboard Endpoint (POST) Official Schema Verification", () => {
    it("rejects unauthenticated caller with 401", async () => {
      mockRequireUser.mockRejectedValueOnce(new Error("Unauthorized"));
      const { POST } = await import("@/app/api/app/freelancer/paypal/onboard/route");
      const res = await POST();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("enforces official PayPal Partner Referrals v2 payload schema with third_party_details.features", async () => {
      mockRequireUser.mockResolvedValueOnce({
        user: { id: "a8e9d3b4-1111-4444-8888-abcdef123456", email: "freelancer@example.com" },
      });

      mockQueryResult = null;

      let capturedPayload: {
        tracking_id?: string;
        partner_config_override?: { return_url?: string };
        operations?: Array<{
          operation?: string;
          api_integration_preference?: {
            rest_api_integration?: {
              integration_method?: string;
              integration_type?: string;
              third_party_details?: {
                features?: string[];
              };
            };
          };
        }>;
        products?: string[];
        legal_consents?: Array<{ type?: string; granted?: boolean }>;
      } | undefined;

      vi.stubGlobal("fetch", vi.fn().mockImplementation((url, init) => {
        if (typeof url === "string" && url.includes("/v1/oauth2/token")) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: "token123", expires_in: 3600 }), { status: 200 }));
        }
        if (typeof url === "string" && url.includes("/v2/customer/partner-referrals")) {
          capturedPayload = JSON.parse(init.body);
          return Promise.resolve(new Response(JSON.stringify({
            links: [
              { href: "https://www.sandbox.paypal.com/bizsignup/partner/entry?token=test1234", rel: "action_url", method: "GET" },
            ],
            partner_referral_id: "ref_12345",
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }));

      const { POST } = await import("@/app/api/app/freelancer/paypal/onboard/route");
      const res = await POST();
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.success).toBe(true);
      expect(body.actionUrl).toContain("https://www.sandbox.paypal.com/bizsignup/partner/entry");
      expect(body.trackingId).toMatch(/^pr_track_[0-9a-f]{40}$/);

      // Verify tracking ID is NOT user's raw UUID
      expect(body.trackingId).not.toContain("a8e9d3b4-1111-4444-8888-abcdef123456");

      // Verify Partner Referral payload structure matches official PayPal docs
      expect(capturedPayload).toBeDefined();
      expect(capturedPayload?.tracking_id).toBe(body.trackingId);
      expect(capturedPayload?.partner_config_override?.return_url).toContain(`/api/app/freelancer/paypal/callback?state=${encodeURIComponent(body.trackingId)}`);
      expect(capturedPayload?.operations?.[0].operation).toBe("API_INTEGRATION");
      expect(capturedPayload?.operations?.[0].api_integration_preference?.rest_api_integration?.integration_method).toBe("PAYPAL");
      expect(capturedPayload?.operations?.[0].api_integration_preference?.rest_api_integration?.integration_type).toBe("THIRD_PARTY");
      expect(capturedPayload?.operations?.[0].api_integration_preference?.rest_api_integration?.third_party_details?.features).toEqual(["PAYMENT", "REFUND"]);
      expect(capturedPayload?.products).toEqual(["EXPRESS_CHECKOUT"]);
      expect(capturedPayload?.legal_consents?.[0].type).toBe("SHARE_DATA_CONSENT");
      expect(capturedPayload?.legal_consents?.[0].granted).toBe(true);

      vi.unstubAllGlobals();
    });

    it("returns alreadyConnected when seller is already COMPLETED and payments are receivable", async () => {
      mockRequireUser.mockResolvedValueOnce({
        user: { id: "user_connected_1", email: "connected@example.com" },
      });

      mockQueryResult = {
        id: "acc_1",
        onboarding_status: "COMPLETED",
        payments_receivable: true,
      };

      const { POST } = await import("@/app/api/app/freelancer/paypal/onboard/route");
      const res = await POST();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.alreadyConnected).toBe(true);
    });
  });

  // ==========================================================================
  // 4. GET /api/app/freelancer/paypal/callback Contract & Replay Hardening
  // ==========================================================================
  describe("4. Seller Callback Endpoint (GET) Parameter Mapping & Hardening", () => {
    it("redirects to invalid_state if tracking ID is missing", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=invalid_state");
      expect(res.headers.get("location")).toContain("MISSING_OR_INVALID_TRACKING_ID");
    });

    it("redirects to invalid_state if merchantId and state parameters mismatch", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_1111111111111111&state=pr_track_2222222222222222");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=invalid_state");
      expect(res.headers.get("location")).toContain("STATE_PARAM_MISMATCH");
    });

    it("extracts tracking ID from merchantId and seller ID from merchantIdInPayPal", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      mockQueryResult = {
        id: "acc_pending",
        user_id: "user_test_cb",
        tracking_id: "pr_track_valid_tracking_id",
        onboarding_status: "INITIATED",
        payments_receivable: false,
      };

      let queriedPartnerId = "";
      let queriedMerchantId = "";
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) => {
        if (typeof url === "string" && url.includes("/v1/oauth2/token")) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: "token123", expires_in: 3600 }), { status: 200 }));
        }
        if (typeof url === "string" && url.includes("/v1/customer/partners/")) {
          const match = url.match(/\/v1\/customer\/partners\/([^/]+)\/merchant-integrations\/([^/?]+)/);
          if (match) {
            queriedPartnerId = match[1];
            queriedMerchantId = match[2];
          }
          return Promise.resolve(new Response(JSON.stringify({
            merchant_id: "SELLER_PAYER_ID_789",
            tracking_id: "pr_track_valid_tracking_id",
            payments_receivable: true,
            primary_email_confirmed: true,
            primary_email: "seller789@example.com",
            oauth_third_party: [{ scopes: ["https://uri.paypal.com/services/payments/realtimepayment"] }],
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }));

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      // PayPal returns merchantId as tracking ID, and merchantIdInPayPal as seller ID
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_valid_tracking_id&merchantIdInPayPal=SELLER_PAYER_ID_789&permissionsGranted=true&consentStatus=true");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=connected");

      // Verifies endpoint was queried with partner ID and candidate seller ID (NOT tracking ID)
      expect(queriedPartnerId).toBe("PARTNER_MERCHANT_999");
      expect(queriedMerchantId).toBe("SELLER_PAYER_ID_789");

      // Verifies full unmasked merchant ID is persisted in database
      expect(mockUpdateFn).toHaveBeenCalledWith(expect.objectContaining({
        paypal_merchant_id: "SELLER_PAYER_ID_789",
        onboarding_status: "COMPLETED",
        payments_receivable: true,
        primary_email_confirmed: true,
        seller_email: "seller789@example.com",
      }));

      vi.unstubAllGlobals();
    });

    it("rejects callback if merchantIdInPayPal is missing even if merchantId (trackingId) is present", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      mockQueryResult = {
        id: "acc_pending",
        user_id: "user_test_cb",
        tracking_id: "pr_track_valid_tracking_id",
        onboarding_status: "INITIATED",
        payments_receivable: false,
      };

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      // Missing merchantIdInPayPal
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_valid_tracking_id&permissionsGranted=true&consentStatus=true");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=missing_merchant_id");

      expect(mockUpdateFn).toHaveBeenCalledWith(expect.objectContaining({
        onboarding_status: "FAILED",
        payments_receivable: false,
      }));
    });

    it("fails with config_error if PAYPAL_PARTNER_MERCHANT_ID is not configured", async () => {
      delete process.env.PAYPAL_PARTNER_MERCHANT_ID;
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      mockQueryResult = {
        id: "acc_pending",
        user_id: "user_test_cb",
        tracking_id: "pr_track_valid_tracking_id",
        onboarding_status: "INITIATED",
        payments_receivable: false,
      };

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_valid_tracking_id&merchantIdInPayPal=SELLER_123&permissionsGranted=true&consentStatus=true");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=config_error");
      expect(res.headers.get("location")).toContain("MISSING_PARTNER_MERCHANT_ID");
    });

    it("replay protection: replaying callback on COMPLETED account redirects to already_connected without mutating DB", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      mockQueryResult = {
        id: "acc_already_done",
        user_id: "user_test_cb",
        tracking_id: "pr_track_completed_123",
        onboarding_status: "COMPLETED",
        payments_receivable: true,
        paypal_merchant_id: "EXISTING_VERIFIED_MERCHANT",
      };

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_completed_123&merchantIdInPayPal=NEW_UNVERIFIED_SPOOF&permissionsGranted=true&consentStatus=true");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=already_connected");

      // Must NOT call PayPal API or mutate database
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockUpdateFn).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("replay protection: replaying callback on REVOKED account redirects to consent_declined without re-verifying", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      mockQueryResult = {
        id: "acc_revoked",
        user_id: "user_test_cb",
        tracking_id: "pr_track_revoked_123",
        onboarding_status: "REVOKED",
        payments_receivable: false,
      };

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_revoked_123&merchantIdInPayPal=SELLER_123");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=consent_declined");
      expect(res.headers.get("location")).toContain("ALREADY_REVOKED");
    });

    it("concurrency fencing: rejects concurrent callback attempt if another process is in PROCESSING", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      mockQueryResult = {
        id: "acc_processing",
        user_id: "user_test_cb",
        tracking_id: "pr_track_in_flight",
        onboarding_status: "PROCESSING",
        payments_receivable: false,
      };

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_in_flight&merchantIdInPayPal=SELLER_123");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=processing");
      expect(res.headers.get("location")).toContain("CONCURRENT_VERIFICATION_IN_FLIGHT");
    });

    it("cross-user isolation: rejects callback when tracking ID belongs to a different user", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_attacker" } });

      // DB query with user_id = user_attacker returns null because tracking ID belongs to user_victim
      mockQueryResult = null;

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_victim_account&merchantIdInPayPal=ATTACKER_MERCHANT");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=invalid_state");
      expect(res.headers.get("location")).toContain("STATE_NOT_FOUND_OR_USER_MISMATCH");
    });

    it("fails verification when PayPal returns mismatched tracking_id", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });

      mockQueryResult = {
        id: "acc_pending",
        user_id: "user_test_cb",
        tracking_id: "pr_track_expected_123",
        onboarding_status: "INITIATED",
        payments_receivable: false,
      };

      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) => {
        if (typeof url === "string" && url.includes("/v1/oauth2/token")) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: "token123", expires_in: 3600 }), { status: 200 }));
        }
        if (typeof url === "string" && url.includes("/v1/customer/partners/")) {
          return Promise.resolve(new Response(JSON.stringify({
            merchant_id: "SELLER_123",
            tracking_id: "pr_track_DIFFERENT_SPOOF", // Mismatched provider tracking ID!
            payments_receivable: true,
            primary_email_confirmed: true,
          }), { status: 200 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }));

      const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");
      const req = new Request("http://localhost:3000/api/app/freelancer/paypal/callback?merchantId=pr_track_expected_123&merchantIdInPayPal=SELLER_123&permissionsGranted=true&consentStatus=true");
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("paypal_status=verification_failed");
      expect(res.headers.get("location")).toContain("PROVIDER_TRACKING_ID_MISMATCH");

      expect(mockUpdateFn).toHaveBeenCalledWith(expect.objectContaining({
        onboarding_status: "FAILED",
        payments_receivable: false,
      }));

      vi.unstubAllGlobals();
    });

    it("enforces canonical app URL in onboard/callback and fails closed in production when unconfigured", async () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origAppUrl = process.env.PAYROOST_APP_URL;
      const origNextPublicUrl = process.env.NEXT_PUBLIC_APP_URL;

      try {
        (process.env as Record<string, string | undefined>).NODE_ENV = "production";
        delete process.env.PAYROOST_APP_URL;
        delete process.env.NEXT_PUBLIC_APP_URL;

        const { POST } = await import("@/app/api/app/freelancer/paypal/onboard/route");
        const { GET } = await import("@/app/api/app/freelancer/paypal/callback/route");

        mockRequireUser.mockResolvedValueOnce({
          user: { id: "user_prod_no_url", email: "freelancer@example.com" },
        });
        mockQueryResult = null;
        const onboardMissingRes = await POST();
        expect(onboardMissingRes.status).toBe(503);
        expect(onboardMissingRes.headers.get("Cache-Control")).toBe("no-store");
        expect((await onboardMissingRes.json()).error).toBe("CONFIGURATION_UNAVAILABLE");

        const callbackMissingRes = await GET(
          new Request("https://attacker.example/api/app/freelancer/paypal/callback?state=pr_track_1")
        );
        expect(callbackMissingRes.status).toBe(503);
        expect(callbackMissingRes.headers.get("Cache-Control")).toBe("no-store");
        expect((await callbackMissingRes.json()).error).toBe("CONFIGURATION_UNAVAILABLE");

        process.env.PAYROOST_APP_URL = "https://portal.payroost.com///";
        mockRequireUser.mockResolvedValueOnce({ user: { id: "user_test_cb" } });
        const callbackValidRes = await GET(
          new Request("https://untrusted.example/api/app/freelancer/paypal/callback")
        );
        expect(callbackValidRes.status).toBe(302);
        expect(callbackValidRes.headers.get("location")).toBe(
          "https://portal.payroost.com/app/settings?paypal_status=invalid_state&reason=MISSING_OR_INVALID_TRACKING_ID"
        );
      } finally {
        if (origNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
        else (process.env as Record<string, string | undefined>).NODE_ENV = origNodeEnv;
        if (origAppUrl === undefined) delete process.env.PAYROOST_APP_URL;
        else process.env.PAYROOST_APP_URL = origAppUrl;
        if (origNextPublicUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
        else process.env.NEXT_PUBLIC_APP_URL = origNextPublicUrl;
        vi.unstubAllGlobals();
      }
    });

    it("returns sanitized JSON error body and valid headers on onboard referral errors without leaking upstream details", async () => {
      mockRequireUser.mockResolvedValue({
        user: { id: "user_ref_err", email: "freelancer@example.com" },
      });
      mockQueryResult = null;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url) => {
          if (typeof url === "string" && url.includes("/v1/oauth2/token")) {
            return Promise.resolve(
              new Response(JSON.stringify({ access_token: "token123", expires_in: 3600 }), {
                status: 200,
              })
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                name: "INVALID_REQUEST",
                message: "Sensitive upstream credential/token dump: sk_live_secret",
              }),
              { status: 500 }
            )
          );
        })
      );

      const { POST } = await import("@/app/api/app/freelancer/paypal/onboard/route");
      const failRes = await POST();
      expect(failRes.status).toBe(502);
      expect(failRes.headers.get("Cache-Control")).toBe("no-store");
      expect(failRes.headers.get("details")).toBeNull();
      expect(failRes.headers.get("message")).toBeNull();
      const failBody = await failRes.json();
      expect(failBody.error).toBe("PAYPAL_REFERRAL_FAILED");
      expect(typeof failBody.message).toBe("string");
      expect(JSON.stringify(failBody)).not.toContain("sk_live_secret");

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url) => {
          if (typeof url === "string" && url.includes("/v1/oauth2/token")) {
            return Promise.resolve(
              new Response(JSON.stringify({ access_token: "token123", expires_in: 3600 }), {
                status: 200,
              })
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ links: [] }), { status: 200 })
          );
        })
      );

      const malformedRes = await POST();
      expect(malformedRes.status).toBe(502);
      expect(malformedRes.headers.get("Cache-Control")).toBe("no-store");
      expect(malformedRes.headers.get("message")).toBeNull();
      const malformedBody = await malformedRes.json();
      expect(malformedBody.error).toBe("MALFORMED_REFERRAL_RESPONSE");
      expect(typeof malformedBody.message).toBe("string");

      vi.unstubAllGlobals();
    });
  });

  // ==========================================================================
  // 5. GET /api/app/freelancer/paypal/status
  // ==========================================================================
  describe("5. Seller Status Endpoint (GET)", () => {
    it("returns safe un-connected structure when no record exists", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_no_acc" } });
      mockQueryResult = null;

      const { GET } = await import("@/app/api/app/freelancer/paypal/status/route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isConnected).toBe(false);
      expect(body.onboardingStatus).toBe("NOT_STARTED");
      expect(body.paymentsReceivable).toBe(false);
      expect(body.sellerMerchantIdMasked).toBeNull();
    });

    it("masks merchant ID and returns true isConnected strictly when verified", async () => {
      mockRequireUser.mockResolvedValueOnce({ user: { id: "user_verified_seller" } });

      mockQueryResult = {
        id: "acc_ok",
        onboarding_status: "COMPLETED",
        payments_receivable: true,
        primary_email_confirmed: true,
        paypal_merchant_id: "XYZ123456789ABC",
        seller_email: "seller@payroost.test",
        connected_at: "2026-11-10T12:00:00Z",
      };

      const { GET } = await import("@/app/api/app/freelancer/paypal/status/route");
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isConnected).toBe(true);
      expect(body.onboardingStatus).toBe("COMPLETED");
      expect(body.paymentsReceivable).toBe(true);
      expect(body.primaryEmailConfirmed).toBe(true);
      expect(body.sellerMerchantIdMasked).toBe("XYZ***ABC");
      expect(body.sellerEmail).toBe("seller@payroost.test");
    });
  });
});
