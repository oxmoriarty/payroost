import { NextResponse } from "next/server";
import { z } from "zod";
import { markAllUserNotificationsRead } from "@/features/notifications/service";
import { apiError } from "@/lib/http";
import { validateOperatorCsrf } from "@/lib/security/operator-csrf";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const bodySchema = z.object({
  projectId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  let projectId: string | undefined;
  const rawBody = await request.text();
  if (rawBody.trim().length > 0) {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return apiError("INVALID_JSON", 400, NO_STORE);
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", 400, NO_STORE);
    }
    projectId = parsed.data.projectId;
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

    if (!(await allowRequest(`app-notifications-read-all:${user.id}`, 20, 60_000))) {
      return apiError("RATE_LIMITED", 429, NO_STORE);
    }

    const result = await markAllUserNotificationsRead({
      userId: user.id,
      projectId,
      supabaseClient: supabase,
    });

    return NextResponse.json({ data: result }, { status: 200, headers: NO_STORE });
  } catch {
    return apiError("DATABASE_ERROR", 500, NO_STORE);
  }
}
