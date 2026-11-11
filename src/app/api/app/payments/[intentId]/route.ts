import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";
import { getPaymentInvestigationDetails } from "@/features/payments/investigation-data";

const uuidSchema = z.string().uuid();

/**
 * GET /api/app/payments/[intentId]
 *
 * Returns a tenant-isolated, PII-minimized operational investigation dossier
 * correlating the payment intent, ledger transactions, signature-verified PayPal
 * webhook events, audit timeline, consistency diagnostics, and action eligibility.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ intentId: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return apiError("UNAUTHORIZED", 401);
  }

  const rlResult = await checkRateLimit(`operator-investigation:${user.id}`, 60, 600_000, {
    failClosedInProduction: true,
  });
  if (!rlResult.allowed) {
    return apiError("RATE_LIMITED", 429);
  }

  const { intentId } = await context.params;
  if (!uuidSchema.safeParse(intentId).success) {
    return apiError("INVALID_INTENT_ID", 400);
  }

  const result = await getPaymentInvestigationDetails({
    intentId,
    supabaseClient: supabase,
    authenticatedUserId: user.id,
  });

  if (!result.ok) {
    return apiError(result.error, result.httpStatus);
  }

  return NextResponse.json(result.dossier, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
