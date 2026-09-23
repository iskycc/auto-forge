"use client";

import { Progress as AntProgress } from "antd";
import type { ComponentProps } from "react";
import { cn, definedProps } from "@/lib/utils";

export function Progress({
  className,
  value,
  max = 100,
  ...props
}: ComponentProps<"div"> & { value?: number | null; max?: number }) {
  const percent = value == null ? 35 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <AntProgress
      data-slot="progress"
      className={cn("ui-progress m-0 block w-full", className)}
      percent={percent}
      status={value == null ? "active" : "normal"}
      showInfo={false}
      size="small"
      {...definedProps(props)}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value ?? undefined}
    />
  );
}
