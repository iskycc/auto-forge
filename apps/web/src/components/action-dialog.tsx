"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./ui";
import { useDialogInteraction } from "./use-dialog-interaction";
import { DialogDiscardPrompt } from "./dialog-discard-prompt";

export function ActionDialog({
  children,
  className,
  description,
  open,
  title,
  onClose,
  protectUnsavedChanges = false,
  dirty: controlledDirty,
  closeDisabled = false,
  inactive = false,
  closeLabel,
  backdropClassName,
  footer,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  open: boolean;
  title: string;
  onClose: () => void;
  protectUnsavedChanges?: boolean;
  dirty?: boolean;
  closeDisabled?: boolean;
  inactive?: boolean;
  closeLabel?: string;
  backdropClassName?: string;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const hasChanges = controlledDirty ?? dirty;
  function requestClose() {
    if (closeDisabled || inactive) return;
    if (protectUnsavedChanges && hasChanges) setConfirmDiscard(true);
    else onClose();
  }
  useDialogInteraction({ dialogRef, open, active: open && !inactive, onClose: requestClose });
  useEffect(() => {
    const dialog = dialogRef.current;
    const markDraft = (event: Event) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== "search")
        setDirty(true);
    };
    dialog?.addEventListener("change", markDraft);
    return () => dialog?.removeEventListener("change", markDraft);
  }, [open]);

  if (!open && (dirty || confirmDiscard)) {
    setDirty(false);
    setConfirmDiscard(false);
  }
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className={`dialog-backdrop action-dialog-backdrop ${backdropClassName ?? ""}`}
      onMouseDown={requestClose}
    >
      <section
        onChangeCapture={(event) => {
          if (!(event.target instanceof HTMLInputElement) || event.target.type !== "search")
            setDirty(true);
        }}
        onClickCapture={(event) => {
          const button = (event.target as HTMLElement).closest("[data-dialog-dismiss]");
          if (button && (closeDisabled || (protectUnsavedChanges && hasChanges))) {
            event.preventDefault();
            event.stopPropagation();
            requestClose();
          }
        }}
        aria-label={title}
        aria-modal={!inactive}
        aria-hidden={inactive || undefined}
        inert={inactive}
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
            aria-label={closeLabel ?? `关闭${title}`}
            disabled={closeDisabled}
            className="icon-button"
            onClick={requestClose}
            type="button"
          >
            <X size={18} />
          </Button>
        </header>
        <div className="action-dialog-body">
          {confirmDiscard ? (
            <DialogDiscardPrompt
              onContinue={() => setConfirmDiscard(false)}
              onDiscard={() => {
                if (!closeDisabled) onClose();
              }}
            />
          ) : null}
          {children}
        </div>
        {footer ? <footer className="action-dialog-footer">{footer}</footer> : null}
      </section>
    </div>,
    document.body,
  );
}
