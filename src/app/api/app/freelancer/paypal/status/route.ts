import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/http";

/**
 * Masks a PayPal merchant ID for safe display (e.g. "ABC***XYZ").
 */
function maskMerchantId(merchantId: string): string {
  const trimmed = merchantId.trim();
  if (trimmed.length <= 6) {
    return "***";
  }
  const start = trimmed.slice(0, 3);
  const end = trimmed.slice(-3);
  return `${start}***${end}`;
}

/**
 * GET /api/app/freelancer/paypal/status
 *
 * Returns safe PayPal seller connection information for the authenticated freelancer.
 *
 * Security Invariants:
 * 1. Strict authentication via Supabase Auth (requireUser).
 * 2. Queries public.freelancer_paypal_accounts using authenticated client (enforces RLS).
 * 3. Never exposes raw tokens, secrets, tracking tokens, or full internal payloads.
 * 4. Masks merchant ID for safe UI display.
 */
export async function GET() {
  let user: { id: string };
  try {
    const authResult = await requireUser();
    user = authResult.user;
  } catch {
    return apiError("UNAUTHORIZED", 401, { "Cache-Control": "no-store" });
  }

  const supabase = await createClient();

  const { data: account, error } = await supabase
    .from("freelancer_paypal_accounts")
    .select("id, onboarding_status, payments_receivable, primary_email_confirmed, paypal_merchant_id, seller_email, connected_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return apiError("DATABASE_UNAVAILABLE", 503, { "Cache-Control": "no-store" });
  }

  if (!account) {
    return NextResponse.json(
      {
        isConnected: false,
        onboardingStatus: "NOT_STARTED",
        paymentsReceivable: false,
        primaryEmailConfirmed: false,
        sellerMerchantIdMasked: null,
        sellerEmail: null,
        connectedAt: null,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  const isConnected =
    account.onboarding_status === "COMPLETED" &&
    account.payments_receivable === true &&
    account.primary_email_confirmed === true;

  return NextResponse.json(
    {
      isConnected,
      onboardingStatus: account.onboarding_status,
      paymentsReceivable: account.payments_receivable,
      primaryEmailConfirmed: account.primary_email_confirmed,
      sellerMerchantIdMasked: account.paypal_merchant_id ? maskMerchantId(account.paypal_merchant_id) : null,
      sellerEmail: account.seller_email ?? null,
      connectedAt: account.connected_at ?? null,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
