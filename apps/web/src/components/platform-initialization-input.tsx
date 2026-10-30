"use client";

import { useId, useState, type ComponentProps } from "react";
import { Typography } from "antd";
import { Input } from "./ui";
import { textPasteExceedsLimit } from "@/lib/bounded-text-paste";

/** Initialization addresses must be bounded before native input layout, without truncation. */
export function PlatformInitializationInput({
  maxLength,
  onPaste,
  onChange,
  ...props
}: ComponentProps<typeof Input> & { maxLength: number }) {
  const errorId = useId();
  const [pasteError, setPasteError] = useState("");
  return (
    <>
      <Input
        {...props}
        maxLength={maxLength}
        autoComplete={props.autoComplete ?? "off"}
        spellCheck={false}
        {...(pasteError
          ? {
              "aria-invalid": true,
              "aria-describedby": [props["aria-describedby"], errorId].filter(Boolean).join(" "),
            }
          : {})}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          const control = event.currentTarget;
          if (
            textPasteExceedsLimit({
              value: control.value,
              pastedText: event.clipboardData?.getData("text/plain") ?? "",
              maximumLength: maxLength,
              selectionStart: control.selectionStart,
              selectionEnd: control.selectionEnd,
            })
          ) {
            event.preventDefault();
            setPasteError(
              `最多允许 ${maxLength} 个字符，本次粘贴未写入，原有内容已保留。请检查剪贴板内容。`,
            );
            return;
          }
          setPasteError("");
        }}
        onChange={(event) => {
          setPasteError("");
          onChange?.(event);
        }}
      />
      {pasteError ? (
        <Typography.Text id={errorId} type="danger" role="alert">
          {pasteError}
        </Typography.Text>
      ) : null}
    </>
  );
}
