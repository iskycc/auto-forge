"use client";

import { OctagonX, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { RunBatchRounds, type RunnerDirectoryEntry } from "@/components/run-batch-rounds";
import { RerunFinalFailuresDialog } from "@/components/rerun-final-failures-dialog";
import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import type { ExecutionBatchView } from "@/lib/execution-batch-view";
import {
  formatBatchDuration,
  formatLocalDateTime,
  isActiveRunBatch,
  isTerminalRunBatch,
  runBatchCompletionLabel,
  runBatchPassRate,
} from "@/lib/run-batch-presentation";

// 计划开始时间由服务端在创建批次时固化；资源等待不能悄悄改写用户选择的开始时间。
function batchStartedAt(batch: ExecutionBatchView): string {
  return batch.scheduledFor;
}

// 终态批次的结束时间取最晚的 attempt 或环境恢复更新时间，缺失时回退批次
// updatedAt。这样 Jenkins 恢复及构建后的等待不会从任务总时长中被扣除。
function batchFinishedAt(batch: ExecutionBatchView): string {
  return batch.finishedAt;
}

/**
 * 批次详情编排层：概要指标带、批次级操作（取消/再次执行）、进行中批次的
 * 自动刷新；轮次列表与轮次详情由 RunBatchRounds 承载。
 */
export function ExecutionBatchDetails({
  batch: initialBatch,
  retrySuiteId,
  rerunConfiguration,
  canCancelRuns,
  canCreateRuns,
  canReadLogs,
  canReadAttemptEvents,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  accessToken,
}: {
  batch: ExecutionBatchView;
  retrySuiteId?: string;
  rerunConfiguration?: {
    defaultConcurrency: number;
    hasRetryConcurrencyRules: boolean;
  };
  canCancelRuns: boolean;
  canCreateRuns: boolean;
  canReadLogs: boolean;
  canReadAttemptEvents: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: readonly RunnerDirectoryEntry[];
  accessToken?: string;
}) {
  const router = useRouter();
  const [batch, setBatch] = useState(initialBatch);
  const [actionError, setActionError] = useState("");
  const [actionPending, setActionPending] = useState<"cancel" | "retry" | undefined>();
  const [observedAtMs, setObservedAtMs] = useState(() => Date.now());
  const [finalFailuresDialogOpen, setFinalFailuresDialogOpen] = useState(false);
  const activeBatch = isActiveRunBatch(batch.status);
  const startedAt = batchStartedAt(batch);
  const awaitingScheduledStart =
    batch.status === "queued" && Date.parse(batch.scheduledFor) > observedAtMs;
  const finalFailureCount = batch.failedRuns + batch.timedOutRuns;
  const canRerunFinalFailures =
    canCreateRuns && !activeBatch && finalFailureCount > 0 && rerunConfiguration !== undefined;

  const refreshBatch = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const parameters = new URLSearchParams();
      if (accessToken) parameters.set("access_token", accessToken);
      const response = await fetch(
        `/api/v1/run-batches/${encodeURIComponent(initialBatch.id)}/overview${parameters.size > 0 ? `?${parameters.toString()}` : ""}`,
        { cache: "no-store", ...(signal ? { signal } : {}) },
      );
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "刷新执行详情失败。"))!);
      }
      const latest = (await response.json()) as ExecutionBatchView;
      setBatch(accessToken ? { ...latest, accessToken } : latest);
    },
    [accessToken, initialBatch.id],
  );

  // 只拉取有界概要并更新当前组件，不再 router.refresh() 重跑整页 Server Component。
  useEffect(() => {
    if (!activeBatch) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        await refreshBatch(controller.signal);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setActionError(cause instanceof Error ? cause.message : "刷新执行详情失败。");
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 5_000);
      }
    };
    timer = window.setTimeout(() => void poll(), 5_000);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeBatch, refreshBatch]);

  useEffect(() => {
    if (!activeBatch) return;
    const timer = window.setInterval(() => setObservedAtMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeBatch]);

  async function terminateBatch(): Promise<void> {
    if (
      !window.confirm(
        "终止后会立即停止后续调度；正在执行的用例会继续到本次完成，随后任务正式终止。确认继续？",
      )
    )
      return;
    setActionPending("cancel");
    setActionError("");
    try {
      const response = await fetch(
        `/api/v1/run-batches/${encodeURIComponent(batch.id)}/terminate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Terminated from execution details." }),
        },
      );
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "终止任务失败。"))!);
      }
      await refreshBatch();
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "终止任务失败。");
    } finally {
      setActionPending(undefined);
    }
  }

  async function retryBatch(): Promise<void> {
    if (!retrySuiteId) return;
    setActionPending("retry");
    setActionError("");
    try {
      const response = await fetch("/api/v1/run-batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suiteId: retrySuiteId }),
      });
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "重新执行失败。"))!);
      }
      const created = (await response.json()) as { id?: string };
      if (!created.id) throw new Error("平台未返回新批次标识。");
      router.push(`/run-batches/${encodeURIComponent(created.id)}`);
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "重新执行失败。");
    } finally {
      setActionPending(undefined);
    }
  }

  async function refreshVisibleBatch(): Promise<void> {
    setActionError("");
    try {
      await refreshBatch();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "刷新执行详情失败。");
    }
  }

  return (
    <div className="execution-detail-layout">
      <section className="batch-metrics-band" aria-label="批次概览">
        <Metric
          label="状态"
          value={awaitingScheduledStart ? "倒计时" : runBatchCompletionLabel(batch)}
        />
        <Metric label="总通过率" value={`${runBatchPassRate(batch)}%`} />
        <Metric
          label="用例总数"
          value={String(batch.totalRuns)}
          hint={`通过 ${batch.succeededRuns} · 失败 ${batch.failedRuns + batch.timedOutRuns}`}
        />
        <Metric
          label="开始时间"
          value={formatLocalDateTime(startedAt)}
          title={`UTC ${startedAt}`}
        />
        {awaitingScheduledStart ? (
          <CountdownMetric nowMs={observedAtMs} scheduledFor={batch.scheduledFor} />
        ) : (
          <ElapsedMetric active={activeBatch} batch={batch} startedAt={startedAt} />
        )}
        <Metric
          label="当前轮次"
          value={
            batch.retryMode === "round"
              ? `第 ${batch.currentRound} 轮 · 用例重跑上限 ${batch.retryLimit} 次`
              : "立即重跑模式"
          }
        />
      </section>

      {(canCancelRuns || (canCreateRuns && retrySuiteId) || canRerunFinalFailures) && (
        <section className="execution-detail-actions" aria-label="批次操作">
          <div>
            <strong>
              {batch.terminationRequestedAt
                ? "任务正在终止"
                : activeBatch
                  ? "批次仍在执行"
                  : "批次已进入终态"}
            </strong>
            <span>
              {batch.terminationRequestedAt
                ? "后续调度已停止，等待正在执行的用例自然完成。"
                : "再次执行会读取任务当前版本的完整配置并创建新批次。"}
            </span>
          </div>
          <div className="button-row">
            {canCancelRuns && activeBatch ? (
              <Button
                className="button button-danger-quiet"
                disabled={actionPending !== undefined || Boolean(batch.terminationRequestedAt)}
                onClick={() => void terminateBatch()}
                type="button"
              >
                <OctagonX size={16} />
                {batch.terminationRequestedAt
                  ? "终止中"
                  : actionPending === "cancel"
                    ? "正在终止…"
                    : "终止任务"}
              </Button>
            ) : null}
            {canCreateRuns && retrySuiteId && !activeBatch ? (
              <Button
                className="button button-primary"
                disabled={actionPending !== undefined}
                onClick={() => void retryBatch()}
                type="button"
              >
                <RotateCcw size={16} />
                {actionPending === "retry" ? "正在创建…" : "再次执行"}
              </Button>
            ) : null}
            {canRerunFinalFailures ? (
              <Button
                className="button button-secondary"
                disabled={actionPending !== undefined}
                onClick={() => setFinalFailuresDialogOpen(true)}
                type="button"
              >
                <RotateCcw size={16} />
                重新执行最后一轮
              </Button>
            ) : null}
          </div>
          {actionError ? (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          ) : null}
        </section>
      )}

      <RunBatchRounds
        batch={accessToken ? { ...batch, accessToken } : batch}
        canCancelRuns={canCancelRuns}
        canReadLogs={canReadLogs}
        canCreateRuns={canCreateRuns}
        canReadAttemptEvents={canReadAttemptEvents}
        canReadArtifacts={canReadArtifacts}
        artifactsEnabled={artifactsEnabled}
        runnerDirectory={runnerDirectory}
        onRefresh={() => void refreshVisibleBatch()}
      />
      {finalFailuresDialogOpen ? (
        <RerunFinalFailuresDialog
          batchId={batch.id}
          defaultConcurrency={rerunConfiguration?.defaultConcurrency ?? 1}
          failedCount={finalFailureCount}
          hasRetryConcurrencyRules={rerunConfiguration?.hasRetryConcurrencyRules ?? false}
          hasRoundRecovery={batch.roundRecoveries.length > 0}
          onClose={() => setFinalFailuresDialogOpen(false)}
          onCreated={(createdBatchId) =>
            router.push(`/run-batches/${encodeURIComponent(createdBatchId)}`)
          }
        />
      ) : null}
    </div>
  );
}

function CountdownMetric({ scheduledFor, nowMs }: { scheduledFor: string; nowMs: number }) {
  return (
    <Metric
      label="距离开始"
      value={formatBatchDuration(Math.max(0, Date.parse(scheduledFor) - nowMs))}
    />
  );
}

function Metric({
  label,
  value,
  hint,
  title,
}: {
  label: string;
  value: string;
  hint?: string;
  title?: string;
}) {
  return (
    <div className="batch-metric" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

// 进行中批次每秒滴答刷新已运行时长；终态批次显示开始结束之间的总时长。
function ElapsedMetric({
  active,
  batch,
  startedAt,
}: {
  active: boolean;
  batch: ExecutionBatchView;
  startedAt: string;
}) {
  const terminal = isTerminalRunBatch(batch.status);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const endMs = terminal ? Date.parse(batchFinishedAt(batch)) : nowMs;
  const durationMs = Math.max(0, endMs - Date.parse(startedAt));
  return <Metric label="已运行时长" value={formatBatchDuration(durationMs)} />;
}
