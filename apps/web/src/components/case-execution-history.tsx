"use client";
import { Notice } from "@/components/ui/notice";

import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { CaseExecutionHistoryAttempt, CaseExecutionHistoryPage } from "@autoforge/application";
import { ListRestart } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AttemptLogViewer } from "@/components/attempt-log-viewer";
import { Button } from "@/components/ui";
import {
  caseExecutionResultLabel,
  caseExecutionStatusLabel,
} from "@/lib/case-execution-presentation";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { formatAttemptDuration } from "@/lib/run-batch-presentation";

function formatDate(value: string, timeZone: string): string {
  return formatPlatformDateTime(value, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function CaseExecutionHistory({
  caseDefinitionId,
  initialPage,
  canReadLogs,
  canCreateRuns,
  timeZone,
  historyUrl,
  compact = false,
}: {
  caseDefinitionId: string;
  initialPage: CaseExecutionHistoryPage;
  canReadLogs: boolean;
  canCreateRuns: boolean;
  timeZone: string;
  historyUrl?: string;
  compact?: boolean;
}) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [logAttempt, setLogAttempt] = useState<CaseExecutionHistoryAttempt>();

  async function loadMore(): Promise<void> {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError("");
    try {
      const url = new URL(
        historyUrl ?? `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/executions`,
        window.location.origin,
      );
      url.searchParams.set("cursor", nextCursor);
      url.searchParams.set("limit", "50");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "读取执行历史失败。"))!);
      }
      const page = (await response.json()) as CaseExecutionHistoryPage;
      setItems((current) => {
        const knownRunIds = new Set(current.map((item) => item.runId));
        return [...current, ...page.items.filter((item) => !knownRunIds.has(item.runId))];
      });
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取执行历史失败。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Card
        as="section"
        className={cn(
          "card table-card case-execution-history",
          compact && "is-compact",
          uiPatterns["card"],
          caseExecutionHistoryStyles["table-card"],
          caseExecutionHistoryStyles["case-execution-history"],
        )}
      >
        <div className={cn("card-heading", uiPatterns["card-heading"])}>
          <div>
            {!compact ? (
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Execution history</span>
            ) : null}
            <h2>全部执行历史</h2>
            <p>
              {compact ? (
                `已加载 ${items.length} 条执行记录 · 每个任务展示总结结果`
              ) : (
                <>
                  每个任务仅展示总结结果：任一轮通过则记录通过轮次，否则记录最后一轮；已加载{" "}
                  {items.length} 条执行记录。
                </>
              )}
            </p>
          </div>
          <ListRestart size={22} aria-hidden="true" />
        </div>
        <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
          <Table className={cn("data-table", uiPatterns["data-table"])}>
            <TableHeader>
              <TableRow>
                <TableHead>执行时间</TableHead>
                <TableHead>任务批次</TableHead>
                <TableHead>用例状态</TableHead>
                <TableHead>轮次 / 结果</TableHead>
                <TableHead>Runner</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>当前用例尚无执行记录。</TableCell>
                </TableRow>
              ) : null}
              {items.flatMap((item) => {
                if (item.attempts.length === 0) {
                  return (
                    <TableRow key={item.runId}>
                      <TableCell>{formatDate(item.createdAt, timeZone)}</TableCell>
                      <TableCell>
                        <strong>#{item.batchSequenceNumber}</strong>
                        <span
                          className={cn(
                            "case-history-batch-name",
                            caseExecutionHistoryStyles["case-history-batch-name"],
                          )}
                        >
                          {item.batchName}
                        </span>
                      </TableCell>
                      <TableCell>{caseExecutionStatusLabel(item.status)}</TableCell>
                      <TableCell>尚未生成执行尝试</TableCell>
                      <TableCell>—</TableCell>
                      <TableCell>—</TableCell>
                      <TableCell>
                        <Link href={`/run-batches/${encodeURIComponent(item.batchId)}`}>
                          查看批次
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                }
                return item.attempts.map((attempt) => (
                  <TableRow key={attempt.id}>
                    <TableCell>
                      {formatDate(attempt.finishedAt ?? attempt.createdAt, timeZone)}
                    </TableCell>
                    <TableCell>
                      <strong>#{item.batchSequenceNumber}</strong>
                      <span
                        className={cn(
                          "case-history-batch-name",
                          caseExecutionHistoryStyles["case-history-batch-name"],
                        )}
                      >
                        {item.batchName}
                      </span>
                    </TableCell>
                    <TableCell>{caseExecutionStatusLabel(item.status)}</TableCell>
                    <TableCell>
                      <strong>第 {attempt.executionRound} 轮总结</strong>
                      <span
                        className={cn(
                          "case-history-attempt-result",
                          caseExecutionHistoryStyles["case-history-attempt-result"],
                        )}
                      >
                        {attempt.executionRound === attempt.attemptNumber
                          ? ""
                          : `第 ${attempt.attemptNumber} 次尝试 · `}
                        {caseExecutionStatusLabel(attempt.status)} ·{" "}
                        {caseExecutionResultLabel(attempt.resultCode)}
                      </span>
                    </TableCell>
                    <TableCell title={attempt.runnerId}>
                      {attempt.runnerName ?? attempt.runnerId.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      {attempt.durationMs === undefined
                        ? "—"
                        : formatAttemptDuration(attempt.durationMs)}
                    </TableCell>
                    <TableCell>
                      <div
                        className={cn(
                          "case-history-actions",
                          caseExecutionHistoryStyles["case-history-actions"],
                        )}
                      >
                        {canReadLogs ? (
                          <Button
                            aria-label={`查看第 ${attempt.executionRound} 轮总结日志`}
                            className={cn(
                              "button button-secondary compact-button",
                              uiPatterns["button"],
                              uiPatterns["button-secondary"],
                              uiPatterns["compact-button"],
                            )}
                            onClick={() => setLogAttempt(attempt)}
                            type="button"
                          >
                            查看日志
                          </Button>
                        ) : null}
                        <Link href={`/run-batches/${encodeURIComponent(item.batchId)}`}>
                          查看批次
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                ));
              })}
            </TableBody>
          </Table>
        </div>
        {error ? (
          <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
            {error}
          </Notice>
        ) : null}
        {nextCursor ? (
          <div
            className={cn(
              "case-history-load-more",
              caseExecutionHistoryStyles["case-history-load-more"],
            )}
          >
            <Button
              className={cn(
                "button button-secondary",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
              )}
              disabled={loading}
              onClick={() => void loadMore()}
              type="button"
            >
              {loading ? "正在加载..." : "加载更早的执行历史"}
            </Button>
          </div>
        ) : items.length > 0 ? (
          <p
            className={cn(
              "case-history-complete",
              caseExecutionHistoryStyles["case-history-complete"],
            )}
          >
            已显示该用例的全部执行历史。
          </p>
        ) : null}
      </Card>

      {logAttempt ? (
        <AttemptLogViewer
          attemptId={logAttempt.id}
          attemptStatus={logAttempt.status}
          canReadLogs={canReadLogs}
          canCreateRuns={canCreateRuns}
          onClose={() => setLogAttempt(undefined)}
        />
      ) : null}
    </>
  );
}

const caseExecutionHistoryStyles = {
  "case-execution-history":
    "[&_.card-heading_p]:[margin:4px_0_0] [&_.card-heading_p]:text-muted-foreground [&.is-compact_.ui-card-content_>_.card-heading]:min-h-0 [&.is-compact_.ui-card-content_>_.card-heading]:py-2 [&.is-compact_.card-heading_p]:text-xs",
  "case-history-actions": "flex items-center gap-2.5 whitespace-nowrap",
  "case-history-attempt-result": "block mt-[3px] text-muted-foreground text-xs",
  "case-history-batch-name": "block mt-[3px] text-muted-foreground text-xs",
  "case-history-complete": "m-0 [padding:14px_16px_18px] text-muted-foreground text-center",
  "case-history-load-more": "flex justify-center [padding:14px_16px_18px]",
  "table-card":
    "overflow-hidden [&_.ui-card-content_>_.card-heading]:min-h-17 [&_.ui-card-content_>_.card-heading]:items-center [&_.ui-card-content_>_.card-heading]:border-b [&_.ui-card-content_>_.card-heading]:border-solid [&_.ui-card-content_>_.card-heading]:border-border [&_.ui-card-content_>_.card-heading]:py-3.5 [&_.ui-card-content_>_.card-heading]:px-4.5",
} as const;
