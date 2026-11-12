"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createHash } from "node:crypto";
import { requireUser } from "@/lib/auth/require-user";
import { projectInputSchema } from "@/features/agreements/schema";
import { createVerificationToken, hashVerificationToken } from "@/lib/security/tokens";
import { sendClientVerificationEmail } from "@/lib/email/provider";

export type CreateProjectFieldName =
  | "title"
  | "clientName"
  | "clientEmail"
  | "brief"
  | "totalAmountMinor"
  | "currency"
  | "startDate"
  | "targetEndDate";

export interface CreateProjectActionState {
  status: "idle" | "error";
  message: string | null;
  code?: string;
  fieldErrors: Partial<Record<CreateProjectFieldName, string>>;
}

interface PostgresLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

type SubmissionOutcome =
  | { kind: "redirect"; redirectTo: string }
  | { kind: "error"; state: CreateProjectActionState };

const INITIAL_ERROR_FIELDS: Partial<Record<CreateProjectFieldName, string>> = {};
const VALID_FIELD_NAMES = new Set<CreateProjectFieldName>([
  "title",
  "clientName",
  "clientEmail",
  "brief",
  "totalAmountMinor",
  "currency",
  "startDate",
  "targetEndDate",
]);

const MAX_TRACKED_SUBMISSIONS = 500;
const COMPLETED_SUBMISSION_TTL_MS = 120_000;
const inFlightSubmissions = new Map<string, Promise<SubmissionOutcome>>();
const completedSubmissions = new Map<string, { redirectTo: string; expiresAt: number }>();

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function logSafeDbError(operation: string, error: PostgresLikeError | null | undefined) {
  if (!error) return;
  console.error(`[createProjectAction] ${operation} failed`, {
    code: error.code ?? null,
    message: error.message ?? null,
    hint: error.hint ?? null,
    details: error.details ?? null,
  });
}

function mapConstraintFieldError(
  error: PostgresLikeError,
): Partial<Record<CreateProjectFieldName, string>> {
  const haystack = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  if (haystack.includes("title")) {
    return { title: "Project title must be between 2 and 140 characters." };
  }
  if (haystack.includes("client_name")) {
    return { clientName: "Client name must be between 2 and 140 characters." };
  }
  if (haystack.includes("client_email")) {
    return { clientEmail: "Enter a valid client email address up to 320 characters." };
  }
  if (haystack.includes("brief")) {
    return { brief: "Project brief must be between 20 and 20,000 characters." };
  }
  if (haystack.includes("total_amount_minor")) {
    return { totalAmountMinor: "Total amount must be greater than zero." };
  }
  if (haystack.includes("currency")) {
    return { currency: "Currency must be a valid 3-letter uppercase ISO code." };
  }
  if (haystack.includes("target_end_date") || haystack.includes("projects_check")) {
    return { targetEndDate: "Target end date must be on or after the start date." };
  }
  return {};
}

function mapDatabaseErrorState(error: PostgresLikeError | null | undefined): CreateProjectActionState {
  const code = error?.code ?? undefined;
  const fieldErrors = error ? mapConstraintFieldError(error) : INITIAL_ERROR_FIELDS;

  if (code === "42501") {
    return {
      status: "error",
      code: "DB_PERMISSION_DENIED",
      message:
        "You do not have database permission to create this project right now. If this persists, check that the latest database permissions and migrations are applied.",
      fieldErrors,
    };
  }
  if (code === "23503") {
    return {
      status: "error",
      code: "DB_FOREIGN_KEY",
      message:
        "Your workspace profile record is not ready yet. Please refresh or sign out and back in, then try again.",
      fieldErrors,
    };
  }
  if (code === "23514") {
    return {
      status: "error",
      code: "DB_CHECK_CONSTRAINT",
      message: "One or more project fields did not meet database validation requirements.",
      fieldErrors,
    };
  }
  if (code === "42P01" || code === "42883") {
    return {
      status: "error",
      code: "DB_SCHEMA_MISMATCH",
      message:
        "Required workspace database tables or functions are missing. Please apply the latest migrations and try again.",
      fieldErrors,
    };
  }

  return {
    status: "error",
    code: code ? `DB_${code}` : "DB_CREATE_FAILED",
    message: "We could not save the project due to a server database error. Please retry.",
    fieldErrors,
  };
}

function pruneCompletedSubmissions(now: number) {
  for (const [key, entry] of completedSubmissions.entries()) {
    if (entry.expiresAt <= now) {
      completedSubmissions.delete(key);
    }
  }
  while (completedSubmissions.size > MAX_TRACKED_SUBMISSIONS) {
    const oldestKey = completedSubmissions.keys().next().value;
    if (!oldestKey) break;
    completedSubmissions.delete(oldestKey);
  }
}

export async function createProjectAction(
  prevStateOrFormData: CreateProjectActionState | FormData,
  maybeFormData?: FormData,
): Promise<CreateProjectActionState> {
  const formData = prevStateOrFormData instanceof FormData ? prevStateOrFormData : maybeFormData;
  if (!formData) {
    return {
      status: "error",
      code: "INVALID_REQUEST",
      message: "No project form data was received. Please try submitting again.",
      fieldErrors: {},
    };
  }

  const input = projectInputSchema.safeParse({
    title: formValue(formData, "title"),
    clientName: formValue(formData, "clientName"),
    clientEmail: formValue(formData, "clientEmail"),
    brief: formValue(formData, "brief"),
    totalAmountMinor: formValue(formData, "totalAmountMinor"),
    currency: formValue(formData, "currency"),
    startDate: formValue(formData, "startDate"),
    targetEndDate: formValue(formData, "targetEndDate"),
  });

  if (!input.success) {
    const fieldErrors: Partial<Record<CreateProjectFieldName, string>> = {};
    for (const issue of input.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && VALID_FIELD_NAMES.has(key as CreateProjectFieldName)) {
        const field = key as CreateProjectFieldName;
        if (!fieldErrors[field]) {
          fieldErrors[field] = issue.message;
        }
      }
    }
    const firstMessage =
      Object.values(fieldErrors)[0] ?? "Please check the highlighted fields and try again.";
    return {
      status: "error",
      code: "VALIDATION_ERROR",
      message: firstMessage,
      fieldErrors,
    };
  }

  const { supabase, user } = await requireUser();
  const normalizedClientEmail = input.data.clientEmail.trim().toLowerCase();
  const normalizedUserEmail = user.email?.trim().toLowerCase();

  if (normalizedUserEmail && normalizedClientEmail === normalizedUserEmail) {
    return {
      status: "error",
      code: "OWNER_EMAIL_FORBIDDEN",
      message:
        "You cannot use your own registered account email as the client email. Client email must belong to an external reviewer.",
      fieldErrors: {
        clientEmail: "Client email must be different from your account email.",
      },
    };
  }

  const rawToken = formValue(formData, "submissionToken").trim();
  const dedupeKey =
    /^[a-zA-Z0-9_-]{8,128}$/.test(rawToken) ? `${user.id}:${rawToken}` : null;

  const now = Date.now();
  pruneCompletedSubmissions(now);
  if (dedupeKey) {
    const completed = completedSubmissions.get(dedupeKey);
    if (completed && completed.expiresAt > now) {
      redirect(completed.redirectTo);
    }
    const existingPromise = inFlightSubmissions.get(dedupeKey);
    if (existingPromise) {
      const outcome = await existingPromise;
      if (outcome.kind === "redirect") {
        redirect(outcome.redirectTo);
      }
      return outcome.state;
    }
  }

  const runCreate = async (): Promise<SubmissionOutcome> => {
    const displayName =
      typeof user.user_metadata?.display_name === "string" && user.user_metadata.display_name.trim()
        ? user.user_metadata.display_name.trim()
        : "Freelancer";

    // Ensure the owner profile row exists before inserting into projects (owner_id FK -> profiles.id).
    const { data: existingProfile, error: profileLookupError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (profileLookupError) {
      logSafeDbError("profiles.select", profileLookupError);
      return { kind: "error", state: mapDatabaseErrorState(profileLookupError) };
    }

    if (!existingProfile) {
      const { error: profileInsertError } = await supabase
        .from("profiles")
        .insert({ id: user.id, display_name: displayName });
      if (profileInsertError && profileInsertError.code !== "23505") {
        logSafeDbError("profiles.insert", profileInsertError);
        return { kind: "error", state: mapDatabaseErrorState(profileInsertError) };
      }
    }

    // Check for a recent identical project to stay idempotent across retries or multi-clicks.
    const cutoffIso = new Date(Date.now() - COMPLETED_SUBMISSION_TTL_MS).toISOString();
    const { data: recentDuplicate, error: duplicateLookupError } = await supabase
      .from("projects")
      .select("id")
      .eq("owner_id", user.id)
      .eq("title", input.data.title)
      .eq("client_email", normalizedClientEmail)
      .eq("total_amount_minor", input.data.totalAmountMinor)
      .eq("currency", input.data.currency)
      .eq("brief", input.data.brief)
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (duplicateLookupError) {
      logSafeDbError("projects.duplicate_check", duplicateLookupError);
    } else if (recentDuplicate?.id) {
      return { kind: "redirect", redirectTo: `/app/projects/${recentDuplicate.id}` };
    }

    const { data: project, error: projectInsertError } = await supabase
      .from("projects")
      .insert({
        owner_id: user.id,
        title: input.data.title,
        client_name: input.data.clientName,
        client_email: normalizedClientEmail,
        brief: input.data.brief,
        total_amount_minor: input.data.totalAmountMinor,
        currency: input.data.currency,
        start_date: input.data.startDate || null,
        target_end_date: input.data.targetEndDate || null,
      })
      .select("id")
      .single();

    if (projectInsertError || !project) {
      logSafeDbError("projects.insert", projectInsertError);
      return { kind: "error", state: mapDatabaseErrorState(projectInsertError) };
    }

    const ownerParticipantEmail = normalizedUserEmail || "owner@payroost.local";
    const results = await Promise.all([
      supabase.from("project_participants").insert({
        project_id: project.id,
        profile_id: user.id,
        email: ownerParticipantEmail,
        display_name: displayName,
        role: "OWNER",
      }),
      supabase.from("project_participants").insert({
        project_id: project.id,
        email: normalizedClientEmail,
        display_name: input.data.clientName,
        role: "CLIENT",
      }),
      supabase.from("agreements").insert({ project_id: project.id }),
      supabase.from("activity_events").insert({
        project_id: project.id,
        actor_user_id: user.id,
        actor_label: displayName,
        event_type: "project.created",
        summary: "Created project " + input.data.title,
        metadata: {
          projectTitleHash: createHash("sha256").update(input.data.title).digest("hex"),
        },
      }),
    ]);

    const failedSetup = results.find((result) => result.error);
    if (failedSetup?.error) {
      logSafeDbError("projects.setup_records", failedSetup.error);
      // Roll back the parent project row so failed setups never leave orphaned workspaces.
      const { error: cleanupError } = await supabase
        .from("projects")
        .delete()
        .eq("id", project.id)
        .eq("owner_id", user.id);
      if (cleanupError) {
        logSafeDbError("projects.cleanup", cleanupError);
      }
      return { kind: "error", state: mapDatabaseErrorState(failedSetup.error) };
    }

    // Initiate client email verification immediately upon project creation
    try {
      const verificationToken = createVerificationToken();
      const tokenHash = hashVerificationToken(verificationToken);
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      await supabase.rpc("create_client_email_verification", {
        p_project_id: project.id,
        p_token_hash: tokenHash,
        p_expires_at: expiresAt,
      });
      // Dispatch verification email to client (safe async failure handling)
      await sendClientVerificationEmail({
        clientEmail: normalizedClientEmail,
        clientName: input.data.clientName,
        projectTitle: input.data.title,
        verificationToken,
      });
    } catch (verificationErr) {
      // Non-fatal if email provider is unconfigured in development; status remains unverified
      console.warn("[createProjectAction] Verification email dispatch skipped", {
        reason: verificationErr instanceof Error ? verificationErr.message : "unknown",
      });
    }

    revalidatePath("/app");
    revalidatePath("/app/projects");
    return { kind: "redirect", redirectTo: `/app/projects/${project.id}` };
  };

  const execution = runCreate();
  if (dedupeKey) {
    inFlightSubmissions.set(dedupeKey, execution);
  }

  let outcome: SubmissionOutcome;
  try {
    outcome = await execution;
  } finally {
    if (dedupeKey) {
      inFlightSubmissions.delete(dedupeKey);
    }
  }

  if (outcome.kind === "redirect") {
    if (dedupeKey) {
      completedSubmissions.set(dedupeKey, {
        redirectTo: outcome.redirectTo,
        expiresAt: Date.now() + COMPLETED_SUBMISSION_TTL_MS,
      });
    }
    redirect(outcome.redirectTo);
  }

  return outcome.state;
}
