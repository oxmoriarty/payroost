import {
  Bell,
  CreditCard,
  FolderKanban,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type AppNavLink = {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
};

export const APP_NAV_LINKS: AppNavLink[] = [
  { label: "Overview", href: "/app", icon: LayoutDashboard, exact: true },
  { label: "Projects", href: "/app/projects", icon: FolderKanban },
  { label: "Notifications", href: "/app/notifications", icon: Bell },
  { label: "Payment operations", href: "/app/payments", icon: CreditCard },
  { label: "Settings", href: "/app/settings", icon: Settings },
];

export function isNavLinkActive(pathname: string, href: string, exact = false): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
