import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { validateOperatorCsrf } from "@/lib/security/operator-csrf";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const updateProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Display name is required.")
    .max(80, "Display name cannot exceed 80 characters."),
  countryCode: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === "" || /^[A-Z]{2}$/.test(v), "Country code must be 2 uppercase letters (e.g. US).")
    .transform((v) => (v === "" ? null : v)),
});

export async function PATCH(request: Request) {
  const csrf = await validateOperatorCsrf(request);
  if (!csrf.valid) {
    return apiError(csrf.error ?? "CSRF_VALIDATION_FAILED", 403, NO_STORE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid profile details.",
      },
      { status: 400, headers: NO_STORE },
    );
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

    const { error: upsertError } = await supabase.from("profiles").upsert(
      {
        id: user.id,
        display_name: parsed.data.displayName,
        country_code: parsed.data.countryCode,
      },
      { onConflict: "id" },
    );

    if (upsertError) {
      return apiError("PROFILE_SAVE_FAILED", 500, NO_STORE);
    }

    // Keep auth metadata display_name synchronized cleanly (best-effort)
    await supabase.auth
      .updateUser({
        data: { display_name: parsed.data.displayName },
      })
      .catch(() => undefined);

    return NextResponse.json(
      {
        data: {
          displayName: parsed.data.displayName,
          countryCode: parsed.data.countryCode,
        },
      },
      { headers: NO_STORE },
    );
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
