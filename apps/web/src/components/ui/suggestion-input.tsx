"use client";

import { AutoComplete } from "antd";
import {
  useCallback,
  useImperativeHandle,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentRef,
} from "react";
import { definedProps } from "@/lib/utils";
import { FieldFeedback } from "./field-feedback";
import { formControlLabel } from "./form-control-label";
import { useClientReadiness } from "./use-client-readiness";
import { useFormFieldValue } from "./use-form-field-value";

export function SuggestionInput({
  ref,
  suggestions,
  value,
  defaultValue,
  onChange,
  ...props
}: ComponentProps<"input"> & { suggestions: readonly string[] }) {
  const ready = useClientReadiness();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<ComponentRef<typeof AutoComplete>>(null);
  const readControl = useCallback(() => input.current, []);
  const field = useFormFieldValue(value, defaultValue, readControl);
  useImperativeHandle(ref, () => input.current!);
  const [label, setLabel] = useState<string>();
  useEffect(() => {
    const visibleControl = input.current?.parentElement?.querySelector<HTMLInputElement>(
      "input:not([aria-hidden=true])",
    );
    if (visibleControl) setLabel(formControlLabel(visibleControl));
  }, [props.id]);
  return (
    <FieldFeedback>
      <AutoComplete
        key={field.resetVersion}
        ref={trigger}
        {...definedProps({ id: props.id })}
        className="w-full min-w-0"
        aria-label={props["aria-label"] ?? label}
        aria-required={props.required}
        value={String(field.value ?? "")}
        disabled={props.disabled || !ready}
        placeholder={props.placeholder}
        options={suggestions.map((value) => ({ value }))}
        filterOption={(query, option) =>
          String(option?.value ?? "")
            .toLowerCase()
            .includes(query.toLowerCase())
        }
        onChange={(next) => {
          if (!input.current) return;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
            input.current,
            next,
          );
          input.current.dispatchEvent(new Event("input", { bubbles: true }));
        }}
      />
      <input
        {...props}
        id={undefined}
        aria-label={undefined}
        aria-labelledby={undefined}
        ref={input}
        className="sr-only pointer-events-none opacity-0"
        tabIndex={-1}
        aria-hidden="true"
        value={String(field.value ?? "")}
        disabled={props.disabled || !ready}
        onFocus={() => trigger.current?.focus()}
        onChange={(event) => {
          field.setDraft(event.target.value);
          onChange?.(event);
        }}
      />
    </FieldFeedback>
  );
}
