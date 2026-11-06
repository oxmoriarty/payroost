"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createHash } from "node:crypto";
import { requireUser } from "@/lib/auth/require-user";
import { projectInputSchema } from "@/features/agreements/schema";
import { createVerificationToken, hashVerificationToken } from "@/lib/security/tokens";
import { sendClientVerificationEmail } from "@/lib/email/provider";

function formValue(formData: FormData, key: string) { return String(formData.get(key) ?? ""); }

export async function createProjectAction(formData: FormData) {
  const input = projectInputSchema.safeParse({
    title: formValue(formData, "title"), clientName: formValue(formData, "clientName"), clientEmail: formValue(formData, "clientEmail"),
    brief: formValue(formData, "brief"), totalAmountMinor: formValue(formData, "totalAmountMinor"), currency: formValue(formData, "currency"),
    startDate: formValue(formData, "startDate"), targetEndDate: formValue(formData, "targetEndDate"),
  });
  if (!input.success) redirect("/app/projects/new?error=validation");
  const { supabase, user } = await requireUser();
  if (user.email && input.data.clientEmail.trim().toLowerCase() === user.email.trim().toLowerCase()) {
    redirect("/app/projects/new?error=owner_email_forbidden");
  }
  const { data: project, error } = await supabase.from("projects").insert({
    owner_id: user.id, title: input.data.title, client_name: input.data.clientName, client_email: input.data.clientEmail,
    brief: input.data.brief, total_amount_minor: input.data.totalAmountMinor, currency: input.data.currency,
    start_date: input.data.startDate || null, target_end_date: input.data.targetEndDate || null,
  }).select("id").single();
  if (error || !project) redirect("/app/projects/new?error=create");
  const displayName = user.user_metadata.display_name as string | undefined;
  const results = await Promise.all([
    supabase.from("project_participants").insert({ project_id: project.id, profile_id: user.id, email: user.email ?? "owner@payroost.local", display_name: displayName ?? "Freelancer", role: "OWNER" }),
    supabase.from("project_participants").insert({ project_id: project.id, email: input.data.clientEmail, display_name: input.data.clientName, role: "CLIENT" }),
    supabase.from("agreements").insert({ project_id: project.id }),
    supabase.from("activity_events").insert({ project_id: project.id, actor_user_id: user.id, actor_label: displayName ?? "Freelancer", event_type: "project.created", summary: "Created project " + input.data.title, metadata: { projectTitleHash: createHash("sha256").update(input.data.title).digest("hex") } }),
  ]);
  if (results.some((result) => result.error)) redirect("/app/projects/new?error=setup");

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
      clientEmail: input.data.clientEmail,
      clientName: input.data.clientName,
      projectTitle: input.data.title,
      verificationToken,
    });
  } catch {
    // Non-fatal if email provider is unconfigured in development; status remains unverified
  }

  revalidatePath("/app");
  redirect(`/app/projects/${project.id}`);
}
