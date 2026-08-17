"use client";

import type { RunBatchDetails } from "@autoforge/domain";
import { RotateCcw, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { RunBatchRounds } from "@/components/run-batch-rounds";
import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import {
  formatBatchDuration,
  formatLocalDateTime,
  isActiveRunBatch,
  isTerminalRunBatch,
  runBatchPassRate,
  runBatchStatusLabel,
} from "@/lib/run-batch-presentation";

// 批次没有 startedAt 字段：开始时间取所有 attempt 的最早 startedAt，无 attempt 时回退创建时间。
function batchStartedAt(batch: RunBatchDetails): string {
  let earliest = batch.createdAt;
  for (const attempt of batch.attempts) {
    if (attempt.startedAt && Date.parse(attempt.startedAt) < Date.parse(earliest)) {
      earliest = attempt.startedAt;
    }
  }
  return earliest;
}

// 终态批次的结束时间取最晚的 attempt finishedAt，缺失时回退批次 updatedAt。
function batchFinishedAt(batch: RunBatchDetails): string {
  let latest = batch.updatedAt;
  for (const attempt of batch.attempts) {
    if (attempt.finishedAt && Date.parse(attempt.finishedAt) > Date.parse(latest)) {
      latest = attempt.finishedAt;
    }
  }
  return latest;
}

/**
 * 批次详情编排层：概要指标带、批次级操作（取消/再次执行）、进行中批次的
 * 自动刷新；轮次列表与轮次详情由 RunBatchRounds 承载。
 */
export function ExecutionBatchDetails({
  batch,
  canCancelRuns,
  canCreateRuns,
  canReadLogs,
  canReadArtifacts,
}: {
  batch: RunBatchDetails;
  canCancelRuns: boolean;
  canCreateRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState("");
  const [actionPending, setActionPending] = useState<"cancel" | "retry" | undefined>();
  const activeBatch = isActiveRunBatch(batch.status);
  const retryBlockedByLegacySecrets =
    batch.secretBindings.length > 0 && batch.environmentVersionId === undefined;
  const startedAt = batchStartedAt(batch);

  // 进行中的批次每 5 秒刷新服务端数据，让轮次进度自动推进；组件卸载时清理。
  useEffect(() => {
    if (!activeBatch) return;
    const timer = window.setInterval(() => router.refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [activeBatch, router]);

  async function cancelBatch(): Promise<void> {
    if (!window.confirm("取消后，尚未结束的执行将收到停止请求。确认取消当前批次？")) return;
    setActionPending("cancel");
    setActionError("");
    try {
      const response = await fetch(`/api/v1/run-batches/${encodeURIComponent(batch.id)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Cancelled from execution details." }),
      });
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "取消批次失败。"))!);
      }
      router.refresh();
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "取消批次失败。");
    } finally {
      setActionPending(undefined);
    }
  }

  async function retryBatch(): Promise<void> {
    setActionPending("retry");
    setActionError("");
    try {
      const response = await fetch("/api/v1/run-batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: batch.projectId,
          suiteId: batch.suiteId,
          runnerIds: batch.selectedRunnerIds,
          retryLimit: batch.retryLimit,
          priority: batch.priority,
          queueTimeoutMs: batch.queueTimeoutMs,
          claimTimeoutMs: batch.claimTimeoutMs,
          executionTimeoutMs: batch.executionTimeoutMs,
          uploadTimeoutMs: batch.uploadTimeoutMs,
          ...(batch.environmentVersionId
            ? { environmentVersionId: batch.environmentVersionId }
            : { environmentVariables: batch.environmentVariables }),
        }),
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

  return (
    <div className="execution-detail-layout">
      <section className="batch-metrics-band" aria-label="批次概览">
        <Metric label="状态" value={runBatchStatusLabel(batch.status)} />
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
        <ElapsedMetric active={activeBatch} batch={batch} startedAt={startedAt} />
        <Metric
          label="当前轮次"
          value={
            batch.retryMode === "round"
              ? `第 ${batch.currentRound} 轮 / 共 ${batch.retryLimit + 1} 轮`
              : "立即重跑模式"
          }
        />
      </section>

      {(canCancelRuns || canCreateRuns) && (
        <section className="execution-detail-actions" aria-label="批次操作">
          <div>
            <strong>{activeBatch ? "批次仍在执行" : "批次已进入终态"}</strong>
            <span>
              {retryBlockedByLegacySecrets
                ? "历史批次包含无法重放的密文绑定，请从任务页面重新选择环境。"
                : "重新执行会创建新批次，并保留当前策略快照供审计对比。"}
            </span>
          </div>
          <div className="button-row">
            {canCancelRuns && activeBatch ? (
              <Button
                className="button button-danger-quiet"
                disabled={actionPending !== undefined}
                onClick={() => void cancelBatch()}
                type="button"
              >
                <XCircle size={16} />
                {actionPending === "cancel" ? "正在取消…" : "取消批次"}
              </Button>
            ) : null}
            {canCreateRuns && !activeBatch ? (
              <Button
                className="button button-primary"
                disabled={actionPending !== undefined || retryBlockedByLegacySecrets}
                onClick={() => void retryBatch()}
                type="button"
              >
                <RotateCcw size={16} />
                {actionPending === "retry" ? "正在创建…" : "再次执行"}
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
        batch={batch}
        canCancelRuns={canCancelRuns}
        canReadLogs={canReadLogs}
        canReadArtifacts={canReadArtifacts}
      />
    </div>
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
  batch: RunBatchDetails;
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
