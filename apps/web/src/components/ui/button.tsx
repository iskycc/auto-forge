"use client";

import { Button as AntButton } from "antd";
import type { VariantProps } from "class-variance-authority";
import { buttonVariants } from "./button-variants";
import type { ComponentProps } from "react";

import { cn, definedProps } from "@/lib/utils";
import { useClientReadiness } from "./use-client-readiness";

export function Button({
  className,
  variant = "default",
  size = "default",
  type = "submit",
  disabled,
  ...props
}: Omit<ComponentProps<"button">, "color"> &
  VariantProps<typeof buttonVariants> & { loading?: boolean }) {
  const clientReady = useClientReadiness();
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
      disabled={disabled || !clientReady}
      {...definedProps(props)}
    />
  );
}
