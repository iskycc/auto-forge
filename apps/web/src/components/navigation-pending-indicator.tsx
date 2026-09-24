"use client";

import { Spin } from "antd";
import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Reserve the slot so slow navigation gives feedback without moving its label. */
export function NavigationPendingIndicator({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={cn("navigation-pending inline-grid size-4 shrink-0 place-items-center", className)}
    >
      {children && !pending ? children : <Spin size="small" spinning={pending} delay={150} />}
    </span>
  );
}
