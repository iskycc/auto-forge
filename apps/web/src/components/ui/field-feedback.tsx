"use client";

import { Typography } from "antd";
import { useId, useState, useEffect, useRef, useCallback, type ReactNode } from "react";

/** Keep browser constraint validation, but present its feedback inside the current form. */
export function FieldFeedback({ children }: { children: ReactNode }) {
  const [error, setError] = useState("");
  const errorId = useId();
  const container = useRef<HTMLSpanElement>(null);
  const invalidControls = useRef(
    new Map<HTMLElement, { invalid: string | null; message: string | null }>(),
  );
  const clearFeedback = useCallback(() => {
    setError("");
    for (const [control, previous] of invalidControls.current) {
      if (control.getAttribute("aria-errormessage") !== errorId) continue;
      if (previous.invalid === null) control.removeAttribute("aria-invalid");
      else control.setAttribute("aria-invalid", previous.invalid);
      if (previous.message === null) control.removeAttribute("aria-errormessage");
      else control.setAttribute("aria-errormessage", previous.message);
    }
    invalidControls.current.clear();
  }, [errorId]);
  useEffect(() => {
    const form = container.current?.closest("form");
    form?.addEventListener("reset", clearFeedback);
    return () => form?.removeEventListener("reset", clearFeedback);
  }, [clearFeedback]);
  return (
    <span
      ref={container}
      className="ui-field-feedback inline-flex w-full min-w-0 flex-col gap-1 align-middle"
      onInvalidCapture={(event) => {
        const control = event.target;
        if (!(
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
        ))
          return;
        event.preventDefault();
        setError(constraintMessage(control));
        const visibleControls =
          container.current?.querySelectorAll<HTMLElement>(
            "input:not([aria-hidden=true]), textarea, [role=combobox]",
          ) ?? [];
        for (const field of new Set<HTMLElement>([control, ...visibleControls])) {
          if (!invalidControls.current.has(field))
            invalidControls.current.set(field, {
              invalid: field.getAttribute("aria-invalid"),
              message: field.getAttribute("aria-errormessage"),
            });
          field.setAttribute("aria-invalid", "true");
          field.setAttribute("aria-errormessage", errorId);
        }
        if (
          control.form?.querySelector("input:invalid, select:invalid, textarea:invalid") === control
        )
          control.focus({ preventScroll: true });
      }}
      onInputCapture={clearFeedback}
      onChangeCapture={clearFeedback}
    >
      {children}
      {error ? (
        <Typography.Text id={errorId} type="danger" role="alert" className="text-xs break-words">
          {error}
        </Typography.Text>
      ) : null}
    </span>
  );
}

function constraintMessage(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): string {
  const validity = control.validity;
  if (validity.valueMissing)
    return control instanceof HTMLSelectElement ? "请选择一项。" : "请填写此项。";
  if (validity.typeMismatch)
    return control instanceof HTMLInputElement && control.type === "email"
      ? "请输入有效的邮箱地址。"
      : "请输入有效的地址。";
  if (validity.rangeUnderflow) return `不能小于 ${control.getAttribute("min")}。`;
  if (validity.rangeOverflow) return `不能大于 ${control.getAttribute("max")}。`;
  if (validity.stepMismatch)
    return `请输入符合步长 ${control.getAttribute("step") ?? "1"} 的数值。`;
  if (validity.tooShort) return `至少输入 ${control.getAttribute("minlength")} 个字符。`;
  if (validity.tooLong) return `最多输入 ${control.getAttribute("maxlength")} 个字符。`;
  if (validity.patternMismatch) return "输入内容不符合要求的格式。";
  if (validity.badInput) return "请输入有效的数值。";
  return control.validationMessage || "请检查此项内容。";
}
