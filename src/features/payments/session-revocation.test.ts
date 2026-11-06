import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSessionToken, hashSessionToken } from "@/lib/security/tokens";

describe("Phase 3B.2.1: Client Portal Session Revocation", () => {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202611030010_client_portal_session_revocation.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  // ==========================================================================
  // SECTION 1: STATIC DDL AND ACCESS CONTROL AUDIT
  // ==========================================================================
  describe("1. Static SQL Invariants and Grants Audit", () => {
    it("defines revoke_portal_session with SECURITY DEFINER and empty search_path", () => {
      expect(migrationSql).toMatch(
        /create\s+or\s+replace\s+function\s+public\.revoke_portal_session\s*\(\s*p_session_token_hash\s+text\s*\)\s*returns\s+void/i
      );
      expect(migrationSql).toMatch(/security\s+definer/i);
      expect(migrationSql).toMatch(/set\s+search_path\s*=\s*''/i);
    });

    it("validates 64-character hexadecimal SHA-256 hash format in SQL", () => {
      expect(migrationSql).toMatch(/char_length\(trim\(p_session_token_hash\)\)\s*<>\s*64/i);
      expect(migrationSql).toMatch(/p_session_token_hash\s*!~\*\s*'\^\[0-9a-f\]\{64\}\$'/i);
      expect(migrationSql).toMatch(/raise\s+exception\s+'Invalid session token hash format'/i);
    });

    it("updates public.client_portal_sessions setting revoked_at only for active matching sessions", () => {
      expect(migrationSql).toMatch(/update\s+public\.client_portal_sessions/i);
      expect(migrationSql).toMatch(/set\s+revoked_at\s*=\s*now\(\)/i);
      expect(migrationSql).toMatch(/where\s+session_token_hash\s*=\s*lower\(trim\(p_session_token_hash\)\)/i);
      expect(migrationSql).toMatch(/and\s+revoked_at\s+is\s+null/i);
    });

    it("strictly revokes execution from public, anon, and authenticated roles", () => {
      expect(migrationSql).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.revoke_portal_session\(text\)\s+from\s+public,\s*anon,\s*authenticated;/i
      );
    });

    it("explicitly grants execution strictly to service_role", () => {
      expect(migrationSql).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.revoke_portal_session\(text\)\s+to\s+service_role;/i
      );
    });
  });

  // ==========================================================================
  // SECTION 2: BEHAVIORAL SIMULATION & IDEMPOTENCY
  // ==========================================================================
  describe("2. Behavioral Simulation and Logic Verification", () => {
    interface MockSession {
      id: string;
      project_id: string;
      client_email: string;
      session_token_hash: string;
      csrf_secret: string;
      created_at: Date;
      last_active_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
    }

    // Reference implementation mirroring PostgreSQL RPC logic
    function simulateRevokePortalSession(
      sessions: Map<string, MockSession>,
      p_session_token_hash: string | null | undefined
    ): void {
      if (
        !p_session_token_hash ||
        p_session_token_hash.trim().length !== 64 ||
        !/^[0-9a-f]{64}$/i.test(p_session_token_hash.trim())
      ) {
        throw new Error("Invalid session token hash format");
      }

      const normalizedHash = p_session_token_hash.trim().toLowerCase();
      const session = sessions.get(normalizedHash);

      if (session && session.revoked_at === null) {
        session.revoked_at = new Date();
      }
    }

    function simulateValidatePortalSession(session: MockSession | undefined): {
      valid: boolean;
      reason?: string;
    } {
      if (!session || session.revoked_at !== null) {
        return { valid: false, reason: "REVOKED_OR_NOT_FOUND" };
      }
      return { valid: true };
    }

    it("successfully revokes an active session given its valid token hash", () => {
      const rawToken = createSessionToken();
      const tokenHash = hashSessionToken(rawToken);

      const sessions = new Map<string, MockSession>();
      const initialSession: MockSession = {
        id: "sess-1",
        project_id: "proj-1",
        client_email: "client@example.com",
        session_token_hash: tokenHash,
        csrf_secret: "csrf-secret-1234",
        created_at: new Date(),
        last_active_at: new Date(),
        expires_at: new Date(Date.now() + 12 * 3600_000),
        revoked_at: null,
      };
      sessions.set(tokenHash, initialSession);

      // Before revocation
      expect(simulateValidatePortalSession(sessions.get(tokenHash)).valid).toBe(true);

      // Execute revocation
      simulateRevokePortalSession(sessions, tokenHash);

      // After revocation
      expect(initialSession.revoked_at).not.toBeNull();
      expect(simulateValidatePortalSession(sessions.get(tokenHash))).toEqual({
        valid: false,
        reason: "REVOKED_OR_NOT_FOUND",
      });
    });

    it("is strictly idempotent: repeated calls preserve the initial revoked_at timestamp", async () => {
      const rawToken = createSessionToken();
      const tokenHash = hashSessionToken(rawToken);

      const sessions = new Map<string, MockSession>();
      const session: MockSession = {
        id: "sess-2",
        project_id: "proj-1",
        client_email: "client@example.com",
        session_token_hash: tokenHash,
        csrf_secret: "csrf-secret-1234",
        created_at: new Date(),
        last_active_at: new Date(),
        expires_at: new Date(Date.now() + 12 * 3600_000),
        revoked_at: null,
      };
      sessions.set(tokenHash, session);

      // First call
      simulateRevokePortalSession(sessions, tokenHash);
      const firstRevokedAt = session.revoked_at;
      expect(firstRevokedAt).toBeInstanceOf(Date);

      // Short delay
      await new Promise((r) => setTimeout(r, 10));

      // Second call (idempotent repeat)
      simulateRevokePortalSession(sessions, tokenHash);
      expect(session.revoked_at).toBe(firstRevokedAt);
    });

    it("rejects invalid hash formats with an exception", () => {
      const sessions = new Map<string, MockSession>();

      // Too short
      expect(() => simulateRevokePortalSession(sessions, "abc123")).toThrow(
        /Invalid session token hash format/
      );

      // Non-hex characters
      expect(() =>
        simulateRevokePortalSession(
          sessions,
          "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
        )
      ).toThrow(/Invalid session token hash format/);

      // Null or empty
      expect(() => simulateRevokePortalSession(sessions, "")).toThrow(
        /Invalid session token hash format/
      );
      expect(() => simulateRevokePortalSession(sessions, null)).toThrow(
        /Invalid session token hash format/
      );
    });

    it("does not reveal whether an unknown valid hash exists in the database", () => {
      const sessions = new Map<string, MockSession>();
      const nonExistentHash = hashSessionToken("never-created-token");

      // Execution completes without throwing or returning any boolean indicator
      expect(() => simulateRevokePortalSession(sessions, nonExistentHash)).not.toThrow();
    });
  });
});
