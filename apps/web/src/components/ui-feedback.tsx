"use client";

import { AlertTriangle, CheckCircle2, CircleAlert, Info, X } from "lucide-react";
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

type ToastItem = ToastOptions & {
  id: number;
  message: string;
  tone: ToastTone;
};

export type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
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
  const nextToastId = useRef(1);
  const dialogRequestRef = useRef<DialogRequest | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialogRequest, setDialogRequest] = useState<DialogRequest | null>(null);
  const [promptValue, setPromptValue] = useState("");

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const dismissAllToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (tone: ToastTone, message: string, options: ToastOptions = {}) => {
      const id = nextToastId.current++;
      const item: ToastItem = { id, tone, message, ...options };
      setToasts([item]);
      const durationMs = options.durationMs ?? (tone === "error" ? 7_000 : 4_500);
      window.setTimeout(() => dismissToast(id), durationMs);
    },
    [dismissToast],
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
      confirm: (options) =>
        new Promise<boolean>((resolve) => openDialog({ kind: "confirm", options, resolve })),
      prompt: (options) =>
        new Promise<string | null>((resolve) => openDialog({ kind: "prompt", options, resolve })),
    }),
    [dismissAllToasts, openDialog, showToast],
  );

  const options = dialogRequest?.options;
  const promptRequired =
    dialogRequest?.kind === "prompt" && dialogRequest.options.required !== false;
  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div aria-label="操作通知" className="toast-viewport">
        {toasts.map((item) => (
          <ToastCard item={item} key={item.id} onDismiss={() => dismissToast(item.id)} />
        ))}
      </div>
      <ActionDialog
        className={`confirmation-dialog${options?.tone === "danger" ? " confirmation-dialog-danger" : ""}`}
        onClose={() => closeDialog(dialogRequest?.kind === "confirm" ? false : null)}
        open={dialogRequest !== null}
        title={options?.title ?? "确认操作"}
        {...(options?.description ? { description: options.description } : {})}
      >
        {dialogRequest?.kind === "prompt" ? (
          <label className="confirmation-dialog-field">
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
        <div className="action-dialog-actions">
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

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon =
    item.tone === "success"
      ? CheckCircle2
      : item.tone === "error"
        ? CircleAlert
        : item.tone === "warning"
          ? AlertTriangle
          : Info;
  const title =
    item.title ??
    ({ success: "操作成功", error: "操作失败", warning: "请注意", info: "操作提示" } as const)[
      item.tone
    ];
  return (
    <article
      aria-atomic="true"
      className={`toast-card toast-${item.tone}`}
      role={item.tone === "error" ? "alert" : "status"}
    >
      <span className="toast-icon" aria-hidden="true">
        <Icon size={19} />
      </span>
      <span className="toast-copy">
        <strong>{title}</strong>
        <span>{item.message}</span>
      </span>
      <Button aria-label="关闭通知" className="toast-dismiss" onClick={onDismiss} type="button">
        <X size={15} />
      </Button>
    </article>
  );
}
