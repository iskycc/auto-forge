import { Spin } from "antd";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function LoadingStateMessage({ children, className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-center gap-2 py-3 text-sm text-muted-foreground",
        className,
      )}
    >
      <Spin size="small" />
      <span>{children}</span>
    </div>
  );
}
