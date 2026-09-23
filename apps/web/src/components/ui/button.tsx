import { Button as AntButton } from "antd";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn, definedProps } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border-input bg-background text-foreground hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "bg-transparent text-foreground hover:bg-accent",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3 py-2",
        sm: "h-8 gap-1.5 px-2.5",
        lg: "h-10 px-4",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant = "default",
  size = "default",
  type = "submit",
  ...props
}: Omit<ComponentProps<"button">, "color"> & VariantProps<typeof buttonVariants>) {
  return (
    <AntButton
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        "shrink-0 [&_svg]:shrink-0 disabled:opacity-50",
        size === "icon" && "size-9 p-0",
        className,
      )}
      type={
        variant === "default"
          ? "primary"
          : variant === "link"
            ? "link"
            : variant === "ghost"
              ? "text"
              : "default"
      }
      danger={variant === "destructive"}
      size={size === "sm" ? "small" : size === "lg" ? "large" : "middle"}
      htmlType={type}
      {...definedProps(props)}
    />
  );
}
