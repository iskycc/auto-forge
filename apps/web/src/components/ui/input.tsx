"use client";

import { Input as AntInput, type InputRef } from "antd";
import { useCallback, useImperativeHandle, useRef, type ComponentProps } from "react";
import { FieldFeedback } from "./field-feedback";
import { cn, definedProps } from "@/lib/utils";
import { useFormFieldValue } from "./use-form-field-value";
import { useClientReadiness } from "./use-client-readiness";

export function Input({
  className,
  type,
  ref,
  size,
  value,
  defaultValue,
  onChange,
  disabled,
  ...props
}: ComponentProps<"input">) {
  const clientReady = useClientReadiness();
  const control = useRef<InputRef>(null);
  const readControl = useCallback(() => control.current?.input ?? null, []);
  const field = useFormFieldValue(value, defaultValue, readControl);
  useImperativeHandle(ref, () => control.current!.input!);
  const InputControl = type === "password" ? AntInput.Password : AntInput;
  return (
    <FieldFeedback>
      <InputControl
        key={type === "password" ? field.resetVersion : undefined}
        ref={control}
        {...definedProps({ type })}
        data-slot="input"
        className={cn(
          "w-full min-w-0 disabled:opacity-50 aria-invalid:border-destructive",
          className,
        )}
        {...definedProps(props)}
        disabled={disabled || !clientReady}
        value={field.value ?? ""}
        onChange={(event) => {
          field.setDraft(event.target.value);
          onChange?.(event);
        }}
        {...(size ? { style: { width: `${size}ch`, ...props.style } } : {})}
      />
    </FieldFeedback>
  );
}
