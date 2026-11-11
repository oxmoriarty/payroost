import { NextResponse } from "next/server";
import { z } from "zod";
import {
  generateAgreementDraft,
  GeminiOutputError,
  GeminiUnavailableError,
} from "@/features/agreements/gemini";
import { structuredBriefSchema, type StructuredBrief } from "@/features/briefs/schema";
import { saveAgreementDraft } from "@/app/api/projects/[projectId]/agreement/route";
import { createClient } from "@/lib/supabase/server";
import { allowRequest } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";
import {
  AiConfigurationError,
  AiFinancialReconciliationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";

const uuidSchema = z.string().uuid();

export async function POST(request: Request) {
  let body: {
    projectId?: string;
    structuredBrief?: unknown;
    saveImmediately?: boolean;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("INVALID_JSON", 400);
  }

  if (!body.projectId || typeof body.projectId !== "string" || !uuidSchema.safeParse(body.projectId).success) {
    return apiError("VALIDATION_ERROR", 400);
  }

  // 1. Validate optional structuredBrief payload early
  let parsedStructuredBrief: StructuredBrief | undefined;
  if (body.structuredBrief !== undefined && body.structuredBrief !== null) {
    const briefParsed = structuredBriefSchema.safeParse(body.structuredBrief);
    if (!briefParsed.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: "Invalid structuredBrief payload.",
          issues: briefParsed.error.issues,
        },
        { status: 400 }
      );
    }
    parsedStructuredBrief = briefParsed.data;
  }

  try {
    // 2. Authenticate requesting user cleanly (return 401 rather than redirecting or masking as 403)
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return apiError("UNAUTHORIZED", 401);
    }

    // 3. Rate limit per authenticated user
    if (!(await allowRequest(`ai:agreement:${user.id}`, 5, 60_000))) {
      return apiError("RATE_LIMITED", 429);
    }

    // 4. Fetch project and verify ownership explicitly, separating DB failures from authorization failures
    const { data: projectData, error: projectError } = await supabase
      .from("projects")
      .select(
        "id, owner_id, title, client_name, client_email, client_email_verified_at, brief, currency, total_amount_minor, start_date, target_end_date"
      )
      .eq("id", body.projectId)
      .maybeSingle();

    if (projectError) {
      return apiError("DATABASE_ERROR", 500);
    }

    const project = projectData as {
      id: string;
      owner_id: string;
      title: string;
      client_name: string;
      client_email: string;
      client_email_verified_at: string | null;
      brief: string;
      currency: string;
      total_amount_minor: number;
      start_date: string | null;
      target_end_date: string | null;
    } | null;

    if (!project || project.owner_id !== user.id) {
      return apiError("FORBIDDEN", 403);
    }

    // 5. Strict financial parameter validation
    if (
      typeof project.total_amount_minor !== "number" ||
      !Number.isInteger(project.total_amount_minor) ||
      project.total_amount_minor <= 0
    ) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: "Project budget must be a positive integer amount in minor units.",
        },
        { status: 400 }
      );
    }

    if (!project.currency || !/^[A-Z]{3}$/.test(project.currency)) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: `Invalid project currency code: "${project.currency}".`,
        },
        { status: 400 }
      );
    }

    // 6. Generate agreement draft with exact financial reconciliation
    const draft = await generateAgreementDraft(
      {
        title: project.title,
        brief: project.brief,
        structuredBrief: parsedStructuredBrief,
        clientLabel: project.client_name,
        freelancerLabel: "Freelancer",
        currency: project.currency,
        totalAmountMinor: project.total_amount_minor,
        startDate: project.start_date ?? null,
        endDate: project.target_end_date,
      },
      {
        projectId: project.id,
        userId: user.id,
      }
    );

    // 7. Preview vs Persistence: Preview mode is the default
    if (body.saveImmediately === true) {
      const saved = await saveAgreementDraft(project.id, draft, { source: "AI_ASSISTED" });
      if (saved.error) return saved.error;
      return NextResponse.json({ data: saved.data });
    }

    // Safe preview return: No database writes, no silent overwrite
    return NextResponse.json({
      data: {
        draft,
        preview: true,
        reconciled: true,
        totalAmountMinor: project.total_amount_minor,
        currency: project.currency,
      },
    });
  } catch (error) {
    if (error instanceof AiConfigurationError) {
      return apiError("AI_CONFIG_ERROR", 500);
    }
    if (error instanceof AiRateLimitError) {
      return apiError("AI_RATE_LIMITED", 429);
    }
    if (error instanceof GeminiUnavailableError || error instanceof AiUnavailableError) {
      return apiError("AI_UNAVAILABLE", 503);
    }
    if (
      error instanceof GeminiOutputError ||
      error instanceof AiOutputValidationError ||
      error instanceof AiFinancialReconciliationError
    ) {
      return apiError("AI_OUTPUT_INVALID", 422);
    }

    return apiError("INTERNAL_ERROR", 500);
  }
}
