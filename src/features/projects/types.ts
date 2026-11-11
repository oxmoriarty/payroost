export type ProjectStatus = "DRAFT" | "AWAITING_CLIENT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
export type Project = {
  id: string; owner_id: string; title: string; client_name: string; client_email: string; client_email_verified_at: string | null; brief: string;
  currency: string; total_amount_minor: number; status: ProjectStatus; start_date: string | null; target_end_date: string | null;
  created_at: string; updated_at: string;
};
export type Agreement = { id: string; project_id: string; current_version_id: string | null; status: string; created_at: string; updated_at: string };
export type AgreementVersion = { id: string; agreement_id: string; version_number: number; content: unknown; content_hash: string; status: string; created_by: string; created_at: string; updated_at: string; sent_at: string | null; approved_at: string | null; approved_by_label: string | null };
export type Milestone = { id: string; project_id: string; agreement_version_id: string; title: string; description: string; deliverables: string[]; acceptance_criteria: string[]; amount_minor: number; currency: string; due_date: string | null; sort_order: number; status: string; created_at: string; updated_at: string };
export type ActivityEvent = { id: string; project_id: string; actor_label: string; event_type: string; summary: string; created_at: string };
export type ChangeRequest = {
  id: string;
  project_id?: string;
  agreement_version_id?: string;
  review_link_id?: string | null;
  request_text: string;
  submitted_by_label: string;
  status: string;
  created_at: string;
  resolved_at?: string | null;
  ai_analysis?: unknown | null;
  ai_analyzed_at?: string | null;
  ai_model?: string | null;
};
