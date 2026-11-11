import { NextResponse } from "next/server";
import { z } from "zod";
import { markUserNotificationRead } from "@/features/notifications/service";
import { apiError } from "@/lib/http";
import { validateOperatorCsrf } from "@/lib/security/operator-csrf";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const uuidSchema = z.string().uuid();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ notificationId: string }> },
) {
  const { notificationId } = await context.params;
  if (!uuidSchema.safeParse(notificationId).success) {
    return apiError("VALIDATION_ERROR", 400, NO_STORE);
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return apiError("UNAUTHORIZED", 401, NO_STORE);
    }

    const csrf = await validateOperatorCsrf(request);
    if (!csrf.valid) {
      return apiError("INVALID_CSRF_TOKEN", 403, NO_STORE);
    }

    if (!(await allowRequest(`app-notifications-read:${user.id}`, 60, 60_000))) {
      return apiError("RATE_LIMITED", 429, NO_STORE);
    }

    const updated = await markUserNotificationRead({
      userId: user.id,
      notificationId,
      supabaseClient: supabase,
    });

    if (!updated) {
      return apiError("NOT_FOUND", 404, NO_STORE);
    }

    return NextResponse.json({ data: updated }, { status: 200, headers: NO_STORE });
  } catch {
    return apiError("DATABASE_ERROR", 500, NO_STORE);
  }
}
