import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AiConfigurationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";
import { apiError } from "@/lib/http";
import { assembleProjectAssistantContext } from "./context";
import type { AssistantConversationTurn, AssistantParticipantRole } from "./schema";
import { askProjectAssistant } from "./service";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export function mapAssistantAiError(error: unknown): NextResponse {
  if (error instanceof AiConfigurationError) {
    return apiError("AI_CONFIGURATION_ERROR", 500, NO_STORE_HEADERS);
  }
  if (error instanceof AiRateLimitError) {
    return apiError("RATE_LIMITED", 429, NO_STORE_HEADERS);
  }
  if (error instanceof AiUnavailableError) {
    return apiError("AI_UNAVAILABLE", 503, NO_STORE_HEADERS);
  }
  if (error instanceof AiOutputValidationError) {
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
 * Shared strictly read-only execution pipeline for both Freelancer Dashboard and
 * verified Client Portal project assistant endpoints. Rebuilds authoritative server
 * context on every turn and never persists chats or mutates project records.
 */
export async function handleProjectAssistantRequest(params: {
  supabase: SupabaseClient;
  projectId: string;
  participantRole: AssistantParticipantRole;
  expectedOwnerId?: string;
  expectedClientEmail?: string;
  question: string;
  history: AssistantConversationTurn[];
  userId?: string;
}): Promise<NextResponse> {
  const assembled = await assembleProjectAssistantContext(params.supabase, {
    projectId: params.projectId,
    participantRole: params.participantRole,
    expectedOwnerId: params.expectedOwnerId,
    expectedClientEmail: params.expectedClientEmail,
  });

  if (!assembled.ok) {
    return apiError(assembled.code, assembled.status, NO_STORE_HEADERS);
  }

  try {
    const result = await askProjectAssistant({
      context: assembled.context,
      question: params.question,
      history: params.history,
      userId: params.userId,
    });

    return NextResponse.json(
      {
        data: {
          reply: result.reply,
          model: result.model,
          durationMs: result.durationMs,
        },
      },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return mapAssistantAiError(error);
  }
}
