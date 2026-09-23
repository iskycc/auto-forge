"use client";

import { Checkbox, Radio, type CheckboxRef } from "antd";
import { useImperativeHandle, useRef, type InputHTMLAttributes, type Ref } from "react";
import { nativeInputEvent } from "./native-input-event";
import { cn, definedProps } from "@/lib/utils";

export type ChoiceInputProps = InputHTMLAttributes<HTMLInputElement> & {
  indeterminate?: boolean;
  ref?: Ref<HTMLInputElement> | undefined;
};

/** Preserve the native input event and FormData contract used by existing forms. */
export function ChoiceInput({
  ref,
  className,
  onChange,
  onClick,
  onKeyDown,
  onKeyUp,
  onFocus,
  onBlur,
  indeterminate,
  type,
  ...props
}: ChoiceInputProps) {
  const control = useRef<CheckboxRef>(null);
  useImperativeHandle(ref, () => control.current!.input!);
  const Choice = type === "radio" ? Radio : Checkbox;
  return (
    <span
      className="inline-flex shrink-0 align-middle"
      onChange={(event) => {
        if (event.target instanceof HTMLInputElement)
          onChange?.(nativeInputEvent(event, event.target));
      }}
    >
      <Choice
        {...definedProps(props)}
        ref={control}
        {...(type === "checkbox" ? definedProps({ indeterminate }) : {})}
        className={cn("ui-input m-0", className)}
        // Business forms style their labels as grids. The inner Ant Design
        // label only contains the choice control and must retain its inline layout.
        styles={{ root: { display: "inline-flex", alignItems: "center", gap: 0 } }}
        onClick={(event) => {
          const input = control.current?.input;
          if (input) onClick?.(nativeInputEvent(event, input));
        }}
        onKeyDown={(event) => {
          const input = control.current?.input;
          if (input) onKeyDown?.(nativeInputEvent(event, input));
        }}
        {...definedProps({ onKeyUp, onFocus, onBlur })}
      />
    </span>
  );
}
