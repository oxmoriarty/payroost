import { NextResponse } from "next/server";
import { z } from "zod";
import { getPortalProjectHistory } from "@/features/history/service";
import { authenticatePortalRequest } from "@/features/scope-changes/portal-auth";
import { apiError } from "@/lib/http";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const auth = await authenticatePortalRequest({
    request,
    rawToken: token,
    rateLimitPrefix: "portal-history",
    limit: 60,
    windowMs: 60_000,
    requireCsrf: false,
  });

  if (!auth.ok) {
    return auth.response;
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

  try {
    const result = await getPortalProjectHistory({
      projectId: auth.projectId,
      category: parsed.data.category,
      sort: parsed.data.sort,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      serviceClient: auth.serviceClient,
    });

    return NextResponse.json({ data: result }, { status: 200, headers: NO_STORE });
  } catch {
    return apiError("DATABASE_ERROR", 500, NO_STORE);
  }
}
