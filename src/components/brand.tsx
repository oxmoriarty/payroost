import { Landmark } from "lucide-react";
import { cn } from "@/lib/utils";

export function Brand({ dark = false, compact = false }: { dark?: boolean; compact?: boolean }) {
  return <span className={cn("inline-flex items-center gap-2 font-display text-xl font-semibold tracking-tight", dark ? "text-white" : "text-ink-900")}>
    <span className={cn("grid size-9 place-items-center rounded-xl", dark ? "bg-teal-600" : "bg-ink-900 text-white")}><Landmark aria-hidden="true" size={18} /></span>
    {!compact && "Payroost"}
  </span>;
}
