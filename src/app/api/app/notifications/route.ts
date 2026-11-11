import { NextResponse } from "next/server";
import { z } from "zod";
import { listUserNotifications } from "@/features/notifications/service";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const querySchema = z.object({
  filter: z.enum(["all", "unread", "action_required"]).optional(),
  category: z
    .enum(["PROJECT", "AGREEMENT", "MILESTONE", "SCOPE_CHANGE", "PAYMENT", "RECONCILIATION"])
    .optional(),
  projectId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return apiError("UNAUTHORIZED", 401, NO_STORE);
    }

    if (!(await allowRequest(`app-notifications-list:${user.id}`, 60, 60_000))) {
      return apiError("RATE_LIMITED", 429, NO_STORE);
    }

    const url = new URL(request.url);
    const rawParams = {
      filter: url.searchParams.get("filter") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      projectId: url.searchParams.get("projectId") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    };

    const parsed = querySchema.safeParse(rawParams);
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", 400, NO_STORE);
    }

    const result = await listUserNotifications({
      userId: user.id,
      projectId: parsed.data.projectId,
      filter: parsed.data.filter,
      category: parsed.data.category,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      supabaseClient: supabase,
    });

    return NextResponse.json({ data: result }, { status: 200, headers: NO_STORE });
  } catch {
    return apiError("DATABASE_ERROR", 500, NO_STORE);
  }
}
