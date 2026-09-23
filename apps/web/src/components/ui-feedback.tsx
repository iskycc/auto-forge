"use client";
import { cn } from "@/lib/utils";

import { notification } from "antd";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ActionDialog } from "./action-dialog";
import { Button, Input, Textarea } from "./ui";

export type ToastTone = "success" | "error" | "warning" | "info";

type ToastOptions = {
  title?: string;
  durationMs?: number;
};

export type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger" | "warning";
};

export type PromptOptions = ConfirmOptions & {
  inputLabel: string;
  initialValue?: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
};

type DialogRequest =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (accepted: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

type ToastApi = Record<ToastTone, (message: string, options?: ToastOptions) => void> & {
  dismissAll: () => void;
};

type FeedbackContextValue = {
  toast: ToastApi;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
};

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function UiFeedbackProvider({ children }: { children: ReactNode }) {
  // Ant Design derives its API identity from this configuration. Keep it stable
  // when a confirmation opens so consumers do not restart in-flight reads.
  const notificationConfig = useMemo<Parameters<typeof notification.useNotification>[0]>(
    () => ({
      placement: "topRight",
      top: 80,
      maxCount: 1,
      pauseOnHover: false,
      classNames: { list: "toast-viewport", root: "toast-card" },
      styles: { list: { zIndex: 2000 }, close: { width: 32, height: 32 } },
    }),
    [],
  );
  const [notifications, notificationHolder] = notification.useNotification(notificationConfig);
  const notificationSequence = useRef(0);
  const dialogRequestRef = useRef<DialogRequest | null>(null);
  const [dialogRequest, setDialogRequest] = useState<DialogRequest | null>(null);
  const [promptValue, setPromptValue] = useState("");

  const dismissAllToasts = useCallback(() => notifications.destroy(), [notifications]);
  const showToast = useCallback(
    (tone: ToastTone, message: string, options: ToastOptions = {}) => {
      notifications[tone]({
        // A replaced notice with the same key retains Ant Design's elapsed timer.
        // Each completed operation needs its own full reading time; maxCount
        // still keeps only the latest banner visible.
        key: `operation-feedback-${++notificationSequence.current}`,
        title:
          options.title ??
          { success: "操作成功", error: "操作失败", warning: "请注意", info: "操作提示" }[tone],
        description: message,
        duration: (options.durationMs ?? (tone === "error" ? 7000 : 4500)) / 1000,
        role: tone === "error" ? "alert" : "status",
        closable: { "aria-label": "关闭通知" },
      });
    },
    [notifications],
  );

  const closeDialog = useCallback((value: boolean | string | null) => {
    const current = dialogRequestRef.current;
    if (!current) return;
    dialogRequestRef.current = null;
    setDialogRequest(null);
    if (current.kind === "confirm") current.resolve(value === true);
    else current.resolve(typeof value === "string" ? value : null);
  }, []);

  const openDialog = useCallback((request: DialogRequest) => {
    const previous = dialogRequestRef.current;
    if (previous?.kind === "confirm") previous.resolve(false);
    if (previous?.kind === "prompt") previous.resolve(null);
    dialogRequestRef.current = request;
    setPromptValue(request.kind === "prompt" ? (request.options.initialValue ?? "") : "");
    setDialogRequest(request);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => openDialog({ kind: "confirm", options, resolve })),
    [openDialog],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => openDialog({ kind: "prompt", options, resolve })),
    [openDialog],
  );

  useEffect(
    () => () => {
      const current = dialogRequestRef.current;
      if (current?.kind === "confirm") current.resolve(false);
      if (current?.kind === "prompt") current.resolve(null);
    },
    [],
  );

  const value = useMemo<FeedbackContextValue>(
    () => ({
      toast: {
        success: (message, options) => showToast("success", message, options),
        error: (message, options) => showToast("error", message, options),
        warning: (message, options) => showToast("warning", message, options),
        info: (message, options) => showToast("info", message, options),
        dismissAll: dismissAllToasts,
      },
      confirm,
      prompt,
    }),
    [confirm, dismissAllToasts, prompt, showToast],
  );

  const options = dialogRequest?.options;
  const promptRequired =
    dialogRequest?.kind === "prompt" && dialogRequest.options.required !== false;
  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {notificationHolder}
      <ActionDialog
        className={cn(
          uiFeedbackStyles["confirmation-dialog"],
          "confirmation-dialog",
          options?.tone === "danger" &&
            cn("confirmation-dialog-danger", uiFeedbackStyles["confirmation-dialog-danger"]),
          options?.tone === "warning" &&
            cn("confirmation-dialog-warning", uiFeedbackStyles["confirmation-dialog-warning"]),
        )}
        onClose={() => closeDialog(dialogRequest?.kind === "confirm" ? false : null)}
        open={dialogRequest !== null}
        title={options?.title ?? "确认操作"}
        {...(options?.description ? { description: options.description } : {})}
      >
        {dialogRequest?.kind === "prompt" ? (
          <label
            className={cn(
              "confirmation-dialog-field",
              uiFeedbackStyles["confirmation-dialog-field"],
            )}
          >
            <span>{dialogRequest.options.inputLabel}</span>
            {dialogRequest.options.multiline ? (
              <Textarea
                autoFocus
                onChange={(event) => setPromptValue(event.target.value)}
                rows={4}
                value={promptValue}
                {...(dialogRequest.options.placeholder
                  ? { placeholder: dialogRequest.options.placeholder }
                  : {})}
              />
            ) : (
              <Input
                autoFocus
                onChange={(event) => setPromptValue(event.target.value)}
                value={promptValue}
                {...(dialogRequest.options.placeholder
                  ? { placeholder: dialogRequest.options.placeholder }
                  : {})}
              />
            )}
          </label>
        ) : null}
        <div className={cn("action-dialog-actions", uiFeedbackStyles["action-dialog-actions"])}>
          <Button onClick={() => closeDialog(dialogRequest?.kind === "confirm" ? false : null)}>
            {options?.cancelLabel ?? "取消"}
          </Button>
          <Button
            disabled={promptRequired && promptValue.trim().length === 0}
            onClick={() =>
              closeDialog(dialogRequest?.kind === "prompt" ? promptValue.trim() : true)
            }
            variant={options?.tone === "danger" ? "danger" : "primary"}
          >
            {options?.confirmLabel ?? "确认"}
          </Button>
        </div>
      </ActionDialog>
    </FeedbackContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useFeedbackContext().toast;
}

export function useConfirm(): FeedbackContextValue["confirm"] {
  return useFeedbackContext().confirm;
}

export function usePrompt(): FeedbackContextValue["prompt"] {
  return useFeedbackContext().prompt;
}

function useFeedbackContext(): FeedbackContextValue {
  const context = useContext(FeedbackContext);
  if (!context) throw new Error("UI feedback hooks require UiFeedbackProvider.");
  return context;
}

const uiFeedbackStyles = {
  "action-dialog-actions": "mt-4 flex justify-end gap-2 border-t border-border pt-4",
  "confirmation-dialog": "w-[min(540px,calc(100vw-3rem))]",
  "confirmation-dialog-danger": "[&_.action-dialog-header]:border-destructive/20",
  "confirmation-dialog-field": "grid gap-2 text-sm font-medium",
  "confirmation-dialog-warning": "[&_.action-dialog-header]:border-warning/20",
} as const;
