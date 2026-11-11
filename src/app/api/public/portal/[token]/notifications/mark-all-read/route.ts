import { NextResponse } from "next/server";
import { markAllPortalNotificationsRead } from "@/features/notifications/service";
import { authenticatePortalRequest } from "@/features/scope-changes/portal-auth";
import { apiError } from "@/lib/http";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const auth = await authenticatePortalRequest({
    request,
    rawToken: token,
    rateLimitPrefix: "portal-notifications",
    limit: 20,
    windowMs: 60_000,
    requireCsrf: true,
  });

  if (!auth.ok) {
    return auth.response;
  }

  try {
    const result = await markAllPortalNotificationsRead({
      projectId: auth.projectId,
      clientEmail: auth.clientEmail,
      serviceClient: auth.serviceClient,
    });

    return NextResponse.json({ data: result }, { status: 200, headers: NO_STORE });
  } catch {
    return apiError("DATABASE_ERROR", 500, NO_STORE);
  }
}
