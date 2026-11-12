import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app/header";
import { Sidebar } from "@/components/app/sidebar";
import { listUserNotifications } from "@/features/notifications/service";
import type { NotificationRecord } from "@/features/notifications/types";
import { getWorkspaceChromeData } from "@/features/projects/data";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let chrome = {
    userLabel: "Freelancer",
    userEmail: null as string | null,
    notifications: [] as Awaited<ReturnType<typeof getWorkspaceChromeData>>["notifications"],
  };
  let persistentNotifications: NotificationRecord[] | undefined;
  let unreadCount = 0;
  let actionRequiredCount = 0;

  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    const [workspaceChrome, notificationPage] = await Promise.all([
      getWorkspaceChromeData(supabase, user),
      listUserNotifications({
        userId: user.id,
        page: 1,
        pageSize: 12,
        supabaseClient: supabase,
      }).catch(() => null),
    ]);
    chrome = workspaceChrome;
    if (notificationPage) {
      persistentNotifications = notificationPage.notifications;
      unreadCount = notificationPage.unreadCount;
      actionRequiredCount = notificationPage.actionRequiredCount;
    }
  }

  return (
    <div className="min-h-[100dvh] overflow-x-clip bg-[#f6f5f0] lg:flex">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <AppHeader
          actionRequiredCount={actionRequiredCount}
          notifications={chrome.notifications}
          persistentNotifications={persistentNotifications}
          unreadCount={unreadCount}
          userEmail={chrome.userEmail}
          userLabel={chrome.userLabel}
        />
        <main className="pr-page-enter mx-auto max-w-7xl px-4 py-5 sm:px-8 sm:py-10">{children}</main>
      </div>
    </div>
  );
}
