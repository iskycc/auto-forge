"use client";

import { FileUp } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { Button as DesignButton } from "./ui/button";
import { Input as DesignInput } from "./ui/input";
import { Textarea as DesignTextarea } from "./ui/textarea";
import { ChoiceInput, type ChoiceInputProps } from "./ui/choice-input";
import { Progress, type ProgressTone } from "./ui/progress";
import { cn } from "@/lib/utils";

import { DatePicker } from "antd";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useFormFieldValue } from "./ui/use-form-field-value";
import { formControlLabel } from "./ui/form-control-label";
import { useClientReadiness } from "./ui/use-client-readiness";

type ButtonVariant = "neutral" | "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "compact" | "regular" | "large";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "neutral", size = "regular", ...props },
  ref,
) {
  return (
    <DesignButton
      ref={ref}
      variant={
        variant === "primary"
          ? "default"
          : variant === "danger"
            ? "destructive"
            : variant === "neutral"
              ? "outline"
              : variant
      }
      size={size === "compact" ? "sm" : size === "large" ? "lg" : "default"}
      className={classes("ui-button", `ui-button-${variant}`, `ui-button-${size}`, className)}
      {...props}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, ChoiceInputProps>(function Input(
  { className, ...props },
  ref,
) {
  // File values are browser-owned. Ant Input must not control a selected filename.
  if (props.type === "file" || props.type === "hidden")
    return <input ref={ref} className={className} {...props} />;
  if (props.type === "checkbox" || props.type === "radio")
    return <ChoiceInput ref={ref} {...props} {...(className ? { className } : {})} />;
  return <DesignInput ref={ref} className={classes("ui-input", className)} {...props} />;
});

export { CheckboxGroup, type CheckboxGroupOption } from "./checkbox-group";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <DesignTextarea ref={ref} className={classes("ui-textarea", className)} {...props} />;
});

export { Select } from "./ui/native-select-bridge";

type DatetimeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  value?: string;
};

export const DatetimeInput = forwardRef<HTMLInputElement, DatetimeInputProps>(
  function DatetimeInput({ className, value, defaultValue, onChange, ...props }, ref) {
    const clientReady = useClientReadiness();
    const nativeInput = useRef<HTMLInputElement>(null);
    const picker = useRef<ComponentRef<typeof DatePicker>>(null);
    const [fieldLabel, setFieldLabel] = useState<string>();
    const readControl = useCallback(() => nativeInput.current, []);
    const field = useFormFieldValue(value, defaultValue, readControl);
    const displayed = String(field.value ?? "");
    useEffect(() => {
      if (nativeInput.current) setFieldLabel(formControlLabel(nativeInput.current));
    }, [props.id]);
    function commit(nextValue: string): void {
      const input = nativeInput.current;
      if (!input) return;
      // Notify React through the native field to preserve existing onChange/FormData consumers.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        nextValue,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return (
      <span className={cn("ui-datetime relative inline-flex w-full min-w-0", className)}>
        <input
          {...props}
          disabled={props.disabled || !clientReady}
          ref={(input) => {
            nativeInput.current = input;
            if (typeof ref === "function") ref(input);
            else if (ref) ref.current = input;
          }}
          type="datetime-local"
          className="ui-datetime-control sr-only opacity-0"
          tabIndex={-1}
          aria-hidden="true"
          value={displayed}
          onFocus={(event) => {
            props.onFocus?.(event);
            picker.current?.focus();
          }}
          onInvalid={(event) => {
            props.onInvalid?.(event);
            picker.current?.focus();
          }}
          onChange={(event) => {
            field.setDraft(event.target.value);
            onChange?.(event);
          }}
        />
        <DatePicker
          // A form reset also discards the picker's focused, unconfirmed text draft.
          key={field.resetVersion}
          ref={picker}
          className="w-full min-w-0 min-h-[var(--ant-control-height)]"
          showTime={{ format: "HH:mm" }}
          format="YYYY/MM/DD HH:mm"
          placeholder="选择日期与时间"
          value={displayed ? dayjs(displayed) : null}
          disabled={props.disabled === true || !clientReady}
          onChange={(next) => commit(next ? next.format("YYYY-MM-DDTHH:mm") : "")}
          aria-label={props["aria-label"] ?? fieldLabel ?? "日期与时间"}
          aria-required={props.required}
          aria-invalid={props["aria-invalid"]}
          aria-describedby={props["aria-describedby"]}
        />
      </span>
    );
  },
);

type FileInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export const FileInput = forwardRef<HTMLInputElement, FileInputProps>(function FileInput(
  { className, onChange, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const fileInput = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => fileInput.current!);
  const [fileName, setFileName] = useState<string | undefined>(undefined);

  return (
    <span
      className={classes(
        "ui-file relative flex min-h-9 w-full min-w-0 items-center gap-3 rounded-md border border-input bg-card pr-3 text-sm data-[disabled=true]:opacity-50",
        className,
      )}
      data-disabled={props.disabled ? "true" : undefined}
      data-empty={!fileName ? "true" : undefined}
    >
      <input
        id={inputId}
        ref={fileInput}
        className="ui-file-control peer sr-only"
        onChange={(event) => {
          setFileName(event.target.files?.item(0)?.name);
          onChange?.(event);
        }}
        type="file"
        {...props}
      />
      <DesignButton
        className="ui-file-trigger shrink-0"
        type="button"
        variant="outline"
        disabled={props.disabled}
        onClick={() => fileInput.current?.click()}
      >
        <FileUp aria-hidden="true" size={15} />
        选择文件
      </DesignButton>
      <span className="ui-file-name min-w-0 truncate text-muted-foreground" title={fileName}>
        {fileName ?? "未选择任何文件"}
      </span>
    </span>
  );
});

export function ProgressBar({
  value,
  max = 100,
  label,
  indeterminate = false,
  tone = "info",
}: {
  value: number;
  max?: number;
  label?: string;
  indeterminate?: boolean;
  tone?: ProgressTone;
}) {
  return (
    <Progress
      tone={tone}
      aria-label={label}
      value={indeterminate ? null : value}
      max={max > 0 ? max : 100}
      data-indeterminate={indeterminate ? "true" : undefined}
    />
  );
}

export function OperationProgress({
  label,
  detail,
  value,
  indeterminate = false,
}: {
  label: string;
  detail: string;
  value: number;
  indeterminate?: boolean;
}) {
  return (
    <div
      className="ui-operation-progress grid min-w-0 gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex justify-between gap-3">
        <strong>{label}</strong>
        <span>{indeterminate ? "处理中" : `${Math.round(value)}%`}</span>
      </div>
      <ProgressBar indeterminate={indeterminate} label={`${label}进度`} max={100} value={value} />
      <small className="truncate text-xs text-muted-foreground" title={detail}>
        {detail}
      </small>
    </div>
  );
}

function classes(...values: Array<string | undefined | false>): string {
  return cn(...values);
}
