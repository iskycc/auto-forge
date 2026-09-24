"use client";

import { Modal } from "antd";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { useClientReadiness } from "./use-client-readiness";

/** Shared modal lifecycle; callers keep ownership of drafts and close policies. */
export function Dialog({
  open,
  title,
  children,
  onClose,
  className,
  backdropClassName,
  inactive = false,
  closeDisabled = false,
  initialFocusRef,
  zIndex = 1000,
  panelRef,
  panelProps,
  onEscape,
  role = "dialog",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string | undefined;
  backdropClassName?: string | undefined;
  inactive?: boolean;
  closeDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  zIndex?: number;
  onEscape?: () => void;
  role?: "dialog" | "alertdialog";
  panelRef?: RefObject<HTMLElement | null>;
  panelProps?: Omit<ComponentProps<"div">, "ref" | "className"> & {
    "data-read-only"?: string | undefined;
  };
}) {
  const clientReady = useClientReadiness();
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) setRendered(true);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = returnFocus.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open]);
  // Keep the portal through its exit animation, then release its DOM and scroll lock.
  if (!open && !rendered) return null;
  return (
    <Modal
      // Ant's portal has no server container; URL-opened dialogs must hydrate before mounting it.
      open={open && clientReady}
      title={<span className="sr-only">{title}</span>}
      footer={null}
      closable={false}
      centered
      width="fit-content"
      zIndex={inactive ? zIndex - 1 : zIndex}
      keyboard={!inactive && !closeDisabled && !onEscape}
      mask={inactive ? false : { closable: !closeDisabled }}
      destroyOnHidden
      style={{ maxWidth: "calc(100% - 24px)", padding: 0 }}
      classNames={{ wrapper: cn(backdropClassName, inactive && "pointer-events-none") }}
      styles={{
        header: { margin: 0, padding: 0, height: 0 },
        container: { padding: 0, overflow: "hidden" },
        body: { minWidth: 0 },
      }}
      afterOpenChange={(visible) => {
        if (visible) initialFocusRef?.current?.focus();
        else if (!open) setRendered(false);
      }}
      onCancel={() => {
        if (!inactive && !closeDisabled) onClose();
      }}
      modalRender={(content) => (
        <div inert={inactive} aria-hidden={inactive || undefined}>
          {content}
        </div>
      )}
    >
      <div
        {...panelProps}
        // Large content must fit the modal's actual width, including reserved scrollbar space.
        style={{ ...panelProps?.style, maxWidth: "100%" }}
        ref={(element) => {
          // Ant Modal exposes one dialog element; preserve urgent confirmation semantics on it.
          element?.closest(".ant-modal")?.setAttribute("role", role);
          if (panelRef) panelRef.current = element;
        }}
        onKeyDownCapture={(event) => {
          if (!inactive && !closeDisabled && event.key === "Escape" && onEscape) {
            event.preventDefault();
            event.stopPropagation();
            onEscape();
            return;
          }
          if (inactive || event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]',
            ),
          ).filter(
            (element) =>
              element.tabIndex >= 0 &&
              element.getClientRects().length > 0 &&
              !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
              getComputedStyle(element).visibility !== "hidden",
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (
            first &&
            last &&
            ((event.shiftKey && document.activeElement === first) ||
              (!event.shiftKey && document.activeElement === last))
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        }}
        className={cn(
          "relative flex max-h-[calc(100dvh-3rem)] w-[min(640px,calc(100vw-3rem))] max-w-[calc(100vw-3rem)] min-w-0 flex-col overflow-hidden bg-card text-card-foreground [&>section]:contents",
          className,
        )}
      >
        {children}
      </div>
    </Modal>
  );
}
