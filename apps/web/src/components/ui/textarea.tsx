"use client";

import { Input } from "antd";
import {
  useCallback,
  useImperativeHandle,
  useRef,
  type ComponentProps,
  type ComponentRef,
} from "react";
import { cn, definedProps } from "@/lib/utils";
import { useFormFieldValue } from "./use-form-field-value";
import { useClientReadiness } from "./use-client-readiness";

export function Textarea({
  className,
  ref,
  value,
  defaultValue,
  onChange,
  disabled,
  ...props
}: ComponentProps<"textarea">) {
  const clientReady = useClientReadiness();
  const control = useRef<ComponentRef<typeof Input.TextArea>>(null);
  const readControl = useCallback(() => control.current?.resizableTextArea?.textArea ?? null, []);
  const field = useFormFieldValue(value, defaultValue, readControl);
  useImperativeHandle(ref, () => control.current!.resizableTextArea!.textArea);
  return (
    <Input.TextArea
      ref={control}
      data-slot="textarea"
      className={cn(
        "min-h-24 w-full min-w-0 disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...definedProps(props)}
      disabled={disabled || !clientReady}
      value={field.value ?? ""}
      onChange={(event) => {
        field.setDraft(event.target.value);
        onChange?.(event);
      }}
    />
  );
}
