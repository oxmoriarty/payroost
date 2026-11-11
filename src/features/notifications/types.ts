export type NotificationRecipientType = "USER" | "CLIENT_PORTAL";

export type NotificationCategory =
  | "PROJECT"
  | "AGREEMENT"
  | "MILESTONE"
  | "SCOPE_CHANGE"
  | "PAYMENT"
  | "RECONCILIATION";

export type NotificationSeverity = "INFO" | "ACTION_REQUIRED" | "SUCCESS" | "WARNING";

export type NotificationFilter = "all" | "unread" | "action_required";

export interface NotificationRecord {
  id: string;
  projectId: string;
  sourceActivityEventId: string | null;
  recipientType: NotificationRecipientType;
  category: NotificationCategory;
  eventType: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actionRequired: boolean;
  actionLabel: string | null;
  actionHref: string | null;
  actorLabel: string;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationInsertDraft {
  project_id: string;
  source_activity_event_id: string | null;
  recipient_type: NotificationRecipientType;
  recipient_user_id: string | null;
  recipient_client_email: string | null;
  idempotency_key: string;
  category: NotificationCategory;
  event_type: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  action_required: boolean;
  action_label: string | null;
  action_href: string | null;
  actor_label: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface NotificationPageResult {
  notifications: NotificationRecord[];
  unreadCount: number;
  actionRequiredCount: number;
  totalCount: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
