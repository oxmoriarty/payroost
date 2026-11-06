"use client";

import { useRouter } from "next/navigation";
import { Bell, LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function AppHeader() {
  const router = useRouter();
  async function signOut() { try { await createClient().auth.signOut(); } finally { router.push("/"); router.refresh(); } }
  return <header className="flex min-h-20 items-center justify-between border-b border-ink-100 bg-[#f6f5f0]/80 px-5 backdrop-blur sm:px-8"><button aria-label="Open navigation" className="rounded-lg p-2 text-ink-700 lg:hidden"><Menu size={20} /></button><div className="hidden lg:block"><p className="text-xs font-bold uppercase tracking-[0.14em] text-ink-700">Freelancer workspace</p><p className="mt-1 font-display text-xl text-ink-950">Good morning, Sam</p></div><div className="ml-auto flex items-center gap-2"><button aria-label="Notifications" className="rounded-xl p-2.5 text-ink-700 hover:bg-ink-100"><Bell size={18} /></button><Button aria-label="Sign out" onClick={signOut} variant="secondary"><LogOut size={16} /><span className="ml-2 hidden sm:inline">Sign out</span></Button></div></header>;
}
