"use client";

import { Skeleton as AntSkeleton } from "antd";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("h-4 min-w-0", className)}
      {...props}
    >
      <AntSkeleton.Input
        active
        block
        className="h-full min-w-0"
        styles={{ content: { width: "100%", minWidth: 0, height: "100%", minHeight: 8 } }}
      />
    </div>
  );
}
