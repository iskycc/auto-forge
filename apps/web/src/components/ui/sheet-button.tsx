"use client";

import { Button, theme } from "antd";
import type { ComponentProps } from "react";
import { cn, definedProps } from "@/lib/utils";

/** Quiet spreadsheet cells retain Ant's keyboard, focus and minimum control size. */
export function SheetButton({
  type = "button",
  className,
  style,
  ...props
}: Omit<ComponentProps<"button">, "color">) {
  const { token } = theme.useToken();
  return (
    <Button
      {...definedProps(props)}
      type="text"
      htmlType={type}
      className={cn(
        "h-auto min-w-0 justify-start whitespace-normal rounded-sm px-1 text-left text-inherit shadow-none [&>span]:min-w-0",
        className,
      )}
      style={{ minHeight: token.controlHeight, textAlign: "left", whiteSpace: "normal", ...style }}
    />
  );
}
