import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";
import {
  AiConfigurationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";
import { structureBriefRequestSchema } from "@/features/briefs/schema";
import { structureProjectBrief } from "@/features/briefs/service";

export const maxDuration = 60;

function getSafeConfigErrorMessage(error: AiConfigurationError): string {
  if (error.status === 401 || error.status === 403) {
    return "Gemini API key was rejected or lacks permission. Verify GEMINI_API_KEY in server configuration.";
  }
  if (error.status === 404) {
    return "Configured Gemini model was not found. Verify GEMINI_MODEL (default: gemini-3.8-flash) in server configuration.";
  }
  if (error.status === 400) {
    return "Gemini rejected the request configuration or schema. Check server AI settings.";
  }
  return "AI brief generation is not configured on the server. Set GEMINI_API_KEY in your environment configuration.";
}

export async function POST(request: Request) {
  let bodyRaw: unknown;
  try {
    bodyRaw = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400);
  }

  const parsed = structureBriefRequestSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid request body",
        issues: parsed.error.issues,
      },
      { status: 400 }
    );
  }

  try {
    // 1. Authenticate requesting user
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return apiError("UNAUTHORIZED", 401);
    }

    // 2. Rate limit per authenticated user (10 requests per minute)
    const rateLimit = await checkRateLimit(`ai:brief:${user.id}`, 10, 60_000, {
      failClosedInProduction: true,
    });
    if (!rateLimit.allowed) {
      if (rateLimit.isUnavailable || rateLimit.status === "service_unavailable") {
        return NextResponse.json(
          {
            error: "RATE_LIMITER_UNAVAILABLE",
            message: "Rate limiting service is temporarily unavailable. Please try again in a moment.",
          },
          { status: 503 }
        );
      }
      return apiError("RATE_LIMITED", 429);
    }

    let description = parsed.data.description;
    let clientContext: { clientName?: string; existingTitle?: string } | undefined;

    // 3. Project ownership verification if projectId is specified
    if (parsed.data.projectId) {
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, title, client_name, brief")
        .eq("id", parsed.data.projectId)
        .eq("owner_id", user.id)
        .maybeSingle();

      if (projectError) {
        console.error("[/api/ai/structure-brief] Project lookup failed", {
          code: projectError.code,
          message: projectError.message,
        });
        return NextResponse.json(
          {
            error: "DATABASE_ERROR",
            message: "Unable to verify project ownership right now. Please try again.",
          },
          { status: 500 }
        );
      }

      if (!project) {
        return apiError("FORBIDDEN", 403);
      }

      clientContext = {
        clientName: project.client_name,
        existingTitle: project.title,
      };

      if (!description) {
        description = project.brief;
      }
    }

    if (!description || description.trim().length < 10) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: "Project description must be at least 10 characters long.",
        },
        { status: 400 }
      );
    }

    // 4. Execute AI structuring service
    const result = await structureProjectBrief({
      description,
      context: clientContext,
      projectId: parsed.data.projectId,
      userId: user.id,
    });

    return NextResponse.json({
      data: {
        brief: result.brief,
        model: result.model,
        durationMs: result.durationMs,
      },
    });
  } catch (error) {
    if (error instanceof AiConfigurationError) {
      console.error("[/api/ai/structure-brief] AI configuration failure", {
        status: error.status ?? null,
        message: error.message,
      });
      return NextResponse.json(
        {
          error: "AI_CONFIG_ERROR",
          message: getSafeConfigErrorMessage(error),
        },
        { status: 500 }
      );
    }
    if (error instanceof AiRateLimitError) {
      return NextResponse.json(
        {
          error: "AI_RATE_LIMITED",
          message: "Gemini API rate limit exceeded. Please wait a minute before trying again.",
        },
        { status: 429 }
      );
    }
    if (error instanceof AiUnavailableError) {
      console.error("[/api/ai/structure-brief] AI provider unavailable", {
        status: error.status ?? null,
        isTimeout: error.isTimeout,
        message: error.message,
      });
      return NextResponse.json(
        {
          error: "AI_UNAVAILABLE",
          message: error.isTimeout
            ? "AI request timed out while waiting on Gemini. Please retry in a moment."
            : "AI service is temporarily unavailable. Please retry in a moment.",
        },
        { status: 503 }
      );
    }
    if (error instanceof AiOutputValidationError) {
      return NextResponse.json(
        {
          error: "AI_OUTPUT_INVALID",
          message: "AI generated an incomplete brief. Please provide a more descriptive summary and try again.",
        },
        { status: 422 }
      );
    }

    console.error("[/api/ai/structure-brief] Unexpected error", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return apiError("INTERNAL_ERROR", 500);
  }
}
