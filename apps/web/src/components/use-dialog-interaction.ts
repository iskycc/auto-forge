"use client";

import { useEffect, useRef, type RefObject } from "react";

let scrollLockCount = 0;
let originalBodyOverflow = "";

/** Keep custom dialogs on the same keyboard/focus lifecycle as native modals. */
export function useDialogInteraction({
  dialogRef,
  open,
  active,
  onClose,
}: {
  dialogRef: RefObject<HTMLElement | null>;
  open: boolean;
  active: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  const lastDialogFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scrollLockCount++ === 0) originalBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      if (--scrollLockCount === 0) document.body.style.overflow = originalBodyOverflow;
      lastDialogFocus.current = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!active) return;
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && dialogRef.current?.contains(event.target))
        lastDialogFocus.current = event.target;
    };
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter(
        (element) =>
          element.getClientRects().length > 0 && !element.closest('[inert],[aria-hidden="true"]'),
      );
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]',
        ),
      ).filter(
        (element) =>
          element.getClientRects().length > 0 && !element.closest('[inert],[aria-hidden="true"]'),
      );
      if (dialogs.at(-1) !== dialogRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements.at(-1);
        if (!first || !last) {
          event.preventDefault();
          dialogRef.current?.focus();
        } else if (
          !dialogRef.current?.contains(document.activeElement) ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    // A nested modal may have restored its trigger already. Otherwise restore the
    // last control here; inert can blur that trigger before the child captures it.
    const frame = window.requestAnimationFrame(() => {
      if (
        document.querySelector("dialog[open]") ||
        dialogRef.current?.contains(document.activeElement)
      )
        return;
      const previousControl = lastDialogFocus.current;
      (previousControl && focusable().includes(previousControl)
        ? previousControl
        : (focusable()[0] ?? dialogRef.current)
      )?.focus();
    });
    window.addEventListener("focusin", rememberFocus);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("focusin", rememberFocus);
    };
  }, [active, dialogRef]);
}
