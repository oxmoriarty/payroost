import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type SellerReadinessErrorCode =
  | "PROJECT_NOT_FOUND"
  | "SELLER_NOT_CONNECTED"
  | "SELLER_ONBOARDING_INCOMPLETE"
  | "SELLER_NOT_RECEIVABLE"
  | "SELLER_EMAIL_UNCONFIRMED"
  | "SELLER_MERCHANT_ID_INVALID"
  | "SELLER_MISMATCH"
  | "DATABASE_UNAVAILABLE";

export interface SellerReadinessResult {
  success: boolean;
  error?: SellerReadinessErrorCode;
  sellerMerchantId?: string;
  sellerPayerId?: string;
  sellerEmail?: string | null;
  userId?: string;
}

/**
 * Authoritatively verifies that the freelancer owning a project has an active,
 * fully onboarded, and payment-receivable PayPal Sandbox seller account.
 *
 * Security Invariants & Preflight Gates:
 * 1. Payee merchant ID originates strictly from server-side verified records (freelancer_paypal_accounts).
 * 2. Cryptographic binding: freelancer_paypal_accounts.user_id = projects.owner_id.
 * 3. Enforces onboarding_status = 'COMPLETED'.
 * 4. Enforces payments_receivable = true.
 * 5. Enforces primary_email_confirmed = true.
 * 6. Validates merchant ID length (between 3 and 64 characters).
 * 7. Fails closed on any inconsistency; never trusts browser-supplied payee information.
 */
export async function verifyProjectSellerReadiness(
  supabase: SupabaseClient,
  projectId: string
): Promise<SellerReadinessResult> {
  // 1. Resolve project owner
  let project: { id: string; owner_id: string } | null = null;
  try {
    const projectBuilder = supabase.from("projects");
    if (!projectBuilder || typeof projectBuilder.select !== "function") {
      return { success: false, error: "SELLER_NOT_CONNECTED" };
    }
    const selectQuery = projectBuilder.select("id, owner_id");
    if (!selectQuery || typeof selectQuery.eq !== "function") {
      return { success: false, error: "SELLER_NOT_CONNECTED" };
    }
    const eqQuery = selectQuery.eq("id", projectId);
    if (!eqQuery || typeof eqQuery.maybeSingle !== "function") {
      return { success: false, error: "SELLER_NOT_CONNECTED" };
    }

    const { data, error } = await eqQuery.maybeSingle();
    if (error) {
      return { success: false, error: "DATABASE_UNAVAILABLE" };
    }
    project = data;
  } catch {
    return { success: false, error: "DATABASE_UNAVAILABLE" };
  }

  if (!project || !project.owner_id) {
    return { success: false, error: "PROJECT_NOT_FOUND" };
  }

  // 2. Query freelancer seller account strictly bound to project owner
  let sellerAccount: {
    id: string;
    user_id: string;
    paypal_merchant_id: string | null;
    onboarding_status: string;
    payments_receivable: boolean;
    primary_email_confirmed: boolean;
    seller_email: string | null;
  } | null = null;

  try {
    const accountBuilder = supabase.from("freelancer_paypal_accounts");
    if (!accountBuilder || typeof accountBuilder.select !== "function") {
      return { success: false, error: "SELLER_NOT_CONNECTED" };
    }
    const selectQuery = accountBuilder.select(
      "id, user_id, paypal_merchant_id, onboarding_status, payments_receivable, primary_email_confirmed, seller_email"
    );
    if (!selectQuery || typeof selectQuery.eq !== "function") {
      return { success: false, error: "SELLER_NOT_CONNECTED" };
    }
    const eqQuery = selectQuery.eq("user_id", project.owner_id);
    if (!eqQuery || typeof eqQuery.maybeSingle !== "function") {
      return { success: false, error: "SELLER_NOT_CONNECTED" };
    }

    const { data, error } = await eqQuery.maybeSingle();
    if (error) {
      return { success: false, error: "DATABASE_UNAVAILABLE" };
    }
    sellerAccount = data;
  } catch {
    return { success: false, error: "DATABASE_UNAVAILABLE" };
  }

  // 3. Preflight check: Connected seller record exists
  if (!sellerAccount) {
    return { success: false, error: "SELLER_NOT_CONNECTED" };
  }

  // 4. Invariant: Seller record strictly belongs to project owner
  if (sellerAccount.user_id !== project.owner_id) {
    return { success: false, error: "SELLER_MISMATCH" };
  }

  // 5. Invariant: Onboarding status must be COMPLETED
  if (sellerAccount.onboarding_status !== "COMPLETED") {
    return { success: false, error: "SELLER_ONBOARDING_INCOMPLETE" };
  }

  // 6. Invariant: Seller must be receivable
  if (sellerAccount.payments_receivable !== true) {
    return { success: false, error: "SELLER_NOT_RECEIVABLE" };
  }

  // 7. Invariant: Primary seller email confirmed by PayPal
  if (sellerAccount.primary_email_confirmed !== true) {
    return { success: false, error: "SELLER_EMAIL_UNCONFIRMED" };
  }

  // 8. Invariant: Merchant ID format validity
  const merchantId = sellerAccount.paypal_merchant_id?.trim();
  if (!merchantId || merchantId.length < 3 || merchantId.length > 64) {
    return { success: false, error: "SELLER_MERCHANT_ID_INVALID" };
  }

  return {
    success: true,
    sellerMerchantId: merchantId,
    sellerPayerId: merchantId, // Authoritative PayPal seller account ID for Auth Assertion
    sellerEmail: sellerAccount.seller_email ?? null,
    userId: sellerAccount.user_id,
  };
}
