import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section className={cn("rounded-2xl border border-ink-100 bg-white shadow-[0_1px_2px_rgba(13,28,37,0.04)]", className)} {...props} />;
}
