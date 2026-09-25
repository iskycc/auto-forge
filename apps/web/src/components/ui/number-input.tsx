"use client";

import { InputNumber } from "antd";
import {
  useCallback,
  useImperativeHandle,
  useRef,
  useEffect,
  useState,
  type ComponentProps,
  type ComponentRef,
} from "react";
import { cn, definedProps } from "@/lib/utils";
import { formControlLabel } from "./form-control-label";
import { FieldFeedback } from "./field-feedback";
import { useClientReadiness } from "./use-client-readiness";
import { useFormFieldValue } from "./use-form-field-value";

/** The hidden number field preserves FormData and validity while InputNumber owns interaction. */
export function NumberInput({
  ref,
  className,
  value,
  defaultValue,
  onChange,
  disabled,
  size,
  ...props
}: ComponentProps<"input">) {
  const ready = useClientReadiness();
  const native = useRef<HTMLInputElement>(null);
  const visible = useRef<ComponentRef<typeof InputNumber>>(null);
  const readControl = useCallback(() => native.current, []);
  const field = useFormFieldValue(value, defaultValue, readControl);
  useImperativeHandle(ref, () => native.current!);
  const [label, setLabel] = useState<string>();
  useEffect(() => {
    const visibleControl = native.current?.parentElement?.querySelector<HTMLInputElement>(
      "input:not([aria-hidden=true])",
    );
    if (visibleControl) setLabel(formControlLabel(visibleControl));
  }, [props.id]);
  const text = String(field.value ?? "");
  return (
    <FieldFeedback>
      <InputNumber
        ref={visible}
        id={props.id}
        key={field.resetVersion}
        className={cn("w-full min-w-0", className)}
        stringMode
        value={text === "" ? null : text}
        {...definedProps({
          min: props.min === undefined ? undefined : String(props.min),
          max: props.max === undefined ? undefined : String(props.max),
          step: props.step === "any" ? undefined : props.step,
          disabled: disabled || !ready,
          readOnly: props.readOnly,
          style: { width: size ? `${size}ch` : "100%", ...props.style },
          onBlur: props.onBlur,
          onFocus: props.onFocus,
          onKeyDown: props.onKeyDown,
          placeholder: props.placeholder,
          "aria-label": props["aria-label"] ?? label,
          "aria-labelledby": props["aria-labelledby"],
          "aria-describedby": props["aria-describedby"],
          "aria-required": props.required,
        })}
        onChange={(next) => {
          if (!native.current) return;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
            native.current,
            next ?? "",
          );
          native.current.dispatchEvent(new Event("input", { bubbles: true }));
        }}
      />
      <input
        {...props}
        id={undefined}
        aria-label={undefined}
        aria-labelledby={undefined}
        ref={native}
        type="number"
        className="sr-only pointer-events-none opacity-0"
        aria-hidden="true"
        tabIndex={-1}
        disabled={disabled || !ready}
        value={text}
        onFocus={() => visible.current?.focus()}
        onChange={(event) => {
          field.setDraft(event.target.value);
          onChange?.(event);
        }}
      />
    </FieldFeedback>
  );
}
