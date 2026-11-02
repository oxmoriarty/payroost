import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceEnv } from "./server-env";

export { getSupabaseServiceEnv } from "./server-env";

/**
 * Creates an unauthenticated, privileged Supabase client using the service-role key.
 *
 * Invariants & Security Boundaries:
 * - Server-only: Protected by the "server-only" barrier to prevent bundling into client code.
 * - Session persistence disabled: Does not track cookies, browser storage, or client sessions.
 * - Automatic token refresh disabled: The service-role key is a static administrative bearer credential.
 * - Strict credential isolation: Never logged, serialized into JSON responses, or exposed to the browser.
 * - Purpose: Intended exclusively for privileged server-side operations such as payment intent creation,
 *   authoritative reconciliation, and webhook event queue dispatching.
 */
export function createServiceClient(
  customEnv?: Record<string, string | undefined>
): SupabaseClient {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseServiceEnv(customEnv);

  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
