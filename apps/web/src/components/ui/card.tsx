import { Card as AntCard } from "antd";
import type { ComponentProps } from "react";
import { cn, definedProps } from "@/lib/utils";

export function Card({
  as = "div",
  className,
  ...props
}: ComponentProps<"div"> & { as?: "div" | "section" | "article" }) {
  return (
    <AntCard
      data-slot="card"
      classNames={{ body: "ui-card-content" }}
      className={cn(
        "min-w-0 rounded-xl border border-border bg-card text-card-foreground shadow-xs",
        className,
      )}
      {...definedProps(props)}
      {...definedProps({
        role:
          props.role ??
          (as === "article"
            ? "article"
            : as === "section" && props["aria-label"]
              ? "region"
              : undefined),
      })}
      styles={{ body: { padding: 0, display: "contents" } }}
    />
  );
}
