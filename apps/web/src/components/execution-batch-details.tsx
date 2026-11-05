"use client";
import { BatchSchedulingButton } from "./batch-scheduling-button";
import { AiAnalysisButton } from "./ai-analysis-button";
import { ExecutionBatchOverview } from "./execution-batch-overview";
import { ExecutionStatisticsStatus } from "./execution-statistics-status";
import { Notice } from "@/components/ui/notice";
import { SemanticStatusTag } from "@/components/ui/semantic-status-tag";
import { LoadingOutlined } from "@ant-design/icons";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import {
  StartFailureAnalysisButton,
  type FailureAnalysisScope,
} from "./start-failure-analysis-button";

import { AlertTriangle, Gauge, ListPlus, OctagonX, RotateCcw } from "lucide-react";
import { ConcurrencyDiagnosticsDialog } from "./concurrency-diagnostics-dialog";
import { ExecutionExceptionsDialog } from "./execution-exceptions-dialog";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { RunBatchRounds, type RunnerDirectoryEntry } from "@/components/run-batch-rounds";
import { RerunFinalFailuresDialog } from "@/components/rerun-final-failures-dialog";
import { CreateFailureCaseSuiteDialog } from "@/components/create-failure-case-suite-dialog";
import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { useConfirm } from "@/components/ui-feedback";
import type { ExecutionBatchView } from "@/lib/execution-batch-view";
import { isActiveRunBatch, isTerminalRunBatch } from "@/lib/run-batch-presentation";

/**
 * 批次详情编排层：概要指标带、批次级操作（取消/再次执行）、进行中批次的
 * 自动刷新；轮次列表与轮次详情由 RunBatchRounds 承载。
 */
export function ExecutionBatchDetails({
  batch: initialBatch,
  retrySuiteId,
  analysisScope,
  rerunConfiguration,
  failureTaskConfiguration,
  canCancelRuns,
  canCreateRuns,
  canRetryRuns,
  canReadLogs,
  canReadAttemptEvents,
  canReadArtifacts,
  canReadConcurrencyDiagnostics = false,
  artifactsEnabled,
  runnerDirectory,
  accessToken,
  publicAccess = false,
}: {
  batch: ExecutionBatchView;
  retrySuiteId?: string;
  analysisScope?: FailureAnalysisScope;
  rerunConfiguration?: {
    defaultConcurrency: number;
    hasRetryConcurrencyRules: boolean;
  };
  failureTaskConfiguration?: { suiteName: string };
  canCancelRuns: boolean;
  canCreateRuns: boolean;
  canRetryRuns: boolean;
  canReadLogs: boolean;
  canReadAttemptEvents: boolean;
  canReadArtifacts: boolean;
  canReadConcurrencyDiagnostics?: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: readonly RunnerDirectoryEntry[];
  accessToken?: string;
  publicAccess?: boolean;
}) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const [batch, setBatch] = useState(initialBatch);
  const currentRunnerDirectory = useMemo(() => {
    const entries = new Map(runnerDirectory.map((runner) => [runner.id, runner]));
    for (const runner of batch.runnerNames ?? []) {
      entries.set(runner.id, { ...entries.get(runner.id), ...runner });
    }
    return [...entries.values()];
  }, [runnerDirectory, batch.runnerNames]);
  const [actionError, setActionError] = useState("");
  const [actionPending, setActionPending] = useState<"cancel" | "retry" | undefined>();
  const [finalFailuresDialogOpen, setFinalFailuresDialogOpen] = useState(false);
  const [failureTaskDialogOpen, setFailureTaskDialogOpen] = useState(false);
  const [exceptionsDialogOpen, setExceptionsDialogOpen] = useState(false);
  const [concurrencyDialogOpen, setConcurrencyDialogOpen] = useState(false);
  const activeBatch = isActiveRunBatch(batch.status);
  const statisticsState = batch.statistics?.state;
  const statisticsPending = !!batch.statistics && !batch.statistics.generation;
  const finalFailureCount = batch.failedRuns + batch.timedOutRuns;
  const canRerunFinalFailures =
    canRetryRuns && !activeBatch && finalFailureCount > 0 && rerunConfiguration !== undefined;
  const failureTaskCaseCount = Math.max(0, batch.totalRuns - batch.succeededRuns);
  const canCreateFailureTask =
    failureTaskConfiguration !== undefined &&
    isTerminalRunBatch(batch.status) &&
    !statisticsPending &&
    failureTaskCaseCount > 0;

  const refreshBatch = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const parameters = new URLSearchParams();
      if (accessToken) parameters.set("access_token", accessToken);
      if (publicAccess) parameters.set("public", "1");
      const response = await fetch(
        `/api/v1/run-batches/${encodeURIComponent(initialBatch.id)}/overview${parameters.size > 0 ? `?${parameters.toString()}` : ""}`,
        { cache: "no-store", ...(signal ? { signal } : {}) },
      );
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "刷新执行详情失败。"))!);
      }
      const latest = (await response.json()) as ExecutionBatchView;
      const next = {
        ...latest,
        ...(accessToken ? { accessToken } : {}),
        ...(publicAccess ? { publicAccess } : {}),
      };
      setBatch((current) =>
        current.updatedAt === next.updatedAt &&
        current.finishedAt === next.finishedAt &&
        current.status === next.status &&
        current.statistics?.generation === next.statistics?.generation &&
        current.statistics?.state === next.statistics?.state &&
        JSON.stringify(current.runnerNames) === JSON.stringify(next.runnerNames)
          ? current
          : next,
      );
    },
    [accessToken, publicAccess, initialBatch.id],
  );

  // 只拉取有界概要并更新当前组件，不再 router.refresh() 重跑整页 Server Component。
  useEffect(() => {
    if (!activeBatch && (!statisticsState || statisticsState === "ready")) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        if (document.visibilityState === "visible") await refreshBatch(controller.signal);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setActionError(cause instanceof Error ? cause.message : "刷新执行详情失败。");
        }
      } finally {
        if (!controller.signal.aborted)
          timer = window.setTimeout(() => void poll(), statisticsPending ? 1_000 : 5_000);
      }
    };
    timer = window.setTimeout(() => void poll(), statisticsPending ? 1_000 : 5_000);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeBatch, statisticsPending, statisticsState, refreshBatch]);

  async function terminateBatch(): Promise<void> {
    if (
      !(await confirmAction({
        title: "终止执行任务",
        description: "平台会立即停止后续调度；正在执行的用例会继续到本次完成，随后任务正式终止。",
        confirmLabel: "确认终止",
        tone: "danger",
      }))
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
    <div
      className={cn(
        "execution-detail-layout",
        executionBatchDetailsStyles["execution-detail-layout"],
      )}
    >
      {batch.statistics ? (
        <ExecutionStatisticsStatus
          statistics={batch.statistics}
          canRefresh={!publicAccess}
          onRefresh={refreshBatch}
        />
      ) : null}
      <ExecutionBatchOverview batch={batch}>
        {((canReadLogs && !publicAccess && !activeBatch) ||
          analysisScope ||
          (activeBatch && canReadConcurrencyDiagnostics && !publicAccess) ||
          batch.status === "failed" ||
          canCancelRuns ||
          (canCreateRuns && retrySuiteId) ||
          canRerunFinalFailures ||
          canCreateFailureTask) && (
          <section
            className={cn(
              "execution-detail-actions",
              executionBatchDetailsStyles["execution-detail-actions"],
            )}
            aria-label="批次操作"
          >
            <div>
              <strong>
                {batch.terminationRequestedAt
                  ? activeBatch
                    ? "任务正在终止"
                    : "任务已终止"
                  : batch.pauseRequestedAt && activeBatch
                    ? batch.status === "queued"
                      ? "任务已暂停"
                      : "任务正在暂停"
                    : activeBatch
                      ? "批次仍在执行"
                      : "批次已进入终态"}
              </strong>
              <span>
                {batch.terminationRequestedAt
                  ? activeBatch
                    ? "后续调度已停止，等待已领取用例自然完成及状态收尾；不会进入下一轮。"
                    : "本批次的执行与收尾已结束，执行记录和结果已保留。"
                  : batch.pauseRequestedAt && activeBatch
                    ? "新的调度已暂停，已下发的用例继续完成；点击继续调度执行剩余用例及重试。"
                    : batch.status === "failed"
                      ? "查看异常原因可定位非正常结束的用例或轮次恢复步骤。"
                      : retrySuiteId
                        ? "再次执行会读取任务当前版本的完整配置并创建新批次。"
                        : "本批次的执行记录与配置快照已保留，可继续查看结果和日志。"}
              </span>
            </div>
            <div className={cn("button-row", uiPatterns["button-row"])}>
              {canReadLogs && !publicAccess && !activeBatch ? (
                <AiAnalysisButton batchId={batch.id} />
              ) : null}
              {activeBatch && canReadConcurrencyDiagnostics && !publicAccess ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConcurrencyDialogOpen(true)}
                >
                  <Gauge size={16} />
                  并发诊断
                </Button>
              ) : null}
              {batch.status === "failed" ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setExceptionsDialogOpen(true)}
                >
                  <AlertTriangle size={16} />
                  查看异常原因
                </Button>
              ) : null}
              {analysisScope && !activeBatch && batch.failedRuns > 0 ? (
                <StartFailureAnalysisButton scope={analysisScope} />
              ) : null}
              {canCancelRuns && activeBatch && !batch.terminationRequestedAt ? (
                <BatchSchedulingButton
                  batch={batch}
                  onChanged={refreshBatch}
                  disabled={actionPending !== undefined}
                />
              ) : null}
              {canCancelRuns && activeBatch ? (
                batch.terminationRequestedAt ? (
                  <span role="status" aria-live="polite">
                    <SemanticStatusTag tone="info">
                      <span className="inline-flex min-h-8 items-center gap-2">
                        <LoadingOutlined spin />
                        终止中
                      </span>
                    </SemanticStatusTag>
                  </span>
                ) : (
                  <Button
                    className={cn(
                      "button button-danger-quiet",
                      uiPatterns["button"],
                      uiPatterns["button-danger-quiet"],
                    )}
                    disabled={actionPending !== undefined}
                    onClick={() => void terminateBatch()}
                    type="button"
                  >
                    <OctagonX size={16} />
                    {actionPending === "cancel" ? "正在终止…" : "终止任务"}
                  </Button>
                )
              ) : null}
              {canCreateRuns && retrySuiteId && !activeBatch ? (
                <Button
                  className={cn(
                    "button button-primary",
                    uiPatterns["button"],
                    uiPatterns["button-primary"],
                  )}
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
                  className={cn(
                    "button button-secondary",
                    uiPatterns["button"],
                    uiPatterns["button-secondary"],
                  )}
                  disabled={actionPending !== undefined}
                  onClick={() => setFinalFailuresDialogOpen(true)}
                  type="button"
                >
                  <RotateCcw size={16} />
                  重新执行最后一轮
                </Button>
              ) : null}
              {canCreateFailureTask ? (
                <Button
                  variant="secondary"
                  disabled={actionPending !== undefined}
                  onClick={() => setFailureTaskDialogOpen(true)}
                  type="button"
                >
                  <ListPlus size={16} />
                  以未通过用例创建任务
                </Button>
              ) : null}
            </div>
            {actionError ? (
              <Notice
                tone="error"
                className={cn("form-error", uiPatterns["form-error"])}
                role="alert"
              >
                {actionError}
              </Notice>
            ) : null}
          </section>
        )}
      </ExecutionBatchOverview>

      {concurrencyDialogOpen && !publicAccess ? (
        <ConcurrencyDiagnosticsDialog
          batchId={batch.id}
          onClose={() => setConcurrencyDialogOpen(false)}
        />
      ) : null}
      {exceptionsDialogOpen ? (
        <ExecutionExceptionsDialog
          batchId={batch.id}
          accessToken={accessToken}
          publicAccess={publicAccess}
          onClose={() => setExceptionsDialogOpen(false)}
        />
      ) : null}
      <RunBatchRounds
        batch={{
          ...batch,
          ...(accessToken ? { accessToken } : {}),
          ...(publicAccess ? { publicAccess } : {}),
        }}
        canCancelRuns={canCancelRuns}
        canReadLogs={canReadLogs}
        canRetryRuns={canRetryRuns}
        canReadAttemptEvents={canReadAttemptEvents}
        canReadArtifacts={canReadArtifacts}
        artifactsEnabled={artifactsEnabled}
        runnerDirectory={currentRunnerDirectory}
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
      {failureTaskDialogOpen && failureTaskConfiguration ? (
        <CreateFailureCaseSuiteDialog
          batchId={batch.id}
          suiteName={failureTaskConfiguration.suiteName}
          nonPassedCount={failureTaskCaseCount}
          canCreateRuns={canCreateRuns}
          onClose={() => setFailureTaskDialogOpen(false)}
          onCreated={(suiteId) => router.push(`/case-suites/${encodeURIComponent(suiteId)}`)}
          onStarted={(createdBatchId) =>
            router.push(`/run-batches/${encodeURIComponent(createdBatchId)}`)
          }
        />
      ) : null}
    </div>
  );
}

const executionBatchDetailsStyles = {
  "execution-detail-actions":
    "grid min-w-0 gap-3 border-t border-border bg-muted/20 px-5 py-4 [&_>_div:first-child]:grid [&_>_div:first-child]:min-w-0 [&_>_div:first-child]:gap-1 [&_>_div:first-child_>_span]:text-muted-foreground [&_>_div:first-child_>_span]:text-xs [&_.button-row]:min-w-0 [&_.button-row]:max-w-full [&_.button-row]:mt-0 [&_.button-row]:gap-2 [&_.button-row_.button]:shrink-0 [&_.form-error]:m-0",
  "execution-detail-layout": "grid grid-cols-[minmax(0,_1fr)] gap-4",
} as const;
