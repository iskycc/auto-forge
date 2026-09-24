"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { theme } from "antd";
import { cn } from "@/lib/utils";

/** Fade only the panel, without remounting drafts or animating layout/scroll geometry. */
export function useContentTransition<Element extends HTMLElement = HTMLDivElement>(
  activeKey: string,
) {
  const { token } = theme.useToken();
  const contentRef = useRef<Element>(null);
  const previousKey = useRef(activeKey);

  useLayoutEffect(() => {
    const changed = previousKey.current !== activeKey;
    previousKey.current = activeKey;
    const content = contentRef.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!changed || !content?.animate || reducedMotion.matches || !token.motion) return;

    const transition = content.animate([{ opacity: 0.55 }, { opacity: 1 }], {
      id: "autoforge-content-enter",
      duration: parseFloat(token.motionDurationMid) * 1000,
      easing: token.motionEaseOut,
    });
    const cancel = () => transition.cancel();
    reducedMotion.addEventListener("change", cancel);
    return () => {
      transition.cancel();
      reducedMotion.removeEventListener("change", cancel);
    };
  }, [activeKey, token.motion, token.motionDurationMid, token.motionEaseOut]);

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
  const contentRef = useContentTransition(activeKey);
  return (
    <div ref={contentRef} className={cn("tab-content grid min-w-0 content-start gap-4", className)}>
      {children}
    </div>
  );
}
