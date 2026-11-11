import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityEvent } from "@/features/projects/types";
import { createServiceClient } from "@/lib/supabase/service";
import {
  mapActivityEventToNotificationDrafts,
  type NotificationProjectContext,
} from "./mapper";
import type {
  NotificationCategory,
  NotificationFilter,
  NotificationInsertDraft,
  NotificationPageResult,
  NotificationRecord,
} from "./types";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

interface NotificationDbRow {
  id: string;
  project_id: string;
  source_activity_event_id: string | null;
  recipient_type: "USER" | "CLIENT_PORTAL";
  category: NotificationCategory;
  event_type: string;
  severity: NotificationRecord["severity"];
  title: string;
  body: string;
  action_required: boolean;
  action_label: string | null;
  action_href: string | null;
  actor_label: string;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

const NOTIFICATION_SELECT_COLUMNS =
  "id, project_id, source_activity_event_id, recipient_type, category, event_type, severity, title, body, action_required, action_label, action_href, actor_label, metadata, read_at, created_at";

function mapRowToNotification(row: NotificationDbRow): NotificationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceActivityEventId: row.source_activity_event_id,
    recipientType: row.recipient_type,
    category: row.category,
    eventType: row.event_type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    actionRequired: row.action_required,
    actionLabel: row.action_label,
    actionHref: row.action_href,
    actorLabel: row.actor_label,
    metadata: row.metadata ?? {},
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function tryCreateServiceClient(): SupabaseClient | null {
  try {
    return createServiceClient();
  } catch {
    return null;
  }
}

export function isMissingNotificationsTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /public\.notifications/i.test(message) && /(does not exist|could not find the table)/i.test(message)
  );
}

function isUniqueViolationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "23505";
}

function clampPagination(page?: number, pageSize?: number) {
  const safePage = Number.isFinite(page) && (page ?? 1) >= 1 ? Math.floor(page as number) : 1;
  const safePageSize =
    Number.isFinite(pageSize) && (pageSize ?? DEFAULT_PAGE_SIZE) >= 1
      ? Math.min(Math.floor(pageSize as number), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  return { page: safePage, pageSize: safePageSize };
}

async function insertMissingDrafts(
  serviceClient: SupabaseClient,
  projectId: string,
  drafts: NotificationInsertDraft[],
): Promise<void> {
  if (drafts.length === 0) return;

  const uniqueKeys = Array.from(new Set(drafts.map((d) => d.idempotency_key)));
  const { data: existingRows, error: existingErr } = await serviceClient
    .from("notifications")
    .select("recipient_type, recipient_user_id, recipient_client_email, idempotency_key")
    .eq("project_id", projectId)
    .in("idempotency_key", uniqueKeys);

  if (existingErr) {
    if (isMissingNotificationsTableError(existingErr)) return;
    throw existingErr;
  }

  const seen = new Set<string>();
  for (const row of (existingRows ?? []) as Array<{
    recipient_type: string;
    recipient_user_id: string | null;
    recipient_client_email: string | null;
    idempotency_key: string;
  }>) {
    seen.add(
      `${row.recipient_type}:${row.recipient_user_id ?? ""}:${row.recipient_client_email ?? ""}:${row.idempotency_key}`,
    );
  }

  const pending: NotificationInsertDraft[] = [];
  for (const draft of drafts) {
    const key = `${draft.recipient_type}:${draft.recipient_user_id ?? ""}:${draft.recipient_client_email ?? ""}:${draft.idempotency_key}`;
    if (!seen.has(key)) {
      seen.add(key);
      pending.push(draft);
    }
  }

  if (pending.length === 0) return;

  const { error: batchErr } = await serviceClient.from("notifications").insert(pending);
  if (!batchErr) return;

  if (isUniqueViolationError(batchErr)) {
    // Handle partial unique index races by inserting individually and ignoring 23505
    for (const draft of pending) {
      const { error: singleErr } = await serviceClient.from("notifications").insert(draft);
      if (singleErr && !isUniqueViolationError(singleErr) && !isMissingNotificationsTableError(singleErr)) {
        throw singleErr;
      }
    }
    return;
  }

  if (!isMissingNotificationsTableError(batchErr)) {
    throw batchErr;
  }
}

/**
 * Non-fatal catch-up projection from authoritative activity_events into public.notifications.
 * Complements the Postgres AFTER INSERT trigger and backfills pre-existing events idempotently.
 */
export async function syncNotificationsFromActivityEvents(params: {
  projectId: string;
  ownerIdFilter?: string;
  limit?: number;
  serviceClient?: SupabaseClient | null;
}): Promise<void> {
  const client = params.serviceClient ?? tryCreateServiceClient();
  if (!client) return;

  const { data: project, error: projectErr } = await client
    .from("projects")
    .select("id, owner_id, title, client_name, client_email")
    .eq("id", params.projectId)
    .maybeSingle();

  if (projectErr || !project) return;
  const typedProject = project as {
    id: string;
    owner_id: string;
    title: string;
    client_name: string;
    client_email: string;
  };

  if (params.ownerIdFilter && typedProject.owner_id !== params.ownerIdFilter) {
    return;
  }

  const { data: activities, error: actErr } = await client
    .from("activity_events")
    .select("id, project_id, actor_label, event_type, summary, metadata, created_at")
    .eq("project_id", params.projectId)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 100);

  if (actErr || !activities || activities.length === 0) return;

  const projectContext: NotificationProjectContext = {
    id: typedProject.id,
    ownerId: typedProject.owner_id,
    title: typedProject.title,
    clientName: typedProject.client_name,
    clientEmail: typedProject.client_email,
  };

  const drafts: NotificationInsertDraft[] = [];
  for (const act of activities as ActivityEvent[]) {
    drafts.push(...mapActivityEventToNotificationDrafts(act, projectContext));
  }

  await insertMissingDrafts(client, params.projectId, drafts);
}

/**
 * Non-fatal catch-up sync across all projects owned by an authenticated freelancer.
 */
export async function syncNotificationsForUser(params: {
  userId: string;
  projectId?: string;
  serviceClient?: SupabaseClient | null;
}): Promise<void> {
  const client = params.serviceClient ?? tryCreateServiceClient();
  if (!client) return;

  if (params.projectId) {
    await syncNotificationsFromActivityEvents({
      projectId: params.projectId,
      ownerIdFilter: params.userId,
      serviceClient: client,
    });
    return;
  }

  const { data: projects, error: projErr } = await client
    .from("projects")
    .select("id, owner_id, title, client_name, client_email")
    .eq("owner_id", params.userId)
    .order("updated_at", { ascending: false })
    .limit(30);

  if (projErr || !projects || projects.length === 0) return;

  const typedProjects = projects as Array<{
    id: string;
    owner_id: string;
    title: string;
    client_name: string;
    client_email: string;
  }>;
  const projectMap = new Map<string, NotificationProjectContext>();
  for (const p of typedProjects) {
    projectMap.set(p.id, {
      id: p.id,
      ownerId: p.owner_id,
      title: p.title,
      clientName: p.client_name,
      clientEmail: p.client_email,
    });
  }

  const { data: activities, error: actErr } = await client
    .from("activity_events")
    .select("id, project_id, actor_label, event_type, summary, metadata, created_at")
    .in("project_id", Array.from(projectMap.keys()))
    .order("created_at", { ascending: false })
    .limit(150);

  if (actErr || !activities || activities.length === 0) return;

  const draftsByProject = new Map<string, NotificationInsertDraft[]>();
  for (const act of activities as ActivityEvent[]) {
    const ctx = projectMap.get(act.project_id);
    if (!ctx) continue;
    const mapped = mapActivityEventToNotificationDrafts(act, ctx);
    if (mapped.length === 0) continue;
    const list = draftsByProject.get(ctx.id) ?? [];
    list.push(...mapped);
    draftsByProject.set(ctx.id, list);
  }

  for (const [projId, drafts] of draftsByProject.entries()) {
    await insertMissingDrafts(client, projId, drafts);
  }
}

export async function emitActivityEvent(params: {
  projectId: string;
  actorLabel: string;
  eventType: string;
  summary: string;
  metadata?: Record<string, unknown>;
  supabaseClient: SupabaseClient;
  serviceClient?: SupabaseClient | null;
}): Promise<string | null> {
  const { data, error } = await params.supabaseClient
    .from("activity_events")
    .insert({
      project_id: params.projectId,
      actor_label: params.actorLabel,
      event_type: params.eventType,
      summary: params.summary,
      metadata: params.metadata ?? {},
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("Unable to persist activity event:", params.eventType, error.message);
    return null;
  }

  try {
    await syncNotificationsFromActivityEvents({
      projectId: params.projectId,
      limit: 10,
      serviceClient: params.serviceClient,
    });
  } catch (syncError) {
    console.warn("Non-fatal notification sync failure after activity insert:", syncError);
  }

  return (data as { id: string } | null)?.id ?? null;
}

export async function listUserNotifications(params: {
  userId: string;
  projectId?: string;
  filter?: NotificationFilter;
  category?: NotificationCategory;
  page?: number;
  pageSize?: number;
  sync?: boolean;
  supabaseClient: SupabaseClient;
  serviceClient?: SupabaseClient | null;
}): Promise<NotificationPageResult> {
  const { page, pageSize } = clampPagination(params.page, params.pageSize);
  const filter = params.filter ?? "all";

  if (params.sync !== false) {
    try {
      await syncNotificationsForUser({
        userId: params.userId,
        projectId: params.projectId,
        serviceClient: params.serviceClient,
      });
    } catch (syncError) {
      if (!isMissingNotificationsTableError(syncError)) {
        console.warn("Non-fatal user notification sync failed:", syncError);
      }
    }
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let listQuery = params.supabaseClient
    .from("notifications")
    .select(NOTIFICATION_SELECT_COLUMNS, { count: "exact" })
    .eq("recipient_type", "USER")
    .eq("recipient_user_id", params.userId);

  if (params.projectId) {
    listQuery = listQuery.eq("project_id", params.projectId);
  }
  if (params.category) {
    listQuery = listQuery.eq("category", params.category);
  }
  if (filter === "unread") {
    listQuery = listQuery.is("read_at", null);
  } else if (filter === "action_required") {
    listQuery = listQuery.eq("action_required", true).is("read_at", null);
  }

  const { data: rows, count: filteredCount, error: listErr } = await listQuery
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (listErr) {
    if (isMissingNotificationsTableError(listErr)) {
      console.warn("public.notifications table unavailable; returning empty notification feed.");
      return {
        notifications: [],
        unreadCount: 0,
        actionRequiredCount: 0,
        totalCount: 0,
        page,
        pageSize,
        hasMore: false,
      };
    }
    throw listErr;
  }

  let unreadQuery = params.supabaseClient
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_type", "USER")
    .eq("recipient_user_id", params.userId)
    .is("read_at", null);

  let actionQuery = params.supabaseClient
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_type", "USER")
    .eq("recipient_user_id", params.userId)
    .eq("action_required", true)
    .is("read_at", null);

  if (params.projectId) {
    unreadQuery = unreadQuery.eq("project_id", params.projectId);
    actionQuery = actionQuery.eq("project_id", params.projectId);
  }

  const [{ count: unreadCount }, { count: actionRequiredCount }] = await Promise.all([
    unreadQuery,
    actionQuery,
  ]);

  const notifications = ((rows ?? []) as NotificationDbRow[]).map(mapRowToNotification);
  const totalCount = filteredCount ?? notifications.length;

  return {
    notifications,
    unreadCount: unreadCount ?? 0,
    actionRequiredCount: actionRequiredCount ?? 0,
    totalCount,
    page,
    pageSize,
    hasMore: from + notifications.length < totalCount,
  };
}

export async function markUserNotificationRead(params: {
  userId: string;
  notificationId: string;
  supabaseClient: SupabaseClient;
}): Promise<NotificationRecord | null> {
  const { data: existing, error: findErr } = await params.supabaseClient
    .from("notifications")
    .select(NOTIFICATION_SELECT_COLUMNS)
    .eq("id", params.notificationId)
    .eq("recipient_type", "USER")
    .eq("recipient_user_id", params.userId)
    .maybeSingle();

  if (findErr) {
    if (isMissingNotificationsTableError(findErr)) return null;
    throw findErr;
  }
  if (!existing) return null;

  const typedExisting = existing as NotificationDbRow;
  if (typedExisting.read_at) {
    return mapRowToNotification(typedExisting);
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await params.supabaseClient
    .from("notifications")
    .update({ read_at: now })
    .eq("id", params.notificationId)
    .eq("recipient_type", "USER")
    .eq("recipient_user_id", params.userId)
    .is("read_at", null)
    .select(NOTIFICATION_SELECT_COLUMNS)
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (updated) {
    return mapRowToNotification(updated as NotificationDbRow);
  }

  const { data: refetched } = await params.supabaseClient
    .from("notifications")
    .select(NOTIFICATION_SELECT_COLUMNS)
    .eq("id", params.notificationId)
    .eq("recipient_type", "USER")
    .eq("recipient_user_id", params.userId)
    .maybeSingle();

  return refetched ? mapRowToNotification(refetched as NotificationDbRow) : null;
}

export async function markAllUserNotificationsRead(params: {
  userId: string;
  projectId?: string;
  supabaseClient: SupabaseClient;
}): Promise<{ updatedCount: number }> {
  let query = params.supabaseClient
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_type", "USER")
    .eq("recipient_user_id", params.userId)
    .is("read_at", null);

  if (params.projectId) {
    query = query.eq("project_id", params.projectId);
  }

  const { data, error } = await query.select("id");
  if (error) {
    if (isMissingNotificationsTableError(error)) return { updatedCount: 0 };
    throw error;
  }

  return { updatedCount: (data ?? []).length };
}

export async function listPortalNotifications(params: {
  projectId: string;
  clientEmail: string;
  filter?: NotificationFilter;
  category?: NotificationCategory;
  page?: number;
  pageSize?: number;
  sync?: boolean;
  serviceClient?: SupabaseClient;
}): Promise<NotificationPageResult> {
  const client = params.serviceClient ?? tryCreateServiceClient();
  const normalizedEmail = params.clientEmail.trim().toLowerCase();
  const { page, pageSize } = clampPagination(params.page, params.pageSize);
  const filter = params.filter ?? "all";

  if (!client || normalizedEmail.length < 3) {
    return {
      notifications: [],
      unreadCount: 0,
      actionRequiredCount: 0,
      totalCount: 0,
      page,
      pageSize,
      hasMore: false,
    };
  }

  if (params.sync !== false) {
    try {
      await syncNotificationsFromActivityEvents({
        projectId: params.projectId,
        serviceClient: client,
      });
    } catch (syncError) {
      if (!isMissingNotificationsTableError(syncError)) {
        console.warn("Non-fatal portal notification sync failed:", syncError);
      }
    }
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let listQuery = client
    .from("notifications")
    .select(NOTIFICATION_SELECT_COLUMNS, { count: "exact" })
    .eq("project_id", params.projectId)
    .eq("recipient_type", "CLIENT_PORTAL")
    .eq("recipient_client_email", normalizedEmail);

  if (params.category) {
    listQuery = listQuery.eq("category", params.category);
  }
  if (filter === "unread") {
    listQuery = listQuery.is("read_at", null);
  } else if (filter === "action_required") {
    listQuery = listQuery.eq("action_required", true).is("read_at", null);
  }

  const { data: rows, count: filteredCount, error: listErr } = await listQuery
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (listErr) {
    if (isMissingNotificationsTableError(listErr)) {
      console.warn("public.notifications table unavailable; returning empty portal notifications.");
      return {
        notifications: [],
        unreadCount: 0,
        actionRequiredCount: 0,
        totalCount: 0,
        page,
        pageSize,
        hasMore: false,
      };
    }
    throw listErr;
  }

  const [{ count: unreadCount }, { count: actionRequiredCount }] = await Promise.all([
    client
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("project_id", params.projectId)
      .eq("recipient_type", "CLIENT_PORTAL")
      .eq("recipient_client_email", normalizedEmail)
      .is("read_at", null),
    client
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("project_id", params.projectId)
      .eq("recipient_type", "CLIENT_PORTAL")
      .eq("recipient_client_email", normalizedEmail)
      .eq("action_required", true)
      .is("read_at", null),
  ]);

  const notifications = ((rows ?? []) as NotificationDbRow[]).map(mapRowToNotification);
  const totalCount = filteredCount ?? notifications.length;

  return {
    notifications,
    unreadCount: unreadCount ?? 0,
    actionRequiredCount: actionRequiredCount ?? 0,
    totalCount,
    page,
    pageSize,
    hasMore: from + notifications.length < totalCount,
  };
}

export async function markPortalNotificationRead(params: {
  projectId: string;
  clientEmail: string;
  notificationId: string;
  serviceClient?: SupabaseClient;
}): Promise<NotificationRecord | null> {
  const client = params.serviceClient ?? tryCreateServiceClient();
  if (!client) return null;

  const normalizedEmail = params.clientEmail.trim().toLowerCase();
  const { data: existing, error: findErr } = await client
    .from("notifications")
    .select(NOTIFICATION_SELECT_COLUMNS)
    .eq("id", params.notificationId)
    .eq("project_id", params.projectId)
    .eq("recipient_type", "CLIENT_PORTAL")
    .eq("recipient_client_email", normalizedEmail)
    .maybeSingle();

  if (findErr) {
    if (isMissingNotificationsTableError(findErr)) return null;
    throw findErr;
  }
  if (!existing) return null;

  const typedExisting = existing as NotificationDbRow;
  if (typedExisting.read_at) {
    return mapRowToNotification(typedExisting);
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await client
    .from("notifications")
    .update({ read_at: now })
    .eq("id", params.notificationId)
    .eq("project_id", params.projectId)
    .eq("recipient_type", "CLIENT_PORTAL")
    .eq("recipient_client_email", normalizedEmail)
    .is("read_at", null)
    .select(NOTIFICATION_SELECT_COLUMNS)
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (updated) {
    return mapRowToNotification(updated as NotificationDbRow);
  }

  const { data: refetched } = await client
    .from("notifications")
    .select(NOTIFICATION_SELECT_COLUMNS)
    .eq("id", params.notificationId)
    .eq("project_id", params.projectId)
    .eq("recipient_type", "CLIENT_PORTAL")
    .eq("recipient_client_email", normalizedEmail)
    .maybeSingle();

  return refetched ? mapRowToNotification(refetched as NotificationDbRow) : null;
}

export async function markAllPortalNotificationsRead(params: {
  projectId: string;
  clientEmail: string;
  serviceClient?: SupabaseClient;
}): Promise<{ updatedCount: number }> {
  const client = params.serviceClient ?? tryCreateServiceClient();
  if (!client) return { updatedCount: 0 };

  const normalizedEmail = params.clientEmail.trim().toLowerCase();
  const { data, error } = await client
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("project_id", params.projectId)
    .eq("recipient_type", "CLIENT_PORTAL")
    .eq("recipient_client_email", normalizedEmail)
    .is("read_at", null)
    .select("id");

  if (error) {
    if (isMissingNotificationsTableError(error)) return { updatedCount: 0 };
    throw error;
  }

  return { updatedCount: (data ?? []).length };
}
