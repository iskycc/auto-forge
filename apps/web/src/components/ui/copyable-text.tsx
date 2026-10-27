"use client";

import { Typography } from "antd";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keep Ant Design's offline/HTTP-compatible copy behavior with a keyboard-friendly hit area. */
export function CopyableText({
  text,
  children,
  className,
  block = false,
}: {
  text: string;
  children?: ReactNode;
  className?: string;
  block?: boolean;
}) {
  const Text = block ? Typography.Paragraph : Typography.Text;
  return (
    <Text
      copyable={{ text }}
      className={cn(
        "[&_.ant-typography-copy]:!inline-flex [&_.ant-typography-copy]:!size-8 [&_.ant-typography-copy]:items-center [&_.ant-typography-copy]:justify-center",
        className,
      )}
    >
      {children ?? text}
    </Text>
  );
}
