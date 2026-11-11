import { NextResponse } from "next/server";
import { z } from "zod";
import { markPortalNotificationRead } from "@/features/notifications/service";
import { authenticatePortalRequest } from "@/features/scope-changes/portal-auth";
import { apiError } from "@/lib/http";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const uuidSchema = z.string().uuid();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string; notificationId: string }> },
) {
  const { token, notificationId } = await context.params;
  if (!uuidSchema.safeParse(notificationId).success) {
    return apiError("VALIDATION_ERROR", 400, NO_STORE);
  }

  const auth = await authenticatePortalRequest({
    request,
    rawToken: token,
    rateLimitPrefix: "portal-notifications",
    limit: 60,
    windowMs: 60_000,
    requireCsrf: true,
  });

  if (!auth.ok) {
    return auth.response;
  }

  try {
    const updated = await markPortalNotificationRead({
      projectId: auth.projectId,
      clientEmail: auth.clientEmail,
      notificationId,
      serviceClient: auth.serviceClient,
    });

    if (!updated) {
      return apiError("NOT_FOUND", 404, NO_STORE);
    }

    return NextResponse.json({ data: updated }, { status: 200, headers: NO_STORE });
  } catch {
    return apiError("DATABASE_ERROR", 500, NO_STORE);
  }
}
