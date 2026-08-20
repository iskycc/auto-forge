"use client";

import type { AttemptArtifactList, AttemptEventPage } from "@autoforge/contracts";
import type {
  RunAttempt,
  RunBatchDetails,
  RunBatchRoundSummary,
  RunnerResourceSnapshot,
} from "@autoforge/domain";
import {
  isTerminalAttemptStatus,
  summarizeAllRunBatchRounds,
  summarizeRunBatchRounds,
} from "@autoforge/domain";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Globe,
  RefreshCw,
  ScrollText,
  Search,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AttemptLogViewer } from "@/components/attempt-log-viewer";
import { DonutChart, type DonutChartSegment } from "@/components/donut-chart";
import { RunBatchExportDialog } from "@/components/run-batch-export-dialog";
import { SchedulingLogViewer } from "@/components/scheduling-log-viewer";
import { Button, Input, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import {
  buildRoundCaseRows,
  canCancelRoundCaseRow,
  compareRoundCaseRowsByStatus,
  type RoundCaseRowModel,
} from "@/lib/round-case-rows";
import {
  attemptFailureHint,
  formatArtifactBytes,
  formatAttemptDuration,
  formatBatchDuration,
  formatLocalDateTime,
} from "@/lib/run-batch-presentation";
import { columnCharacterWidthAtCoverage, widestText } from "@/lib/table-column-width";

const DEFAULT_CASE_PAGE_SIZE = 50;
// 用户可选的每页用例数；500 为需求上限。
const CASE_PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500] as const;

/** 行内详情缓存：展开过的 attempt 产物与事件只请求一次，切换页面/重新展开不再重复拉取。 */
type AttemptDetailEntry = {
  artifacts?: AttemptArtifactList["items"] | undefined;
  events?: AttemptEventPage["items"] | undefined;
  error?: string | undefined;
};

/**
 * 执行机目录条目：由服务端页面按 runner.read 权限加载后传入，用于把 UUID
 * 映射为执行机名称与实时资源快照；查不到（无权限、已清除等）时回落 UUID 短码。
 */
export type RunnerDirectoryEntry = {
  id: string;
  name: string;
  resourceSnapshot?: RunnerResourceSnapshot;
};

type CaseStatusFilter = "all" | "succeeded" | "failed" | "timed_out" | "cancelled" | "pending";

// 轮次行命名：第 1 轮是初始执行，round 模式之后叫「重跑第 N 轮」，
// immediate 模式按第几次尝试叫「重试第 N 次」，两种模式的文案不得混用。
function roundLabel(retryMode: RunBatchDetails["retryMode"], round: number): string {
  if (round === 1) return "初始轮次";
  return retryMode === "round" ? `重跑第 ${round - 1} 轮` : `重试第 ${round - 1} 次`;
}

function roundStatusLabel(summary: RunBatchRoundSummary, currentRound: number): string {
  if (summary.status === "running") return "运行中";
  if (summary.status === "completed") return "已完成";
  return summary.round <= currentRound ? "等待调度" : "等待上一轮结束";
}

function roundStatusClass(summary: RunBatchRoundSummary): string {
  if (summary.status === "running") return "";
  if (summary.status === "completed") return "batch-status-succeeded";
  return "batch-status-neutral";
}

function attemptStatusLabel(attempt: RunAttempt): string {
  const labels: Record<RunAttempt["status"], string> = {
    assigned: "已分配",
    running: "运行中",
    succeeded: "通过",
    failed: "失败",
    timed_out: "超时",
    cancelled: "已取消",
  };
  return labels[attempt.status];
}

function attemptStatusClass(attempt: RunAttempt): string {
  if (attempt.status === "succeeded") return "batch-status-succeeded";
  if (attempt.status === "failed") return "batch-status-failed";
  if (attempt.status === "timed_out") return "batch-status-queued";
  if (attempt.status === "cancelled") return "batch-status-neutral";
  return "";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// 执行机展示名：优先注册名称（一般为 runner-IP），目录查不到时回落 UUID 短码。
function runnerDisplayName(
  runnerId: string,
  directory: ReadonlyMap<string, RunnerDirectoryEntry>,
): string {
  return directory.get(runnerId)?.name || shortId(runnerId);
}

// 资源快照展示与执行机页保持一致：负载按单核归一，便于跨机型比较。
function runnerResourceLabel(snapshot: RunnerResourceSnapshot): string {
  const loadPerCpu =
    snapshot.logicalCpuCount > 0 ? snapshot.loadAverage1m / snapshot.logicalCpuCount : 0;
  return `CPU ${snapshot.cpuUtilizationPercent}% · 内存 ${snapshot.memoryUtilizationPercent}% · 负载/CPU ${loadPerCpu.toFixed(2)}`;
}

// 终态失败提示行：adapter 正常失败露出完整失败描述，blocked 露出原因码；
// 提示文案为空（非终态或信息缺失）时不渲染。
function AttemptFailureHintLine({ attempt }: { attempt: RunAttempt }) {
  const hint = attemptFailureHint(attempt);
  if (!hint) return null;
  return (
    <small className="table-secondary attempt-failure-line" title={hint}>
      {hint}
    </small>
  );
}

/**
 * 轮次列表 + 选中轮次的详情面板。轮次聚合来自领域纯函数 summarizeRunBatchRounds，
 * 选中轮次写入 ?round=N，刷新或分享链接后可恢复。
 */
export function RunBatchRounds({
  batch,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
}: {
  batch: RunBatchDetails;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: readonly RunnerDirectoryEntry[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const summaries = useMemo(
    () => summarizeRunBatchRounds(batch, batch.runs, batch.attempts),
    [batch],
  );
  const runnerDirectoryById = useMemo(
    () => new Map(runnerDirectory.map((entry) => [entry.id, entry])),
    [runnerDirectory],
  );
  const requestedRoundParam = searchParams.get("round");
  // round=all 是虚拟轮次：跨全部轮次逐条展示执行记录，不对应任何真实轮次号。
  const allRoundsSelected = requestedRoundParam === "all";
  const requestedRound = Number(requestedRoundParam ?? "");
  // 默认落在最后一个已执行的轮次；纯等待轮（还没有任何 attempt）不作为默认选中。
  const defaultRound =
    [...summaries].reverse().find((summary) => summary.status !== "waiting")?.round ??
    summaries.at(-1)?.round ??
    1;
  const selectedRound = summaries.some((summary) => summary.round === requestedRound)
    ? requestedRound
    : defaultRound;
  const selectedSummary = summaries.find((summary) => summary.round === selectedRound);
  const allRoundsStats = useMemo(() => summarizeAllRunBatchRounds(summaries), [summaries]);
  const [activeTab, setActiveTab] = useState<"cases" | "runners">("cases");
  const [logAttempt, setLogAttempt] = useState<RunAttempt | undefined>();
  const [schedulingViewer, setSchedulingViewer] = useState<
    { runnerId?: string; title: string } | undefined
  >();
  const [cancelPending, setCancelPending] = useState(false);
  const [actionError, setActionError] = useState("");
  // 行内详情缓存按批次组件生命周期存活；刷新按钮触发 router.refresh() 后
  // 服务端数据更新，缓存仍按 attemptId 复用已加载的产物与事件。
  const [detailCache, setDetailCache] = useState<Map<string, AttemptDetailEntry>>(new Map());

  const rememberAttemptDetail = useCallback((attemptId: string, entry: AttemptDetailEntry) => {
    setDetailCache((current) => {
      const next = new Map(current);
      next.set(attemptId, entry);
      return next;
    });
  }, []);

  function selectRound(round: number | "all"): void {
    const parameters = new URLSearchParams(searchParams.toString());
    parameters.set("round", String(round));
    router.replace(`${pathname}?${parameters.toString()}`, { scroll: false });
  }

  async function cancelRun(runId: string): Promise<void> {
    const reason = window.prompt(
      "请输入取消该用例执行的原因：",
      "Cancelled from execution details.",
    );
    if (!reason?.trim()) return;
    setCancelPending(true);
    setActionError("");
    try {
      const response = await fetch(`/api/v1/execution-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "取消用例执行失败。"))!);
      }
      router.refresh();
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "取消用例执行失败。");
    } finally {
      setCancelPending(false);
    }
  }

  return (
    <>
      <section aria-label="轮次列表">
        <div className="section-heading">
          <div>
            <span className="step-label">ROUNDS</span>
            <h2>轮次</h2>
          </div>
          <span className="muted">共 {summaries.length} 轮</span>
        </div>
        <div className="table-scroll round-table-scroll">
          <table className="data-table execution-round-table">
            <colgroup>
              <col className="round-column-name" />
              <col className="round-column-status" />
              <col className="round-column-count" span={6} />
              <col className="round-column-start" />
              <col className="round-column-duration" />
            </colgroup>
            <thead>
              <tr>
                <th>轮次</th>
                <th>状态</th>
                <th>总用例数</th>
                <th>总通过率</th>
                <th>轮次通过率</th>
                <th>通过数</th>
                <th>失败数</th>
                <th>未执行数</th>
                <th>开始时间</th>
                <th>轮次时长</th>
              </tr>
            </thead>
            <tbody>
              {/* 虚拟轮次：跨全部轮次逐条查看/筛选执行记录，并导出所有轮次结果。 */}
              <tr
                className={allRoundsSelected ? "selected-row" : undefined}
                onClick={() => selectRound("all")}
              >
                <td>
                  <Button
                    className="round-select-button"
                    variant="ghost"
                    size="compact"
                    type="button"
                    aria-pressed={allRoundsSelected}
                    onClick={() => selectRound("all")}
                  >
                    全部轮次
                  </Button>
                </td>
                <td>—</td>
                <td>{allRoundsStats.totalRuns}</td>
                <td>{allRoundsStats.passRate}%</td>
                <td>—</td>
                <td>{allRoundsStats.passed}</td>
                <td>{allRoundsStats.failed + allRoundsStats.timedOut}</td>
                <td>{allRoundsStats.notExecuted}</td>
                <td>—</td>
                <td>—</td>
              </tr>
              {summaries.map((summary) => (
                <tr
                  key={summary.round}
                  className={
                    !allRoundsSelected && summary.round === selectedRound
                      ? "selected-row"
                      : undefined
                  }
                  onClick={() => selectRound(summary.round)}
                >
                  <td>
                    <Button
                      className="round-select-button"
                      variant="ghost"
                      size="compact"
                      type="button"
                      aria-pressed={!allRoundsSelected && summary.round === selectedRound}
                      onClick={() => selectRound(summary.round)}
                    >
                      {roundLabel(batch.retryMode, summary.round)}
                    </Button>
                  </td>
                  <td>
                    <span className={`batch-status ${roundStatusClass(summary)}`.trim()}>
                      {roundStatusLabel(summary, batch.currentRound)}
                    </span>
                  </td>
                  <td>{summary.totalRuns}</td>
                  <td>{summary.overallPassRate}%</td>
                  <td>
                    {summary.roundPassRate === null
                      ? "—"
                      : `${summary.roundPassRate}%${summary.status === "running" ? "（进行中）" : ""}`}
                  </td>
                  <td>{summary.passed}</td>
                  <td>{summary.failed + summary.timedOut}</td>
                  <td>{summary.notExecuted}</td>
                  <td>
                    {summary.startedAt ? (
                      <time title={`UTC ${summary.startedAt}`}>
                        {formatLocalDateTime(summary.startedAt)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {summary.durationMs !== null
                      ? formatBatchDuration(summary.durationMs)
                      : summary.status === "running" && summary.startedAt
                        ? "进行中"
                        : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {allRoundsSelected ? (
        <AllRoundsPanel
          batch={batch}
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadArtifacts={canReadArtifacts}
          artifactsEnabled={artifactsEnabled}
          runnerDirectory={runnerDirectoryById}
          cancelPending={cancelPending}
          actionError={actionError}
          detailCache={detailCache}
          onRememberAttemptDetail={rememberAttemptDetail}
          onCancelRun={(runId) => void cancelRun(runId)}
          onOpenLogs={setLogAttempt}
        />
      ) : selectedSummary ? (
        <RoundDetailPanel
          batch={batch}
          summary={selectedSummary}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadArtifacts={canReadArtifacts}
          artifactsEnabled={artifactsEnabled}
          runnerDirectory={runnerDirectoryById}
          cancelPending={cancelPending}
          actionError={actionError}
          detailCache={detailCache}
          onRememberAttemptDetail={rememberAttemptDetail}
          onCancelRun={(runId) => void cancelRun(runId)}
          onOpenLogs={setLogAttempt}
          onOpenScheduling={(runnerId) =>
            setSchedulingViewer(
              runnerId
                ? {
                    runnerId,
                    title: `runner ${runnerDisplayName(runnerId, runnerDirectoryById)} · 调度日志`,
                  }
                : { title: "总体调度日志" },
            )
          }
        />
      ) : null}

      {logAttempt ? (
        <AttemptLogViewer
          attemptId={logAttempt.id}
          attemptStatus={logAttempt.status}
          canReadLogs={canReadLogs}
          onClose={() => setLogAttempt(undefined)}
        />
      ) : null}
      {schedulingViewer ? (
        <SchedulingLogViewer
          batchId={batch.id}
          runnerId={schedulingViewer.runnerId}
          title={schedulingViewer.title}
          onClose={() => setSchedulingViewer(undefined)}
        />
      ) : null}
    </>
  );
}

/**
 * 全部轮次虚拟面板：同一用例在不同轮次产生的每条 attempt 各占一行，
 * 用轮次列区分；导出默认使用 scope=all（所有轮次逐条记录）。
 */
function AllRoundsPanel({
  batch,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  cancelPending,
  actionError,
  detailCache,
  onRememberAttemptDetail,
  onCancelRun,
  onOpenLogs,
}: {
  batch: RunBatchDetails;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  cancelPending: boolean;
  actionError: string;
  detailCache: ReadonlyMap<string, AttemptDetailEntry>;
  onRememberAttemptDetail: (attemptId: string, entry: AttemptDetailEntry) => void;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
}) {
  const router = useRouter();
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  return (
    <section className="round-detail-panel" aria-label="轮次详情：全部轮次">
      <div className="round-detail-header">
        <div className="round-detail-title">
          <h2>全部轮次</h2>
          <span className="batch-status batch-status-neutral">逐条记录</span>
        </div>
        <div className="round-detail-header-actions">
          <Button
            className="button button-secondary compact-button"
            onClick={() => router.refresh()}
            type="button"
            title="重新从服务端拉取最新执行状态"
          >
            <RefreshCw size={15} /> 刷新
          </Button>
          {canReadLogs ? (
            <Button
              className="button button-secondary compact-button"
              onClick={() => setExportDialogOpen(true)}
              type="button"
            >
              <Download size={15} /> 导出结果
            </Button>
          ) : null}
        </div>
      </div>
      {exportDialogOpen ? (
        <RunBatchExportDialog
          batchId={batch.id}
          defaultScope="all"
          onClose={() => setExportDialogOpen(false)}
        />
      ) : null}
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {/* 全部轮次没有环形图，不能使用 round-detail-body 的双列网格，
          否则表格会被挤进 320px 的图表列。 */}
      <div className="round-tab-content">
        <RoundCasesTable
          key="all"
          batch={batch}
          round="all"
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadArtifacts={canReadArtifacts}
          artifactsEnabled={artifactsEnabled}
          runnerDirectory={runnerDirectory}
          cancelPending={cancelPending}
          detailCache={detailCache}
          onRememberAttemptDetail={onRememberAttemptDetail}
          onCancelRun={onCancelRun}
          onOpenLogs={onOpenLogs}
        />
      </div>
    </section>
  );
}

function RoundDetailPanel({
  batch,
  summary,
  activeTab,
  onTabChange,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  cancelPending,
  actionError,
  detailCache,
  onRememberAttemptDetail,
  onCancelRun,
  onOpenLogs,
  onOpenScheduling,
}: {
  batch: RunBatchDetails;
  summary: RunBatchRoundSummary;
  activeTab: "cases" | "runners";
  onTabChange: (tab: "cases" | "runners") => void;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  cancelPending: boolean;
  actionError: string;
  detailCache: ReadonlyMap<string, AttemptDetailEntry>;
  onRememberAttemptDetail: (attemptId: string, entry: AttemptDetailEntry) => void;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
  onOpenScheduling: (runnerId: string | undefined) => void;
}) {
  const label = roundLabel(batch.retryMode, summary.round);
  const router = useRouter();
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const passedRunsSoFar = useMemo(() => {
    const passed = new Set<string>();
    for (const attempt of batch.attempts) {
      if (attempt.attemptNumber <= summary.round && attempt.outcome === "succeeded") {
        passed.add(attempt.executionRunId);
      }
    }
    return passed.size;
  }, [batch.attempts, summary.round]);
  const inProgress = Math.max(
    0,
    summary.executed - summary.passed - summary.failed - summary.timedOut - summary.cancelled,
  );
  const resultSegments: DonutChartSegment[] = [
    { label: "通过", value: summary.passed, color: "var(--color-success)" },
    { label: "失败", value: summary.failed, color: "var(--color-danger)" },
    { label: "超时", value: summary.timedOut, color: "var(--color-warning)" },
    { label: "进行中", value: inProgress, color: "var(--color-info)" },
    { label: "取消", value: summary.cancelled, color: "var(--color-text-tertiary)" },
  ];
  const progressSegments: DonutChartSegment[] = [
    { label: "累计通过", value: passedRunsSoFar, color: "var(--color-success)" },
    {
      label: "未通过",
      value: Math.max(0, batch.totalRuns - passedRunsSoFar),
      color: "var(--color-border-strong)",
    },
  ];

  return (
    <section className="round-detail-panel" aria-label={`轮次详情：${label}`}>
      <div className="round-detail-header">
        <div className="round-detail-title">
          <h2>{label}</h2>
          <span className={`batch-status ${roundStatusClass(summary)}`.trim()}>
            {roundStatusLabel(summary, batch.currentRound)}
          </span>
          {summary.status === "running" && canReadLogs ? (
            <span className="status-badge">实时更新</span>
          ) : null}
        </div>
        <div className="round-detail-header-actions">
          <Button
            className="button button-secondary compact-button"
            onClick={() => router.refresh()}
            type="button"
            title="重新从服务端拉取最新执行状态"
          >
            <RefreshCw size={15} /> 刷新
          </Button>
          {canReadLogs ? (
            <Button
              className="button button-secondary compact-button"
              onClick={() => onOpenScheduling(undefined)}
              type="button"
            >
              <ScrollText size={15} /> 总体调度日志
            </Button>
          ) : null}
          {canReadLogs ? (
            <Button
              className="button button-secondary compact-button"
              onClick={() => setExportDialogOpen(true)}
              type="button"
            >
              <Download size={15} /> 导出结果
            </Button>
          ) : null}
        </div>
      </div>
      {exportDialogOpen ? (
        <RunBatchExportDialog
          batchId={batch.id}
          round={summary.round}
          roundLabelText={label}
          onClose={() => setExportDialogOpen(false)}
        />
      ) : null}
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="round-detail-body">
        <div className="round-donuts">
          <div className="round-donut-block">
            <h3>本轮结果分布</h3>
            <DonutChart
              segments={resultSegments}
              centerValue={String(summary.executed)}
              centerLabel="已执行"
              ariaLabel={`本轮结果分布：通过 ${summary.passed}，失败 ${summary.failed}，超时 ${summary.timedOut}，进行中 ${inProgress}，取消 ${summary.cancelled}`}
            />
          </div>
          <div className="round-donut-block">
            <h3>总体通过进度</h3>
            <DonutChart
              segments={progressSegments}
              centerValue={`${summary.overallPassRate}%`}
              centerLabel="总通过率"
              ariaLabel={`截至本轮总体通过进度：累计通过 ${passedRunsSoFar} 个用例，共 ${batch.totalRuns} 个`}
            />
          </div>
        </div>
        <div className="round-tab-content">
          <div className="segmented-control" aria-label="轮次详情视图">
            <Button
              aria-pressed={activeTab === "cases"}
              className={activeTab === "cases" ? "active" : ""}
              onClick={() => onTabChange("cases")}
              type="button"
            >
              用例
            </Button>
            <Button
              aria-pressed={activeTab === "runners"}
              className={activeTab === "runners" ? "active" : ""}
              onClick={() => onTabChange("runners")}
              type="button"
            >
              执行机
            </Button>
          </div>
          {activeTab === "cases" ? (
            <RoundCasesTable
              key={summary.round}
              batch={batch}
              round={summary.round}
              canCancelRuns={canCancelRuns}
              canReadLogs={canReadLogs}
              canReadArtifacts={canReadArtifacts}
              artifactsEnabled={artifactsEnabled}
              runnerDirectory={runnerDirectory}
              cancelPending={cancelPending}
              detailCache={detailCache}
              onRememberAttemptDetail={onRememberAttemptDetail}
              onCancelRun={onCancelRun}
              onOpenLogs={onOpenLogs}
            />
          ) : (
            <RoundRunnerCards
              batch={batch}
              round={summary.round}
              canReadLogs={canReadLogs}
              runnerDirectory={runnerDirectory}
              onOpenScheduling={onOpenScheduling}
            />
          )}
        </div>
      </div>
    </section>
  );
}

type CaseSortKey = "name" | "status" | "runner" | "duration";

type CaseSortSpec = {
  key: CaseSortKey | "none";
  direction: "asc" | "desc";
};

function compareRowsBy(
  left: RoundCaseRowModel,
  right: RoundCaseRowModel,
  key: CaseSortKey,
): number {
  switch (key) {
    case "name":
      return left.run.displayName.localeCompare(right.run.displayName, "zh-CN");
    case "status":
      return compareRoundCaseRowsByStatus(left, right);
    case "runner": {
      const leftRunner = left.attempt?.runnerId ?? left.run.assignedRunnerId ?? "";
      const rightRunner = right.attempt?.runnerId ?? right.run.assignedRunnerId ?? "";
      return leftRunner.localeCompare(rightRunner);
    }
    case "duration": {
      // 无耗时的行排在有耗时之后（升序时），无穷大之间视为相等避免 NaN。
      const leftDuration = left.attempt?.durationMs ?? Number.POSITIVE_INFINITY;
      const rightDuration = right.attempt?.durationMs ?? Number.POSITIVE_INFINITY;
      if (leftDuration === rightDuration) return 0;
      return leftDuration - rightDuration;
    }
  }
}

function RoundCasesTable({
  batch,
  round,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  cancelPending,
  detailCache,
  onRememberAttemptDetail,
  onCancelRun,
  onOpenLogs,
}: {
  batch: RunBatchDetails;
  /** 具体轮次号，或 "all" 表示全部轮次虚拟视图（逐条 attempt 一行）。 */
  round: number | "all";
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  cancelPending: boolean;
  detailCache: ReadonlyMap<string, AttemptDetailEntry>;
  onRememberAttemptDetail: (attemptId: string, entry: AttemptDetailEntry) => void;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
}) {
  const rows = useMemo<RoundCaseRowModel[]>(() => buildRoundCaseRows(batch, round), [batch, round]);
  const showRoundColumn = round === "all";
  const [statusFilter, setStatusFilter] = useState<CaseStatusFilter>("all");
  const [nameQuery, setNameQuery] = useState("");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_CASE_PAGE_SIZE);
  const [page, setPage] = useState(1);
  // 不再自动展开行内详情：无论单用例还是多用例，都需用户主动点击详情。
  const [expandedAttemptId, setExpandedAttemptId] = useState<string | undefined>();
  const [sortSpec, setSortSpec] = useState<CaseSortSpec>({ key: "none", direction: "asc" });
  const columnWidths = useMemo(
    () => ({
      case: columnCharacterWidthAtCoverage(
        rows.map((row) => widestText([row.run.displayName, row.run.className])),
        { minimum: 22, maximum: 42 },
      ),
      status: columnCharacterWidthAtCoverage(
        rows.map((row) =>
          widestText(
            (row.attempt
              ? `${attemptStatusLabel(row.attempt)} ${attemptFailureHint(row.attempt) ?? ""}`
              : "未执行"
            ).split(/\r?\n/),
          ),
        ),
        { minimum: 12, maximum: 36 },
      ),
      runner: columnCharacterWidthAtCoverage(
        rows.map((row) => {
          const runnerId = row.attempt?.runnerId ?? row.run.assignedRunnerId;
          return runnerId ? runnerDisplayName(runnerId, runnerDirectory) : "—";
        }),
        { minimum: 10, maximum: 24 },
      ),
    }),
    [rows, runnerDirectory],
  );

  const filteredRows = useMemo(() => {
    const keyword = nameQuery.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (statusFilter !== "all" && rowStatusKey(row) !== statusFilter) return false;
      if (!keyword) return true;
      return `${row.run.displayName} ${row.run.className}`.toLowerCase().includes(keyword);
    });
    if (sortSpec.key === "none") return filtered;
    const direction = sortSpec.direction === "asc" ? 1 : -1;
    const sortKey = sortSpec.key;
    return [...filtered].sort((left, right) => {
      const comparison = compareRowsBy(left, right, sortKey);
      // 排序键相同时按用例名兜底，保证结果稳定。
      return (
        (comparison !== 0
          ? comparison
          : left.run.displayName.localeCompare(right.run.displayName, "zh-CN")) * direction
      );
    });
  }, [nameQuery, rows, sortSpec, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function rowStatusKey(row: RoundCaseRowModel): CaseStatusFilter {
    if (!row.attempt) return "pending";
    if (row.attempt.status === "assigned" || row.attempt.status === "running") return "all";
    return row.attempt.status;
  }

  function toggleSort(key: CaseSortKey): void {
    setSortSpec((current) => {
      if (current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      // 第三次点击同一列恢复默认顺序。
      return { key: "none", direction: "asc" };
    });
  }

  return (
    <div className="round-cases">
      <div className="round-filter-row">
        <Select
          aria-label="按状态筛选"
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value as CaseStatusFilter);
            setPage(1);
          }}
        >
          <option value="all">全部状态</option>
          <option value="succeeded">通过</option>
          <option value="failed">失败</option>
          <option value="timed_out">超时</option>
          <option value="cancelled">取消</option>
          <option value="pending">未执行</option>
        </Select>
        <span className="round-filter-search">
          <Search size={15} aria-hidden="true" />
          <Input
            aria-label="按名称搜索用例"
            placeholder="搜索用例或类名"
            value={nameQuery}
            onChange={(event) => {
              setNameQuery(event.target.value);
              setPage(1);
            }}
          />
        </span>
      </div>
      {filteredRows.length === 0 ? (
        <div className="inline-empty">没有匹配当前筛选条件的用例。</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table execution-case-table">
            <colgroup>
              <col style={{ width: `${columnWidths.case}ch` }} />
              {showRoundColumn ? <col className="case-column-round" /> : null}
              <col style={{ width: `${columnWidths.status}ch` }} />
              <col style={{ width: `${columnWidths.runner}ch` }} />
              <col className="case-column-duration" />
              <col className="case-column-actions" />
            </colgroup>
            <thead>
              <tr>
                <SortableCaseTh
                  label="用例"
                  sortKey="name"
                  active={sortSpec}
                  onToggle={() => toggleSort("name")}
                />
                {showRoundColumn ? <th>轮次</th> : null}
                <SortableCaseTh
                  label={showRoundColumn ? "状态" : "本轮状态"}
                  sortKey="status"
                  active={sortSpec}
                  onToggle={() => toggleSort("status")}
                />
                <SortableCaseTh
                  label="Runner"
                  sortKey="runner"
                  active={sortSpec}
                  onToggle={() => toggleSort("runner")}
                />
                <SortableCaseTh
                  label="耗时"
                  sortKey="duration"
                  active={sortSpec}
                  onToggle={() => toggleSort("duration")}
                />
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <RoundCaseRow
                  key={row.attempt ? row.attempt.id : `${row.run.id}:${row.round}`}
                  row={row}
                  showRoundColumn={showRoundColumn}
                  expanded={expandedAttemptId === row.attempt?.id}
                  onToggleDetail={() =>
                    setExpandedAttemptId((current) =>
                      current === row.attempt?.id ? undefined : row.attempt?.id,
                    )
                  }
                  canCancelRuns={canCancelRuns}
                  canReadLogs={canReadLogs}
                  canReadArtifacts={canReadArtifacts}
                  artifactsEnabled={artifactsEnabled}
                  runnerDirectory={runnerDirectory}
                  cancelPending={cancelPending}
                  detailEntry={row.attempt ? detailCache.get(row.attempt.id) : undefined}
                  onRememberDetail={onRememberAttemptDetail}
                  onCancelRun={onCancelRun}
                  onOpenLogs={onOpenLogs}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="round-pagination">
        <label className="round-page-size">
          每页
          <Select
            aria-label="每页显示用例数"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {CASE_PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
          个用例
        </label>
        <Button
          className="button button-secondary compact-button"
          disabled={currentPage <= 1}
          onClick={() => setPage(currentPage - 1)}
          type="button"
        >
          <ChevronLeft size={15} /> 上一页
        </Button>
        <span>
          第 {currentPage} / {pageCount} 页 · 共 {filteredRows.length} 条
        </span>
        <Button
          className="button button-secondary compact-button"
          disabled={currentPage >= pageCount}
          onClick={() => setPage(currentPage + 1)}
          type="button"
        >
          下一页 <ChevronRight size={15} />
        </Button>
      </div>
    </div>
  );
}

function SortableCaseTh({
  label,
  sortKey,
  active,
  onToggle,
}: {
  label: string;
  sortKey: CaseSortKey;
  active: CaseSortSpec;
  onToggle: () => void;
}) {
  const isActive = active.key === sortKey;
  return (
    <th aria-sort={isActive ? (active.direction === "asc" ? "ascending" : "descending") : "none"}>
      <Button
        className="sortable-th-button"
        variant="ghost"
        size="compact"
        onClick={onToggle}
        type="button"
      >
        {label}
        <span aria-hidden="true" className="sortable-th-indicator">
          {isActive ? (active.direction === "asc" ? "▲" : "▼") : ""}
        </span>
      </Button>
    </th>
  );
}

function RoundCaseRow({
  row,
  expanded,
  onToggleDetail,
  showRoundColumn,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  cancelPending,
  detailEntry,
  onRememberDetail,
  onCancelRun,
  onOpenLogs,
}: {
  row: RoundCaseRowModel;
  expanded: boolean;
  onToggleDetail: () => void;
  /** 全部轮次视图下展示 attempt 所属轮次列。 */
  showRoundColumn: boolean;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  cancelPending: boolean;
  detailEntry: AttemptDetailEntry | undefined;
  onRememberDetail: (attemptId: string, entry: AttemptDetailEntry) => void;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
}) {
  const { run, attempt } = row;
  const runnerId = attempt?.runnerId ?? run.assignedRunnerId;
  const [sharePending, setSharePending] = useState(false);
  const [shareError, setShareError] = useState("");
  const hasDetail =
    attempt !== undefined &&
    isTerminalAttemptStatus(attempt.status) &&
    (attempt.testNg !== undefined || canReadArtifacts);
  // 终态 attempt 可创建日志公开访问链接；后端校验项目权限并签发永久有效链接。
  const canShareLog = attempt !== undefined && isTerminalAttemptStatus(attempt.status);

  async function openShareLog(): Promise<void> {
    if (!attempt) return;
    setSharePending(true);
    setShareError("");
    try {
      const response = await fetch(
        `/api/v1/run-attempts/${encodeURIComponent(attempt.id)}/log-share`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "创建日志公开访问链接失败。"))!);
      }
      const payload = (await response.json()) as { shareUrl: string };
      window.open(payload.shareUrl, "_blank", "noopener");
    } catch (shareFailure) {
      setShareError(
        shareFailure instanceof Error ? shareFailure.message : "创建日志公开访问链接失败。",
      );
    } finally {
      setSharePending(false);
    }
  }

  return (
    <>
      <tr>
        <td>
          <strong>{run.displayName}</strong>
          <small className="table-secondary">{run.className}</small>
        </td>
        {showRoundColumn ? <td className="round-cell-nowrap">第 {row.round} 轮</td> : null}
        <td>
          {attempt ? (
            <>
              <span className={`batch-status ${attemptStatusClass(attempt)}`.trim()}>
                {attemptStatusLabel(attempt)}
              </span>
              {/* 终态失败提示直接露出，无需展开详情：adapter 正常失败显示完整描述，
                  blocked（重启协调、超时等）显示原因码。 */}
              {isTerminalAttemptStatus(attempt.status) && attempt.status !== "succeeded" ? (
                <AttemptFailureHintLine attempt={attempt} />
              ) : null}
            </>
          ) : (
            <span className="batch-status batch-status-neutral">未执行</span>
          )}
        </td>
        {/* 执行机优先展示注册名称（一般为 runner-IP），title 保留完整 UUID。 */}
        <td>
          {runnerId ? (
            <span className="round-runner-name" title={runnerId}>
              {runnerDisplayName(runnerId, runnerDirectory)}
            </span>
          ) : (
            "—"
          )}
        </td>
        <td>
          {attempt?.durationMs === undefined ? "—" : formatAttemptDuration(attempt.durationMs)}
        </td>
        <td>
          <div className="round-row-actions">
            {attempt && canReadLogs ? (
              <Button
                className="button button-secondary compact-button"
                onClick={() => onOpenLogs(attempt)}
                type="button"
              >
                <Eye size={15} /> 查看日志
              </Button>
            ) : null}
            {canShareLog ? (
              <Button
                className="button button-secondary compact-button"
                disabled={sharePending}
                onClick={() => void openShareLog()}
                type="button"
                title="生成日志公开访问链接并在新窗口打开"
              >
                <Globe size={15} /> 公开日志
              </Button>
            ) : null}
            {hasDetail && attempt ? (
              <Button
                className="button button-secondary compact-button"
                aria-expanded={expanded}
                onClick={onToggleDetail}
                type="button"
              >
                <FileText size={15} /> 详情
              </Button>
            ) : null}
            {canCancelRuns && canCancelRoundCaseRow(row) ? (
              <Button
                className="danger-text-button"
                disabled={cancelPending}
                onClick={() => onCancelRun(run.id)}
                type="button"
              >
                取消该用例
              </Button>
            ) : null}
          </div>
          {shareError ? <p className="form-error">{shareError}</p> : null}
        </td>
      </tr>
      {expanded && attempt ? (
        <tr className="round-detail-row">
          <td colSpan={showRoundColumn ? 6 : 5}>
            <AttemptInlineDetail
              attempt={attempt}
              canReadArtifacts={canReadArtifacts}
              artifactsEnabled={artifactsEnabled}
              cached={detailEntry}
              onRemember={onRememberDetail}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AttemptInlineDetail({
  attempt,
  canReadArtifacts,
  artifactsEnabled,
  cached,
  onRemember,
}: {
  attempt: RunAttempt;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  cached: AttemptDetailEntry | undefined;
  onRemember: (attemptId: string, entry: AttemptDetailEntry) => void;
}) {
  const [artifacts, setArtifacts] = useState<AttemptArtifactList["items"] | undefined>(
    cached?.artifacts,
  );
  const [events, setEvents] = useState<AttemptEventPage["items"] | undefined>(cached?.events);
  const [error, setError] = useState(cached?.error ?? "");
  // 已缓存的详情不再请求：展开/收起/翻页后重开复用首次加载结果。
  const [loaded, setLoaded] = useState(
    () => cached !== undefined && (cached.artifacts !== undefined || cached.events !== undefined),
  );

  useEffect(() => {
    if (loaded) return;
    let disposed = false;
    const load = async (): Promise<void> => {
      setError("");
      try {
        const [artifactResponse, eventResponse] = await Promise.all([
          canReadArtifacts && artifactsEnabled
            ? fetch(`/api/v1/run-attempts/${encodeURIComponent(attempt.id)}/artifacts`, {
                cache: "no-store",
              })
            : null,
          fetch(`/api/v1/run-attempts/${encodeURIComponent(attempt.id)}/events?limit=200`, {
            cache: "no-store",
          }),
        ]);
        if (artifactResponse && !artifactResponse.ok) {
          throw new Error((await readApiErrorMessage(artifactResponse, "读取产物失败。"))!);
        }
        if (!eventResponse.ok) {
          throw new Error((await readApiErrorMessage(eventResponse, "读取执行时间线失败。"))!);
        }
        if (disposed) return;
        const nextArtifacts = artifactResponse
          ? ((await artifactResponse.json()) as AttemptArtifactList).items
          : undefined;
        const nextEvents = ((await eventResponse.json()) as AttemptEventPage).items;
        setArtifacts(nextArtifacts);
        setEvents(nextEvents);
        setLoaded(true);
        onRemember(attempt.id, { artifacts: nextArtifacts, events: nextEvents });
      } catch (loadError) {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : "读取执行详情失败。");
        }
      }
    };
    const kick = window.setTimeout(() => void load(), 0);
    return () => {
      disposed = true;
      window.clearTimeout(kick);
    };
  }, [attempt.id, artifactsEnabled, canReadArtifacts, loaded, onRemember]);

  return (
    <div className="attempt-inline-detail">
      {error ? <p className="form-error">{error}</p> : null}
      {attempt.testNg ? (
        <div className="attempt-inline-block">
          <h3>结构化测试结果</h3>
          <TestNgResults result={attempt.testNg} />
        </div>
      ) : null}
      {/* 产物收集全局开关关闭时，不展示产物区块（服务端也未收集任何产物）。 */}
      {artifactsEnabled ? (
        <div className="attempt-inline-block">
          <h3>产物</h3>
          {!canReadArtifacts ? (
            <div className="inline-empty">当前账号没有读取执行产物的权限。</div>
          ) : artifacts === undefined ? (
            <div className="inline-empty">正在读取产物...</div>
          ) : artifacts.length === 0 ? (
            <div className="inline-empty">当前尝试没有已声明产物。</div>
          ) : (
            <div className="artifact-list">
              {artifacts.map((artifact) => (
                <div className="artifact-row" key={artifact.artifactId}>
                  <FileText size={17} />
                  <span>
                    <strong>{artifact.relativePath}</strong>
                    <small>
                      {formatArtifactBytes(artifact.sizeBytes)} · {artifact.status}
                    </small>
                  </span>
                  {artifact.downloadPath ? (
                    <span className="artifact-actions">
                      {isPreviewable(artifact.mediaType) ? (
                        <a
                          className="icon-button small-icon-button"
                          href={`${artifact.downloadPath}?preview=1`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`预览 ${artifact.relativePath}`}
                        >
                          <Eye size={15} />
                        </a>
                      ) : null}
                      <a
                        className="icon-button small-icon-button"
                        href={artifact.downloadPath}
                        aria-label={`下载 ${artifact.relativePath}`}
                      >
                        <Download size={15} />
                      </a>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      <div className="attempt-inline-block">
        <h3>状态事件</h3>
        {events === undefined ? (
          <div className="inline-empty">正在读取状态事件...</div>
        ) : events.length === 0 ? (
          <div className="inline-empty">当前尝试暂无状态事件。</div>
        ) : (
          <ol className="execution-timeline">
            {events.map((event) => (
              <li key={event.eventId}>
                <span className="timeline-marker" aria-hidden="true" />
                <div>
                  <strong>{eventLabel(event.eventType)}</strong>
                  <span>
                    {event.fromStatus && event.toStatus
                      ? `${event.fromStatus} → ${event.toStatus}`
                      : (event.toStatus ?? event.fromStatus ?? event.reasonCode ?? "状态记录")}
                  </span>
                  <small>
                    UTC {event.recordedAt}
                    {event.reasonCode ? ` · ${event.reasonCode}` : ""}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function RoundRunnerCards({
  batch,
  round,
  canReadLogs,
  runnerDirectory,
  onOpenScheduling,
}: {
  batch: RunBatchDetails;
  round: number;
  canReadLogs: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  onOpenScheduling: (runnerId: string | undefined) => void;
}) {
  const cards = useMemo(() => {
    const byRunner = new Map<
      string,
      { executed: number; passed: number; failed: number; lastActivity: string }
    >();
    for (const attempt of batch.attempts) {
      if (attempt.attemptNumber !== round) continue;
      const entry = byRunner.get(attempt.runnerId) ?? {
        executed: 0,
        passed: 0,
        failed: 0,
        lastActivity: attempt.createdAt,
      };
      entry.executed += 1;
      if (attempt.outcome === "succeeded") entry.passed += 1;
      if (attempt.outcome === "failed" || attempt.outcome === "timed_out") entry.failed += 1;
      const activity = attempt.finishedAt ?? attempt.startedAt ?? attempt.createdAt;
      if (Date.parse(activity) > Date.parse(entry.lastActivity)) entry.lastActivity = activity;
      byRunner.set(attempt.runnerId, entry);
    }
    return [...byRunner.entries()];
  }, [batch.attempts, round]);

  if (cards.length === 0) {
    return <div className="inline-empty">本轮还没有执行机参与执行。</div>;
  }
  return (
    <div className="runner-card-grid">
      {cards.map(([runnerId, card]) => {
        const directoryEntry = runnerDirectory.get(runnerId);
        const resourceSnapshot = directoryEntry?.resourceSnapshot;
        return (
          <div className="runner-card" key={runnerId}>
            <div className="runner-card-heading">
              <strong title={runnerId}>{directoryEntry?.name || shortId(runnerId)}</strong>
              <span className="muted">本轮执行 {card.executed} 个</span>
            </div>
            <div className="runner-card-stats">
              <span>通过 {card.passed}</span>
              <span>失败 {card.failed}</span>
            </div>
            {resourceSnapshot ? (
              <small
                className="muted runner-card-resources"
                title={`采集于 UTC ${resourceSnapshot.observedAt}`}
              >
                {runnerResourceLabel(resourceSnapshot)}
              </small>
            ) : (
              <small className="muted runner-card-resources">暂无资源快照</small>
            )}
            <small className="muted">
              最后活动{" "}
              <time title={`UTC ${card.lastActivity}`}>
                {formatLocalDateTime(card.lastActivity)}
              </time>
            </small>
            {canReadLogs ? (
              <Button
                className="button button-secondary compact-button"
                onClick={() => onOpenScheduling(runnerId)}
                type="button"
              >
                <ScrollText size={15} /> 调度日志
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TestNgResults({ result }: { result: NonNullable<RunAttempt["testNg"]> }) {
  return (
    <div className="testng-results">
      <div className="testng-counts" aria-label="TestNG 结果汇总">
        <TestNgCount label="总计" value={result.total} />
        <TestNgCount label="通过" value={result.passed} />
        <TestNgCount label="失败" value={result.failed} />
        <TestNgCount label="跳过" value={result.skipped} />
        <TestNgCount label="配置失败" value={result.configurationFailures} />
      </div>
      {result.detailsTruncated ? (
        <p className="result-notice">明细已达到安全解析上限；汇总计数仍包含完整报告。</p>
      ) : null}
      {result.suites.map((suite, suiteIndex) => (
        <details
          className="testng-suite"
          key={`${suite.name}-${suiteIndex}`}
          open={suiteIndex === 0}
        >
          <summary>
            <span>{suite.name}</span>
            <small>
              {suite.passed}/{suite.total} 通过 · {formatAttemptDuration(suite.durationMs)}
            </small>
          </summary>
          {suite.tests.map((test, testIndex) => (
            <div className="testng-test" key={`${test.name}-${testIndex}`}>
              <div className="testng-scope-heading">
                <strong>{test.name}</strong>
                <span>{formatAttemptDuration(test.durationMs)}</span>
              </div>
              {test.classes.map((classResult, classIndex) => (
                <div className="testng-class" key={`${classResult.name}-${classIndex}`}>
                  <div className="testng-scope-heading">
                    <code>{classResult.name}</code>
                    <span>{formatAttemptDuration(classResult.durationMs)}</span>
                  </div>
                  <div className="table-scroll">
                    <table className="data-table testng-method-table">
                      <thead>
                        <tr>
                          <th>方法</th>
                          <th>类型</th>
                          <th>状态</th>
                          <th>耗时</th>
                        </tr>
                      </thead>
                      <tbody>
                        {classResult.methods.map((method, methodIndex) => (
                          <tr key={`${method.name}-${method.signature ?? ""}-${methodIndex}`}>
                            <td>
                              <strong>{method.name}</strong>
                              {method.signature ? (
                                <small className="table-secondary">{method.signature}</small>
                              ) : null}
                            </td>
                            <td>{method.configuration ? "配置" : "测试"}</td>
                            <td>{testNgStatusLabel(method.status)}</td>
                            <td>{formatAttemptDuration(method.durationMs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}

function TestNgCount({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function isPreviewable(mediaType: string): boolean {
  return [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
  ].includes(mediaType);
}

function testNgStatusLabel(status: "passed" | "failed" | "skipped"): string {
  return { passed: "通过", failed: "失败", skipped: "跳过" }[status];
}

function eventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "assignment.claimed": "Runner 已领取",
    "attempt.completed": "执行已完成",
    "attempt.cancelled": "执行已取消",
    "attempt.completion_conflict": "完成结果冲突",
    "assignment.claim_timed_out": "领取超时",
    "attempt.execution_timed_out": "执行超时",
    "lease.expired": "租约已过期",
  };
  return labels[eventType] ?? eventType;
}
