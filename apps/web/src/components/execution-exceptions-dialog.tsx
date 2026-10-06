"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { executionExceptionPageSchema, type ExecutionExceptionPage } from "@autoforge/contracts";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui";
import { Notice } from "@/components/ui/notice";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/loading-state";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { uiPatterns } from "@/components/ui/patterns";
import { cn } from "@/lib/utils";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatLocalDateTime, runBatchStatusLabel } from "@/lib/run-batch-presentation";
import { executionExceptionReasonLabel } from "@/lib/execution-exceptions-presentation";

export function ExecutionExceptionsDialog({
  batchId,
  accessToken,
  onClose,
}: {
  batchId: string;
  accessToken?: string | undefined;
  onClose: () => void;
}) {
  const [result, setResult] = useState<ExecutionExceptionPage | null>(null);
  const [error, setError] = useState("");
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const cursor = cursors[page];
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setResult(null);
      setError("");
      try {
        const parameters = new URLSearchParams({ limit: "50" });
        if (cursor) parameters.set("cursor", cursor);
        if (accessToken) parameters.set("access_token", accessToken);
        const response = await fetch(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}/exceptions?${parameters}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, "读取异常原因失败，请重试。"));
        const parsed = executionExceptionPageSchema.parse(await response.json());
        if (!controller.signal.aborted) setResult(parsed);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取异常原因失败，请重试。");
      }
    };
    void load();
    return () => controller.abort();
  }, [batchId, accessToken, cursor, retry]);

  function nextPage() {
    if (!result?.nextCursor) return;
    setCursors((current) => [...current.slice(0, page + 1), result.nextCursor]);
    setPage((current) => current + 1);
  }
  return (
    <Dialog
      open
      title="执行异常原因"
      onClose={onClose}
      className="grid w-[min(1180px,_calc(100vw_-_64px))] max-h-[86vh] grid-rows-[auto_minmax(0,_1fr)_auto] overflow-hidden rounded-xl border border-solid border-border bg-card shadow-lg"
    >
      <header className="flex items-center justify-between gap-3 border-b border-solid border-border px-5 py-4">
        <strong className="inline-flex items-center gap-2">
          <AlertTriangle size={18} />
          执行异常原因
        </strong>
        <Button type="button" aria-label="关闭" onClick={onClose}>
          <X size={16} />
        </Button>
      </header>
      <div className="grid min-h-0 gap-4 overflow-auto p-5">
        <p className="m-0 text-sm text-muted-foreground">
          排队超时、轮次恢复失败可能没有本次执行日志；同轮次的较早异常也可能已被后续重试恢复。
        </p>
        {error ? (
          <Notice tone="error" role="alert">
            {error}
            <Button type="button" onClick={() => setRetry((current) => current + 1)}>
              <RefreshCw size={15} />
              重试
            </Button>
          </Notice>
        ) : !result ? (
          <LoadingState label="正在读取异常原因…" />
        ) : (
          <>
            <Notice tone={result.consistent ? "info" : "error"} role="status">
              {result.consistent
                ? `判定核对一致：${result.abnormalRuns} 个用例非正常结束。`
                : `状态记录与用例终态不一致：当前为“${runBatchStatusLabel(result.status)}”，按终态应为“${runBatchStatusLabel(result.expectedStatus)}”。`}
              普通断言失败、配置失败和跳过不属于执行异常。
            </Notice>
            {result.items.length === 0 ? (
              <EmptyState>
                没有找到可展示的异常记录。历史记录可能已清理，请结合平台诊断检查。
              </EmptyState>
            ) : (
              <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
                <Table
                  className={cn(
                    uiPatterns["data-table"],
                    "min-w-[880px] table-fixed [&_td]:align-top [&_td_time]:whitespace-normal",
                  )}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[12%]">轮次 / 尝试</TableHead>
                      <TableHead className="w-[20%]">用例</TableHead>
                      <TableHead className="w-[22%]">异常类型与原因</TableHead>
                      <TableHead className="w-[22%]">说明</TableHead>
                      <TableHead className="w-[10%]">判定影响</TableHead>
                      <TableHead className="w-[14%]">发生时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          第 {item.round} 轮{item.kind === "recovery" ? "后恢复" : ""}
                          {item.attemptNumber ? (
                            <small className="block text-muted-foreground">
                              尝试 {item.attemptNumber}
                            </small>
                          ) : null}
                        </TableCell>
                        <TableCell className="break-words">
                          <strong>{item.caseName ?? "轮次环境恢复"}</strong>
                          {item.className ? (
                            <small className="block break-all text-muted-foreground">
                              {item.className}
                            </small>
                          ) : null}
                        </TableCell>
                        <TableCell className="break-words">
                          {executionExceptionReasonLabel(item.resultCode)}
                          <code className="block break-all text-xs text-muted-foreground">
                            {item.resultCode}
                          </code>
                        </TableCell>
                        <TableCell className="whitespace-pre-wrap break-words">
                          {item.summary}
                        </TableCell>
                        <TableCell>{item.affectsBatchStatus ? "终态原因" : "历史异常"}</TableCell>
                        <TableCell>
                          <time className="block" title={`UTC ${item.occurredAt}`}>
                            {formatLocalDateTime(item.occurredAt)}
                          </time>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-solid border-border px-5 py-3">
        <span className="text-sm text-muted-foreground">第 {page + 1} 页 · 每页最多 50 条</span>
        <div className="inline-flex gap-2">
          <Button
            type="button"
            disabled={!result || page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            <ChevronLeft size={16} />
            上一页
          </Button>
          <Button type="button" disabled={!result?.nextCursor} onClick={nextPage}>
            下一页
            <ChevronRight size={16} />
          </Button>
        </div>
      </footer>
    </Dialog>
  );
}
