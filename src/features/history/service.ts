import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityEvent } from "@/features/projects/types";
import { mapActivityEventsToHistoryItems } from "./mapper";
import type { ProjectHistoryCategory, ProjectHistoryPageResult } from "./types";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_HISTORY_SCAN = 500;

function clampPagination(page?: number, pageSize?: number) {
  const safePage = Number.isFinite(page) && (page ?? 1) >= 1 ? Math.floor(page as number) : 1;
  const safePageSize =
    Number.isFinite(pageSize) && (pageSize ?? DEFAULT_PAGE_SIZE) >= 1
      ? Math.min(Math.floor(pageSize as number), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  return { page: safePage, pageSize: safePageSize };
}

function paginateHistoryRows(params: {
  rows: ActivityEvent[];
  audience: "freelancer" | "client";
  category?: ProjectHistoryCategory;
  page?: number;
  pageSize?: number;
}): ProjectHistoryPageResult {
  const { page, pageSize } = clampPagination(params.page, params.pageSize);
  let items = mapActivityEventsToHistoryItems(params.rows, params.audience);

  if (params.category) {
    items = items.filter((item) => item.category === params.category);
  }

  const totalCount = items.length;
  const from = (page - 1) * pageSize;
  const pagedItems = items.slice(from, from + pageSize);

  return {
    items: pagedItems,
    totalCount,
    page,
    pageSize,
    hasMore: from + pagedItems.length < totalCount,
  };
}

/**
 * Fetches chronological project history for the authenticated freelancer owner.
 * Returns null if the project does not exist or is not accessible to the user.
 */
export async function getProjectHistory(params: {
  projectId: string;
  userId?: string;
  category?: ProjectHistoryCategory;
  sort?: "desc" | "asc";
  page?: number;
  pageSize?: number;
  supabaseClient: SupabaseClient;
}): Promise<ProjectHistoryPageResult | null> {
  let projectQuery = params.supabaseClient
    .from("projects")
    .select("id")
    .eq("id", params.projectId);

  if (params.userId) {
    projectQuery = projectQuery.eq("owner_id", params.userId);
  }

  const { data: projectRow, error: projErr } = await projectQuery.maybeSingle();
  if (projErr) throw projErr;
  if (!projectRow) return null;

  const ascending = params.sort === "asc";
  const { data: rows, error: actErr } = await params.supabaseClient
    .from("activity_events")
    .select("id, project_id, actor_label, event_type, summary, metadata, created_at")
    .eq("project_id", params.projectId)
    .order("created_at", { ascending })
    .order("id", { ascending })
    .limit(MAX_HISTORY_SCAN);

  if (actErr) throw actErr;

  return paginateHistoryRows({
    rows: (rows ?? []) as ActivityEvent[],
    audience: "freelancer",
    category: params.category,
    page: params.page,
    pageSize: params.pageSize,
  });
}

/**
 * Fetches privacy-filtered chronological project history for a verified client portal session.
 */
export async function getPortalProjectHistory(params: {
  projectId: string;
  category?: ProjectHistoryCategory;
  sort?: "desc" | "asc";
  page?: number;
  pageSize?: number;
  serviceClient: SupabaseClient;
}): Promise<ProjectHistoryPageResult> {
  const ascending = params.sort === "asc";
  const { data: rows, error } = await params.serviceClient
    .from("activity_events")
    .select("id, project_id, actor_label, event_type, summary, metadata, created_at")
    .eq("project_id", params.projectId)
    .order("created_at", { ascending })
    .order("id", { ascending })
    .limit(MAX_HISTORY_SCAN);

  if (error) throw error;

  return paginateHistoryRows({
    rows: (rows ?? []) as ActivityEvent[],
    audience: "client",
    category: params.category,
    page: params.page,
    pageSize: params.pageSize,
  });
}
