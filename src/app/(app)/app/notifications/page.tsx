import { redirect } from "next/navigation";
import { NotificationsCenter } from "@/features/notifications/notifications-center";
import { listUserNotifications } from "@/features/notifications/service";
import type { NotificationPageResult } from "@/features/notifications/types";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  let initialData: NotificationPageResult = {
    notifications: [],
    unreadCount: 0,
    actionRequiredCount: 0,
    totalCount: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
  };
  const projectTitles: Record<string, string> = {};

  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      redirect("/login");
    }

    const [feed, projectsResult] = await Promise.all([
      listUserNotifications({
        userId: user.id,
        page: 1,
        pageSize: 20,
        supabaseClient: supabase,
      }),
      supabase
        .from("projects")
        .select("id, title")
        .eq("owner_id", user.id),
    ]);

    initialData = feed;
    for (const row of (projectsResult.data ?? []) as Array<{ id: string; title: string }>) {
      projectTitles[row.id] = row.title;
    }
  }

  return <NotificationsCenter initialData={initialData} projectTitles={projectTitles} />;
}
