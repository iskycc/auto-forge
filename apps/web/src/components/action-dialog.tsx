"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./ui";

export function ActionDialog({
  children,
  className,
  description,
  open,
  title,
  onClose,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  open: boolean;
  title: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const focusableElements = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
        (element) => element.getClientRects().length > 0,
      );
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = elements[0]!;
      const last = elements.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const focusFrame = window.requestAnimationFrame(() => {
      (focusableElements()[0] ?? dialogRef.current)?.focus();
    });
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="dialog-backdrop action-dialog-backdrop" onMouseDown={onClose}>
      <section
        aria-label={title}
        aria-modal="true"
        className={`action-dialog${className ? ` ${className}` : ""}`}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="action-dialog-header">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <Button
            aria-label={`关闭${title}`}
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </Button>
        </header>
        <div className="action-dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
