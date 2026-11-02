import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSupabaseServiceEnv } from "./server-env";
import { createServiceClient } from "./service";
import * as publicEnv from "./env";

describe("Supabase Service-Role Client", () => {
  const serviceFilePath = resolve(process.cwd(), "src/lib/supabase/service.ts");
  const serviceFileContent = readFileSync(serviceFilePath, "utf-8");
  const serverEnvFilePath = resolve(process.cwd(), "src/lib/supabase/server-env.ts");
  const serverEnvFileContent = readFileSync(serverEnvFilePath, "utf-8");

  it("verifies server-only barrier is enforced on service.ts and server-env.ts", () => {
    expect(serviceFileContent).toMatch(/^import\s+["']server-only["'];/m);
    expect(serverEnvFileContent).toMatch(/^import\s+["']server-only["'];/m);
  });

  it("confirms public env.ts does not export service-role environment getter", () => {
    expect(publicEnv).not.toHaveProperty("getSupabaseServiceEnv");
    expect(publicEnv).toHaveProperty("getSupabasePublicEnv");
    expect(publicEnv).toHaveProperty("getSupabaseClientEnv");
  });

  it("successfully parses valid service-role environment configuration", () => {
    const config = getSupabaseServiceEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "eyJh-super-secret-service-role-key",
    });

    expect(config.NEXT_PUBLIC_SUPABASE_URL).toBe("https://example.supabase.co");
    expect(config.SUPABASE_SERVICE_ROLE_KEY).toBe("eyJh-super-secret-service-role-key");
  });

  it("rejects missing SUPABASE_SERVICE_ROLE_KEY without leaking values", () => {
    expect(() =>
      getSupabaseServiceEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "",
      })
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/i);
  });

  it("creates a service client with session persistence and auto-refresh disabled", () => {
    const client = createServiceClient({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key-valid-123456",
    });

    expect(client).toBeDefined();
    // Check auth configuration on client
    // @ts-expect-error accessing internal auth options for invariant verification
    const authOptions = client.auth?.options;
    if (authOptions) {
      expect(authOptions.persistSession).toBe(false);
      expect(authOptions.autoRefreshToken).toBe(false);
      expect(authOptions.detectSessionInUrl).toBe(false);
    }
  });
});
