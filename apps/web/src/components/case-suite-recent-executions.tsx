"use client";

import {
  caseSuiteRecentExecutionsSchema,
  type CaseSuiteRecentExecution,
  type CaseSuiteRecentExecutions as ExecutionPage,
} from "@autoforge/contracts";
import { ArrowRight, History, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui";
import { ApiClientError, readApiError } from "@/lib/client-api";
import {
  formatBatchDuration,
  formatLocalDateTime,
  isActiveRunBatch,
  runBatchCompletionLabel,
  runBatchPassRate,
} from "@/lib/run-batch-presentation";

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | ({ status: "ready" } & ExecutionPage);

export function CaseSuiteRecentExecutions({
  suiteId,
  projectId,
  projectVersionId,
  view = "recent",
}: {
  suiteId: string;
  projectId: string;
  projectVersionId: string;
  view?: "recent" | "history";
}) {
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = pageCursors.at(-1);
  const query = new URLSearchParams({ projectId, projectVersionId, suiteId });

  useEffect(() => {
    const controller = new AbortController();
    const scope = new URLSearchParams({ projectId, projectVersionId });
    if (cursor) scope.set("cursor", cursor);
    async function load(): Promise<void> {
      try {
        const response = await fetch(
          `/api/v1/case-suites/${encodeURIComponent(suiteId)}/executions?${scope}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const failure = await readApiError(response, "最近执行记录加载失败，请重试。");
        if (failure) throw failure;
        const result = caseSuiteRecentExecutionsSchema.parse(await response.json());
        if (!controller.signal.aborted) setState({ status: "ready", ...result });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            status: "error",
            message:
              error instanceof ApiClientError
                ? error.message
                : navigator.onLine
                  ? "最近执行记录加载失败，请重试。"
                  : "当前网络已离线，恢复连接后请重试。",
          });
      }
    }
    void load();
    return () => controller.abort();
  }, [suiteId, projectId, projectVersionId, refreshSequence, cursor]);

  function refresh(): void {
    setState({ status: "loading" });
    setPageCursors([undefined]);
    setRefreshSequence((current) => current + 1);
  }

  return (
    <section
      className="suite-recent-executions"
      aria-label={view === "history" ? "任务执行历史" : "最近执行记录"}
      aria-busy={state.status === "loading"}
    >
      <header>
        <strong>{view === "history" ? "执行历史" : "最近 10 次执行"}</strong>
        <span>
          <Button
            aria-label="刷新最近执行"
            disabled={state.status === "loading"}
            onClick={refresh}
            type="button"
            variant="ghost"
          >
            <RefreshCw size={14} />
          </Button>
          <Link href={`/execution-records?${query}`}>
            全部记录 <ArrowRight size={13} />
          </Link>
        </span>
      </header>
      {state.status === "loading" ? (
        <p className="suite-history-feedback" role="status">
          <LoaderCircle className="spin" size={17} /> 正在加载执行记录…
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="suite-history-feedback" role="alert">
          <span>{state.message}</span>
          <Button onClick={refresh} type="button">
            重试
          </Button>
        </div>
      ) : null}
      {state.status === "ready" && state.items.length === 0 ? (
        <p className="suite-history-feedback">
          <History size={18} /> 暂无执行记录，开始执行任务后将在这里展示。
        </p>
      ) : null}
      {state.status === "ready" && state.items.length > 0 ? (
        <ol className="suite-history-list">
          {state.items.map((batch) => (
            <RecentExecution key={batch.id} batch={batch} />
          ))}
        </ol>
      ) : null}
      {view === "history" ? (
        <footer className="suite-history-pagination" aria-label="执行历史分页">
          <span>第 {pageCursors.length} 页 · 每页最多 10 条</span>
          <Button
            disabled={state.status === "loading" || pageCursors.length === 1}
            onClick={() => {
              setState({ status: "loading" });
              setPageCursors((current) => current.slice(0, -1));
            }}
            type="button"
          >
            上一页
          </Button>
          <Button
            disabled={state.status !== "ready" || !state.nextCursor}
            onClick={() => {
              if (state.status !== "ready" || !state.nextCursor) return;
              setPageCursors((current) => [...current, state.nextCursor]);
              setState({ status: "loading" });
            }}
            type="button"
          >
            下一页
          </Button>
        </footer>
      ) : null}
    </section>
  );
}

function RecentExecution({ batch }: { batch: CaseSuiteRecentExecution }) {
  const active = isActiveRunBatch(batch.status);
  const statusTone = active
    ? "info"
    : batch.status === "succeeded"
      ? "success"
      : batch.status === "failed"
        ? "danger"
        : "warning";
  const durationMs = Math.max(0, Date.parse(batch.updatedAt) - Date.parse(batch.createdAt));
  const counts = `通过 ${batch.succeededRuns} / ${batch.totalRuns} · 失败 ${batch.failedRuns} · 超时 ${batch.timedOutRuns} · 取消 ${batch.cancelledRuns}`;
  return (
    <li>
      <Link
        className="suite-history-record"
        href={`/run-batches/${encodeURIComponent(batch.id)}`}
        aria-label={`查看执行记录 #${batch.sequenceNumber || batch.id}`}
      >
        <span className="suite-history-identity">
          <strong>#{batch.sequenceNumber || batch.id.slice(0, 8)}</strong>
          <span className={`status-badge ${statusTone}`}>
            {runBatchCompletionLabel({
              status: batch.status,
              ...(batch.terminationRequestedAt
                ? { terminationRequestedAt: batch.terminationRequestedAt }
                : {}),
            })}
          </span>
          {batch.kind === "final_failure_rerun" ? <small>失败重跑</small> : null}
          <ArrowRight size={15} />
        </span>
        <span className="suite-history-result" title={counts}>
          <span>
            通过 <strong>{batch.succeededRuns.toLocaleString("zh-CN")}</strong> /{" "}
            {batch.totalRuns.toLocaleString("zh-CN")}
          </span>
          <span>
            {active ? "当前通过率" : "通过率"}{" "}
            <strong>{batch.totalRuns === 0 ? "—" : `${runBatchPassRate(batch)}%`}</strong>
          </span>
          <span>
            第 {batch.currentRound} / {batch.retryLimit + 1} 轮
          </span>
        </span>
        <span className="suite-history-metadata">
          <time dateTime={batch.createdAt} title={`创建时间（UTC）：${batch.createdAt}`}>
            {formatLocalDateTime(batch.createdAt)}
          </time>
          <span>{active ? "执行尚未结束" : `总耗时 ${formatBatchDuration(durationMs)}`}</span>
          {batch.requestedBy ? (
            <span title={batch.requestedBy}>发起人 {batch.requestedBy}</span>
          ) : null}
          {Date.parse(batch.scheduledFor) > Date.parse(batch.createdAt) ? (
            <span title={batch.scheduledFor}>计划 {formatLocalDateTime(batch.scheduledFor)}</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}
