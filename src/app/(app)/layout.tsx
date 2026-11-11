import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app/header";
import { Sidebar } from "@/components/app/sidebar";
import { getWorkspaceChromeData } from "@/features/projects/data";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let chrome = {
    userLabel: "Freelancer",
    userEmail: null as string | null,
    notifications: [] as Awaited<ReturnType<typeof getWorkspaceChromeData>>["notifications"],
  };

  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
    chrome = await getWorkspaceChromeData(supabase, user);
  }

  return (
    <div className="min-h-screen bg-[#f6f5f0] lg:flex">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <AppHeader
          notifications={chrome.notifications}
          userEmail={chrome.userEmail}
          userLabel={chrome.userLabel}
        />
        <main className="mx-auto max-w-7xl px-5 py-7 sm:px-8 sm:py-10">{children}</main>
      </div>
    </div>
  );
}
