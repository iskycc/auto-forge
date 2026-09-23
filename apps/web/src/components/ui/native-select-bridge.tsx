"use client";

import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";
import { Select as AntSelect, type RefSelectProps } from "antd";
import { useFormFieldValue } from "./use-form-field-value";
import { formControlLabel } from "./form-control-label";
import { useClientReadiness } from "./use-client-readiness";

type Option = { value: string; label: string; disabled: boolean };

function optionLabel(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("");
}

function readOptions(children: ReactNode, groupDisabled = false): Option[] {
  return Children.toArray(children).flatMap((child): Option[] => {
    if (
      !isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean }>(child)
    )
      return [];
    if (child.type === Fragment || child.type === "optgroup") {
      return readOptions(child.props.children, groupDisabled || child.props.disabled === true);
    }
    if (child.type !== "option") return [];
    const label = optionLabel(child.props.children);
    return [
      {
        value: String(child.props.value ?? label),
        label,
        disabled: groupDisabled || child.props.disabled === true,
      },
    ];
  });
}

/** Keep native form data, required validation, refs and change events while Ant Design
 * owns the visible listbox, focus, keyboard navigation and collision handling. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(
    { children, className, disabled, multiple, value, defaultValue, onChange, ...props },
    forwardedRef,
  ) {
    const clientReady = useClientReadiness();
    const options = readOptions(children);
    const selectRef = useRef<HTMLSelectElement | null>(null);
    const triggerRef = useRef<RefSelectProps | null>(null);
    const readControl = useCallback(() => selectRef.current, []);
    const field = useFormFieldValue(value, defaultValue, readControl);
    const uncontrolledValue = String(field.value ?? "");
    const [fieldLabel, setFieldLabel] = useState<string>();
    const currentValue =
      value === undefined
        ? options.some((option) => option.value === uncontrolledValue)
          ? uncontrolledValue
          : (options.find((option) => !option.disabled)?.value ?? "")
        : String(value);
    useEffect(() => {
      if (selectRef.current) setFieldLabel(formControlLabel(selectRef.current));
    }, [props.id]);

    function chooseOption(nextValue: string) {
      const control = selectRef.current;
      if (!control) return;
      control.value = nextValue;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return (
      <span
        className={cn(
          "ui-select relative inline-block w-full min-w-0 max-w-full align-middle [&>select[aria-hidden=true]]:opacity-0",
          multiple && "ui-select-multiple",
        )}
        data-disabled={disabled ? "true" : undefined}
        data-multiple={multiple ? "true" : undefined}
        data-empty={options.length ? undefined : "true"}
      >
        <select
          {...props}
          ref={(element) => {
            selectRef.current = element;
            if (typeof forwardedRef === "function") forwardedRef(element);
            else if (forwardedRef) forwardedRef.current = element;
          }}
          aria-hidden={!multiple}
          className={cn(
            "ui-select-control",
            multiple
              ? "w-full min-w-0 rounded-md border border-input bg-card p-2 text-sm outline-none focus:ring-2 focus:ring-ring/30"
              : "ui-select-control-hidden sr-only pointer-events-none opacity-0",
            className,
          )}
          disabled={disabled || !clientReady}
          multiple={multiple}
          tabIndex={multiple ? 0 : -1}
          value={multiple ? field.value : currentValue}
          onChange={(event) => {
            field.setDraft(
              multiple
                ? Array.from(event.target.selectedOptions, (option) => option.value)
                : event.target.value,
            );
            onChange?.(event);
          }}
          onInvalid={(event) => {
            props.onInvalid?.(event);
            if (!multiple) triggerRef.current?.focus();
          }}
          onFocus={(event) => {
            props.onFocus?.(event);
            if (!multiple) triggerRef.current?.focus();
          }}
        >
          {children}
        </select>
        {!multiple ? (
          <AntSelect
            ref={triggerRef}
            className="ui-select-trigger w-full"
            aria-label={props["aria-label"] ?? fieldLabel}
            aria-labelledby={props["aria-labelledby"]}
            aria-describedby={props["aria-describedby"]}
            aria-invalid={props["aria-invalid"]}
            aria-required={props.required}
            value={currentValue}
            onChange={chooseOption}
            disabled={disabled || !clientReady || !options.length}
            options={options}
            placeholder={options.length ? "请选择" : "暂无可选项"}
            virtual={options.length > 200}
            getPopupContainer={(trigger) => trigger.closest("dialog") ?? document.body}
          />
        ) : null}
      </span>
    );
  },
);
