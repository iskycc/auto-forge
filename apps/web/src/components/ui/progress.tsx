"use client";

import { Progress as AntProgress } from "antd";
import type { ComponentProps } from "react";
import { cn, definedProps } from "@/lib/utils";

const progressColors = {
  info: "var(--info)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--destructive)",
} as const;

export type ProgressTone = keyof typeof progressColors;

export function Progress({
  className,
  value,
  max = 100,
  tone = "info",
  ...props
}: ComponentProps<"div"> & { value?: number | null; max?: number; tone?: ProgressTone }) {
  const percent = value == null ? 35 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <AntProgress
      data-slot="progress"
      className={cn("ui-progress m-0 block w-full", className)}
      percent={percent}
      status={value == null ? "active" : "normal"}
      showInfo={false}
      size="small"
      strokeColor={progressColors[tone]}
      railColor="var(--border)"
      // A block body avoids the inline baseline gap in compact cards and grids.
      styles={{ body: { display: "flex" } }}
      {...definedProps(props)}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value ?? undefined}
    />
  );
}
