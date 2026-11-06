import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POST as dispatchOtp } from "./[token]/otp/route";
import * as emailProvider from "@/lib/email/provider";
import { hashPortalToken, createPortalToken } from "@/lib/security/tokens";
import {
  getPortalTokenRateLimitKey,
  getPortalIpRateLimitKey,
} from "@/lib/security/client-ip";
import * as serviceClientModule from "@/lib/supabase/service";
import * as publicEnvModule from "@/lib/supabase/env";

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: mockRpc,
  })),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => ({
    rpc: mockRpc,
  })),
  getSupabaseServiceEnv: vi.fn(),
}));

describe("Phase 3B.2.5.1: OTP Challenge Authorization Audit and Remediation", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHmacSecret = process.env.PORTAL_OTP_HMAC_SECRET;
  const validRawToken = "valid-test-portal-token-43-chars-long-base64url_";

  beforeEach(() => {
    vi.clearAllMocks();
    emailProvider.emailDeliveryLog.length = 0;
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    process.env.PORTAL_OTP_HMAC_SECRET = "test-hmac-secret-min-32-bytes-long-for-testing!!";

    mockRpc.mockImplementation((rpcName: string) => {
      if (rpcName === "consume_rate_limit") {
        return Promise.resolve({
          data: { allowed: true, current: 1, limit: 5, resetAt: new Date(Date.now() + 60000).toISOString() },
          error: null,
        });
      }
      if (rpcName === "create_portal_otp_challenge") {
        return Promise.resolve({
          data: {
            challengeId: "c0000000-0000-4000-a000-000000000001",
            clientEmail: "verified-client@acme-corp.com",
            projectTitle: "Production Payment Integration",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    process.env.PORTAL_OTP_HMAC_SECRET = originalHmacSecret;
  });

  // ==========================================================================
  // 1, 2, 3: Database Migration Privileges & Effective Grants
  // ==========================================================================
  describe("Database Migration 202611030013: Challenge-Creation Authorization", () => {
    const migrationPath = resolve(
      process.cwd(),
      "supabase/migrations/202611030013_harden_portal_otp_challenge_authorization.sql"
    );
    const sql = readFileSync(migrationPath, "utf-8");

    it("1. revokes execute on create_portal_otp_challenge from anon", () => {
      expect(sql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_portal_otp_challenge\s*\([^)]*\)\s+from\s+[^;]*anon/i
      );
    });

    it("2. revokes execute on create_portal_otp_challenge from authenticated", () => {
      expect(sql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.create_portal_otp_challenge\s*\([^)]*\)\s+from\s+[^;]*authenticated/i
      );
    });

    it("3. grants execute on create_portal_otp_challenge exclusively to service_role", () => {
      expect(sql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.create_portal_otp_challenge\s*\([^)]*\)\s+to\s+service_role\s*;/i
      );
      // Ensures no grant to anon or authenticated remains in the remediation migration
      expect(sql).not.toMatch(
        /grant\s+execute\s+on\s+function\s+public\.create_portal_otp_challenge\s*\([^)]*\)\s+to\s+[^;]*(?:anon|authenticated)/i
      );
    });
  });

  // ==========================================================================
  // 4, 5: OTP Dispatch Route Uses Service-Role Client & Verified Email
  // ==========================================================================
  describe("OTP Dispatch Route: Privileged Challenge Creation & Email Target", () => {
    it("4. OTP dispatch route invokes create_portal_otp_challenge via server-only service-role client", async () => {
      const createServiceClientSpy = vi.spyOn(serviceClientModule, "createServiceClient");

      const req = new Request(`https://payroost.com/api/public/portal/${validRawToken}/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const res = await dispatchOtp(req, { params: Promise.resolve({ token: validRawToken }) });
      expect(res.status).toBe(200);

      expect(createServiceClientSpy).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith(
        "create_portal_otp_challenge",
        expect.objectContaining({
          p_portal_token_hash: hashPortalToken(validRawToken),
        })
      );
    });

    it("5. route sends the generated OTP strictly to the verified client email returned by the database", async () => {
      const sendSpy = vi.spyOn(emailProvider, "sendPortalOtpEmail").mockResolvedValueOnce({
        success: true,
        messageId: "mock-email-id-555",
      });

      const req = new Request(`https://payroost.com/api/public/portal/${validRawToken}/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const res = await dispatchOtp(req, { params: Promise.resolve({ token: validRawToken }) });
      expect(res.status).toBe(200);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const emailArgs = sendSpy.mock.calls[0][0];
      // Target must match database return exactly, regardless of what caller passes
      expect(emailArgs.clientEmail).toBe("verified-client@acme-corp.com");
      expect(emailArgs.projectTitle).toBe("Production Payment Integration");
      expect(emailArgs.otpCode).toMatch(/^\d{6}$/);
    });
  });

  // ==========================================================================
  // 6: Service-Role Key Isolation from Browser
  // ==========================================================================
  describe("Service-Role Credential Boundary & Isolation", () => {
    it("6. verifies server-only guard protects service.ts and server-env.ts and public env does not expose service key", () => {
      const serviceFile = readFileSync(resolve(process.cwd(), "src/lib/supabase/service.ts"), "utf-8");
      const serverEnvFile = readFileSync(resolve(process.cwd(), "src/lib/supabase/server-env.ts"), "utf-8");

      expect(serviceFile).toMatch(/^import\s+["']server-only["'];/m);
      expect(serverEnvFile).toMatch(/^import\s+["']server-only["'];/m);

      // Verify client-accessible publicEnv module exports NO service-role functions or keys
      expect(publicEnvModule).not.toHaveProperty("getSupabaseServiceEnv");
      expect(publicEnvModule).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    });
  });

  // ==========================================================================
  // 7: Table Direct Access Revocations
  // ==========================================================================
  describe("Direct Table Permissions Audit", () => {
    it("7. confirms client_portal_otp_challenges has RLS enabled and all direct mutations revoked from anon and authenticated", () => {
      const migration5 = readFileSync(
        resolve(process.cwd(), "supabase/migrations/202611030005_payment_foundation_and_ledger.sql"),
        "utf-8"
      );

      expect(migration5).toMatch(
        /alter\s+table\s+public\.client_portal_otp_challenges\s+enable\s+row\s+level\s+security\s*;/i
      );
      expect(migration5).toMatch(
        /revoke\s+all\s+on\s+public\.client_portal_otp_challenges\s+from\s+public,\s*anon,\s*authenticated\s*;/i
      );
    });
  });

  // ==========================================================================
  // 8: Cross-Invitation Challenge Binding Protection
  // ==========================================================================
  describe("Verification RPC Challenge Binding", () => {
    it("8. confirms verify_portal_otp_and_create_session rejects challenges bound to another invitation token", () => {
      const migration12 = readFileSync(
        resolve(process.cwd(), "supabase/migrations/202611030012_portal_session_verification_hardening.sql"),
        "utf-8"
      );

      // Must check both portal_token_id and project_id relational binding
      expect(migration12).toMatch(/v_challenge\.portal_token_id\s*<>\s*v_token\.id/i);
      expect(migration12).toMatch(/v_challenge\.project_id\s*<>\s*v_token\.project_id/i);
      expect(migration12).toMatch(/'CHALLENGE_NOT_FOUND'/i);
    });
  });

  // ==========================================================================
  // 9: Persistent Attempt Counting & 5-Attempt Ceiling
  // ==========================================================================
  describe("Verification Attempt Counting Invariants", () => {
    it("9. confirms attempt counter is incremented before HMAC comparison and commits on mismatch", () => {
      const migration12 = readFileSync(
        resolve(process.cwd(), "supabase/migrations/202611030012_portal_session_verification_hardening.sql"),
        "utf-8"
      );

      expect(migration12).toMatch(
        /update\s+public\.client_portal_otp_challenges\s+set\s+attempts\s*=\s*attempts\s*\+\s*1/i
      );
      expect(migration12).toMatch(/returning\s+attempts\s+into\s+v_new_attempts\s*;/i);
      expect(migration12).toMatch(/v_new_attempts\s*>=\s*5/i);
      expect(migration12).toMatch(/'OTP_EXHAUSTED'/i);
    });
  });

  // ==========================================================================
  // 10: Logout Works After Invitation Consumption
  // ==========================================================================
  describe("Session Revocation After Token Consumption", () => {
    it("10. confirms revoke_portal_session_v2 resolves project_id without requiring consumed_at IS NULL", () => {
      const migration12 = readFileSync(
        resolve(process.cwd(), "supabase/migrations/202611030012_portal_session_verification_hardening.sql"),
        "utf-8"
      );

      // Looks up token by hash without filtering out consumed tokens
      expect(migration12).toMatch(
        /select\s+project_id\s+into\s+v_project_id\s+from\s+public\.client_portal_tokens\s+where\s+token_hash\s*=\s*lower\(trim\(p_portal_token_hash\)\)\s*;/i
      );
      // Ensures consumed_at is NOT checked in the revocation lookup
      expect(migration12).not.toMatch(
        /where\s+token_hash\s*=\s*lower\(trim\(p_portal_token_hash\)\)\s+and\s+consumed_at\s+is\s+null/i
      );
    });
  });

  // ==========================================================================
  // 11: Rate-Limit Keys Use Full 64-Character SHA-256 Hash
  // ==========================================================================
  describe("Full 64-Character Token Hash in Rate Limiter Keys", () => {
    it("11. verifies getPortalTokenRateLimitKey formats with full 64-character hash", () => {
      const sampleToken = createPortalToken();
      const tokenHash = hashPortalToken(sampleToken);

      expect(tokenHash).toHaveLength(64);
      expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);

      const getKey = getPortalTokenRateLimitKey("portal-get", tokenHash);
      const otpKey = getPortalTokenRateLimitKey("portal-otp", tokenHash);
      const sessionKey = getPortalTokenRateLimitKey("portal-session", tokenHash);

      expect(getKey).toBe(`portal-get:${tokenHash}`);
      expect(otpKey).toBe(`portal-otp:${tokenHash}`);
      expect(sessionKey).toBe(`portal-session:${tokenHash}`);

      // Ensure key length is exactly prefix.length + 1 + 64
      expect(getKey.length).toBe("portal-get".length + 1 + 64);
      expect(otpKey.length).toBe("portal-otp".length + 1 + 64);
      expect(sessionKey.length).toBe("portal-session".length + 1 + 64);

      // Verify IP key does not contain token hash
      const ipKey = getPortalIpRateLimitKey("portal-otp", "198.51.100.25");
      expect(ipKey).toBe("portal-otp-ip:198.51.100.25");
      expect(ipKey).not.toContain(tokenHash);
    });
  });
});
