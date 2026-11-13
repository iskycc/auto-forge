"use client";

import type { ReactNode } from "react";
import { Card } from "./ui/card";
import { ExecutionActors } from "./execution-actors";
import { ExecutionEnvironmentAddresses } from "./execution-environment-addresses";
import { usePlatformNow } from "./platform-time";
import type { ExecutionBatchView } from "@/lib/execution-batch-view";
import {
  formatBatchDuration,
  formatLocalDateTime,
  isActiveRunBatch,
  isTerminalRunBatch,
  runBatchCompletionLabel,
  runBatchPassRate,
} from "@/lib/run-batch-presentation";

export function ExecutionBatchOverview({
  batch,
  children,
}: {
  batch: ExecutionBatchView;
  children: ReactNode;
}) {
  const awaitingScheduledStart =
    batch.status === "queued" && Date.parse(batch.scheduledFor) > Date.parse(batch.updatedAt);
  const pending = batch.statistics?.generation === null;
  return (
    <Card as="section" aria-label="批次概览" className="batch-overview overflow-hidden">
      <div className="batch-metrics-band grid min-w-0 grid-cols-4 divide-x divide-border">
        <Metric
          label="状态"
          value={awaitingScheduledStart ? "倒计时" : runBatchCompletionLabel(batch)}
        />
        <Metric
          label="用例总数"
          value={String(batch.totalRuns)}
          hint={pending ? "统计准备中" : `失败 ${batch.failedRuns} · 超时 ${batch.timedOutRuns}`}
        />
        <Metric
          label="总通过率"
          value={pending ? "—" : `${runBatchPassRate(batch)}%`}
          hint={
            pending
              ? "统计准备中"
              : `通过 ${batch.succeededRuns} · 终止 ${batch.finalSummary.cancelled}`
          }
        />
        <DurationMetric batch={batch} countdown={awaitingScheduledStart} />
      </div>
      <div className="grid min-w-0 gap-3 border-t border-border px-5 py-4">
        <dl className="m-0 grid min-w-0 grid-cols-3 gap-4 text-sm [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:mt-1 [&_dd]:[overflow-wrap:anywhere]">
          <div>
            <dt>开始时间</dt>
            <dd>
              <time title={`UTC ${batch.scheduledFor}`}>
                {formatLocalDateTime(batch.scheduledFor)}
              </time>
            </dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>
              {isTerminalRunBatch(batch.status) ? (
                <time title={`UTC ${batch.finishedAt}`}>
                  {formatLocalDateTime(batch.finishedAt)}
                </time>
              ) : (
                "尚未结束"
              )}
            </dd>
          </div>
          {batch.retryCompletionReason ? (
            <div className="col-span-full">
              <dt>完成原因</dt>
              <dd className="break-words">{batch.retryCompletionReason}</dd>
            </div>
          ) : null}
          <div>
            <dt>当前轮次</dt>
            <dd>
              {batch.retryMode === "round"
                ? `第 ${batch.currentRound} 轮 · ${batch.unlimitedRetries ? "无限重跑" : `重跑上限 ${batch.retryLimit} 次`}`
                : "立即重跑模式"}
            </dd>
          </div>
        </dl>
        {batch.environmentAddresses?.length ? (
          <section
            aria-label="本次执行环境"
            className="flex min-w-0 items-start gap-4 border-t border-border pt-3"
          >
            <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
              环境 IP · {batch.environmentAddresses.length} 个
            </span>
            <ExecutionEnvironmentAddresses addresses={batch.environmentAddresses} />
          </section>
        ) : null}
        <ExecutionActors
          compact
          {...(batch.publicExecution ? { publicExecution: batch.publicExecution } : {})}
          {...(batch.terminatedBy ? { terminatedBy: batch.terminatedBy } : {})}
        />
      </div>
      {children}
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="batch-metric flex min-w-0 flex-col gap-2 px-5 py-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="text-xl font-semibold tabular-nums [overflow-wrap:anywhere]">
        {value}
      </strong>
      {hint ? <small className="text-xs leading-5 text-muted-foreground">{hint}</small> : null}
    </div>
  );
}

// Isolate the clock so result tables and charts do not rerender every second.
function DurationMetric({ batch, countdown }: { batch: ExecutionBatchView; countdown: boolean }) {
  const active = isActiveRunBatch(batch.status);
  const now = usePlatformNow(active);
  const end = isTerminalRunBatch(batch.status) ? Date.parse(batch.finishedAt) : now;
  return (
    <Metric
      label={countdown ? "距离开始" : active ? "已运行时长" : "执行耗时"}
      value={formatBatchDuration(
        Math.max(
          0,
          countdown ? Date.parse(batch.scheduledFor) - now : end - Date.parse(batch.scheduledFor),
        ),
      )}
    />
  );
}
