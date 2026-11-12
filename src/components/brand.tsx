import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

const BRAND_SIZE_CLASSES = {
  sm: "h-6 w-auto",
  md: "h-7 sm:h-8 w-auto",
  lg: "h-8 sm:h-9 w-auto",
} as const;

export interface BrandProps {
  dark?: boolean;
  compact?: boolean;
  size?: keyof typeof BRAND_SIZE_CLASSES;
  className?: string;
}

export function Brand({
  dark = false,
  compact = false,
  size,
  className,
}: BrandProps) {
  const effectiveSize = size ?? (compact ? "sm" : "md");

  return (
    <span className={cn("inline-flex shrink-0 items-center transition-transform duration-200 ease-out hover:scale-[1.015] active:scale-[0.99]", className)}>
      <Image
        alt="Payroost"
        className={cn("shrink-0 select-none object-contain", BRAND_SIZE_CLASSES[effectiveSize])}
        height={310}
        priority
        src={dark ? "/brand/PayRoostLogo-dark.svg" : "/brand/PayRoostLogo.svg"}
        unoptimized
        width={1452}
      />
    </span>
  );
}

export function PublicBrandHeader({
  subtitle,
  maxWidthClass = "max-w-5xl",
}: {
  subtitle?: string;
  maxWidthClass?: string;
}) {
  return (
    <header className="border-b border-ink-100 bg-white/90 backdrop-blur">
      <div
        className={cn(
          "mx-auto flex items-center justify-between gap-3 px-4 py-3.5 sm:gap-4 sm:px-6 lg:px-8",
          maxWidthClass
        )}
      >
        <Link className="inline-flex shrink-0 items-center" href="/">
          <Brand size="sm" />
        </Link>
        {subtitle && (
          <span className="min-w-0 truncate text-right text-[11px] font-semibold uppercase tracking-wider text-ink-600 sm:text-xs">
            {subtitle}
          </span>
        )}
      </div>
    </header>
  );
}
