import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { allowRequest } from "@/lib/security/rate-limit";
import { apiError } from "@/lib/http";
import {
  AiConfigurationError,
  AiOutputValidationError,
  AiRateLimitError,
  AiUnavailableError,
} from "@/lib/ai/errors";
import { structureBriefRequestSchema } from "@/features/briefs/schema";
import { structureProjectBrief } from "@/features/briefs/service";

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
  const allowed = await allowRequest(`ai:brief:${user.id}`, 10, 60_000);
  if (!allowed) {
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

    if (projectError || !project) {
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
  try {
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
      return apiError("AI_CONFIG_ERROR", 500);
    }
    if (error instanceof AiRateLimitError) {
      return apiError("AI_RATE_LIMITED", 429);
    }
    if (error instanceof AiUnavailableError) {
      return apiError("AI_UNAVAILABLE", 503);
    }
    if (error instanceof AiOutputValidationError) {
      return apiError("AI_OUTPUT_INVALID", 422);
    }

    return apiError("INTERNAL_ERROR", 500);
  }
}
