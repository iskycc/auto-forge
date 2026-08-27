"use client";

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
}: {
  caseDefinitionId: string;
  initialPage: CaseExecutionHistoryPage;
  canReadLogs: boolean;
  canCreateRuns: boolean;
  timeZone: string;
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
      const parameters = new URLSearchParams({ cursor: nextCursor, limit: "50" });
      const response = await fetch(
        `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/executions?${parameters}`,
        { cache: "no-store" },
      );
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
      <section className="card table-card case-execution-history">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Execution history</span>
            <h2>全部执行历史</h2>
            <p>按执行时间倒序展示；已加载 {items.length} 条执行记录及其全部执行尝试。</p>
          </div>
          <ListRestart size={22} aria-hidden="true" />
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>执行时间</th>
                <th>任务批次</th>
                <th>用例状态</th>
                <th>轮次 / 结果</th>
                <th>Runner</th>
                <th>耗时</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7}>当前用例尚无执行记录。</td>
                </tr>
              ) : null}
              {items.flatMap((item) => {
                if (item.attempts.length === 0) {
                  return (
                    <tr key={item.runId}>
                      <td>{formatDate(item.createdAt, timeZone)}</td>
                      <td>
                        <strong>#{item.batchSequenceNumber}</strong>
                        <span className="case-history-batch-name">{item.batchName}</span>
                      </td>
                      <td>{caseExecutionStatusLabel(item.status)}</td>
                      <td>尚未生成执行尝试</td>
                      <td>—</td>
                      <td>—</td>
                      <td>
                        <Link href={`/run-batches/${encodeURIComponent(item.batchId)}`}>
                          查看批次
                        </Link>
                      </td>
                    </tr>
                  );
                }
                return item.attempts.map((attempt, attemptIndex) => (
                  <tr key={attempt.id}>
                    <td>{formatDate(attempt.finishedAt ?? attempt.createdAt, timeZone)}</td>
                    <td>
                      <strong>#{item.batchSequenceNumber}</strong>
                      <span className="case-history-batch-name">{item.batchName}</span>
                    </td>
                    <td>{caseExecutionStatusLabel(item.status)}</td>
                    <td>
                      <strong>第 {attempt.attemptNumber} 次尝试</strong>
                      <span className="case-history-attempt-result" title={attempt.resultCode}>
                        {caseExecutionStatusLabel(attempt.status)} ·{" "}
                        {caseExecutionResultLabel(attempt.resultCode)}
                      </span>
                    </td>
                    <td title={attempt.runnerId}>
                      {attempt.runnerName ?? attempt.runnerId.slice(0, 8)}
                    </td>
                    <td>
                      {attempt.durationMs === undefined
                        ? "—"
                        : formatAttemptDuration(attempt.durationMs)}
                    </td>
                    <td>
                      <div className="case-history-actions">
                        {canReadLogs ? (
                          <Button
                            aria-label={`查看第 ${attempt.attemptNumber} 次尝试日志`}
                            className="button button-secondary compact-button"
                            onClick={() => setLogAttempt(attempt)}
                            type="button"
                          >
                            查看日志
                          </Button>
                        ) : null}
                        {attemptIndex === 0 ? (
                          <Link href={`/run-batches/${encodeURIComponent(item.batchId)}`}>
                            查看批次
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        {nextCursor ? (
          <div className="case-history-load-more">
            <Button
              className="button button-secondary"
              disabled={loading}
              onClick={() => void loadMore()}
              type="button"
            >
              {loading ? "正在加载..." : "加载更早的执行历史"}
            </Button>
          </div>
        ) : items.length > 0 ? (
          <p className="case-history-complete">已显示该用例的全部执行历史。</p>
        ) : null}
      </section>

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
