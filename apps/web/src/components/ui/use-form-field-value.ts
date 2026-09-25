"use client";

import { useEffect, useState } from "react";

type FieldValue = string | number | readonly string[] | undefined;
type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Preserve native form reset and new server-provided defaults with controlled library inputs. */
export function useFormFieldValue(
  value: FieldValue,
  defaultValue: FieldValue,
  readControl: () => FormControl | null,
) {
  const [previousDefault, setPreviousDefault] = useState(defaultValue);
  const [draft, setDraft] = useState<FieldValue>(defaultValue ?? "");
  const [resetVersion, setResetVersion] = useState(0);
  if (!sameFieldValue(previousDefault, defaultValue)) {
    setPreviousDefault(defaultValue);
    setDraft(defaultValue ?? "");
  }

  useEffect(() => {
    const form = readControl()?.form;
    let frame = 0;
    const reset = (event: Event) => {
      // Native reset is applied after dispatch. Respect forms that cancel it.
      frame = requestAnimationFrame(() => {
        if (!event.defaultPrevented) {
          setDraft(defaultValue ?? "");
          setResetVersion((version) => version + 1);
        }
      });
    };
    form?.addEventListener("reset", reset);
    return () => {
      form?.removeEventListener("reset", reset);
      cancelAnimationFrame(frame);
    };
  }, [defaultValue, readControl]);

  return { value: value ?? draft, setDraft, resetVersion };
}

function sameFieldValue(left: FieldValue, right: FieldValue): boolean {
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => item === right[index]);
  return left === right;
}
