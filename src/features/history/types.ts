export type ProjectHistoryAudience = "freelancer" | "client";

export type ProjectHistoryCategory =
  | "PROJECT"
  | "AGREEMENT"
  | "MILESTONE"
  | "SCOPE_CHANGE"
  | "PAYMENT"
  | "RECONCILIATION";

export type ProjectHistoryActorKind =
  | "FREELANCER"
  | "CLIENT"
  | "AI_ASSISTED"
  | "SYSTEM"
  | "OPERATOR";

export interface ProjectHistoryEntityRef {
  kind: "AGREEMENT_VERSION" | "MILESTONE" | "CHANGE_REQUEST" | "PAYMENT_INTENT";
  label: string;
  href: string | null;
}

export interface ProjectHistoryItem {
  id: string;
  projectId: string;
  eventType: string;
  category: ProjectHistoryCategory;
  title: string;
  summary: string;
  actorLabel: string;
  actorKind: ProjectHistoryActorKind;
  isAiAssisted: boolean;
  aiAttributionLabel: "AI-assisted" | "Manual" | null;
  stateDisciplineBadge: string | null;
  entityRef: ProjectHistoryEntityRef | null;
  createdAt: string;
}

export interface ProjectHistoryPageResult {
  items: ProjectHistoryItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
