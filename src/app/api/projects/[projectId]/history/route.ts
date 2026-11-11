import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectHistory } from "@/features/history/service";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const uuidSchema = z.string().uuid();

const querySchema = z.object({
  category: z
    .enum(["PROJECT", "AGREEMENT", "MILESTONE", "SCOPE_CHANGE", "PAYMENT", "RECONCILIATION"])
    .optional(),
  sort: z.enum(["desc", "asc"]).optional(),
  page: z.coerce.number().int().min(1).max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  if (!uuidSchema.safeParse(projectId).success) {
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

    if (!(await allowRequest(`project-history:${user.id}:${projectId}`, 60, 60_000))) {
      return apiError("RATE_LIMITED", 429, NO_STORE);
    }

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      category: url.searchParams.get("category") ?? undefined,
      sort: url.searchParams.get("sort") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });

    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", 400, NO_STORE);
    }

    const result = await getProjectHistory({
      projectId,
      userId: user.id,
      category: parsed.data.category,
      sort: parsed.data.sort,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      supabaseClient: supabase,
    });

    if (!result) {
      return apiError("NOT_FOUND", 404, NO_STORE);
    }

    return NextResponse.json({ data: result }, { status: 200, headers: NO_STORE });
  } catch {
    return apiError("DATABASE_ERROR", 500, NO_STORE);
  }
}
