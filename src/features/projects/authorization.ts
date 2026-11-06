import "server-only";
import { requireUser } from "@/lib/auth/require-user";

export async function requireProjectOwner(projectId: string) {
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase.from("projects").select("id, title, client_name, client_email, client_email_verified_at, brief, currency, total_amount_minor, target_end_date").eq("id", projectId).eq("owner_id", user.id).maybeSingle();
  if (error || !data) throw new Error("NOT_FOUND_OR_FORBIDDEN");
  return { supabase, user, project: data as { id: string; title: string; client_name: string; client_email: string; client_email_verified_at: string | null; brief: string; currency: string; total_amount_minor: number; target_end_date: string | null } };
}
