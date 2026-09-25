import { Spin } from "antd";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Compact Ant spinner for inline actions; motion belongs to Spin, not its container. */
export function LoadingIcon({
  size = 16,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children" | "ref"> & { size?: number }) {
  return (
    <Spin
      {...props}
      size="small"
      className={cn("inline-flex shrink-0 align-middle", className)}
      style={{ width: size, height: size, ...props.style }}
    />
  );
}
