"use client";

import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

interface RevealProps {
  children: ReactNode;
  className?: string;
  delayMs?: number;
}

export function Reveal({ children, className, delayMs = 0 }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const revealNow = () => {
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    };

    if (prefersReducedMotion || typeof IntersectionObserver === "undefined") {
      return revealNow();
    }

    const rect = node.getBoundingClientRect();
    if (rect.top <= window.innerHeight * 0.94) {
      return revealNow();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -36px 0px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={cn(
        "transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transform-none motion-reduce:transition-none",
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
        className
      )}
      ref={ref}
      style={delayMs > 0 ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </div>
  );
}

function subscribeClock(onStoreChange: () => void): () => void {
  const interval = window.setInterval(onStoreChange, 30000);
  return () => window.clearInterval(interval);
}

function getClockSnapshot(): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  } catch {
    return "";
  }
}

function getServerClockSnapshot(): string {
  return "";
}

export function LiveWorkspaceTime() {
  const timeText = useSyncExternalStore(
    subscribeClock,
    getClockSnapshot,
    getServerClockSnapshot
  );

  if (!timeText) {
    return null;
  }

  return (
    <span className="hidden items-center gap-1.5 text-xs font-medium text-ink-700 xl:inline-flex">
      <span className="size-1.5 rounded-full bg-teal-600/70" aria-hidden="true" />
      <span>{timeText} local</span>
    </span>
  );
}
