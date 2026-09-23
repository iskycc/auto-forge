import { Tag } from "antd";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn, definedProps } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:size-3.5",
  {
    variants: {
      variant: {
        secondary: "bg-muted text-muted-foreground",
        success: "bg-success/10 text-success",
        warning: "bg-warning/10 text-warning",
        destructive: "bg-destructive/10 text-destructive",
        info: "bg-info/10 text-info",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

export function Badge({
  className,
  variant = "secondary",
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <Tag
      data-slot="badge"
      color={
        variant === "destructive"
          ? "error"
          : variant === "info"
            ? "processing"
            : variant === "secondary"
              ? "default"
              : (variant ?? "default")
      }
      className={cn("m-0", badgeVariants({ variant }), className)}
      {...definedProps(props)}
    />
  );
}
