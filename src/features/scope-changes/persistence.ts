import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { agreementDraftSchema } from "@/features/agreements/schema";
import {
  AiConfigurationError,
  AiFinancialReconciliationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";
import { apiError } from "@/lib/http";
import { normalizeChangeRequestText } from "./classification";
import {
  loadAuthoritativeScopeChangeContext,
  validateSubmittedAiAnalysisSnapshot,
  type LoadScopeChangeContextResult,
} from "./context";
import type { ScopeChangeRequesterRole } from "./schema";
import { analyzeScopeChange } from "./service";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export function mapScopeContextFailure(
  failure: Extract<LoadScopeChangeContextResult, { ok: false }>
): NextResponse {
  if (failure.code === "AGREEMENT_VERSION_REQUIRED") {
    return NextResponse.json(
      {
        error: "AGREEMENT_VERSION_REQUIRED",
        message:
          "Create or generate at least one agreement version before analyzing or submitting scope changes.",
      },
      { status: 409, headers: NO_STORE_HEADERS }
    );
  }

  if (failure.code === "VERSION_FORBIDDEN") {
    return apiError("FORBIDDEN", 403, NO_STORE_HEADERS);
  }

  return apiError(failure.code, failure.status, NO_STORE_HEADERS);
}

export function mapScopeAiError(error: unknown): NextResponse {
  if (error instanceof AiConfigurationError) {
    return apiError("AI_CONFIGURATION_ERROR", 500, NO_STORE_HEADERS);
  }
  if (error instanceof AiRateLimitError) {
    return apiError("RATE_LIMITED", 429, NO_STORE_HEADERS);
  }
  if (error instanceof AiUnavailableError) {
    return apiError("AI_UNAVAILABLE", 503, NO_STORE_HEADERS);
  }
  if (
    error instanceof AiOutputValidationError ||
    error instanceof AiFinancialReconciliationError
  ) {
    return NextResponse.json(
      {
        error: "AI_VALIDATION_ERROR",
        message: error.message,
      },
      { status: 422, headers: NO_STORE_HEADERS }
    );
  }
  return apiError("INTERNAL_ERROR", 500, NO_STORE_HEADERS);
}

/**
 * Shared read-only preview execution for both Freelancer Dashboard and verified Client Portal.
 * Performs zero database mutations.
 */
export async function runScopeChangePreviewAnalysis(params: {
  supabase: SupabaseClient;
  projectId: string;
  expectedOwnerId?: string;
  requestedAgreementVersionId?: string;
  requestText: string;
  requesterRole: ScopeChangeRequesterRole;
  userId?: string;
}): Promise<NextResponse> {
  const contextResult = await loadAuthoritativeScopeChangeContext(params.supabase, {
    projectId: params.projectId,
    expectedOwnerId: params.expectedOwnerId,
    requestedAgreementVersionId: params.requestedAgreementVersionId,
  });

  if (!contextResult.ok) {
    return mapScopeContextFailure(contextResult);
  }

  const ctx = contextResult.context;
  const parsedAgreement = agreementDraftSchema.safeParse(ctx.targetVersion.content);

  try {
    const result = await analyzeScopeChange(
      {
        projectId: ctx.project.id,
        projectTitle: ctx.project.title,
        projectBrief: ctx.project.brief,
        projectStatus: ctx.project.status,
        confirmedBudgetMinor: ctx.confirmedBudgetMinor,
        establishedCurrency: ctx.establishedCurrency,
        startDate: ctx.project.start_date,
        targetEndDate: ctx.project.target_end_date,
        agreementVersionId: ctx.targetVersion.id,
        agreementVersionNumber: ctx.targetVersion.version_number,
        agreementStatus: ctx.targetVersion.status,
        agreementContent: parsedAgreement.success ? parsedAgreement.data : null,
        rawAgreementSummary: ctx.rawAgreementSummary,
        milestones: ctx.milestones,
        openChangeRequests: ctx.openChangeRequests,
        requesterRole: params.requesterRole,
        requestText: params.requestText,
      },
      { userId: params.userId }
    );

    return NextResponse.json(
      {
        data: {
          analysis: result.analysis,
          preview: true,
          persisted: false,
          agreementVersionId: ctx.targetVersion.id,
          agreementVersionNumber: ctx.targetVersion.version_number,
          agreementStatus: ctx.targetVersion.status,
          model: result.model,
          durationMs: result.durationMs,
        },
      },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return mapScopeAiError(error);
  }
}

/**
 * Shared server-authoritative submission helper for creating a NEW public.change_requests row.
 * Strictly separates user request_text from validated ai_analysis snapshots, rejects stale or
 * cross-project snapshots, and never mutates existing agreements, milestones, or payments.
 */
export async function submitValidatedChangeRequest(params: {
  supabase: SupabaseClient;
  projectId: string;
  expectedOwnerId?: string;
  requestedAgreementVersionId?: string;
  requestText: string;
  rawAiAnalysis?: unknown;
  expectedRole: ScopeChangeRequesterRole;
  submittedByLabel: string;
  actorUserId: string | null;
}): Promise<NextResponse> {
  const contextResult = await loadAuthoritativeScopeChangeContext(params.supabase, {
    projectId: params.projectId,
    expectedOwnerId: params.expectedOwnerId,
    requestedAgreementVersionId: params.requestedAgreementVersionId,
  });

  if (!contextResult.ok) {
    return mapScopeContextFailure(contextResult);
  }

  const ctx = contextResult.context;
  const normalizedRequestText = normalizeChangeRequestText(params.requestText);

  let validatedAnalysis: ReturnType<typeof validateSubmittedAiAnalysisSnapshot> | null = null;
  if (params.rawAiAnalysis !== undefined && params.rawAiAnalysis !== null) {
    validatedAnalysis = validateSubmittedAiAnalysisSnapshot({
      rawAnalysis: params.rawAiAnalysis,
      projectId: ctx.project.id,
      agreementVersionId: ctx.targetVersion.id,
      requestText: normalizedRequestText,
      expectedRole: params.expectedRole,
    });

    if (!validatedAnalysis.ok) {
      return NextResponse.json(
        {
          error: validatedAnalysis.code,
          message: validatedAnalysis.message,
        },
        { status: validatedAnalysis.status, headers: NO_STORE_HEADERS }
      );
    }
  }

  const analysisSnapshot = validatedAnalysis?.ok ? validatedAnalysis.analysis : null;

  const { data: created, error: insertError } = await params.supabase
    .from("change_requests")
    .insert({
      project_id: ctx.project.id,
      agreement_version_id: ctx.targetVersion.id,
      request_text: normalizedRequestText,
      submitted_by_label: params.submittedByLabel,
      status: "OPEN",
      ai_analysis: analysisSnapshot,
      ai_analyzed_at: analysisSnapshot ? analysisSnapshot.snapshotMetadata.analyzedAt : null,
      ai_model: analysisSnapshot ? analysisSnapshot.snapshotMetadata.model : null,
    })
    .select(
      "id, project_id, agreement_version_id, request_text, submitted_by_label, status, created_at, resolved_at, ai_analysis, ai_analyzed_at, ai_model"
    )
    .single();

  if (insertError || !created) {
    return apiError("CHANGE_REQUEST_SAVE_FAILED", 500, NO_STORE_HEADERS);
  }

  await params.supabase.from("activity_events").insert({
    project_id: ctx.project.id,
    actor_user_id: params.actorUserId,
    actor_label: params.submittedByLabel,
    event_type: "change_request.submitted",
    summary: analysisSnapshot
      ? `Submitted scope-change request (${analysisSnapshot.overallClassification} AI impact proposal) against agreement v${ctx.targetVersion.version_number}`
      : `Submitted scope-change request against agreement v${ctx.targetVersion.version_number}`,
    metadata: {
      changeRequestId: (created as { id: string }).id,
      agreementVersionId: ctx.targetVersion.id,
      agreementVersionNumber: ctx.targetVersion.version_number,
      requesterRole: params.expectedRole,
      hasAiAnalysis: Boolean(analysisSnapshot),
      overallClassification: analysisSnapshot?.overallClassification ?? null,
      financialDirection: analysisSnapshot?.financialImpact.direction ?? null,
    },
  });

  return NextResponse.json(
    {
      data: {
        changeRequest: created,
        persisted: true,
        agreementChanged: false,
        milestonesChanged: false,
        paymentsChanged: false,
      },
    },
    { status: 201, headers: NO_STORE_HEADERS }
  );
}
