import { NextResponse } from "next/server";
import { agreementDraftSchema, type AgreementDraft } from "@/features/agreements/schema";
import { generateMilestonesRequestSchema } from "@/features/milestones/schema";
import { generateMilestonePlan } from "@/features/milestones/service";
import {
  AiConfigurationError,
  AiFinancialReconciliationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";
import { apiError } from "@/lib/http";
import { allowRequest } from "@/lib/security/rate-limit";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  let bodyRaw: unknown;
  try {
    bodyRaw = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400);
  }

  const parsed = generateMilestonesRequestSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid milestone generation request.",
        issues: parsed.error.issues,
      },
      { status: 400 }
    );
  }

  try {
    // 1. Authenticate requester cleanly
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return apiError("UNAUTHORIZED", 401);
    }

    // 2. Per-user rate limiting
    if (!(await allowRequest(`ai:milestones:${user.id}`, 5, 60_000))) {
      return apiError("RATE_LIMITED", 429);
    }

    // 3. Authoritative project fetch & ownership check (separate DB error from 403)
    const { data: projectData, error: projectError } = await supabase
      .from("projects")
      .select(
        "id, owner_id, title, client_name, brief, currency, total_amount_minor, status, start_date, target_end_date"
      )
      .eq("id", parsed.data.projectId)
      .maybeSingle();

    if (projectError) {
      return apiError("DATABASE_ERROR", 500);
    }

    const project = projectData as {
      id: string;
      owner_id: string;
      title: string;
      client_name: string;
      brief: string;
      currency: string;
      total_amount_minor: number;
      status: string;
      start_date: string | null;
      target_end_date: string | null;
    } | null;

    if (!project || project.owner_id !== user.id) {
      return apiError("FORBIDDEN", 403);
    }

    // 4. Fetch current agreement & saved milestone context (read-only)
    const { data: agreementData, error: agreementError } = await supabase
      .from("agreements")
      .select("id, status, current_version_id")
      .eq("project_id", project.id)
      .maybeSingle();

    if (agreementError) {
      return apiError("DATABASE_ERROR", 500);
    }

    const agreement = agreementData as {
      id: string;
      status: string;
      current_version_id: string | null;
    } | null;

    let currentAgreementDraft: AgreementDraft | null = null;
    let currentVersionNumber: number | null = null;
    let currentVersionStatus: string | null = agreement?.status ?? null;

    if (agreement?.current_version_id) {
      const { data: versionData, error: versionError } = await supabase
        .from("agreement_versions")
        .select("id, version_number, status, content")
        .eq("id", agreement.current_version_id)
        .maybeSingle();

      if (versionError) {
        return apiError("DATABASE_ERROR", 500);
      }

      if (versionData) {
        const version = versionData as {
          id: string;
          version_number: number;
          status: string;
          content: unknown;
        };
        currentVersionNumber = version.version_number;
        currentVersionStatus = version.status;
        const parsedContent = agreementDraftSchema.safeParse(version.content);
        if (parsedContent.success) {
          currentAgreementDraft = parsedContent.data;
        }
      }
    }

    const { data: existingMilestonesData, error: milestonesError } = await supabase
      .from("milestones")
      .select("id, title, status, amount_minor, currency, sort_order")
      .eq("project_id", project.id)
      .order("sort_order", { ascending: true });

    if (milestonesError) {
      return apiError("DATABASE_ERROR", 500);
    }

    const existingMilestones = (
      (existingMilestonesData ?? []) as Array<{
        title: string;
        status: string;
        amount_minor: number;
        currency: string;
      }>
    ).map((m) => ({
      title: m.title,
      status: m.status,
      amountMinor: m.amount_minor,
      currency: m.currency,
    }));

    const hasSufficientContext =
      (project.brief?.trim().length ?? 0) >= 10 ||
      Boolean(parsed.data.structuredBrief) ||
      Boolean(currentAgreementDraft);

    if (!hasSufficientContext) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message:
            "Insufficient project brief or agreement context to propose milestones.",
        },
        { status: 400 }
      );
    }

    const hasConfirmedBudget =
      typeof project.total_amount_minor === "number" &&
      Number.isInteger(project.total_amount_minor) &&
      project.total_amount_minor > 0 &&
      typeof project.currency === "string" &&
      /^[A-Z]{3}$/.test(project.currency);

    const allocateBudget =
      hasConfirmedBudget && parsed.data.includeFinancialAllocation !== false;

    // 5. Generate standalone milestone proposal without persisting
    const result = await generateMilestonePlan(
      {
        projectTitle: project.title,
        projectBrief: project.brief,
        structuredBrief: parsed.data.structuredBrief ?? null,
        existingAgreement: currentAgreementDraft,
        existingMilestones,
        confirmedBudgetMinor: hasConfirmedBudget ? project.total_amount_minor : null,
        establishedCurrency:
          project.currency && /^[A-Z]{3}$/.test(project.currency)
            ? project.currency
            : null,
        allocateBudget,
        startDate: project.start_date ?? null,
        targetEndDate: project.target_end_date ?? null,
        planningGoal: parsed.data.planningGoal ?? null,
      },
      {
        projectId: project.id,
        userId: user.id,
      }
    );

    return NextResponse.json({
      data: {
        plan: result.plan,
        model: result.model,
        durationMs: result.durationMs,
        preview: true,
        persisted: false,
        projectContext: {
          confirmedBudgetMinor: hasConfirmedBudget ? project.total_amount_minor : null,
          currency: project.currency ?? null,
          agreementStatus: currentVersionStatus,
          agreementVersionNumber: currentVersionNumber,
          hasApprovedAgreement:
            currentVersionStatus === "APPROVED" || agreement?.status === "APPROVED",
        },
      },
    });
  } catch (error) {
    if (error instanceof AiConfigurationError) {
      return apiError("AI_CONFIG_ERROR", 500);
    }
    if (error instanceof AiRateLimitError) {
      return apiError("AI_RATE_LIMITED", 429);
    }
    if (error instanceof AiUnavailableError) {
      return apiError("AI_UNAVAILABLE", 503);
    }
    if (
      error instanceof AiOutputValidationError ||
      error instanceof AiFinancialReconciliationError
    ) {
      return apiError("AI_OUTPUT_INVALID", 422);
    }

    return apiError("INTERNAL_ERROR", 500);
  }
}
