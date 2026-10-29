"use client";
import { Tag, theme } from "antd";
import type { ReactNode } from "react";

/** Explicit semantic tokens keep status text readable in both zero-runtime themes. */
export function SemanticStatusTag({
  tone,
  children,
}: {
  tone: "info" | "success" | "danger" | "neutral";
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  const palette =
    tone === "success"
      ? {
          color: token.colorSuccessText,
          background: token.colorSuccessBg,
          borderColor: token.colorSuccessBorder,
        }
      : tone === "danger"
        ? {
            color: token.colorErrorText,
            background: token.colorErrorBg,
            borderColor: token.colorErrorBorder,
          }
        : tone === "info"
          ? {
              color: token.colorInfoText,
              background: token.colorInfoBg,
              borderColor: token.colorInfoBorder,
            }
          : {
              color: token.colorTextSecondary,
              background: token.colorFillAlter,
              borderColor: token.colorBorderSecondary,
            };
  return <Tag style={{ marginInlineEnd: 0, ...palette }}>{children}</Tag>;
}
