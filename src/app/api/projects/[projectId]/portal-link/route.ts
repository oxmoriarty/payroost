import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createPortalToken, hashPortalToken } from "@/lib/security/tokens";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { getCanonicalAppUrl } from "@/lib/security/app-url";
import { sendPortalInvitationEmail } from "@/lib/email/provider";
import { syncNotificationsFromActivityEvents } from "@/features/notifications/service";
import { apiError } from "@/lib/http";

export const PORTAL_TOKEN_EXPIRY_DAYS = 7;
export const PORTAL_TOKEN_EXPIRY_MS = PORTAL_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

const uuidSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;

  // 1. Validate project UUID format
  const parsedProjectId = uuidSchema.safeParse(projectId);
  if (!parsedProjectId.success) {
    return apiError("INVALID_PROJECT_ID", 400);
  }

  // 2. Reject arbitrary or malicious request payload
  const bodyText = await request.text();
  if (bodyText.trim().length > 0) {
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return apiError("INVALID_JSON", 400);
    }

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return apiError("VALIDATION_ERROR", 400);
    }

    // Strictly disallow caller-supplied parameters (email, expiry, tokens, redirect URLs)
    const keys = Object.keys(json);
    if (keys.length > 0) {
      return apiError("VALIDATION_ERROR", 400);
    }
  }

  // 3. Authenticate Supabase user session (authenticated owner requirement)
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return apiError("UNAUTHORIZED", 401);
  }

  // 4. Rate-limit portal-link issuance per authenticated user and project
  const rateLimitKey = `portal-link-issue:${user.id}:${projectId}`;
  const rateLimit = await checkRateLimit(rateLimitKey, 5, 600_000, {
    failClosedInProduction: true,
  });

  if (!rateLimit.allowed) {
    if (rateLimit.status === "service_unavailable") {
      return apiError("RATE_LIMITER_UNAVAILABLE", 503);
    }
    return apiError("RATE_LIMITED", 429);
  }

  // 5. Resolve and validate canonical application base URL BEFORE creating database tokens
  let appBaseUrl: string;
  try {
    appBaseUrl = getCanonicalAppUrl();
  } catch {
    // Sanitized server configuration error; never leak environment details
    return apiError("CONFIGURATION_UNAVAILABLE", 503);
  }

  // 6. Generate high-entropy portal token and SHA-256 hash
  const rawToken = createPortalToken();
  const tokenHash = hashPortalToken(rawToken);
  const expiresAt = new Date(Date.now() + PORTAL_TOKEN_EXPIRY_MS).toISOString();

  // 7. Invoke existing database RPC using the authenticated user client
  // The RPC verifies caller is owner, project exists, client email is verified, and revokes prior tokens
  const { data: tokenId, error: rpcError } = await supabase.rpc(
    "create_client_portal_token",
    {
      p_project_id: projectId,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
    }
  );

  if (rpcError || !tokenId) {
    if (rpcError?.message?.includes("Client email must be verified")) {
      return apiError("CLIENT_EMAIL_NOT_VERIFIED", 409);
    }
    // Return generic authorization error without disclosing project existence
    return apiError("NOT_FOUND_OR_FORBIDDEN", 403);
  }

  // 8. Query verified client email and project metadata via authenticated client
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, title, client_name, client_email")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError || !project || !project.client_email) {
    return apiError("NOT_FOUND_OR_FORBIDDEN", 403);
  }

  // 9. Construct portal URL using validated canonical base URL (never Host or Origin headers)
  const portalUrl = new URL(
    `/portal/${encodeURIComponent(rawToken)}`,
    appBaseUrl
  ).toString();

  // 10. Dispatch portal invitation email to verified client email
  const delivery = await sendPortalInvitationEmail({
    clientEmail: project.client_email,
    clientName: project.client_name,
    projectTitle: project.title,
    portalUrl,
    expiresInDays: PORTAL_TOKEN_EXPIRY_DAYS,
  });

  if (!delivery.success) {
    // Sanitized error response; never disclose raw token or URL
    return apiError("EMAIL_DELIVERY_FAILED", 502);
  }

  // Record audit/history event without ever persisting raw tokens or invite URLs
  try {
    await supabase.from("activity_events").insert({
      project_id: projectId,
      actor_user_id: user.id,
      actor_label: "Freelancer",
      event_type: "portal.invited",
      summary: "Sent verified Client Portal invitation link",
      metadata: { expiresAt },
    });
    await syncNotificationsFromActivityEvents({ projectId, limit: 10 });
  } catch {
    // Non-fatal if activity insert/sync unavailable in mocked environments
  }

  // 11. Success response: Raw token and portal URL are strictly omitted from response
  return NextResponse.json({
    success: true,
    expiresAt,
  });
}
