"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const TAB_TRANSITION_DURATION_MS = 180;

/** Fade only the panel, without remounting drafts or animating layout/scroll geometry. */
export function useTabTransition(activeKey: string) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previousKey = useRef(activeKey);

  useLayoutEffect(() => {
    const changed = previousKey.current !== activeKey;
    previousKey.current = activeKey;
    const content = contentRef.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!changed || !content?.animate || reducedMotion.matches) return;

    const transition = content.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: TAB_TRANSITION_DURATION_MS,
      easing: "ease-out",
    });
    const cancel = () => transition.cancel();
    reducedMotion.addEventListener("change", cancel);
    return () => {
      transition.cancel();
      reducedMotion.removeEventListener("change", cancel);
    };
  }, [activeKey]);

  return contentRef;
}

export function TabContent({
  activeKey,
  children,
  className,
}: {
  activeKey: string;
  children: ReactNode;
  className?: string;
}) {
  const contentRef = useTabTransition(activeKey);
  return (
    <div ref={contentRef} className={cn("tab-content grid min-w-0 content-start gap-4", className)}>
      {children}
    </div>
  );
}
