"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./ui";

export function ActionDialog({
  children,
  className,
  description,
  open,
  title,
  onClose,
  protectUnsavedChanges = false,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  open: boolean;
  title: string;
  onClose: () => void;
  protectUnsavedChanges?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  function requestClose() {
    if (protectUnsavedChanges && dirty) setConfirmDiscard(true);
    else onClose();
  }
  const onCloseRef = useRef(requestClose);

  useEffect(() => {
    onCloseRef.current = requestClose;
  });

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
      // Native modal dialogs can be opened from an action dialog (for example,
      // the reusable log comparison). Let the top-layer dialog own Escape and
      // focus traversal until it closes.
      if (document.querySelector("dialog[open]")) return;
      if ([...document.querySelectorAll(".action-dialog")].at(-1) !== dialogRef.current) return;
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
    const markDraft = (event: Event) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== "search")
        setDirty(true);
    };
    const dialog = dialogRef.current;
    dialog?.addEventListener("change", markDraft);
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      dialog?.removeEventListener("change", markDraft);
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open && (dirty || confirmDiscard)) {
    setDirty(false);
    setConfirmDiscard(false);
  }
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="dialog-backdrop action-dialog-backdrop" onMouseDown={requestClose}>
      <section
        onChangeCapture={(event) => {
          if (!(event.target instanceof HTMLInputElement) || event.target.type !== "search")
            setDirty(true);
        }}
        onClickCapture={(event) => {
          const button = (event.target as HTMLElement).closest("[data-dialog-dismiss]");
          if (button && protectUnsavedChanges && dirty) {
            event.preventDefault();
            event.stopPropagation();
            requestClose();
          }
        }}
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
            onClick={requestClose}
            type="button"
          >
            <X size={18} />
          </Button>
        </header>
        <div className="action-dialog-body">
          {confirmDiscard ? (
            <div className="draft-discard-prompt" role="alert">
              <strong>放弃未保存的修改？</strong>
              <p>关闭后，本次填写的内容将丢失。</p>
              <Button type="button" onClick={() => setConfirmDiscard(false)}>
                继续编辑
              </Button>
              <Button type="button" variant="danger" onClick={onClose}>
                放弃修改并关闭
              </Button>
            </div>
          ) : null}
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}
