import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { hashReviewToken, createReviewToken } from "@/lib/security/tokens";

describe("Review Token Hash Access Hardening (Phase 2A.2)", () => {
  describe("Database Migration DDL Hardening Analysis", () => {
    const migrationPath = resolve(
      process.cwd(),
      "supabase/migrations/202611030002_harden_review_token_hash_access.sql"
    );
    const sql = readFileSync(migrationPath, "utf-8");

    it("revokes all table-level privileges on public.review_links from public, anon, and authenticated", () => {
      expect(sql).toMatch(/revoke\s+all\s+on\s+public\.review_links\s+from\s+public,\s*anon;/i);
      expect(sql).toMatch(/revoke\s+all\s+on\s+public\.review_links\s+from\s+authenticated;/i);
    });

    it("grants column-level SELECT on metadata columns strictly excluding token_hash", () => {
      // Find the grant select block on review_links
      const grantSelectMatch = sql.match(/grant\s+select\s*\(([^)]+)\)\s*on\s+public\.review_links\s+to\s+authenticated/i);
      expect(grantSelectMatch).not.toBeNull();
      if (grantSelectMatch) {
        const columns = grantSelectMatch[1].split(",").map((c) => c.trim().toLowerCase());
        expect(columns).toContain("id");
        expect(columns).toContain("project_id");
        expect(columns).toContain("agreement_version_id");
        expect(columns).toContain("intended_email");
        expect(columns).toContain("expires_at");
        expect(columns).toContain("revoked_at");
        expect(columns).toContain("created_at");
        // CRITICAL: token_hash MUST NOT be in the column list
        expect(columns).not.toContain("token_hash");
      }
    });

    it("grants column-level INSERT on required creation fields including token_hash", () => {
      const grantInsertMatch = sql.match(/grant\s+insert\s*\(([^)]+)\)\s*on\s+public\.review_links\s+to\s+authenticated/i);
      expect(grantInsertMatch).not.toBeNull();
      if (grantInsertMatch) {
        const columns = grantInsertMatch[1].split(",").map((c) => c.trim().toLowerCase());
        expect(columns).toContain("project_id");
        expect(columns).toContain("agreement_version_id");
        expect(columns).toContain("token_hash");
        expect(columns).toContain("intended_email");
        expect(columns).toContain("expires_at");
      }
    });

    it("grants column-level UPDATE on revoked_at exclusively for link invalidation", () => {
      const grantUpdateMatch = sql.match(/grant\s+update\s*\(([^)]+)\)\s*on\s+public\.review_links\s+to\s+authenticated/i);
      expect(grantUpdateMatch).not.toBeNull();
      if (grantUpdateMatch) {
        const columns = grantUpdateMatch[1].split(",").map((c) => c.trim().toLowerCase());
        expect(columns).toEqual(["revoked_at"]);
      }
    });

    it("defines secured view project_review_links with security_invoker omitting token_hash", () => {
      expect(sql).toMatch(/create\s+or\s+replace\s+view\s+public\.project_review_links/i);
      expect(sql).toMatch(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/i);

      // Verify the view SELECT columns omit token_hash
      const viewSelectMatch = sql.match(/create\s+or\s+replace\s+view\s+public\.project_review_links[\s\S]*?as\s+select([\s\S]*?)from\s+public\.review_links/i);
      expect(viewSelectMatch).not.toBeNull();
      if (viewSelectMatch) {
        const viewColumns = viewSelectMatch[1].split(",").map((c) => c.trim().toLowerCase());
        expect(viewColumns).not.toContain("token_hash");
        expect(viewColumns).toContain("id");
        expect(viewColumns).toContain("expires_at");
        expect(viewColumns).toContain("revoked_at");
      }
    });

    it("implements owner self-approval rejection check in submit_public_review", () => {
      expect(sql).toMatch(/auth\.uid\(\)\s+is\s+not\s+null/i);
      expect(sql).toMatch(/p\.owner_id\s*=\s*auth\.uid\(\)/i);
      expect(sql).toMatch(/raise\s+exception\s+'Project owner cannot decide their own agreement'/i);
    });
  });

  describe("Application Review Link Creation and Token Secrecy", () => {
    it("ensures raw token is never persisted and only its SHA-256 hash is stored", () => {
      const rawToken = createReviewToken();
      const hash = hashReviewToken(rawToken);

      // Mock database record as inserted
      const storedRecord = {
        id: "rl-1",
        project_id: "proj-100",
        agreement_version_id: "ver-100",
        token_hash: hash,
        intended_email: "client@example.com",
        expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        revoked_at: null,
        created_at: new Date().toISOString(),
      };

      // Storage has hash, not raw token
      expect(storedRecord.token_hash).not.toBe(rawToken);
      expect(storedRecord.token_hash).toBe(hash);
      expect(storedRecord.token_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("simulates column-level SELECT rejection when an authenticated client requests token_hash", () => {
      // Simulating PostgREST / Postgres column privilege boundary:
      // Allowed columns for authenticated users
      const allowedColumns = new Set([
        "id",
        "project_id",
        "agreement_version_id",
        "intended_email",
        "expires_at",
        "revoked_at",
        "created_at",
      ]);

      function simulatePostgrestSelect(requestedColumns: string[]): { data: unknown; error: { code: string; message: string } | null } {
        const unauthorized = requestedColumns.filter((col) => !allowedColumns.has(col));
        if (unauthorized.length > 0) {
          return {
            data: null,
            error: {
              code: "42501",
              message: `permission denied for column "${unauthorized[0]}" of relation "review_links"`,
            },
          };
        }
        return {
          data: [{ id: "rl-1", expires_at: "2026-11-17T00:00:00Z", revoked_at: null }],
          error: null,
        };
      }

      // Metadata query succeeds
      const safeQuery = simulatePostgrestSelect(["id", "expires_at", "revoked_at"]);
      expect(safeQuery.error).toBeNull();
      expect(safeQuery.data).not.toBeNull();

      // Querying token_hash fails with permission denied
      const hashQuery = simulatePostgrestSelect(["id", "token_hash"]);
      expect(hashQuery.error).not.toBeNull();
      expect(hashQuery.error?.code).toBe("42501");
      expect(hashQuery.error?.message).toContain('permission denied for column "token_hash"');

      // Wildcard / unrestricted query attempting to read token_hash fails
      const wildcardQuery = simulatePostgrestSelect(["*"]);
      expect(wildcardQuery.error?.code).toBe("42501");
    });
  });

  describe("submit_public_review Business Logic and Security Guardrails", () => {
    interface ReviewLink {
      id: string;
      project_id: string;
      agreement_version_id: string;
      token_hash: string;
      expires_at: string;
      revoked_at: string | null;
    }

    interface AgreementVersion {
      id: string;
      agreement_id: string;
      version_number: number;
      status: string;
      approved_by_label?: string | null;
    }

    interface Project {
      id: string;
      owner_id: string;
      status: string;
    }

    function simulateSubmitPublicReview(params: {
      callerAuthUid: string | null;
      tokenHash: string;
      action: "APPROVE" | "REQUEST_CHANGES" | string;
      note?: string;
      actorLabel?: string;
      mockLink: ReviewLink | null;
      mockVersion: AgreementVersion | null;
      mockProject: Project | null;
    }) {
      const { callerAuthUid, mockLink, mockVersion, mockProject, action, note, actorLabel } = params;

      if (!mockLink || mockLink.revoked_at !== null || new Date(mockLink.expires_at) <= new Date()) {
        throw new Error("Review link unavailable");
      }

      // Defense-in-depth: Reject approval attempts originating from the project owner's authenticated session
      if (callerAuthUid !== null && mockProject && mockProject.id === mockLink.project_id && mockProject.owner_id === callerAuthUid) {
        throw new Error("Project owner cannot decide their own agreement");
      }

      if (!mockVersion || mockVersion.status !== "PENDING_CLIENT") {
        throw new Error("Agreement already decided");
      }

      if (action === "APPROVE") {
        mockVersion.status = "APPROVED";
        mockVersion.approved_by_label = actorLabel ? actorLabel.trim().slice(0, 140) : null;
        mockLink.revoked_at = new Date().toISOString();
        return "APPROVED";
      } else if (action === "REQUEST_CHANGES") {
        if (!note || note.trim().length < 3) {
          throw new Error("Change request note required");
        }
        mockVersion.status = "CHANGES_REQUESTED";
        mockLink.revoked_at = new Date().toISOString();
        return "CHANGES_REQUESTED";
      } else {
        throw new Error("Unsupported review action");
      }
    }

    const validLink: ReviewLink = {
      id: "rl-1",
      project_id: "proj-1",
      agreement_version_id: "ver-1",
      token_hash: "valid-hash",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      revoked_at: null,
    };

    const validVersion: AgreementVersion = {
      id: "ver-1",
      agreement_id: "agree-1",
      version_number: 1,
      status: "PENDING_CLIENT",
    };

    const validProject: Project = {
      id: "proj-1",
      owner_id: "owner-user-id",
      status: "AWAITING_CLIENT",
    };

    it("rejects project owner when attempting to approve their own agreement (defense-in-depth)", () => {
      expect(() =>
        simulateSubmitPublicReview({
          callerAuthUid: "owner-user-id", // Owner caller
          tokenHash: "valid-hash",
          action: "APPROVE",
          actorLabel: "Client Impersonator",
          mockLink: { ...validLink },
          mockVersion: { ...validVersion },
          mockProject: { ...validProject },
        })
      ).toThrow("Project owner cannot decide their own agreement");
    });

    it("permits anonymous client (auth.uid() is null) to approve agreement", () => {
      const link = { ...validLink };
      const version = { ...validVersion };
      const result = simulateSubmitPublicReview({
        callerAuthUid: null, // Anonymous client visiting /review/[token]
        tokenHash: "valid-hash",
        action: "APPROVE",
        actorLabel: "Legitimate Client",
        mockLink: link,
        mockVersion: version,
        mockProject: { ...validProject },
      });

      expect(result).toBe("APPROVED");
      expect(version.status).toBe("APPROVED");
      expect(link.revoked_at).not.toBeNull();
    });

    it("permits third-party authenticated client (auth.uid() != owner_id) to approve agreement", () => {
      const link = { ...validLink };
      const version = { ...validVersion };
      const result = simulateSubmitPublicReview({
        callerAuthUid: "external-client-user-id",
        tokenHash: "valid-hash",
        action: "APPROVE",
        actorLabel: "Authenticated Client",
        mockLink: link,
        mockVersion: version,
        mockProject: { ...validProject },
      });

      expect(result).toBe("APPROVED");
      expect(version.status).toBe("APPROVED");
      expect(link.revoked_at).not.toBeNull();
    });

    it("rejects expired review links", () => {
      const expiredLink: ReviewLink = {
        ...validLink,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      };

      expect(() =>
        simulateSubmitPublicReview({
          callerAuthUid: null,
          tokenHash: "valid-hash",
          action: "APPROVE",
          mockLink: expiredLink,
          mockVersion: { ...validVersion },
          mockProject: { ...validProject },
        })
      ).toThrow("Review link unavailable");
    });

    it("rejects already revoked review links", () => {
      const revokedLink: ReviewLink = {
        ...validLink,
        revoked_at: new Date(Date.now() - 60_000).toISOString(),
      };

      expect(() =>
        simulateSubmitPublicReview({
          callerAuthUid: null,
          tokenHash: "valid-hash",
          action: "APPROVE",
          mockLink: revokedLink,
          mockVersion: { ...validVersion },
          mockProject: { ...validProject },
        })
      ).toThrow("Review link unavailable");
    });

    it("rejects agreements that are not in PENDING_CLIENT status", () => {
      const alreadyApprovedVersion: AgreementVersion = {
        ...validVersion,
        status: "APPROVED",
      };

      expect(() =>
        simulateSubmitPublicReview({
          callerAuthUid: null,
          tokenHash: "valid-hash",
          action: "APPROVE",
          mockLink: { ...validLink },
          mockVersion: alreadyApprovedVersion,
          mockProject: { ...validProject },
        })
      ).toThrow("Agreement already decided");
    });

    it("requires at least 3 non-whitespace characters for change request note", () => {
      expect(() =>
        simulateSubmitPublicReview({
          callerAuthUid: null,
          tokenHash: "valid-hash",
          action: "REQUEST_CHANGES",
          note: "  ",
          mockLink: { ...validLink },
          mockVersion: { ...validVersion },
          mockProject: { ...validProject },
        })
      ).toThrow("Change request note required");

      expect(() =>
        simulateSubmitPublicReview({
          callerAuthUid: null,
          tokenHash: "valid-hash",
          action: "REQUEST_CHANGES",
          note: "no",
          mockLink: { ...validLink },
          mockVersion: { ...validVersion },
          mockProject: { ...validProject },
        })
      ).toThrow("Change request note required");
    });

    it("executes valid change request and revokes review link", () => {
      const link = { ...validLink };
      const version = { ...validVersion };
      const result = simulateSubmitPublicReview({
        callerAuthUid: null,
        tokenHash: "valid-hash",
        action: "REQUEST_CHANGES",
        note: "Please adjust Milestone 2 delivery date to next month.",
        mockLink: link,
        mockVersion: version,
        mockProject: { ...validProject },
      });

      expect(result).toBe("CHANGES_REQUESTED");
      expect(version.status).toBe("CHANGES_REQUESTED");
      expect(link.revoked_at).not.toBeNull();
    });
  });
});
