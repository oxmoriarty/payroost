import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { createServiceClient } from "@/lib/supabase/service";
import { getPayPalServerEnv } from "@/lib/paypal/env";
import { PayPalClient } from "@/lib/paypal/client";
import { getCanonicalAppUrl } from "@/lib/security/app-url";
import { apiError } from "@/lib/http";

export interface PayPalMerchantIntegrationResponse {
  merchant_id?: string;
  tracking_id?: string;
  payments_receivable?: boolean;
  primary_email_confirmed?: boolean;
  primary_email?: string;
  legal_name?: string;
  oauth_third_party?: Array<{
    partner_client_id?: string;
    merchant_client_id?: string;
    scopes?: string[];
  }>;
}

const MERCHANT_ID_REGEX = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * GET /api/app/freelancer/paypal/callback
 *
 * Handles the seller onboarding return redirect from PayPal Sandbox.
 *
 * Security Invariants & Contract Specifications:
 * 1. Treats all URL query parameters as untrusted hints.
 * 2. Conceptual parameter distinction:
 *    - `merchantId`: Our internal tracking ID passed during onboarding.
 *    - `merchantIdInPayPal`: The actual PayPal seller merchant ID (payer_id).
 *    - `permissionsGranted`: Boolean string indicating granted scopes.
 *    - `consentStatus`: Boolean string indicating user consent.
 *    - `isEmailConfirmed`: Boolean string indicating seller email confirmation.
 * 3. Never confuses internal tracking ID with the PayPal seller merchant ID.
 * 4. Replay Protection:
 *    - Completed attempts redirect immediately to `already_connected` without mutating data or calling PayPal.
 *    - Revoked/Failed attempts redirect without re-processing.
 * 5. Concurrency Fencing:
 *    - Atomically claims the onboarding attempt (via RPC or conditional status update) before external inquiries.
 * 6. Explicit Partner Merchant ID:
 *    - Requires PAYPAL_PARTNER_MERCHANT_ID; never silently falls back to expectedMerchantId or client ID.
 * 7. Server-to-Server Authoritative Verification:
 *    - Queries GET /v1/customer/partners/{partner_id}/merchant-integrations/{merchant_id}.
 *    - Verifies payments_receivable === true and primary_email_confirmed === true.
 *    - Validates provider tracking_id and merchant_id match expected values.
 * 8. Full Seller Merchant ID Storage:
 *    - Stores full unmasked merchant ID for Phase 3B.R2 multi-party routing.
 * 9. Open Redirect Prevention:
 *    - Only redirects to fixed internal /app/settings path with structured status query params.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  let appUrl: string;
  try {
    appUrl = getCanonicalAppUrl();
  } catch {
    return apiError("CONFIGURATION_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }

  // Helper to construct safe UI redirects (prevents open redirects)
  const makeRedirect = (status: string, reason?: string) => {
    const target = new URL(`${appUrl}/app/settings`);
    target.searchParams.set("paypal_status", status);
    if (reason) target.searchParams.set("reason", reason);
    return NextResponse.redirect(target.toString(), 302);
  };

  // 1. Authenticate freelancer
  let user: { id: string; email?: string };
  try {
    const authResult = await requireUser();
    user = authResult.user;
  } catch {
    return makeRedirect("unauthorized");
  }

  // 2. Extract and validate untrusted callback query parameters
  const merchantIdParam = url.searchParams.get("merchantId")?.trim();
  const stateParam = url.searchParams.get("state")?.trim();
  const merchantIdInPayPal = url.searchParams.get("merchantIdInPayPal")?.trim();
  const permissionsGranted = url.searchParams.get("permissionsGranted")?.trim();
  const consentStatus = url.searchParams.get("consentStatus")?.trim();

  // Cross-validate tracking ID parameters if both are supplied
  if (merchantIdParam && stateParam && merchantIdParam !== stateParam) {
    return makeRedirect("invalid_state", "STATE_PARAM_MISMATCH");
  }

  // Resolve tracking identifier (PayPal returns tracking ID in merchantId; state carries original state)
  const trackingId = merchantIdParam || stateParam;
  if (!trackingId || trackingId.length < 16) {
    return makeRedirect("invalid_state", "MISSING_OR_INVALID_TRACKING_ID");
  }

  const serviceClient = createServiceClient();

  // 3. Inspect existing onboarding record for authenticated freelancer
  const { data: account, error: accountError } = await serviceClient
    .from("freelancer_paypal_accounts")
    .select("id, user_id, tracking_id, onboarding_status, payments_receivable, paypal_merchant_id")
    .eq("user_id", user.id)
    .eq("tracking_id", trackingId)
    .maybeSingle();

  if (accountError || !account) {
    // Replay attempt from wrong user or unknown tracking ID: reject immediately
    return makeRedirect("invalid_state", "STATE_NOT_FOUND_OR_USER_MISMATCH");
  }

  // 4. Replay Protection: Guard terminal and active states
  if (account.onboarding_status === "COMPLETED" && account.payments_receivable) {
    // Seller account is already verified and connected.
    // Replay MUST NOT re-verify or overwrite verified seller association.
    return makeRedirect("already_connected");
  }

  if (account.onboarding_status === "REVOKED") {
    return makeRedirect("consent_declined", "ALREADY_REVOKED");
  }

  if (account.onboarding_status === "FAILED") {
    return makeRedirect("verification_failed", "ALREADY_FAILED");
  }

  if (account.onboarding_status === "PROCESSING") {
    return makeRedirect("processing", "CONCURRENT_VERIFICATION_IN_FLIGHT");
  }

  if (account.onboarding_status !== "INITIATED") {
    return makeRedirect("invalid_state", "INVALID_ONBOARDING_STATUS");
  }

  // 5. Concurrency Fencing: Atomically claim onboarding attempt
  let claimed = false;
  try {
    const { data: claimData, error: rpcError } = await serviceClient.rpc(
      "claim_freelancer_paypal_onboarding_callback",
      {
        p_user_id: user.id,
        p_tracking_id: trackingId,
      }
    );
    if (!rpcError && Array.isArray(claimData) && claimData.length > 0) {
      claimed = Boolean(claimData[0].claimed);
    }
  } catch {
    claimed = false;
  }

  // Fallback to conditional update if RPC is not present
  if (!claimed) {
    const { data: claimedRow } = await serviceClient
      .from("freelancer_paypal_accounts")
      .update({
        onboarding_status: "PROCESSING",
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id)
      .eq("onboarding_status", "INITIATED")
      .select("id")
      .maybeSingle();

    if (!claimedRow) {
      return makeRedirect("processing", "CONCURRENT_VERIFICATION_IN_FLIGHT");
    }
  }

  // 6. Check if seller declined consent or permissions
  if (consentStatus === "false" || permissionsGranted === "false") {
    await serviceClient
      .from("freelancer_paypal_accounts")
      .update({
        onboarding_status: "REVOKED",
        payments_receivable: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    return makeRedirect(
      "consent_declined",
      consentStatus === "false" ? "CONSENT_DENIED" : "PERMISSIONS_DENIED"
    );
  }

  // 7. Extract and validate candidate seller merchant ID from merchantIdInPayPal
  // Contract invariant: merchantId is our tracking ID; merchantIdInPayPal is the seller ID.
  const candidateSellerMerchantId = merchantIdInPayPal;
  if (!candidateSellerMerchantId || !MERCHANT_ID_REGEX.test(candidateSellerMerchantId)) {
    await serviceClient
      .from("freelancer_paypal_accounts")
      .update({
        onboarding_status: "FAILED",
        payments_receivable: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    return makeRedirect("missing_merchant_id", "INVALID_OR_MISSING_PAYPAL_SELLER_ID");
  }

  // 8. Enforce required Partner Merchant ID configuration
  const paypalConfig = getPayPalServerEnv();
  const partnerId = paypalConfig.partnerMerchantId;
  if (!partnerId) {
    await serviceClient
      .from("freelancer_paypal_accounts")
      .update({
        onboarding_status: "FAILED",
        payments_receivable: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    return makeRedirect("config_error", "MISSING_PARTNER_MERCHANT_ID");
  }

  // 9. Server-to-Server Authoritative Merchant-Integrations Verification
  // Invariant: Do NOT trust browser query params. Query PayPal API directly.
  const paypalClient = new PayPalClient(paypalConfig);
  let integrationDetails: PayPalMerchantIntegrationResponse;
  try {
    const res = await paypalClient.get<PayPalMerchantIntegrationResponse>(
      `/v1/customer/partners/${encodeURIComponent(partnerId)}/merchant-integrations/${encodeURIComponent(candidateSellerMerchantId)}`,
      {
        partnerAttributionId: paypalConfig.partnerAttributionId,
      }
    );
    integrationDetails = res.data;
  } catch (err: unknown) {
    await serviceClient
      .from("freelancer_paypal_accounts")
      .update({
        paypal_merchant_id: candidateSellerMerchantId,
        onboarding_status: "FAILED",
        payments_receivable: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    return makeRedirect(
      "verification_failed",
      err instanceof Error ? err.message : "PROVIDER_INQUIRY_FAILED"
    );
  }

  // 10. Provider Response Cross-Validation
  if (integrationDetails.tracking_id && integrationDetails.tracking_id !== trackingId) {
    await serviceClient
      .from("freelancer_paypal_accounts")
      .update({
        onboarding_status: "FAILED",
        payments_receivable: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    return makeRedirect("verification_failed", "PROVIDER_TRACKING_ID_MISMATCH");
  }

  if (integrationDetails.merchant_id && integrationDetails.merchant_id !== candidateSellerMerchantId) {
    await serviceClient
      .from("freelancer_paypal_accounts")
      .update({
        onboarding_status: "FAILED",
        payments_receivable: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    return makeRedirect("verification_failed", "PROVIDER_MERCHANT_ID_MISMATCH");
  }

  // 11. Enforce Readiness Invariants
  const paymentsReceivable = integrationDetails.payments_receivable === true;
  const primaryEmailConfirmed = integrationDetails.primary_email_confirmed === true;

  if (!paymentsReceivable || !primaryEmailConfirmed) {
    await serviceClient
      .from("freelancer_paypal_accounts")
      .update({
        paypal_merchant_id: candidateSellerMerchantId,
        onboarding_status: "FAILED",
        payments_receivable: paymentsReceivable,
        primary_email_confirmed: primaryEmailConfirmed,
        seller_email: integrationDetails.primary_email ?? null,
        oauth_permissions: integrationDetails.oauth_third_party ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    return makeRedirect(
      "incomplete_onboarding",
      !primaryEmailConfirmed ? "EMAIL_UNCONFIRMED" : "PAYMENTS_NOT_RECEIVABLE"
    );
  }

  // 12. Persist Verified Seller Account Record
  // Stores the full, unmasked seller merchant ID server-side for Phase 3B.R2 order routing
  const { error: updateError } = await serviceClient
    .from("freelancer_paypal_accounts")
    .update({
      paypal_merchant_id: candidateSellerMerchantId,
      onboarding_status: "COMPLETED",
      payments_receivable: true,
      primary_email_confirmed: true,
      seller_email: integrationDetails.primary_email ?? null,
      oauth_permissions: integrationDetails.oauth_third_party ?? null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);

  if (updateError) {
    return makeRedirect("database_error");
  }

  return makeRedirect("connected");
}
