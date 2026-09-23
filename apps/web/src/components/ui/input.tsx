"use client";

import { Input as AntInput, type InputRef } from "antd";
import { useCallback, useImperativeHandle, useRef, type ComponentProps } from "react";
import { cn, definedProps } from "@/lib/utils";
import { useFormFieldValue } from "./use-form-field-value";

export function Input({
  className,
  type,
  ref,
  size,
  value,
  defaultValue,
  onChange,
  ...props
}: ComponentProps<"input">) {
  const control = useRef<InputRef>(null);
  const readControl = useCallback(() => control.current?.input ?? null, []);
  const field = useFormFieldValue(value, defaultValue, readControl);
  useImperativeHandle(ref, () => control.current!.input!);
  return (
    <AntInput
      ref={control}
      {...definedProps({ type })}
      data-slot="input"
      className={cn(
        "w-full min-w-0 disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...definedProps(props)}
      value={field.value ?? ""}
      onChange={(event) => {
        field.setDraft(event.target.value);
        onChange?.(event);
      }}
      {...(size ? { style: { width: `${size}ch`, ...props.style } } : {})}
    />
  );
}
