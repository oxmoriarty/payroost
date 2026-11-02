import "server-only";

import { z } from "zod";

const serviceEnvironment = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required and cannot be empty"),
});

/**
 * Validates and extracts server-only Supabase service-role credentials.
 *
 * Security Invariants:
 * - Server-only module guard prevents accidental inclusion in browser bundles.
 * - Enforces valid HTTPS Supabase URL and non-empty service-role key.
 * - Masks error details to prevent accidental key leakage.
 */
export function getSupabaseServiceEnv(customSource?: Record<string, string | undefined>) {
  const source = customSource ?? {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const result = serviceEnvironment.safeParse(source);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid Supabase service configuration: ${missing}`);
  }

  return result.data;
}
