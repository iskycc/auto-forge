"use client";
import { LoadingIcon } from "./ui/loading-icon";
import { Timeline } from "antd";

import { LoadingStateMessage } from "@/components/ui/loading-state-message";

import { EmptyState } from "@/components/ui/empty-state";

import { Segmented } from "./ui/segmented";
import { Notice } from "@/components/ui/notice";

import { Badge } from "@/components/ui/badge";

import { Disclosure } from "@/components/ui/disclosure";

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

import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";

import type { AttemptArtifactList, AttemptEventPage } from "@autoforge/contracts";
import type {
  RunAttempt,
  RunBatchRoundRecovery,
  RunBatchRoundSummary,
  RunnerResourceSnapshot,
} from "@autoforge/domain";
import { isTerminalAttemptStatus } from "@autoforge/domain";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Globe,
  AlertTriangle,
  RefreshCw,
  ScrollText,
  Search,
} from "lucide-react";
import { LinkButton } from "@/components/ui/link-button";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AttemptLogViewer } from "@/components/attempt-log-viewer";
import { DonutChart, type DonutChartSegment } from "@/components/donut-chart";
import { RunBatchExportDialog } from "@/components/run-batch-export-dialog";
import { RunnerFaultDialog } from "@/components/runner-fault-dialog";
import { SchedulingLogViewer } from "@/components/scheduling-log-viewer";
import { Button, Input, Select } from "@/components/ui";
import { LoadingState } from "@/components/loading-state";
import { usePrompt } from "@/components/ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";
import type { ExecutionBatchView } from "@/lib/execution-batch-view";
import { canCancelRoundCaseRow, type RoundCaseRowModel } from "@/lib/round-case-rows";
import {
  attemptFailureHint,
  formatArtifactBytes,
  formatAttemptDuration,
  formatBatchDuration,
  formatLocalDateTime,
} from "@/lib/run-batch-presentation";
import { columnCharacterWidthAtCoverage, widestText } from "@/lib/table-column-width";
import {
  executionCaseColumnWidthsRem,
  minimumCaseNameWidthCh,
  sharedExecutionColumnLayout,
} from "@/lib/shared-execution-column-layout";

const DEFAULT_CASE_PAGE_SIZE = 50;
const EMPTY_CASE_ROWS: RoundCaseRowModel[] = [];
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

type CaseStatusFilter = "all" | "pending" | RunAttempt["status"];

type RecoveryGroup = {
  afterRound: number;
  steps: RunBatchRoundRecovery[];
  activatedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled";
};

// 轮次行命名：第 1 轮是初始执行，round 模式之后叫「重跑第 N 轮」，
// immediate 模式按第几次尝试叫「重试第 N 次」，两种模式的文案不得混用。
function roundLabel(retryMode: ExecutionBatchView["retryMode"], round: number): string {
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

function recoveryGroups(recoveries: readonly RunBatchRoundRecovery[]): RecoveryGroup[] {
  const grouped = new Map<number, RunBatchRoundRecovery[]>();
  for (const recovery of recoveries) {
    // 尚未触发的未来规则不占时间线；被用户在触发前取消的规则也没有激活时间。
    if (!recovery.activatedAt) continue;
    const group = grouped.get(recovery.afterRound) ?? [];
    group.push(recovery);
    grouped.set(recovery.afterRound, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([afterRound, steps]) => {
      const activatedAt = steps.reduce(
        (earliest, step) =>
          Date.parse(step.activatedAt!) < Date.parse(earliest) ? step.activatedAt! : earliest,
        steps[0]!.activatedAt!,
      );
      const terminal = steps.every((step) =>
        ["succeeded", "failed", "cancelled"].includes(step.status),
      );
      const finishedAt = terminal
        ? steps.reduce(
            (latest, step) =>
              Date.parse(step.updatedAt) > Date.parse(latest) ? step.updatedAt : latest,
            steps[0]!.updatedAt,
          )
        : null;
      const status = steps.some((step) => step.status === "failed")
        ? "failed"
        : steps.every((step) => step.status === "succeeded")
          ? "succeeded"
          : terminal
            ? "cancelled"
            : "running";
      return { afterRound, steps, activatedAt, finishedAt, status };
    });
}

function recoveryStatusLabel(status: RecoveryGroup["status"]): string {
  if (status === "succeeded") return "恢复完成";
  if (status === "failed") return "恢复失败";
  if (status === "cancelled") return "已取消";
  return "恢复中";
}

function recoveryStatusClass(status: RecoveryGroup["status"]): string {
  if (status === "succeeded") return "batch-status-succeeded";
  if (status === "failed") return "batch-status-failed";
  if (status === "cancelled") return "batch-status-neutral";
  return "";
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
    <small
      className={cn(
        "table-secondary attempt-failure-line",
        uiPatterns["table-secondary"],
        runBatchRoundsStyles["attempt-failure-line"],
      )}
      title={hint}
    >
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
  canCreateRuns,
  canReadAttemptEvents,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  onRefresh,
}: {
  batch: ExecutionBatchView;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canCreateRuns: boolean;
  canReadAttemptEvents: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: readonly RunnerDirectoryEntry[];
  onRefresh: () => void;
}) {
  const promptAction = usePrompt();
  const searchParams = useSearchParams();
  const summaries = batch.roundSummaries;
  const recoveries = useMemo(() => recoveryGroups(batch.roundRecoveries), [batch.roundRecoveries]);
  const concurrencyByRound = useMemo(
    () => new Map((batch.roundConcurrencies ?? []).map((entry) => [entry.round, entry])),
    [batch.roundConcurrencies],
  );
  const runnerDirectoryById = useMemo(
    () => new Map(runnerDirectory.map((entry) => [entry.id, entry])),
    [runnerDirectory],
  );
  const requestedRoundParam = searchParams.get("round");
  // round=all/summary 都是虚拟轮次，不对应持久化的 executionRound。
  const allRoundsSelected = requestedRoundParam === "all";
  const summarySelected = requestedRoundParam === "summary";
  const requestedRecoveryRound = requestedRoundParam?.match(/^recovery-(\d+)$/u)?.[1];
  const selectedRecovery = recoveries.find(
    (recovery) => recovery.afterRound === Number(requestedRecoveryRound),
  );
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
  const allRoundsStats = batch.allRoundsSummary;
  const finalStats = batch.finalSummary;
  const [activeTab, setActiveTab] = useState<"cases" | "runners">("cases");
  const [logAttempt, setLogAttempt] = useState<RunAttempt | undefined>();
  const [schedulingViewer, setSchedulingViewer] = useState<
    { runnerId?: string; title: string } | undefined
  >();
  const [cancelPending, setCancelPending] = useState(false);
  const [actionError, setActionError] = useState("");
  // 行内详情缓存按批次组件生命周期存活；概要与当前用例页局部刷新时，
  // 缓存仍按 attemptId 复用已加载的产物与事件。
  const [detailCache, setDetailCache] = useState<Map<string, AttemptDetailEntry>>(new Map());

  const rememberAttemptDetail = useCallback((attemptId: string, entry: AttemptDetailEntry) => {
    setDetailCache((current) => {
      const next = new Map(current);
      next.set(attemptId, entry);
      return next;
    });
  }, []);

  function selectRound(round: number | "all" | "summary" | `recovery-${number}`): void {
    const parameters = new URLSearchParams(searchParams.toString());
    parameters.set("round", String(round));
    // 轮次详情的数据由当前客户端组件按页读取，切换轮次不需要重新执行整棵
    // Server Component。原先 router.replace 会重复查询批次概要并造成明显卡顿；
    // 原生 history API 仍会同步 Next.js 的 useSearchParams，同时保留可刷新 URL。
    window.history.replaceState(null, "", `${window.location.pathname}?${parameters.toString()}`);
  }

  async function cancelRun(runId: string): Promise<void> {
    const reason = await promptAction({
      title: "取消用例执行",
      description: "取消原因会写入执行事件，方便后续审计与问题定位。",
      inputLabel: "取消原因",
      initialValue: "Cancelled from execution details.",
      multiline: true,
      confirmLabel: "确认取消",
      tone: "danger",
    });
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
      onRefresh();
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "取消用例执行失败。");
    } finally {
      setCancelPending(false);
    }
  }

  if (batch.statistics && !batch.statistics.generation)
    return (
      <Card
        as="section"
        className={cn("content-card", uiPatterns["content-card"])}
        aria-label="轮次列表"
      >
        <LoadingStateMessage role="status">
          后台正在准备轮次统计，执行控制仍可使用。
        </LoadingStateMessage>
      </Card>
    );
  return (
    <>
      <section aria-label="轮次列表">
        <div className={cn("section-heading", uiPatterns["section-heading"])}>
          <div>
            <span className={cn("step-label", runBatchRoundsStyles["step-label"])}>ROUNDS</span>
            <h2>轮次</h2>
          </div>
          <span className={cn("muted", uiPatterns["muted"])}>
            共 {summaries.length} 轮
            {recoveries.length > 0 ? ` · ${recoveries.length} 次环境恢复` : ""}
          </span>
        </div>
        <div
          className={cn(
            "table-scroll round-table-scroll",
            uiPatterns["table-scroll"],
            runBatchRoundsStyles["round-table-scroll"],
          )}
        >
          <Table
            className={cn(
              "data-table execution-round-table",
              uiPatterns["data-table"],
              runBatchRoundsStyles["execution-round-table"],
            )}
          >
            <colgroup>
              <col className={"round-column-name"} />
              <col className={"round-column-status"} />
              <col className={"round-column-count"} />
              <col className={"round-column-count"} span={6} />
              <col className={"round-column-start"} />
              <col className={"round-column-duration"} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>轮次</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>并发数</TableHead>
                <TableHead>总用例数</TableHead>
                <TableHead>总通过率</TableHead>
                <TableHead>轮次通过率</TableHead>
                <TableHead>通过数</TableHead>
                <TableHead>失败数</TableHead>
                <TableHead>未执行数</TableHead>
                <TableHead>开始时间</TableHead>
                <TableHead>轮次时长</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                className={summarySelected ? "selected-row" : undefined}
                onClick={() => selectRound("summary")}
              >
                <TableCell>
                  <Button
                    aria-pressed={summarySelected}
                    className={cn(
                      "round-select-button",
                      runBatchRoundsStyles["round-select-button"],
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectRound("summary");
                    }}
                    size="compact"
                    type="button"
                    variant="ghost"
                  >
                    总结
                  </Button>
                </TableCell>
                <TableCell>
                  <Badge
                    className={cn(
                      runBatchRoundsStyles["batch-status"],
                      `batch-status ${batch.status === "succeeded" ? cn("batch-status-succeeded", runBatchRoundsStyles["batch-status-succeeded"]) : batch.status === "failed" ? cn("batch-status-failed", runBatchRoundsStyles["batch-status-failed"]) : batch.status === "cancelled" ? cn("batch-status-neutral", runBatchRoundsStyles["batch-status-neutral"]) : ""}`,
                    ).trim()}
                  >
                    {batch.status === "cancelled"
                      ? "已终止"
                      : ["succeeded", "failed"].includes(batch.status)
                        ? "已完成"
                        : "实时汇总"}
                  </Badge>
                </TableCell>
                <TableCell>—</TableCell>
                <TableCell>{finalStats.totalRuns}</TableCell>
                <TableCell>{finalStats.passRate}%</TableCell>
                <TableCell>—</TableCell>
                <TableCell>{finalStats.passed}</TableCell>
                <TableCell>{finalStats.failed + finalStats.timedOut}</TableCell>
                <TableCell>{finalStats.notExecuted}</TableCell>
                <TableCell>—</TableCell>
                <TableCell>—</TableCell>
              </TableRow>
              {/* 虚拟轮次：跨全部轮次逐条查看/筛选执行记录，并导出所有轮次结果。 */}
              <TableRow
                className={allRoundsSelected ? "selected-row" : undefined}
                onClick={() => selectRound("all")}
              >
                <TableCell>
                  <Button
                    className={cn(
                      "round-select-button",
                      runBatchRoundsStyles["round-select-button"],
                    )}
                    variant="ghost"
                    size="compact"
                    type="button"
                    aria-pressed={allRoundsSelected}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectRound("all");
                    }}
                  >
                    全部轮次
                  </Button>
                </TableCell>
                <TableCell>—</TableCell>
                <TableCell>—</TableCell>
                <TableCell>{allRoundsStats.totalRuns}</TableCell>
                <TableCell>{allRoundsStats.passRate}%</TableCell>
                <TableCell>—</TableCell>
                <TableCell>{allRoundsStats.passed}</TableCell>
                <TableCell>{allRoundsStats.failed + allRoundsStats.timedOut}</TableCell>
                <TableCell>{allRoundsStats.notExecuted}</TableCell>
                <TableCell>—</TableCell>
                <TableCell>—</TableCell>
              </TableRow>
              {summaries.flatMap((summary) => {
                const recovery = recoveries.find((item) => item.afterRound === summary.round);
                const roundConcurrency = concurrencyByRound.get(summary.round);
                const rows = [
                  <TableRow
                    key={`round-${summary.round}`}
                    className={
                      !allRoundsSelected &&
                      !summarySelected &&
                      !selectedRecovery &&
                      summary.round === selectedRound
                        ? "selected-row"
                        : undefined
                    }
                    onClick={() => selectRound(summary.round)}
                  >
                    <TableCell>
                      <Button
                        className={cn(
                          "round-select-button",
                          runBatchRoundsStyles["round-select-button"],
                        )}
                        variant="ghost"
                        size="compact"
                        type="button"
                        aria-pressed={
                          !allRoundsSelected && !summarySelected && summary.round === selectedRound
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          selectRound(summary.round);
                        }}
                      >
                        {roundLabel(batch.retryMode, summary.round)}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={cn(
                          runBatchRoundsStyles["batch-status"],
                          `batch-status ${roundStatusClass(summary)}`,
                        ).trim()}
                      >
                        {roundStatusLabel(summary, batch.currentRound)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {roundConcurrency ? (
                        <span
                          className={
                            roundConcurrency.source === "rule_transition"
                              ? cn(
                                  "round-concurrency changed",
                                  runBatchRoundsStyles["round-concurrency"],
                                )
                              : cn("round-concurrency", runBatchRoundsStyles["round-concurrency"])
                          }
                          title={
                            roundConcurrency.source === "rule_transition"
                              ? `动态规则 ${roundConcurrency.ruleId ?? ""}：${roundConcurrency.previousConcurrency ?? "—"} → ${roundConcurrency.concurrency}`
                              : roundConcurrency.source === "inherited_rule"
                                ? `沿用动态规则 ${roundConcurrency.ruleId ?? ""}`
                                : "任务基础并发"
                          }
                        >
                          {roundConcurrency.concurrency}
                          {roundConcurrency.source === "rule_transition" ? (
                            <small>已变更</small>
                          ) : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>{summary.totalRuns}</TableCell>
                    <TableCell>{summary.overallPassRate}%</TableCell>
                    <TableCell>
                      {summary.roundPassRate === null
                        ? "—"
                        : `${summary.roundPassRate}%${summary.status === "running" ? "（进行中）" : ""}`}
                    </TableCell>
                    <TableCell>{summary.passed}</TableCell>
                    <TableCell>{summary.failed + summary.timedOut}</TableCell>
                    <TableCell>{summary.notExecuted}</TableCell>
                    <TableCell>
                      {summary.startedAt ? (
                        <time title={`UTC ${summary.startedAt}`}>
                          {formatLocalDateTime(summary.startedAt)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {summary.durationMs !== null
                        ? formatBatchDuration(summary.durationMs)
                        : summary.status === "running" && summary.startedAt
                          ? "进行中"
                          : "—"}
                    </TableCell>
                  </TableRow>,
                ];
                if (recovery) {
                  const succeeded = recovery.steps.filter(
                    (step) => step.status === "succeeded",
                  ).length;
                  const failed = recovery.steps.filter((step) => step.status === "failed").length;
                  rows.push(
                    <TableRow
                      key={`recovery-${recovery.afterRound}`}
                      className={
                        selectedRecovery?.afterRound === recovery.afterRound
                          ? cn(
                              "selected-row recovery-round-row",
                              runBatchRoundsStyles["recovery-round-row"],
                            )
                          : cn("recovery-round-row", runBatchRoundsStyles["recovery-round-row"])
                      }
                      onClick={() => selectRound(`recovery-${recovery.afterRound}`)}
                    >
                      <TableCell>
                        <Button
                          aria-pressed={selectedRecovery?.afterRound === recovery.afterRound}
                          className={cn(
                            "round-select-button",
                            runBatchRoundsStyles["round-select-button"],
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            selectRound(`recovery-${recovery.afterRound}`);
                          }}
                          size="compact"
                          type="button"
                          variant="ghost"
                        >
                          环境恢复
                        </Button>
                        <small className={cn("table-secondary", uiPatterns["table-secondary"])}>
                          第 {recovery.afterRound} 轮后
                        </small>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={cn(
                            runBatchRoundsStyles["batch-status"],
                            `batch-status ${recoveryStatusClass(recovery.status)}`,
                          ).trim()}
                        >
                          {recoveryStatusLabel(recovery.status)}
                        </Badge>
                      </TableCell>
                      <TableCell colSpan={7}>
                        Jenkins 流水线 {recovery.steps.length} 个 · 完成 {succeeded} · 失败 {failed}
                      </TableCell>
                      <TableCell>
                        <time title={`UTC ${recovery.activatedAt}`}>
                          {formatLocalDateTime(recovery.activatedAt)}
                        </time>
                      </TableCell>
                      <TableCell>
                        {recovery.finishedAt
                          ? formatBatchDuration(
                              Math.max(
                                0,
                                Date.parse(recovery.finishedAt) - Date.parse(recovery.activatedAt),
                              ),
                            )
                          : "进行中"}
                      </TableCell>
                    </TableRow>,
                  );
                }
                return rows;
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      {selectedRecovery ? (
        <RecoveryDetailPanel recovery={selectedRecovery} />
      ) : summarySelected ? (
        <SummaryRoundPanel
          batch={batch}
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadAttemptEvents={canReadAttemptEvents}
          canReadArtifacts={canReadArtifacts}
          artifactsEnabled={artifactsEnabled}
          runnerDirectory={runnerDirectoryById}
          cancelPending={cancelPending}
          actionError={actionError}
          detailCache={detailCache}
          onRememberAttemptDetail={rememberAttemptDetail}
          onCancelRun={(runId) => void cancelRun(runId)}
          onOpenLogs={setLogAttempt}
          onRefresh={onRefresh}
        />
      ) : allRoundsSelected ? (
        <AllRoundsPanel
          batch={batch}
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadAttemptEvents={canReadAttemptEvents}
          canReadArtifacts={canReadArtifacts}
          artifactsEnabled={artifactsEnabled}
          runnerDirectory={runnerDirectoryById}
          cancelPending={cancelPending}
          actionError={actionError}
          detailCache={detailCache}
          onRememberAttemptDetail={rememberAttemptDetail}
          onCancelRun={(runId) => void cancelRun(runId)}
          onOpenLogs={setLogAttempt}
          onRefresh={onRefresh}
        />
      ) : selectedSummary ? (
        <RoundDetailPanel
          batch={batch}
          summary={selectedSummary}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadAttemptEvents={canReadAttemptEvents}
          canReadArtifacts={canReadArtifacts}
          artifactsEnabled={artifactsEnabled}
          runnerDirectory={runnerDirectoryById}
          cancelPending={cancelPending}
          actionError={actionError}
          detailCache={detailCache}
          onRememberAttemptDetail={rememberAttemptDetail}
          onCancelRun={(runId) => void cancelRun(runId)}
          onOpenLogs={setLogAttempt}
          onRefresh={onRefresh}
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
          canCreateRuns={canCreateRuns}
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

function RecoveryDetailPanel({ recovery }: { recovery: RecoveryGroup }) {
  return (
    <section
      className={cn("round-detail-panel", runBatchRoundsStyles["round-detail-panel"])}
      aria-label={`环境恢复详情：第 ${recovery.afterRound} 轮后`}
    >
      <div className={cn("round-detail-header", runBatchRoundsStyles["round-detail-header"])}>
        <div className={cn("round-detail-title", runBatchRoundsStyles["round-detail-title"])}>
          <h2>环境恢复 · 第 {recovery.afterRound} 轮后</h2>
          <Badge
            className={cn(
              runBatchRoundsStyles["batch-status"],
              `batch-status ${recoveryStatusClass(recovery.status)}`,
            ).trim()}
          >
            {recoveryStatusLabel(recovery.status)}
          </Badge>
        </div>
        <span className={cn("muted", uiPatterns["muted"])}>
          下一轮在全部流水线及等待时间结束后统一开始
        </span>
      </div>
      <div className={cn("recovery-step-grid", runBatchRoundsStyles["recovery-step-grid"])}>
        {recovery.steps.map((step, index) => (
          <article
            className={cn("recovery-step-card", runBatchRoundsStyles["recovery-step-card"])}
            key={step.ruleId}
          >
            <div
              className={cn("recovery-step-heading", runBatchRoundsStyles["recovery-step-heading"])}
            >
              <div>
                <span className={cn("step-label", runBatchRoundsStyles["step-label"])}>
                  JENKINS {index + 1}
                </span>
                <h3>{jenkinsJobName(step.jenkinsJobUrl)}</h3>
              </div>
              <Badge
                className={cn(
                  runBatchRoundsStyles["batch-status"],
                  `batch-status ${recoveryStepStatusClass(step)}`,
                ).trim()}
              >
                {recoveryStepStatusLabel(step)}
              </Badge>
            </div>
            <dl className={cn("recovery-step-facts", runBatchRoundsStyles["recovery-step-facts"])}>
              <RecoveryFact
                label="构建编号"
                value={step.rebuildNumber ? `#${step.rebuildNumber}` : "等待发现"}
              />
              <RecoveryFact label="构建结果" value={step.buildResult ?? "—"} />
              <RecoveryTimeFact label="开始时间" value={step.startedAt} />
              <RecoveryTimeFact label="结束时间" value={step.finishedAt} />
              <RecoveryFact
                label="构建耗时"
                value={
                  step.startedAt && step.finishedAt
                    ? formatBatchDuration(
                        Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt)),
                      )
                    : step.startedAt
                      ? "执行中"
                      : "—"
                }
              />
              <RecoveryFact label="构建后等待" value={`${step.waitMinutes} 分钟`} />
            </dl>
            {step.errorMessage ? (
              <Notice
                tone="error"
                className={cn("form-error", uiPatterns["form-error"])}
                role="alert"
              >
                {step.errorMessage}
              </Notice>
            ) : null}
            <LinkButton
              className={cn(
                "button button-secondary compact-button recovery-build-link",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
                uiPatterns["compact-button"],
                runBatchRoundsStyles["recovery-build-link"],
              )}
              href={step.rebuildUrl ?? step.jenkinsJobUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" size={15} />
              {step.rebuildUrl ? "查看 Jenkins 构建" : "查看 Jenkins 任务"}
            </LinkButton>
          </article>
        ))}
      </div>
    </section>
  );
}

function RecoveryFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RecoveryTimeFact({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ? <time title={`UTC ${value}`}>{formatLocalDateTime(value)}</time> : "—"}</dd>
    </div>
  );
}

function recoveryStepStatusLabel(step: RunBatchRoundRecovery): string {
  const labels: Record<RunBatchRoundRecovery["status"], string> = {
    idle: "等待轮次",
    pending: "等待触发",
    polling: step.rebuildNumber ? "构建中" : "查找构建",
    waiting: "构建完成，等待恢复",
    releasing: "恢复完成，继续调度",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[step.status];
}

function recoveryStepStatusClass(step: RunBatchRoundRecovery): string {
  if (step.status === "succeeded") return "batch-status-succeeded";
  if (step.status === "failed") return "batch-status-failed";
  if (step.status === "cancelled" || step.status === "idle") return "batch-status-neutral";
  return "";
}

function jenkinsJobName(jobUrl: string): string {
  try {
    const segments = new URL(jobUrl).pathname.split("/").filter(Boolean);
    return decodeURIComponent(segments.at(-1) ?? jobUrl);
  } catch {
    return jobUrl;
  }
}

/** “总结”虚拟轮次：每个初始用例只保留最终口径的一行。 */
function SummaryRoundPanel({
  batch,
  canCancelRuns,
  canReadLogs,
  canReadAttemptEvents,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  cancelPending,
  actionError,
  detailCache,
  onRememberAttemptDetail,
  onCancelRun,
  onOpenLogs,
  onRefresh,
}: {
  batch: ExecutionBatchView;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadAttemptEvents: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  cancelPending: boolean;
  actionError: string;
  detailCache: ReadonlyMap<string, AttemptDetailEntry>;
  onRememberAttemptDetail: (attemptId: string, entry: AttemptDetailEntry) => void;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
  onRefresh: () => void;
}) {
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  return (
    <section
      className={cn("round-detail-panel", runBatchRoundsStyles["round-detail-panel"])}
      aria-label="轮次详情：总结"
    >
      <div className={cn("round-detail-header", runBatchRoundsStyles["round-detail-header"])}>
        <div className={cn("round-detail-title", runBatchRoundsStyles["round-detail-title"])}>
          <h2>总结</h2>
          <Badge
            className={cn(
              "batch-status batch-status-neutral",
              runBatchRoundsStyles["batch-status"],
              runBatchRoundsStyles["batch-status-neutral"],
            )}
          >
            最终结果
          </Badge>
        </div>
        <div
          className={cn(
            "round-detail-header-actions",
            runBatchRoundsStyles["round-detail-header-actions"],
          )}
        >
          <Button
            className={cn(
              "button button-secondary compact-button",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
              uiPatterns["compact-button"],
            )}
            onClick={onRefresh}
            type="button"
          >
            <RefreshCw size={15} /> 刷新
          </Button>
          {canReadLogs ? (
            <Button
              className={cn(
                "button button-secondary compact-button",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
                uiPatterns["compact-button"],
              )}
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
          defaultScope="final"
          onClose={() => setExportDialogOpen(false)}
        />
      ) : null}
      {actionError ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
          {actionError}
        </Notice>
      ) : null}
      <div className={cn("round-tab-content", runBatchRoundsStyles["round-tab-content"])}>
        <RoundCasesTable
          key="summary"
          batch={batch}
          round="summary"
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadAttemptEvents={canReadAttemptEvents}
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

/**
 * 全部轮次虚拟面板：同一用例在不同轮次产生的每条 attempt 各占一行，
 * 用轮次列区分；导出默认使用 scope=all（所有轮次逐条记录）。
 */
function AllRoundsPanel({
  batch,
  canCancelRuns,
  canReadLogs,
  canReadAttemptEvents,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  cancelPending,
  actionError,
  detailCache,
  onRememberAttemptDetail,
  onCancelRun,
  onOpenLogs,
  onRefresh,
}: {
  batch: ExecutionBatchView;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadAttemptEvents: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  cancelPending: boolean;
  actionError: string;
  detailCache: ReadonlyMap<string, AttemptDetailEntry>;
  onRememberAttemptDetail: (attemptId: string, entry: AttemptDetailEntry) => void;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
  onRefresh: () => void;
}) {
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  return (
    <section
      className={cn("round-detail-panel", runBatchRoundsStyles["round-detail-panel"])}
      aria-label="轮次详情：全部轮次"
    >
      <div className={cn("round-detail-header", runBatchRoundsStyles["round-detail-header"])}>
        <div className={cn("round-detail-title", runBatchRoundsStyles["round-detail-title"])}>
          <h2>全部轮次</h2>
          <Badge
            className={cn(
              "batch-status batch-status-neutral",
              runBatchRoundsStyles["batch-status"],
              runBatchRoundsStyles["batch-status-neutral"],
            )}
          >
            逐条记录
          </Badge>
        </div>
        <div
          className={cn(
            "round-detail-header-actions",
            runBatchRoundsStyles["round-detail-header-actions"],
          )}
        >
          <Button
            className={cn(
              "button button-secondary compact-button",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
              uiPatterns["compact-button"],
            )}
            onClick={onRefresh}
            type="button"
            title="重新从服务端拉取最新执行状态"
          >
            <RefreshCw size={15} /> 刷新
          </Button>
          {canReadLogs ? (
            <Button
              className={cn(
                "button button-secondary compact-button",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
                uiPatterns["compact-button"],
              )}
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
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
          {actionError}
        </Notice>
      ) : null}
      {/* 全部轮次没有环形图，不能使用 round-detail-body 的双列网格，
          否则表格会被挤进 320px 的图表列。 */}
      <div className={cn("round-tab-content", runBatchRoundsStyles["round-tab-content"])}>
        <RoundCasesTable
          key="all"
          batch={batch}
          round="all"
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadAttemptEvents={canReadAttemptEvents}
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
  canReadAttemptEvents,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  cancelPending,
  actionError,
  detailCache,
  onRememberAttemptDetail,
  onCancelRun,
  onOpenLogs,
  onRefresh,
  onOpenScheduling,
}: {
  batch: ExecutionBatchView;
  summary: RunBatchRoundSummary;
  activeTab: "cases" | "runners";
  onTabChange: (tab: "cases" | "runners") => void;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadAttemptEvents: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  cancelPending: boolean;
  actionError: string;
  detailCache: ReadonlyMap<string, AttemptDetailEntry>;
  onRememberAttemptDetail: (attemptId: string, entry: AttemptDetailEntry) => void;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
  onRefresh: () => void;
  onOpenScheduling: (runnerId: string | undefined) => void;
}) {
  const label = roundLabel(batch.retryMode, summary.round);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [faultDialogOpen, setFaultDialogOpen] = useState(false);
  const [runnerTabMounted, setRunnerTabMounted] = useState(activeTab === "runners");
  const faultIncidents = batch.runnerFaultIncidents;
  const passedRunsSoFar = summary.overallPassed;
  const inProgress = Math.max(
    0,
    summary.executed - summary.passed - summary.failed - summary.timedOut - summary.cancelled,
  );
  const notExecuted = Math.max(0, batch.totalRuns - summary.executed);
  const resultSegments: DonutChartSegment[] = [
    { label: "通过", value: summary.passed, color: "var(--success)" },
    { label: "失败", value: summary.failed, color: "var(--destructive)" },
    { label: "超时", value: summary.timedOut, color: "var(--warning)" },
    { label: "进行中", value: inProgress, color: "var(--info)" },
    { label: "取消", value: summary.cancelled, color: "var(--muted-foreground)" },
    { label: "未执行", value: notExecuted, color: "var(--input)" },
  ];
  const progressSegments: DonutChartSegment[] = [
    { label: "累计通过", value: passedRunsSoFar, color: "var(--success)" },
    {
      label: "未通过",
      value: Math.max(0, batch.totalRuns - passedRunsSoFar),
      color: "var(--input)",
    },
  ];

  return (
    <section
      className={cn("round-detail-panel", runBatchRoundsStyles["round-detail-panel"])}
      aria-label={`轮次详情：${label}`}
    >
      <div className={cn("round-detail-header", runBatchRoundsStyles["round-detail-header"])}>
        <div className={cn("round-detail-title", runBatchRoundsStyles["round-detail-title"])}>
          <h2>{label}</h2>
          <Badge
            className={cn(
              runBatchRoundsStyles["batch-status"],
              `batch-status ${roundStatusClass(summary)}`,
            ).trim()}
          >
            {roundStatusLabel(summary, batch.currentRound)}
          </Badge>
          {summary.status === "running" && canReadLogs ? (
            <Badge className={cn("status-badge", runBatchRoundsStyles["status-badge"])}>
              实时更新
            </Badge>
          ) : null}
        </div>
        <div
          className={cn(
            "round-detail-header-actions",
            runBatchRoundsStyles["round-detail-header-actions"],
          )}
        >
          <Button
            className={cn(
              "button button-secondary compact-button",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
              uiPatterns["compact-button"],
            )}
            onClick={onRefresh}
            type="button"
            title="重新从服务端拉取最新执行状态"
          >
            <RefreshCw size={15} /> 刷新
          </Button>
          {canReadLogs ? (
            <Button
              className={cn(
                "button button-secondary compact-button",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
                uiPatterns["compact-button"],
              )}
              onClick={() => onOpenScheduling(undefined)}
              type="button"
            >
              <ScrollText size={15} /> 总体调度日志
            </Button>
          ) : null}
          {canReadLogs ? (
            <Button
              className={cn(
                "button button-secondary compact-button",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
                uiPatterns["compact-button"],
              )}
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
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
          {actionError}
        </Notice>
      ) : null}
      <div className={cn("round-detail-body", runBatchRoundsStyles["round-detail-body"])}>
        <div className={cn("round-donuts", runBatchRoundsStyles["round-donuts"])}>
          <div className={cn("round-donut-block", runBatchRoundsStyles["round-donut-block"])}>
            <h3>本轮结果分布</h3>
            <DonutChart
              segments={resultSegments}
              centerValue={String(summary.executed)}
              centerLabel="已执行"
              ariaLabel={`本轮结果分布：通过 ${summary.passed}，失败 ${summary.failed}，超时 ${summary.timedOut}，进行中 ${inProgress}，取消 ${summary.cancelled}，未执行 ${notExecuted}`}
            />
          </div>
          <div className={cn("round-donut-block", runBatchRoundsStyles["round-donut-block"])}>
            <h3>总体通过进度</h3>
            <DonutChart
              segments={progressSegments}
              centerValue={`${summary.overallPassRate}%`}
              centerLabel="总通过率"
              ariaLabel={`截至本轮总体通过进度：累计通过 ${passedRunsSoFar} 个用例，共 ${batch.totalRuns} 个`}
            />
          </div>
        </div>
        <div className={cn("round-tab-content", runBatchRoundsStyles["round-tab-content"])}>
          <div className={cn("round-tab-toolbar", runBatchRoundsStyles["round-tab-toolbar"])}>
            <Segmented
              label="轮次详情视图"
              value={activeTab}
              options={[
                { value: "cases", label: "用例" },
                { value: "runners", label: "执行机" },
              ]}
              onChange={(value) => {
                if (value === "runners") setRunnerTabMounted(true);
                onTabChange(value);
              }}
            />
            {activeTab === "runners" ? (
              <Button
                className={cn(
                  "button button-secondary compact-button",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                  uiPatterns["compact-button"],
                )}
                onClick={() => setFaultDialogOpen(true)}
                type="button"
              >
                <AlertTriangle size={15} /> 执行机异常 {faultIncidents.length}
              </Button>
            ) : null}
          </div>
          <div
            className={cn("round-tab-panel", runBatchRoundsStyles["round-tab-panel"])}
            hidden={activeTab !== "cases"}
          >
            <RoundCasesTable
              key={summary.round}
              batch={batch}
              round={summary.round}
              canCancelRuns={canCancelRuns}
              canReadLogs={canReadLogs}
              canReadAttemptEvents={canReadAttemptEvents}
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
          {runnerTabMounted ? (
            <div
              className={cn("round-tab-panel", runBatchRoundsStyles["round-tab-panel"])}
              hidden={activeTab !== "runners"}
            >
              <RoundRunnerCards
                batch={batch}
                round={summary.round}
                canReadLogs={canReadLogs}
                runnerDirectory={runnerDirectory}
                onOpenScheduling={onOpenScheduling}
              />
            </div>
          ) : null}
        </div>
      </div>
      {faultDialogOpen ? (
        <RunnerFaultDialog
          incidents={faultIncidents}
          onClose={() => setFaultDialogOpen(false)}
          runnerName={(runnerId) => runnerDisplayName(runnerId, runnerDirectory)}
        />
      ) : null}
    </section>
  );
}

type CaseSortKey = "name" | "status" | "runner" | "duration";

type CaseSortSpec = {
  key: CaseSortKey | "none";
  direction: "asc" | "desc";
};

function RoundCasesTable({
  batch,
  round,
  canCancelRuns,
  canReadLogs,
  canReadAttemptEvents,
  canReadArtifacts,
  artifactsEnabled,
  runnerDirectory,
  cancelPending,
  detailCache,
  onRememberAttemptDetail,
  onCancelRun,
  onOpenLogs,
}: {
  batch: ExecutionBatchView;
  /** 具体轮次号，all 表示逐条尝试，summary 表示每个用例的最终结果。 */
  round: number | "all" | "summary";
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadAttemptEvents: boolean;
  canReadArtifacts: boolean;
  artifactsEnabled: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  cancelPending: boolean;
  detailCache: ReadonlyMap<string, AttemptDetailEntry>;
  onRememberAttemptDetail: (attemptId: string, entry: AttemptDetailEntry) => void;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
}) {
  const showRoundColumn = round === "all";
  const [statusFilter, setStatusFilter] = useState<CaseStatusFilter>("all");
  const [nameQuery, setNameQuery] = useState("");
  const [debouncedNameQuery, setDebouncedNameQuery] = useState("");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_CASE_PAGE_SIZE);
  const [page, setPage] = useState(1);
  // 不再自动展开行内详情：无论单用例还是多用例，都需用户主动点击详情。
  const [expandedAttemptId, setExpandedAttemptId] = useState<string | undefined>();
  const [sortSpec, setSortSpec] = useState<CaseSortSpec>({ key: "none", direction: "asc" });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedNameQuery(nameQuery.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [nameQuery]);

  const casePageUrl = useMemo(() => {
    const parameters = new URLSearchParams({
      cached: "1",
      scope: String(round),
      sort: sortSpec.key,
      direction: sortSpec.direction,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (statusFilter !== "all") parameters.set("status", statusFilter);
    if (debouncedNameQuery) parameters.set("query", debouncedNameQuery);
    if (batch.accessToken) parameters.set("access_token", batch.accessToken);
    return `/api/v1/run-batches/${encodeURIComponent(batch.id)}/cases?${parameters.toString()}`;
  }, [
    batch.accessToken,
    batch.id,
    debouncedNameQuery,
    page,
    pageSize,
    round,
    sortSpec.direction,
    sortSpec.key,
    statusFilter,
  ]);
  const requestKey = `${casePageUrl}\u0000${batch.updatedAt}\u0000${batch.statistics?.generation ?? ""}`;
  const [loadedPage, setLoadedPage] = useState<{
    requestKey: string;
    pageUrl: string;
    rows: RoundCaseRowModel[];
    total: number;
    error: string;
  }>({ requestKey: "", pageUrl: "", rows: [], total: 0, error: "" });
  const loading = loadedPage.requestKey !== requestKey;
  const retainingCurrentPage = loadedPage.pageUrl === casePageUrl;
  const rows = retainingCurrentPage ? loadedPage.rows : EMPTY_CASE_ROWS;
  const totalRows = retainingCurrentPage ? loadedPage.total : 0;
  const loadError = loading ? "" : loadedPage.error;

  useEffect(() => {
    const controller = new AbortController();
    const epoch = browserCacheEpoch();
    const key = `batch-case-page:v1:${requestKey}`;
    const cached = readBrowserSnapshot(key) as
      { items: RoundCaseRowModel[]; total: number } | undefined;
    const load = cached
      ? Promise.resolve(cached)
      : fetchCasePage(casePageUrl, controller.signal).then(async (response) => {
          if (!response.ok) {
            throw new Error((await readApiErrorMessage(response, "读取用例列表失败。"))!);
          }
          return response.json() as Promise<{ items: RoundCaseRowModel[]; total: number }>;
        });
    void load
      .then((result) => {
        if (controller.signal.aborted) return;
        writeBrowserSnapshot(key, result, epoch);
        setLoadedPage({
          requestKey,
          pageUrl: casePageUrl,
          rows: result.items,
          total: result.total,
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadedPage((current) => ({
          requestKey,
          pageUrl: casePageUrl,
          rows: current.pageUrl === casePageUrl ? current.rows : [],
          total: current.pageUrl === casePageUrl ? current.total : 0,
          error: error instanceof Error ? error.message : "读取用例列表失败。",
        }));
      });
    return () => controller.abort();
  }, [casePageUrl, requestKey]);

  const columnWidths = useMemo(() => {
    // Successful rows have no failure text; they must not dilute a visible stack's width.
    const sharedFailureLines = batch.accessToken
      ? rows.flatMap(({ attempt }) => {
          if (
            !attempt ||
            !isTerminalAttemptStatus(attempt.status) ||
            attempt.status === "succeeded"
          )
            return [];
          const hint = attemptFailureHint(attempt);
          return hint ? [widestText(hint.split(/\r?\n/))] : [];
        })
      : [];
    return {
      case: columnCharacterWidthAtCoverage(
        rows.map((row) => widestText([row.run.displayName, row.run.className])),
        { minimum: minimumCaseNameWidthCh, maximum: 42 },
      ),
      status: columnCharacterWidthAtCoverage(
        sharedFailureLines.length > 0
          ? sharedFailureLines
          : rows.map((row) =>
              widestText(
                (row.attempt
                  ? `${attemptStatusLabel(row.attempt)} ${attemptFailureHint(row.attempt) ?? ""}`
                  : "未执行"
                ).split(/\r?\n/),
              ),
            ),
        { minimum: 12, maximum: batch.accessToken ? 96 : 36 },
      ),
      runner: columnCharacterWidthAtCoverage(
        rows.map((row) => {
          const runnerId = row.attempt?.runnerId ?? row.run.assignedRunnerId;
          return runnerId ? runnerDisplayName(runnerId, runnerDirectory) : "—";
        }),
        { minimum: 10, maximum: 24 },
      ),
    };
  }, [rows, runnerDirectory, batch.accessToken]);
  const sharedLayout = batch.accessToken
    ? sharedExecutionColumnLayout({ widths: columnWidths, showRoundColumn })
    : undefined;

  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(page, pageCount);

  function toggleSort(key: CaseSortKey): void {
    setSortSpec((current) => {
      if (current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      // 第三次点击同一列恢复默认顺序。
      return { key: "none", direction: "asc" };
    });
  }

  return (
    <div className={cn("round-cases", runBatchRoundsStyles["round-cases"])}>
      <div className={cn("round-filter-row", runBatchRoundsStyles["round-filter-row"])}>
        <Select
          aria-label="按状态筛选"
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value as CaseStatusFilter);
            setPage(1);
          }}
        >
          <option value="all">全部状态</option>
          <option value="assigned">已分配</option>
          <option value="running">执行中</option>
          <option value="succeeded">通过</option>
          <option value="failed">失败</option>
          <option value="timed_out">超时</option>
          <option value="cancelled">取消</option>
          <option value="pending">未执行</option>
        </Select>
        <span className={cn("round-filter-search", runBatchRoundsStyles["round-filter-search"])}>
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
        {loading && retainingCurrentPage ? (
          <span
            className={cn("round-inline-refresh", runBatchRoundsStyles["round-inline-refresh"])}
            role="status"
          >
            <LoadingIcon size={14} /> 正在同步最新数据
          </span>
        ) : null}
      </div>
      {loadError && rows.length === 0 ? (
        <Notice
          tone="error"
          className={cn("inline-empty", uiPatterns["inline-empty"])}
          role="alert"
        >
          {loadError}
        </Notice>
      ) : loading && rows.length === 0 ? (
        <LoadingState compact label="正在读取当前页用例" />
      ) : rows.length === 0 ? (
        <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
          没有匹配当前筛选条件的用例。
        </EmptyState>
      ) : (
        <div
          className={cn("table-scroll", uiPatterns["table-scroll"])}
          style={sharedLayout ? { containerType: "inline-size" } : undefined}
        >
          <Table
            className={cn(
              "data-table execution-case-table",
              uiPatterns["data-table"],
              runBatchRoundsStyles["execution-case-table"],
            )}
            style={sharedLayout ? { minWidth: sharedLayout.minimumTableWidth } : undefined}
          >
            <colgroup>
              <col style={{ width: sharedLayout?.caseWidth ?? `${columnWidths.case}ch` }} />
              {showRoundColumn ? (
                <col
                  className="case-column-round"
                  style={{ width: `${executionCaseColumnWidthsRem.round}rem` }}
                />
              ) : null}
              <col style={sharedLayout ? undefined : { width: `${columnWidths.status}ch` }} />
              <col style={{ width: `${columnWidths.runner}ch` }} />
              <col
                className="case-column-duration"
                style={{ width: `${executionCaseColumnWidthsRem.duration}rem` }}
              />
              <col
                className="case-column-actions"
                style={{
                  width: `${batch.accessToken ? executionCaseColumnWidthsRem.sharedActions : executionCaseColumnWidthsRem.actions}rem`,
                }}
              />
            </colgroup>
            <TableHeader>
              <TableRow>
                <SortableCaseTh
                  label="用例"
                  sortKey="name"
                  active={sortSpec}
                  onToggle={() => toggleSort("name")}
                />
                {showRoundColumn ? <TableHead>轮次</TableHead> : null}
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
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
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
                  {...(batch.accessToken ? { publicRunShareToken: batch.accessToken } : {})}
                  canReadAttemptEvents={canReadAttemptEvents}
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
            </TableBody>
          </Table>
        </div>
      )}
      <div className={cn("round-pagination", runBatchRoundsStyles["round-pagination"])}>
        <label className={cn("round-page-size", runBatchRoundsStyles["round-page-size"])}>
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
          className={cn(
            "button button-secondary compact-button",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
            uiPatterns["compact-button"],
          )}
          disabled={currentPage <= 1}
          onClick={() => setPage(currentPage - 1)}
          type="button"
        >
          <ChevronLeft size={15} /> 上一页
        </Button>
        <span>
          第 {currentPage} / {pageCount} 页 · 共 {totalRows} 条
        </span>
        <Button
          className={cn(
            "button button-secondary compact-button",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
            uiPatterns["compact-button"],
          )}
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
    <TableHead
      aria-sort={isActive ? (active.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <Button
        className={cn("sortable-th-button", runBatchRoundsStyles["sortable-th-button"])}
        variant="ghost"
        size="compact"
        onClick={onToggle}
        type="button"
      >
        {label}
        <span
          aria-hidden="true"
          className={cn("sortable-th-indicator", runBatchRoundsStyles["sortable-th-indicator"])}
        >
          {isActive ? (active.direction === "asc" ? "▲" : "▼") : ""}
        </span>
      </Button>
    </TableHead>
  );
}

function RoundCaseRow({
  row,
  expanded,
  onToggleDetail,
  showRoundColumn,
  canCancelRuns,
  canReadLogs,
  publicRunShareToken,
  canReadAttemptEvents,
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
  publicRunShareToken?: string;
  canReadAttemptEvents: boolean;
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
  const canShareLog =
    canReadLogs && attempt !== undefined && isTerminalAttemptStatus(attempt.status);

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
      <TableRow>
        <TableCell>
          <span
            className={cn("execution-case-heading", runBatchRoundsStyles["execution-case-heading"])}
          >
            <strong>{run.displayName}</strong>
            <span
              className={cn(
                runBatchRoundsStyles["execution-case-type"],
                `execution-case-type ${run.caseType === "ddt" ? "ddt" : "testng"}`,
              )}
            >
              {run.caseType === "ddt" ? "DDT" : "普通用例"}
            </span>
          </span>
          <small className={cn("table-secondary", uiPatterns["table-secondary"])}>
            {run.className}
          </small>
        </TableCell>
        {showRoundColumn ? (
          <TableCell className={cn("round-cell-nowrap", runBatchRoundsStyles["round-cell-nowrap"])}>
            第 {row.round} 轮
          </TableCell>
        ) : null}
        <TableCell>
          {attempt ? (
            <>
              <Badge
                className={cn(
                  runBatchRoundsStyles["batch-status"],
                  `batch-status ${attemptStatusClass(attempt)}`,
                ).trim()}
              >
                {attemptStatusLabel(attempt)}
              </Badge>
              {/* 终态失败提示直接露出，无需展开详情：adapter 正常失败显示完整描述，
                  blocked（重启协调、超时等）显示原因码。 */}
              {isTerminalAttemptStatus(attempt.status) && attempt.status !== "succeeded" ? (
                <AttemptFailureHintLine attempt={attempt} />
              ) : null}
            </>
          ) : (
            <Badge
              className={cn(
                "batch-status batch-status-neutral",
                runBatchRoundsStyles["batch-status"],
                runBatchRoundsStyles["batch-status-neutral"],
              )}
            >
              未执行
            </Badge>
          )}
        </TableCell>
        {/* 执行机优先展示注册名称（一般为 runner-IP），title 保留完整 UUID。 */}
        <TableCell>
          {runnerId ? (
            <span
              className={cn("round-runner-name", runBatchRoundsStyles["round-runner-name"])}
              title={runnerId}
            >
              {runnerDisplayName(runnerId, runnerDirectory)}
            </span>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          {attempt?.durationMs === undefined ? "—" : formatAttemptDuration(attempt.durationMs)}
        </TableCell>
        <TableCell>
          <div className={cn("round-row-actions", runBatchRoundsStyles["round-row-actions"])}>
            {attempt && canReadLogs ? (
              <Button
                className={cn(
                  "button button-secondary compact-button",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                  uiPatterns["compact-button"],
                )}
                onClick={() => onOpenLogs(attempt)}
                type="button"
              >
                <Eye size={15} /> 查看日志
              </Button>
            ) : null}
            {attempt && publicRunShareToken ? (
              <LinkButton
                aria-label="查看公开日志"
                className={cn(
                  "button button-secondary compact-button",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                  uiPatterns["compact-button"],
                )}
                href={`/share/run/${encodeURIComponent(publicRunShareToken)}/attempt/${encodeURIComponent(attempt.id)}`}
                prefetch={false}
              >
                <Eye size={15} /> 公开日志
              </LinkButton>
            ) : null}
            {canShareLog ? (
              <Button
                className={cn(
                  "button button-secondary compact-button",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                  uiPatterns["compact-button"],
                )}
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
                className={cn(
                  "button button-secondary compact-button",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                  uiPatterns["compact-button"],
                )}
                aria-expanded={expanded}
                onClick={onToggleDetail}
                type="button"
              >
                <FileText size={15} /> 详情
              </Button>
            ) : null}
            {canCancelRuns && canCancelRoundCaseRow(row) ? (
              <Button
                className={cn("danger-text-button", uiPatterns["danger-text-button"])}
                disabled={cancelPending}
                onClick={() => onCancelRun(run.id)}
                type="button"
              >
                取消该用例
              </Button>
            ) : null}
          </div>
          {shareError ? (
            <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
              {shareError}
            </Notice>
          ) : null}
        </TableCell>
      </TableRow>
      {expanded && attempt ? (
        <TableRow className={cn("round-detail-row", runBatchRoundsStyles["round-detail-row"])}>
          <TableCell colSpan={showRoundColumn ? 6 : 5}>
            <AttemptInlineDetail
              attempt={attempt}
              canReadAttemptEvents={canReadAttemptEvents}
              canReadArtifacts={canReadArtifacts}
              artifactsEnabled={artifactsEnabled}
              cached={detailEntry}
              onRemember={onRememberDetail}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function AttemptInlineDetail({
  attempt,
  canReadAttemptEvents,
  canReadArtifacts,
  artifactsEnabled,
  cached,
  onRemember,
}: {
  attempt: RunAttempt;
  canReadAttemptEvents: boolean;
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
  const canLoadRemoteDetails = canReadAttemptEvents || (canReadArtifacts && artifactsEnabled);
  // 已缓存的详情不再请求：展开/收起/翻页后重开复用首次加载结果。
  const [loaded, setLoaded] = useState(
    () =>
      !canLoadRemoteDetails ||
      (cached !== undefined && (cached.artifacts !== undefined || cached.events !== undefined)),
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
          canReadAttemptEvents
            ? fetch(`/api/v1/run-attempts/${encodeURIComponent(attempt.id)}/events?limit=200`, {
                cache: "no-store",
              })
            : null,
        ]);
        if (artifactResponse && !artifactResponse.ok) {
          throw new Error((await readApiErrorMessage(artifactResponse, "读取产物失败。"))!);
        }
        if (eventResponse && !eventResponse.ok) {
          throw new Error((await readApiErrorMessage(eventResponse, "读取执行时间线失败。"))!);
        }
        if (disposed) return;
        const nextArtifacts = artifactResponse
          ? ((await artifactResponse.json()) as AttemptArtifactList).items
          : undefined;
        const nextEvents = eventResponse
          ? ((await eventResponse.json()) as AttemptEventPage).items
          : undefined;
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
  }, [attempt.id, artifactsEnabled, canReadArtifacts, canReadAttemptEvents, loaded, onRemember]);

  return (
    <div className={cn("attempt-inline-detail", runBatchRoundsStyles["attempt-inline-detail"])}>
      {error ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
          {error}
        </Notice>
      ) : null}
      {attempt.testNg ? (
        <div className={cn("attempt-inline-block", runBatchRoundsStyles["attempt-inline-block"])}>
          <h3>结构化测试结果</h3>
          <TestNgResults result={attempt.testNg} />
        </div>
      ) : null}
      {/* 产物收集全局开关关闭时，不展示产物区块（服务端也未收集任何产物）。 */}
      {artifactsEnabled ? (
        <div className={cn("attempt-inline-block", runBatchRoundsStyles["attempt-inline-block"])}>
          <h3>产物</h3>
          {!canReadArtifacts ? (
            <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
              当前账号没有读取执行产物的权限。
            </EmptyState>
          ) : artifacts === undefined ? (
            <LoadingStateMessage className={cn("inline-empty", uiPatterns["inline-empty"])}>
              正在读取产物...
            </LoadingStateMessage>
          ) : artifacts.length === 0 ? (
            <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
              当前尝试没有已声明产物。
            </EmptyState>
          ) : (
            <div className={cn("artifact-list", runBatchRoundsStyles["artifact-list"])}>
              {artifacts.map((artifact) => (
                <div
                  className={cn("artifact-row", runBatchRoundsStyles["artifact-row"])}
                  key={artifact.artifactId}
                >
                  <FileText size={17} />
                  <span>
                    <strong>{artifact.relativePath}</strong>
                    <small>
                      {formatArtifactBytes(artifact.sizeBytes)} · {artifact.status}
                    </small>
                  </span>
                  {artifact.downloadPath ? (
                    <span
                      className={cn("artifact-actions", runBatchRoundsStyles["artifact-actions"])}
                    >
                      {isPreviewable(artifact.mediaType) ? (
                        <LinkButton
                          className={cn(
                            "icon-button small-icon-button",
                            uiPatterns["icon-button"],
                            uiPatterns["small-icon-button"],
                          )}
                          href={`${artifact.downloadPath}?preview=1`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`预览 ${artifact.relativePath}`}
                        >
                          <Eye size={15} />
                        </LinkButton>
                      ) : null}
                      <LinkButton
                        className={cn(
                          "icon-button small-icon-button",
                          uiPatterns["icon-button"],
                          uiPatterns["small-icon-button"],
                        )}
                        href={artifact.downloadPath}
                        aria-label={`下载 ${artifact.relativePath}`}
                      >
                        <Download size={15} />
                      </LinkButton>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {canReadAttemptEvents ? (
        <div className={cn("attempt-inline-block", runBatchRoundsStyles["attempt-inline-block"])}>
          <h3>状态事件</h3>
          {events === undefined ? (
            <LoadingStateMessage className={cn("inline-empty", uiPatterns["inline-empty"])}>
              正在读取状态事件...
            </LoadingStateMessage>
          ) : events.length === 0 ? (
            <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
              当前尝试暂无状态事件。
            </EmptyState>
          ) : (
            <Timeline
              className="execution-timeline min-w-0"
              items={events.map((event) => ({
                key: event.eventId,
                content: (
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
                ),
              }))}
            />
          )}
        </div>
      ) : null}
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
  batch: ExecutionBatchView;
  round: number;
  canReadLogs: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  onOpenScheduling: (runnerId: string | undefined) => void;
}) {
  const cards = batch.runnerRoundSummaries
    .filter((summary) => summary.round === round)
    .map((summary) => [summary.runnerId, summary] as const);

  if (cards.length === 0) {
    return (
      <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
        本轮还没有执行机参与执行。
      </EmptyState>
    );
  }
  return (
    <div className={cn("runner-card-grid", runBatchRoundsStyles["runner-card-grid"])}>
      {cards.map(([runnerId, card]) => {
        const directoryEntry = runnerDirectory.get(runnerId);
        const resourceSnapshot = directoryEntry?.resourceSnapshot;
        return (
          <div className={cn("runner-card", runBatchRoundsStyles["runner-card"])} key={runnerId}>
            <div className={cn("runner-card-heading", runBatchRoundsStyles["runner-card-heading"])}>
              <strong title={runnerId}>{directoryEntry?.name || shortId(runnerId)}</strong>
              <span className={cn("muted", uiPatterns["muted"])}>本轮执行 {card.executed} 个</span>
            </div>
            <div className={cn("runner-card-stats", runBatchRoundsStyles["runner-card-stats"])}>
              <span>通过 {card.passed}</span>
              <span>失败 {card.failed}</span>
            </div>
            {resourceSnapshot ? (
              <small
                className={cn("muted runner-card-resources", uiPatterns["muted"])}
                title={`采集于 UTC ${resourceSnapshot.observedAt}`}
              >
                {runnerResourceLabel(resourceSnapshot)}
              </small>
            ) : (
              <EmptyState className={cn("muted runner-card-resources", uiPatterns["muted"])}>
                暂无资源快照
              </EmptyState>
            )}
            <small className={cn("muted", uiPatterns["muted"])}>
              最后活动{" "}
              <time title={`UTC ${card.lastActivity}`}>
                {formatLocalDateTime(card.lastActivity)}
              </time>
            </small>
            {canReadLogs ? (
              <Button
                className={cn(
                  "button button-secondary compact-button",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                  uiPatterns["compact-button"],
                )}
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
    <div className={cn("testng-results", runBatchRoundsStyles["testng-results"])}>
      <div
        className={cn("testng-counts", runBatchRoundsStyles["testng-counts"])}
        aria-label="TestNG 结果汇总"
      >
        <TestNgCount label="总计" value={result.total} />
        <TestNgCount label="通过" value={result.passed} />
        <TestNgCount label="失败" value={result.failed} />
        <TestNgCount label="跳过" value={result.skipped} />
        <TestNgCount label="配置失败" value={result.configurationFailures} />
      </div>
      {result.detailsTruncated ? (
        <Notice tone="info" className={cn("result-notice", runBatchRoundsStyles["result-notice"])}>
          明细已达到安全解析上限；汇总计数仍包含完整报告。
        </Notice>
      ) : null}
      {result.suites.map((suite, suiteIndex) => (
        <Disclosure
          header={
            <>
              <span>{suite.name}</span>
              <small>
                {suite.passed}/{suite.total} 通过 · {formatAttemptDuration(suite.durationMs)}
              </small>
            </>
          }
          className={cn("testng-suite", runBatchRoundsStyles["testng-suite"])}
          key={`${suite.name}-${suiteIndex}`}
          defaultOpen={suiteIndex === 0}
        >
          {suite.tests.map((test, testIndex) => (
            <div
              className={cn("testng-test", runBatchRoundsStyles["testng-test"])}
              key={`${test.name}-${testIndex}`}
            >
              <div
                className={cn("testng-scope-heading", runBatchRoundsStyles["testng-scope-heading"])}
              >
                <strong>{test.name}</strong>
                <span>{formatAttemptDuration(test.durationMs)}</span>
              </div>
              {test.classes.map((classResult, classIndex) => (
                <div
                  className={cn("testng-class", runBatchRoundsStyles["testng-class"])}
                  key={`${classResult.name}-${classIndex}`}
                >
                  <div
                    className={cn(
                      "testng-scope-heading",
                      runBatchRoundsStyles["testng-scope-heading"],
                    )}
                  >
                    <code>{classResult.name}</code>
                    <span>{formatAttemptDuration(classResult.durationMs)}</span>
                  </div>
                  <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
                    <Table
                      className={cn(
                        "data-table testng-method-table",
                        uiPatterns["data-table"],
                        runBatchRoundsStyles["testng-method-table"],
                      )}
                    >
                      <TableHeader>
                        <TableRow>
                          <TableHead>方法</TableHead>
                          <TableHead>类型</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>耗时</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {classResult.methods.map((method, methodIndex) => (
                          <TableRow key={`${method.name}-${method.signature ?? ""}-${methodIndex}`}>
                            <TableCell>
                              <strong>{method.name}</strong>
                              {method.signature ? (
                                <small
                                  className={cn("table-secondary", uiPatterns["table-secondary"])}
                                >
                                  {method.signature}
                                </small>
                              ) : null}
                            </TableCell>
                            <TableCell>{method.configuration ? "配置" : "测试"}</TableCell>
                            <TableCell>{testNgStatusLabel(method.status)}</TableCell>
                            <TableCell>{formatAttemptDuration(method.durationMs)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </Disclosure>
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

async function fetchCasePage(url: string, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (response.status !== 503 || attempt === 2) return response;
    const failure = (await response.clone().json()) as { error?: { code?: string } };
    if (failure.error?.code !== "READ_MODEL_PENDING") return response;
    await response.body?.cancel();
  }
  throw new Error("后台正在准备当前用例页，请稍后重试。");
}

const runBatchRoundsStyles = {
  "artifact-actions": "inline-flex items-center gap-1",
  "artifact-list": "grid gap-px mt-4.5 [border-block:1px_solid_var(--border)]",
  "artifact-row":
    "[&_small]:block [&_small]:text-muted-foreground [&_small]:text-xs grid grid-cols-[24px_minmax(0,_1fr)_auto] items-center gap-2.5 py-[11px] px-1 border-b border-solid border-border [&:last-child]:border-b-0 [&_span]:min-w-0 [&_strong]:block [&_strong]:overflow-hidden [&_strong]:text-sm [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap",
  "attempt-failure-line": "mt-[3px] [overflow-wrap:anywhere] leading-[1.3] whitespace-pre-wrap",
  "attempt-inline-block": "grid gap-2.5 [&_>_h3]:m-0 [&_>_h3]:text-sm",
  "attempt-inline-detail": "grid gap-4.5 py-1.5 px-1",
  "batch-status": uiPatterns["batch-status"],
  "batch-status-failed": "bg-destructive/10 text-destructive",
  "batch-status-neutral": "bg-muted text-muted-foreground",
  "batch-status-succeeded": "bg-success/10 text-success",
  "execution-case-heading":
    "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 [&_>_strong]:min-w-0 [&_>_strong]:[overflow-wrap:anywhere] [&_>_strong]:whitespace-normal",
  "execution-case-table":
    "min-w-[760px] [table-layout:fixed] [&_th]:py-1.5 [&_th]:px-[9px] [&_th]:leading-[1.3] [&_th]:[overflow-wrap:anywhere] [&_td]:py-1.5 [&_td]:px-[9px] [&_td]:leading-[1.3] [&_td]:[overflow-wrap:anywhere] [&_td:first-child_strong]:block [&_td:first-child_strong]:min-w-0 [&_td:first-child_small]:block [&_td:first-child_small]:min-w-0 [&_.compact-button]:min-h-8 [&_.compact-button]:py-px [&_.danger-text-button]:min-h-8 [&_.danger-text-button]:py-px",
  "execution-case-type":
    "[flex:0_0_auto] rounded-full py-0.5 px-[7px] bg-info/10 text-info text-xs font-semibold [&.ddt]:bg-info/10 [&.ddt]:text-info",
  "execution-round-table":
    "min-w-[980px] [table-layout:fixed] [&_.round-column-name]:w-[128px] [&_.round-column-status]:w-23 [&_.round-column-count]:w-21.5 [&_.round-column-start]:w-[166px] [&_.round-column-duration]:w-23 [&_th]:py-1.5 [&_th]:px-[9px] [&_th]:leading-[1.3] [&_td]:py-1.5 [&_td]:px-[9px] [&_td]:leading-[1.3]",
  "execution-timeline":
    'grid m-0 p-0 [list-style:none] [&_li]:grid [&_li]:grid-cols-[18px_minmax(0,_1fr)] [&_li]:gap-2.5 [&_li]:min-h-16 [&_li:not(:last-child)_.timeline-marker::after]:absolute [&_li:not(:last-child)_.timeline-marker::after]:top-3.5 [&_li:not(:last-child)_.timeline-marker::after]:bottom-[-50px] [&_li:not(:last-child)_.timeline-marker::after]:left-1 [&_li:not(:last-child)_.timeline-marker::after]:w-px [&_li:not(:last-child)_.timeline-marker::after]:bg-border [&_li:not(:last-child)_.timeline-marker::after]:[content:""] [&_li_>_div]:grid [&_li_>_div]:[align-content:start] [&_li_>_div]:gap-[3px] [&_li_>_div]:pb-4 [&_strong]:text-sm [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:[overflow-wrap:anywhere] [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:[overflow-wrap:anywhere]',
  "recovery-build-link": "justify-self-start",
  "recovery-round-row":
    "[&_>_td]:[background:color-mix(in_srgb,_color-mix(in_srgb,_var(--info)_10%,_transparent)_42%,_var(--card))] [&_td:first-child_small]:block [&_td:first-child_small]:px-2 [&_td:first-child_small]:whitespace-nowrap",
  "recovery-step-card":
    "grid min-w-0 gap-3.5 border border-solid border-border rounded-lg p-4 bg-muted [&_>_.form-error]:m-0",
  "recovery-step-facts":
    "grid grid-cols-2 gap-[12px_18px] m-0 [&_div]:grid [&_div]:min-w-0 [&_div]:gap-[3px] [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:min-w-0 [&_dd]:m-0 [&_dd]:text-foreground [&_dd]:text-sm [&_dd]:[overflow-wrap:anywhere]",
  "recovery-step-grid": "grid grid-cols-[repeat(auto-fit,_minmax(320px,_1fr))] gap-3",
  "recovery-step-heading":
    "flex items-start justify-between gap-3 [&_h3]:[margin:3px_0_0] [&_h3]:text-sm [&_h3]:[overflow-wrap:anywhere]",
  "result-notice": "m-0 text-warning text-xs",
  "round-cases": "grid gap-2",
  "round-cell-nowrap": "whitespace-nowrap",
  "round-concurrency":
    "inline-flex items-center gap-[5px] tabular-nums font-semibold [&.changed]:text-warning [&_small]:rounded-full [&_small]:py-0.5 [&_small]:px-[5px] [&_small]:bg-warning/10 [&_small]:text-xs [&_small]:font-semibold [&_small]:whitespace-nowrap",
  "round-detail-body":
    "grid grid-cols-[minmax(220px,_260px)_minmax(0,_1fr)] gap-4 items-start max-[1101px]:grid-cols-[1fr]",
  "round-detail-header":
    "flex items-center justify-between gap-3 [&_.status-badge]:bg-info/10 [&_.status-badge]:text-info",
  "round-detail-header-actions": "flex flex-wrap items-center gap-2",
  "round-detail-panel":
    "grid gap-3.5 border border-solid border-border rounded-xl p-4 bg-card shadow-xs [&_>_.form-error]:m-0",
  "round-detail-row": "[&_>_td]:bg-muted",
  "round-detail-title": "flex items-center gap-2.5 [&_h2]:m-0 [&_h2]:text-base",
  "round-donut-block":
    "grid gap-2.5 [&_h3]:m-0 [&_h3]:text-muted-foreground [&_h3]:text-sm [&_h3]:font-semibold",
  "round-donuts": "grid gap-4.5 max-[1101px]:grid-cols-2 max-[1101px]:items-start",
  "round-filter-row":
    "flex flex-wrap items-center gap-2.5 [&_.ui-select]:w-auto [&_.ui-select]:min-w-[150px]",
  "round-filter-search":
    "flex min-w-[min(360px,_100%)] [flex:1_0_360px] items-center gap-[7px] py-0 px-2.5 border border-solid border-border rounded-lg bg-card text-muted-foreground [&_.ui-input]:w-full [&_.ui-input]:min-h-8.5 [&_.ui-input]:min-w-0 [&_.ui-input]:[flex:1_1_auto] [&_.ui-input]:border-0 [&_.ui-input]:p-0 [&_.ui-input]:[outline:0] [&_.ui-input]:bg-transparent [&:focus-within]:border-info [&:focus-within]:shadow-xs",
  "round-inline-refresh":
    "inline-flex [flex:0_0_100%] items-center gap-1.5 text-muted-foreground text-xs whitespace-nowrap",
  "round-page-size":
    "inline-flex items-center gap-1.5 mr-auto text-muted-foreground whitespace-nowrap [&>_.ui-field-feedback]:w-auto [&_.ui-select]:w-auto [&_.ui-select]:min-w-18 [&_.ui-select]:py-1",
  "round-pagination": "flex items-center justify-end gap-3 text-muted-foreground text-xs",
  "round-row-actions": "flex flex-wrap items-center gap-1",
  "round-runner-name": "block min-w-0 [overflow-wrap:anywhere] whitespace-normal",
  "round-select-button": "font-semibold",
  "round-tab-content":
    "grid w-full min-w-0 gap-3.5 justify-items-start [&_>_.round-cases]:w-full [&_>_.runner-card-grid]:w-full [&_>_.inline-empty]:w-full",
  "round-tab-panel": "w-full min-w-0",
  "round-tab-toolbar": "flex items-center justify-between gap-3 mb-3 [&_.segmented-control]:mb-0",
  "round-table-scroll":
    "border border-solid border-border rounded-lg bg-card [&_tbody_tr]:cursor-pointer",
  "runner-card":
    "grid gap-2 border border-solid border-border rounded-lg p-3.5 bg-card [&_>_small]:text-xs [&_>_.ui-button]:justify-self-start",
  "runner-card-grid": "grid grid-cols-[repeat(auto-fill,_minmax(230px,_1fr))] gap-3",
  "runner-card-heading":
    "flex items-baseline justify-between gap-2 [&_strong]:font-mono [&_strong]:text-sm",
  "runner-card-stats": "flex gap-3 text-muted-foreground text-xs",

  "sortable-th-button":
    "inline-flex items-center gap-[5px] min-h-8 py-0.5 px-1 border-0 rounded-md bg-transparent text-inherit [font:inherit] font-semibold cursor-pointer [&:hover]:text-foreground",
  "sortable-th-indicator": "inline-block min-w-3 text-info text-xs leading-[1]",
  "status-badge":
    "inline-flex w-fit items-center gap-[5px] rounded-full py-[5px] px-2 text-xs font-semibold whitespace-nowrap",
  "step-label":
    "inline-grid min-w-7 h-6 place-items-center rounded-md bg-info/10 text-info text-xs font-semibold tracking-normal",
  "testng-class": "grid gap-2 pl-4.5",
  "testng-counts":
    "grid grid-cols-5 [border-block:1px_solid_var(--border)] [&_>_div]:grid [&_>_div]:gap-1 [&_>_div]:py-3 [&_>_div]:px-3.5 [&_>_div]:border-r [&_>_div]:border-solid [&_>_div]:border-border [&_>_div:last-child]:border-r-0 [&_span]:text-muted-foreground [&_span]:text-xs [&_strong]:text-base",
  "testng-method-table": "[&_th]:py-2 [&_td]:py-2",
  "testng-results": "grid gap-3.5",
  "testng-scope-heading":
    "[&_span]:text-muted-foreground [&_span]:text-xs flex min-w-0 items-baseline justify-between gap-3 [&_code]:[overflow-wrap:anywhere] [&_code]:text-xs",
  "testng-suite":
    "[&_.ui-disclosure-label_small]:text-muted-foreground [&_.ui-disclosure-label_small]:text-xs border-b border-solid border-border [&_.ui-disclosure-label]:flex [&_.ui-disclosure-label]:min-h-10 [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:justify-between [&_.ui-disclosure-label]:gap-3 [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:text-sm [&_.ui-disclosure-label]:font-semibold",
  "testng-test": "grid gap-2 [padding:10px_0_16px_18px]",
  "timeline-marker":
    "relative w-[9px] h-[9px] mt-[5px] border-2 border-solid border-border rounded-full bg-card",
} as const;
