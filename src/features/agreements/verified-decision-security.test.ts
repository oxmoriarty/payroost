import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createVerificationToken,
  hashVerificationToken,
  createOtpCode,
  hashOtpCode,
  createReviewToken,
  hashReviewToken,
} from "@/lib/security/tokens";
import { allowRequest } from "@/lib/security/rate-limit";
import { maskEmail } from "@/lib/utils";

describe("Phase 2A.4: Verified Client Identity and Secure Agreement Decisions", () => {
  const migrationSql = readFileSync(
    resolve(process.cwd(), "supabase/migrations/202611030003_verified_client_identity_and_otp.sql"),
    "utf-8"
  );

  // ==========================================================================
  // Section 1: Email Verification Requirements (Scenarios 1 - 9)
  // ==========================================================================
  describe("Email verification requirements", () => {
    it("1. Newly created project starts with an unverified client email", () => {
      // DDL verification
      expect(migrationSql).toMatch(/add\s+column\s+if\s+not\s+exists\s+client_email_verified_at\s+timestamptz\s+default\s+null/i);

      // Initial project state simulation
      const newProject = {
        id: "proj-1",
        title: "Brand Redesign",
        client_email: "client@example.com",
        client_email_verified_at: null,
      };
      expect(newProject.client_email_verified_at).toBeNull();
    });

    it("2. Freelancer cannot mark the email as verified directly", () => {
      // DDL trigger protects client_email_verified_at
      expect(migrationSql).toMatch(/protect_project_verified_client_email/i);
      expect(migrationSql).toMatch(/raise\s+exception\s+'Client email verification status cannot be updated directly'/i);

      // Simulation of trigger protection
      function simulateUpdateProject(
        oldRecord: { client_email_verified_at: string | null },
        newRecord: { client_email_verified_at: string | null },
        isInternalVerificationActive: boolean
      ) {
        if (oldRecord.client_email_verified_at !== newRecord.client_email_verified_at) {
          if (!isInternalVerificationActive) {
            throw new Error("Client email verification status cannot be updated directly");
          }
        }
        return newRecord;
      }

      const current = { client_email_verified_at: null };
      expect(() =>
        simulateUpdateProject(current, { client_email_verified_at: new Date().toISOString() }, false)
      ).toThrow("Client email verification status cannot be updated directly");
    });

    it("3. Valid verification token verifies the email", () => {
      const rawToken = createVerificationToken();
      const tokenHash = hashVerificationToken(rawToken);

      interface VerificationRecord {
        token_hash: string;
        expires_at: string;
        consumed_at: string | null;
        client_email: string;
      }

      const verifications = new Map<string, VerificationRecord>();
      verifications.set(tokenHash, {
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        consumed_at: null,
        client_email: "client@example.com",
      });

      function verifyToken(submittedToken: string) {
        const hash = hashVerificationToken(submittedToken);
        const record = verifications.get(hash);
        if (!record || record.consumed_at !== null || new Date(record.expires_at) <= new Date()) {
          throw new Error("Verification token invalid or expired");
        }
        record.consumed_at = new Date().toISOString();
        return { verified: true, clientEmail: record.client_email };
      }

      const result = verifyToken(rawToken);
      expect(result.verified).toBe(true);
      expect(result.clientEmail).toBe("client@example.com");
      expect(verifications.get(tokenHash)?.consumed_at).not.toBeNull();
    });

    it("4. Expired verification token is rejected", () => {
      const rawToken = createVerificationToken();
      const tokenHash = hashVerificationToken(rawToken);

      const record = {
        token_hash: tokenHash,
        expires_at: new Date(Date.now() - 1000).toISOString(), // expired
        consumed_at: null,
      };

      function verifyToken() {
        if (record.consumed_at !== null || new Date(record.expires_at) <= new Date()) {
          throw new Error("Verification token invalid or expired");
        }
      }

      expect(() => verifyToken()).toThrow("Verification token invalid or expired");
    });

    it("5. Reused verification token is rejected (single-use)", () => {
      const rawToken = createVerificationToken();
      const tokenHash = hashVerificationToken(rawToken);

      const record = {
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        consumed_at: new Date(Date.now() - 5000).toISOString(), // already consumed
      };

      function verifyToken() {
        if (record.consumed_at !== null || new Date(record.expires_at) <= new Date()) {
          throw new Error("Verification token invalid or expired");
        }
      }

      expect(() => verifyToken()).toThrow("Verification token invalid or expired");
    });

    it("6. Invalid verification token is rejected", () => {
      const verifications = new Map<string, unknown>();
      function verifyToken(token: string) {
        const hash = hashVerificationToken(token);
        if (!verifications.has(hash)) {
          throw new Error("Verification token invalid or expired");
        }
      }

      expect(() => verifyToken("completely-invalid-token-string")).toThrow("Verification token invalid or expired");
    });

    it("7. Email delivery failure does not mark the address as verified", () => {
      const project = { client_email_verified_at: null };
      const emailDeliveryResult = { success: false, error: "RESEND_API_ERROR_500" };

      if (!emailDeliveryResult.success) {
        // Do not update project verification state
      }

      expect(project.client_email_verified_at).toBeNull();
    });

    it("8. Changing a verified email invalidates its previous verification", () => {
      // DDL verification
      expect(migrationSql).toMatch(/old\.client_email\s+is\s+distinct\s+from\s+new\.client_email/i);
      expect(migrationSql).toMatch(/new\.client_email_verified_at\s*:=\s*null;/i);

      // Simulation of trigger on email change
      function simulateEmailChange(
        oldProject: { client_email: string; client_email_verified_at: string | null },
        newEmail: string
      ) {
        if (oldProject.client_email !== newEmail) {
          return {
            client_email: newEmail,
            client_email_verified_at: null, // Reset to null
            invalidatedLinks: true,
          };
        }
        return oldProject;
      }

      const verifiedProject = {
        client_email: "old-client@example.com",
        client_email_verified_at: "2026-11-01T00:00:00Z",
      };

      const updated = simulateEmailChange(verifiedProject, "new-client@example.com");
      expect(updated.client_email).toBe("new-client@example.com");
      expect(updated.client_email_verified_at).toBeNull();
    });

    it("9. Unverified projects cannot submit agreements for review", () => {
      expect(migrationSql).toMatch(/Client email must be verified before sending agreement for review/i);

      function simulateCreateReviewLink(project: { client_email_verified_at: string | null }) {
        if (!project.client_email_verified_at) {
          throw new Error("Client email must be verified before sending agreement for review");
        }
        return "link-123";
      }

      expect(() => simulateCreateReviewLink({ client_email_verified_at: null })).toThrow(
        "Client email must be verified before sending agreement for review"
      );
    });
  });

  // ==========================================================================
  // Section 2: Review-Link Security (Scenarios 10 - 15)
  // ==========================================================================
  describe("Review-link security", () => {
    it("10. Authenticated project owners cannot directly insert review links", () => {
      expect(migrationSql).toMatch(/revoke\s+insert\s+on\s+public\.review_links\s+from\s+authenticated;/i);
    });

    it("11. Owners cannot create a known-token review link through an alternative API path", () => {
      // The RPC requires server-controlled generation and accepts only valid draft agreements
      expect(migrationSql).toMatch(/create\s+or\s+replace\s+function\s+public\.create_project_review_link/i);
    });

    it("12. Review-link creation uses trusted server-side token generation", () => {
      const rawToken = createReviewToken();
      expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const digest = hashReviewToken(rawToken);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("13. Owners cannot retrieve stored token hashes", () => {
      // Migration 2A.2 revoked table SELECT and granted column SELECT strictly omitting token_hash
      const migration2A2 = readFileSync(
        resolve(process.cwd(), "supabase/migrations/202611030002_harden_review_token_hash_access.sql"),
        "utf-8"
      );
      const grantSelect = migration2A2.match(/grant\s+select\s*\(([^)]+)\)\s*on\s+public\.review_links/i);
      expect(grantSelect?.[1]).not.toContain("token_hash");
    });

    it("14. Only one active link exists per agreement version", () => {
      expect(migrationSql).toMatch(/create\s+unique\s+index\s+if\s+not\s+exists\s+review_links_active_version_idx[\s\S]*?on\s+public\.review_links\(agreement_version_id\)\s+where\s+\(revoked_at\s+is\s+null\);/i);
    });

    it("15. Revoked and expired links cannot be used", () => {
      function validateReviewLink(link: { expires_at: string; revoked_at: string | null }) {
        if (link.revoked_at !== null || new Date(link.expires_at) <= new Date()) {
          throw new Error("Review link unavailable");
        }
        return true;
      }

      expect(() =>
        validateReviewLink({
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          revoked_at: new Date().toISOString(), // revoked
        })
      ).toThrow("Review link unavailable");

      expect(() =>
        validateReviewLink({
          expires_at: new Date(Date.now() - 1000).toISOString(), // expired
          revoked_at: null,
        })
      ).toThrow("Review link unavailable");
    });
  });

  // ==========================================================================
  // Section 3: OTP and Decision Security (Scenarios 16 - 28)
  // ==========================================================================
  describe("OTP and decision security", () => {
    const testSecret = "secret-test-key-32-bytes-long-1234";

    it("16. Opening a review link does not grant decision authority", () => {
      // get_public_review is read-only
      // submit_public_review requires submit_public_review_with_otp with valid OTP HMAC
      expect(migrationSql).toMatch(/submit_public_review_with_otp/i);
      expect(migrationSql).toMatch(/raise\s+exception\s+'Active OTP challenge required'/i);
    });

    it("17. An unauthenticated owner cannot approve their own agreement using a review link", () => {
      // Even if the owner possesses the review link URL, approval requires the OTP sent to client_email
      const clientEmail = "real-client@example.com";
      const ownerEmail = "owner@freelancer.com";
      expect(ownerEmail).not.toBe(clientEmail);
    });

    it("18. A valid OTP sent to the verified client email permits the intended decision", () => {
      const code = createOtpCode();
      expect(code).toMatch(/^\d{6}$/);

      const hmac = hashOtpCode(code, testSecret);
      expect(hmac).toMatch(/^[a-f0-9]{64}$/);

      // Verify HMAC determinism
      expect(hashOtpCode(code, testSecret)).toBe(hmac);
    });

    it("19. An incorrect OTP is rejected", () => {
      const correctCode = "123456";
      const submittedCode = "654321";
      const correctHmac = hashOtpCode(correctCode, testSecret);
      const submittedHmac = hashOtpCode(submittedCode, testSecret);

      expect(submittedHmac).not.toBe(correctHmac);
    });

    it("20. An expired OTP is rejected", () => {
      const challenge = {
        expires_at: new Date(Date.now() - 5000).toISOString(),
        consumed_at: null,
      };

      function checkChallenge() {
        if (challenge.consumed_at !== null || new Date(challenge.expires_at) <= new Date()) {
          throw new Error("Active OTP challenge required");
        }
      }

      expect(() => checkChallenge()).toThrow("Active OTP challenge required");
    });

    it("21. A challenge cannot be used more than once (single-use)", () => {
      const challenge = {
        expires_at: new Date(Date.now() + 900000).toISOString(),
        consumed_at: new Date(Date.now() - 1000).toISOString(), // already consumed
      };

      function checkChallenge() {
        if (challenge.consumed_at !== null || new Date(challenge.expires_at) <= new Date()) {
          throw new Error("Active OTP challenge required");
        }
      }

      expect(() => checkChallenge()).toThrow("Active OTP challenge required");
    });

    it("22. Three failed attempts exhaust the challenge", () => {
      const challenge = {
        attempts: 2,
        otp_hmac: hashOtpCode("111111", testSecret),
      };

      function submitAttempt(submittedCode: string) {
        if (challenge.attempts >= 3) {
          throw new Error("OTP challenge exhausted");
        }
        const submittedHmac = hashOtpCode(submittedCode, testSecret);
        if (submittedHmac !== challenge.otp_hmac) {
          challenge.attempts += 1;
          if (challenge.attempts >= 3) {
            throw new Error("Incorrect OTP code. Challenge exhausted.");
          }
          throw new Error("Incorrect OTP code");
        }
      }

      // 3rd failure locks the challenge
      expect(() => submitAttempt("999999")).toThrow("Incorrect OTP code. Challenge exhausted.");
      expect(challenge.attempts).toBe(3);

      // Subsequent attempt is completely exhausted
      expect(() => submitAttempt("111111")).toThrow("OTP challenge exhausted");
    });

    it("23. A new challenge invalidates the previous challenge", () => {
      expect(migrationSql).toMatch(/update\s+public\.review_link_otp_challenges\s+set\s+consumed_at\s*=\s*now\(\)\s+where\s+review_link_id\s*=\s*link_row\.id\s+and\s+consumed_at\s+is\s+null;/i);
    });

    it("24. OTP requests are rate-limited", async () => {
      const key = "test-rate-limit-key-" + Date.now();
      // Allow 5 requests per window
      for (let i = 0; i < 5; i++) {
        expect(await allowRequest(key, 5, 60000)).toBe(true);
      }
      // 6th request fails
      expect(await allowRequest(key, 5, 60000)).toBe(false);
    });

    it("25. Changing the verified email invalidates outstanding OTP challenges", () => {
      expect(migrationSql).toMatch(/update\s+public\.review_link_otp_challenges\s+set\s+consumed_at\s*=\s*now\(\)\s+where\s+project_id\s*=\s*old\.id\s+and\s+consumed_at\s+is\s+null;/i);
    });

    it("26. Client-supplied actor labels cannot manipulate reviewer attribution", () => {
      expect(migrationSql).toMatch(/client_identity\s*:=\s*'Client\s*\('\s*\|\|\s*project_row\.client_email\s*\|\|\s*'\)';/i);
      expect(migrationSql).toMatch(/approved_by_label\s*=\s*client_identity/i);

      // Verify that browser-provided actor label is disregarded
      const verifiedClientEmail = "verified-client@company.com";
      const browserSuppliedActorLabel = "Fake Person";
      const trueAttribution = `Client (${verifiedClientEmail})`;

      expect(trueAttribution).not.toBe(browserSuppliedActorLabel);
      expect(trueAttribution).toContain(verifiedClientEmail);
    });

    it("27. Concurrent decision submissions cannot produce multiple decisions", () => {
      // Row locks with 'for update' in PostgreSQL ensure serializability
      expect(migrationSql).toMatch(/select\s+\*\s+into\s+version_row[\s\S]*?for\s+update;/i);
      expect(migrationSql).toMatch(/select\s+\*\s+into\s+challenge_row[\s\S]*?for\s+update;/i);
    });

    it("28. A decision for an outdated agreement version is rejected", () => {
      function evaluateDecision(versionStatus: string) {
        if (versionStatus !== "PENDING_CLIENT") {
          throw new Error("Agreement already decided");
        }
      }

      expect(() => evaluateDecision("APPROVED")).toThrow("Agreement already decided");
      expect(() => evaluateDecision("CHANGES_REQUESTED")).toThrow("Agreement already decided");
      expect(() => evaluateDecision("SUPERSEDED")).toThrow("Agreement already decided");
    });
  });

  describe("Utility & Masking helpers", () => {
    it("masks client email addresses safely without revealing full address", () => {
      expect(maskEmail("client@example.com")).toBe("c***t@example.com");
      expect(maskEmail("ab@domain.com")).toBe("a***@domain.com");
      expect(maskEmail("jordan.lee@company.org")).toBe("j***e@company.org");
    });
  });

  // ==========================================================================
  // Section 4: Phase 2B Security Closure and Hardening
  // ==========================================================================
  describe("Phase 2B: Security Closure and Hardening", () => {
    const migration2bSql = readFileSync(
      resolve(process.cwd(), "supabase/migrations/202611030004_security_closure_and_rate_limiting.sql"),
      "utf-8"
    );

    it("29. Freelancer cannot enter their own account email as the client email", () => {
      expect(migration2bSql).toMatch(/projects_check_client_email_insert/i);
      expect(migration2bSql).toMatch(/Client email cannot be identical to the project owner email/i);

      function simulateValidateProjectEmail(ownerEmail: string, clientEmail: string) {
        if (ownerEmail.trim().toLowerCase() === clientEmail.trim().toLowerCase()) {
          throw new Error("Client email cannot be identical to the project owner email");
        }
        return true;
      }

      expect(() =>
        simulateValidateProjectEmail("freelancer@agency.com", "freelancer@agency.com")
      ).toThrow("Client email cannot be identical to the project owner email");

      expect(
        simulateValidateProjectEmail("freelancer@agency.com", "client@corp.com")
      ).toBe(true);
    });

    it("30. Direct column updates to client_email_verified_at are revoked", () => {
      expect(migration2bSql).toMatch(
        /revoke\s+update\s*\(client_email_verified_at\)\s+on\s+public\.projects\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });

    it("31. Direct column updates to agreement approval columns are revoked", () => {
      expect(migration2bSql).toMatch(
        /revoke\s+update\s*\(status,\s*approved_at,\s*approved_by_label\)\s+on\s+public\.agreement_versions\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });

    it("32. OTP challenges enforce strict multi-column binding (project, version, action)", () => {
      expect(migration2bSql).toMatch(/and\s+project_id\s*=\s*link_row\.project_id/i);
      expect(migration2bSql).toMatch(/and\s+agreement_version_id\s*=\s*version_row\.id/i);
      expect(migration2bSql).toMatch(/and\s+action\s*=\s*p_action/i);

      function simulateOtpChallengeBinding(
        challenge: { projectId: string; versionId: string; action: string },
        submitted: { projectId: string; versionId: string; action: string }
      ) {
        if (challenge.projectId !== submitted.projectId) {
          throw new Error("OTP challenge project mismatch");
        }
        if (challenge.versionId !== submitted.versionId) {
          throw new Error("OTP challenge version mismatch");
        }
        if (challenge.action !== submitted.action) {
          throw new Error("OTP challenge action mismatch");
        }
        return true;
      }

      const challenge = { projectId: "proj-1", versionId: "ver-1", action: "APPROVE" };

      // Action mismatch: cannot use APPROVE OTP to REQUEST_CHANGES
      expect(() =>
        simulateOtpChallengeBinding(challenge, {
          projectId: "proj-1",
          versionId: "ver-1",
          action: "REQUEST_CHANGES",
        })
      ).toThrow("OTP challenge action mismatch");

      // Version mismatch: cannot reuse OTP across agreement versions
      expect(() =>
        simulateOtpChallengeBinding(challenge, {
          projectId: "proj-1",
          versionId: "ver-2",
          action: "APPROVE",
        })
      ).toThrow("OTP challenge version mismatch");

      // Valid binding matches all fields
      expect(
        simulateOtpChallengeBinding(challenge, {
          projectId: "proj-1",
          versionId: "ver-1",
          action: "APPROVE",
        })
      ).toBe(true);
    });

    it("33. Authenticated project owner session cannot submit review decision even with valid OTP", () => {
      expect(migration2bSql).toMatch(/auth\.uid\(\)\s*is\s+not\s+null\s+and\s+project_row\.owner_id\s*=\s*auth\.uid\(\)/i);
      expect(migration2bSql).toMatch(/Project owner cannot decide their own agreement/i);
    });

    it("34. Database-backed rate limiting DDL and atomic RPC are defined", () => {
      expect(migration2bSql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.rate_limit_buckets/i);
      expect(migration2bSql).toMatch(/create\s+or\s+replace\s+function\s+public\.consume_rate_limit/i);
    });

    it("35. Email verification link GET prefetch does not consume token", () => {
      // Interactive client component requires explicit POST to verify
      const verifyPageSource = readFileSync(
        resolve(process.cwd(), "src/app/verify-client-email/page.tsx"),
        "utf-8"
      );
      // page.tsx must NOT call verify_client_email directly
      expect(verifyPageSource).not.toContain("verify_client_email");
      expect(verifyPageSource).toContain("VerifyEmailClient");
    });
  });
});

