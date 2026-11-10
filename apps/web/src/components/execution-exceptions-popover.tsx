"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import { Popover } from "antd";
import { executionExceptionPageSchema, type ExecutionExceptionPage } from "@autoforge/contracts";
import { Button } from "@/components/ui";
import { Notice } from "@/components/ui/notice";
import { LoadingStateMessage } from "@/components/ui/loading-state-message";
import { ExecutionExceptionsDialog } from "@/components/execution-exceptions-dialog";
import { readApiErrorMessage } from "@/lib/client-api";
import { executionExceptionReasonLabel } from "@/lib/execution-exceptions-presentation";

export function ExecutionExceptionsPopover({
  batchId,
  children,
}: {
  batchId: string;
  children: ReactElement;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [result, setResult] = useState<ExecutionExceptionPage | null>(null);
  const [error, setError] = useState("");
  const [requestVersion, setRequestVersion] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    function trackFocus(event?: FocusEvent) {
      // A retry can replace a focused button without firing blur. Reconcile focus
      // after content changes, and include the popup's separate DOM container.
      const target = event?.type === "focusout" ? event.relatedTarget : document.activeElement;
      setFocused(
        target instanceof Node &&
          !!(triggerRef.current?.contains(target) || contentRef.current?.contains(target)),
      );
    }
    trackFocus();
    document.addEventListener("focusin", trackFocus);
    document.addEventListener("focusout", trackFocus);
    return () => {
      document.removeEventListener("focusin", trackFocus);
      document.removeEventListener("focusout", trackFocus);
    };
  }, [open, result, error]);

  useEffect(() => {
    if (requestVersion === null) return;
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(15_000);
    async function load() {
      setError("");
      setResult(null);
      try {
        const response = await fetch(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}/exceptions?scope=terminal&limit=3`,
          { cache: "no-store", signal: AbortSignal.any([controller.signal, timeout]) },
        );
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, "读取异常原因失败，请重试。"));
        const parsed = executionExceptionPageSchema.parse(await response.json());
        if (!controller.signal.aborted) setResult(parsed);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            timeout.aborted
              ? "读取异常原因超时，请重试。"
              : cause instanceof Error
                ? cause.message
                : "读取异常原因失败，请重试。",
          );
      }
    }
    void load();
    // Opening is lazy, but once accepted a small bounded read survives popup
    // visibility changes. Only a new explicit request or unmount cancels it.
    return () => controller.abort();
  }, [batchId, requestVersion]);

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-flex"
        onFocusCapture={() => {
          setFocused(true);
          setRequestVersion((version) => version ?? 0);
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape" || !open || dialogOpen) return;
          event.preventDefault();
          event.stopPropagation();
          triggerRef.current?.querySelector<HTMLElement>("[tabindex]")?.focus();
          setHovered(false);
          setFocused(false);
        }}
      >
        <Popover
          title="执行异常原因"
          trigger="hover"
          placement="rightTop"
          open={open && !dialogOpen}
          onOpenChange={(next) => {
            setHovered(next);
            if (next) setRequestVersion((version) => version ?? 0);
          }}
          content={
            <div
              ref={contentRef}
              className="grid max-h-[min(520px,calc(100vh-112px))] w-[340px] max-w-[calc(100vw-64px)] gap-3 overflow-y-auto text-sm"
            >
              {error ? (
                <Notice role="alert" tone="error">
                  {error}
                  <Button
                    type="button"
                    size="compact"
                    onClick={() => setRequestVersion((version) => (version ?? 0) + 1)}
                  >
                    重试
                  </Button>
                </Notice>
              ) : !result ? (
                <LoadingStateMessage>正在读取异常原因…</LoadingStateMessage>
              ) : (
                <>
                  <span className="text-muted-foreground">
                    {result.consistent
                      ? `${result.abnormalRuns} 个用例非正常结束`
                      : "状态与用例终态不一致，请查看完整诊断。"}
                  </span>
                  {result.items.length === 0 ? (
                    <Notice tone="info">暂无可展示的终态原因，历史记录可能已清理。</Notice>
                  ) : (
                    <ul className="m-0 grid list-none gap-3 p-0">
                      {result.items.map((item) => (
                        <li key={item.id} className="grid min-w-0 gap-1">
                          <strong className="break-words">
                            第 {item.round} 轮{item.kind === "recovery" ? "后恢复" : ""}
                            {item.attemptNumber ? ` · 尝试 ${item.attemptNumber}` : ""}
                            {` · ${executionExceptionReasonLabel(item.resultCode)}`}
                          </strong>
                          <span className="line-clamp-2 break-words">
                            {item.caseName ?? "轮次环境恢复"}
                          </span>
                          <code className="break-all text-xs text-muted-foreground">
                            {item.resultCode}
                          </code>
                          <p className="m-0 line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">
                            {item.summary}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                  {result.nextCursor ? (
                    <span className="text-xs text-muted-foreground">仅展示前 3 条终态原因。</span>
                  ) : null}
                </>
              )}
              <Button
                type="button"
                size="compact"
                onClick={() => {
                  setHovered(false);
                  setFocused(false);
                  setDialogOpen(true);
                }}
              >
                查看全部异常原因
              </Button>
            </div>
          }
        >
          {/* Keep Ant's trigger ref and pointer events on a native element. */}
          <span className="inline-flex">{children}</span>
        </Popover>
      </span>
      {dialogOpen ? (
        <ExecutionExceptionsDialog batchId={batchId} onClose={() => setDialogOpen(false)} />
      ) : null}
    </>
  );
}
