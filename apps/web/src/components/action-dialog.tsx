"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "./ui";
import { DialogDiscardPrompt } from "./dialog-discard-prompt";
import { Dialog } from "./ui/dialog";
import { cn } from "@/lib/utils";
import { uiPatterns } from "./ui/patterns";

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
  const descriptionId = useId();
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const hasChanges = controlledDirty ?? dirty;
  function requestClose() {
    if (closeDisabled || inactive) return;
    if (protectUnsavedChanges && hasChanges) setConfirmDiscard(true);
    else onClose();
  }
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
  // Keep the shared Modal mounted so Ant can finish its exit transition and
  // restore focus. Dialog owns hydration and destroys hidden content afterwards.
  return (
    <Dialog
      open={open}
      title={title}
      onClose={requestClose}
      className={className}
      backdropClassName={cn("dialog-backdrop action-dialog-backdrop", backdropClassName)}
      inactive={inactive}
      closeDisabled={closeDisabled}
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
        aria-hidden={inactive || undefined}
        inert={inactive}
        className="action-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="action-dialog-header flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="m-0 text-lg font-semibold [overflow-wrap:anywhere]">{title}</h2>

            {description ? (
              <p className="mt-1 text-sm leading-6 text-muted-foreground" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <Button
            aria-label={closeLabel ?? `关闭${title}`}
            disabled={closeDisabled}
            className={cn("icon-button", uiPatterns["icon-button"])}
            onClick={requestClose}
            type="button"
          >
            <X size={18} />
          </Button>
        </header>
        <div className="action-dialog-body min-h-0 min-w-0 overflow-y-auto px-6 py-5 [overflow-wrap:anywhere]">
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
        {footer ? (
          <footer className="action-dialog-footer shrink-0 border-t border-border bg-muted/30 px-6 py-4">
            {footer}
          </footer>
        ) : null}
      </section>
    </Dialog>
  );
}
