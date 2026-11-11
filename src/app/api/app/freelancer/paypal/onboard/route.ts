import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireUser } from "@/lib/auth/require-user";
import { createServiceClient } from "@/lib/supabase/service";
import { getPayPalServerEnv } from "@/lib/paypal/env";
import { PayPalClient } from "@/lib/paypal/client";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { getCanonicalAppUrl } from "@/lib/security/app-url";
import { apiError } from "@/lib/http";

export interface PartnerReferralResponse {
  links?: Array<{ href: string; rel: string; method?: string }>;
  partner_referral_id?: string;
}

/**
 * POST /api/app/freelancer/paypal/onboard
 *
 * Initiates the PayPal Partner Referrals onboarding flow for an authenticated freelancer.
 *
 * Security Invariants:
 * 1. Requires authenticated freelancer session via Supabase Auth.
 * 2. Generates an opaque, cryptographically random tracking ID (does NOT leak the user's UUID).
 * 3. Enforces DB-backed rate limiting (5 requests / 15 minutes per freelancer).
 * 4. Dispatches request to PayPal Sandbox Partner Referrals API requesting minimal scopes (PAYMENT, REFUND).
 * 5. Persists onboarding attempt in public.freelancer_paypal_accounts using privileged service role.
 * 6. Returns action_url for the frontend to open or redirect to.
 */
export async function POST() {
  // 1. Authenticate freelancer
  let user: { id: string; email?: string };
  try {
    const authResult = await requireUser();
    user = authResult.user;
  } catch {
    return apiError("UNAUTHORIZED", 401, { "Cache-Control": "no-store" });
  }

  // 2. Rate limiting (5 attempts / 15 minutes)
  const rateLimitKey = `freelancer-onboard:${user.id}`;
  const rateLimit = await checkRateLimit(rateLimitKey, 5, 900_000, {
    failClosedInProduction: true,
  });

  if (!rateLimit.allowed) {
    if (rateLimit.status === "service_unavailable") {
      return apiError("RATE_LIMITER_UNAVAILABLE", 503, { "Cache-Control": "no-store" });
    }
    return apiError("RATE_LIMITED", 429, { "Cache-Control": "no-store" });
  }

  const serviceClient = createServiceClient();

  // 3. Inspect existing account connection
  const { data: existingAccount } = await serviceClient
    .from("freelancer_paypal_accounts")
    .select("id, onboarding_status, payments_receivable, tracking_id, action_url")
    .eq("user_id", user.id)
    .maybeSingle();

  // If already connected and ready to receive payments, report status
  if (
    existingAccount &&
    existingAccount.onboarding_status === "COMPLETED" &&
    existingAccount.payments_receivable
  ) {
    return NextResponse.json(
      {
        success: true,
        alreadyConnected: true,
        message: "Your PayPal seller account is already connected and active.",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  // 4. Generate opaque cryptographically random tracking ID
  // Prefixed, 40-hex-char opaque identifier (does NOT expose the user's UUID)
  const trackingId = `pr_track_${randomBytes(20).toString("hex")}`;

  // 5. Construct return URL
  let appUrl: string;
  try {
    appUrl = getCanonicalAppUrl();
  } catch {
    return apiError("CONFIGURATION_UNAVAILABLE", 503, {
      "Cache-Control": "no-store",
    });
  }
  const returnUrl = `${appUrl}/api/app/freelancer/paypal/callback?state=${encodeURIComponent(trackingId)}`;

  // 6. Build official PayPal Partner Referrals API payload
  const partnerReferralPayload = {
    tracking_id: trackingId,
    partner_config_override: {
      return_url: returnUrl,
      return_url_description: "Return to PayRoost Seller Settings",
    },
    operations: [
      {
        operation: "API_INTEGRATION",
        api_integration_preference: {
          rest_api_integration: {
            integration_method: "PAYPAL",
            integration_type: "THIRD_PARTY",
            third_party_details: {
              features: ["PAYMENT", "REFUND"],
            },
          },
        },
      },
    ],
    products: ["EXPRESS_CHECKOUT"],
    legal_consents: [
      {
        type: "SHARE_DATA_CONSENT",
        granted: true,
      },
    ],
  };

  // 7. Dispatch call to PayPal Sandbox Partner Referrals API
  const paypalConfig = getPayPalServerEnv();
  const paypalClient = new PayPalClient(paypalConfig);

  let referralResponse: PartnerReferralResponse;
  try {
    const res = await paypalClient.post<PartnerReferralResponse>(
      "/v2/customer/partner-referrals",
      partnerReferralPayload,
      {
        partnerAttributionId: paypalConfig.partnerAttributionId,
      }
    );
    referralResponse = res.data;
  } catch {
    return NextResponse.json(
      {
        error: "PAYPAL_REFERRAL_FAILED",
        message: "Failed to initiate PayPal seller onboarding. Please try again later.",
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const actionUrl = referralResponse.links?.find((l) => l.rel === "action_url")?.href;
  if (!actionUrl) {
    return NextResponse.json(
      {
        error: "MALFORMED_REFERRAL_RESPONSE",
        message: "PayPal did not return an onboarding redirect URL. Please try again.",
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  // 8. Persist onboarding record in public.freelancer_paypal_accounts
  const { error: upsertError } = await serviceClient
    .from("freelancer_paypal_accounts")
    .upsert(
      {
        user_id: user.id,
        tracking_id: trackingId,
        partner_referral_id: referralResponse.partner_referral_id ?? null,
        action_url: actionUrl,
        onboarding_status: "INITIATED",
        payments_receivable: false,
        primary_email_confirmed: false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

  if (upsertError) {
    return apiError("DATABASE_PERSISTENCE_FAILED", 500, {
      "Cache-Control": "no-store",
    });
  }

  return NextResponse.json(
    {
      success: true,
      actionUrl,
      trackingId,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
