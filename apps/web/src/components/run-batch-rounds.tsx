"use client";

import type { AttemptArtifactList, AttemptEventPage } from "@autoforge/contracts";
import type {
  ExecutionRun,
  RunAttempt,
  RunBatchDetails,
  RunBatchRoundSummary,
} from "@autoforge/domain";
import { isTerminalAttemptStatus, summarizeRunBatchRounds } from "@autoforge/domain";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  ScrollText,
  Search,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AttemptLogViewer } from "@/components/attempt-log-viewer";
import { DonutChart, type DonutChartSegment } from "@/components/donut-chart";
import { SchedulingLogViewer } from "@/components/scheduling-log-viewer";
import { Button, Input, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import {
  formatArtifactBytes,
  formatAttemptDuration,
  formatBatchDuration,
  formatLocalDateTime,
} from "@/lib/run-batch-presentation";

const CASE_PAGE_SIZE = 10;

type CaseStatusFilter = "all" | "succeeded" | "failed" | "timed_out" | "cancelled" | "pending";

type RoundCaseRowModel = {
  run: ExecutionRun;
  attempt: RunAttempt | undefined;
};

// 轮次行命名：第 1 轮是初始执行，round 模式之后叫「重跑第 N 轮」，
// immediate 模式按第几次尝试叫「重试第 N 次」，两种模式的文案不得混用。
function roundLabel(retryMode: RunBatchDetails["retryMode"], round: number): string {
  if (round === 1) return "初始轮次";
  return retryMode === "round" ? `重跑第 ${round - 1} 轮` : `重试第 ${round - 1} 次`;
}

function roundStatusLabel(summary: RunBatchRoundSummary): string {
  if (summary.status === "running") return "运行中";
  if (summary.status === "completed") return "已完成";
  return summary.round === 1 ? "等待调度" : "等待上一轮结束";
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

/**
 * 轮次列表 + 选中轮次的详情面板。轮次聚合来自领域纯函数 summarizeRunBatchRounds，
 * 选中轮次写入 ?round=N，刷新或分享链接后可恢复。
 */
export function RunBatchRounds({
  batch,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
}: {
  batch: RunBatchDetails;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const summaries = useMemo(
    () => summarizeRunBatchRounds(batch, batch.runs, batch.attempts),
    [batch],
  );
  const requestedRound = Number(searchParams.get("round") ?? "");
  // 默认落在最后一个已执行的轮次；纯等待轮（还没有任何 attempt）不作为默认选中。
  const defaultRound =
    [...summaries].reverse().find((summary) => summary.status !== "waiting")?.round ??
    summaries.at(-1)?.round ??
    1;
  const selectedRound = summaries.some((summary) => summary.round === requestedRound)
    ? requestedRound
    : defaultRound;
  const selectedSummary = summaries.find((summary) => summary.round === selectedRound);
  const [activeTab, setActiveTab] = useState<"cases" | "runners">("cases");
  const [logAttempt, setLogAttempt] = useState<RunAttempt | undefined>();
  const [schedulingViewer, setSchedulingViewer] = useState<
    { runnerId?: string; title: string } | undefined
  >();
  const [cancelPending, setCancelPending] = useState(false);
  const [actionError, setActionError] = useState("");

  function selectRound(round: number): void {
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
          <table className="data-table">
            <thead>
              <tr>
                <th>轮次</th>
                <th>状态</th>
                <th>总用例数</th>
                <th>总通过率</th>
                <th>轮次通过率</th>
                <th>通过数</th>
                <th>失败数</th>
                <th>阻塞数</th>
                <th>开始时间</th>
                <th>轮次时长</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((summary) => (
                <tr
                  key={summary.round}
                  className={summary.round === selectedRound ? "selected-row" : undefined}
                  onClick={() => selectRound(summary.round)}
                >
                  <td>
                    <Button
                      className="round-select-button"
                      variant="ghost"
                      size="compact"
                      type="button"
                      aria-pressed={summary.round === selectedRound}
                      onClick={() => selectRound(summary.round)}
                    >
                      {roundLabel(batch.retryMode, summary.round)}
                    </Button>
                    <small className="table-secondary">第 {summary.round} 轮</small>
                  </td>
                  <td>
                    <span className={`batch-status ${roundStatusClass(summary)}`.trim()}>
                      {roundStatusLabel(summary)}
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
                  <td>{summary.blocked}</td>
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

      {selectedSummary ? (
        <RoundDetailPanel
          batch={batch}
          summary={selectedSummary}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          canCancelRuns={canCancelRuns}
          canReadLogs={canReadLogs}
          canReadArtifacts={canReadArtifacts}
          cancelPending={cancelPending}
          actionError={actionError}
          onCancelRun={(runId) => void cancelRun(runId)}
          onOpenLogs={setLogAttempt}
          onOpenScheduling={(runnerId) =>
            setSchedulingViewer(
              runnerId
                ? { runnerId, title: `runner ${shortId(runnerId)} · 调度日志` }
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

function RoundDetailPanel({
  batch,
  summary,
  activeTab,
  onTabChange,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
  cancelPending,
  actionError,
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
  cancelPending: boolean;
  actionError: string;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
  onOpenScheduling: (runnerId: string | undefined) => void;
}) {
  const label = roundLabel(batch.retryMode, summary.round);
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
      value: Math.max(0, summary.totalRuns - passedRunsSoFar),
      color: "var(--color-border-strong)",
    },
  ];

  return (
    <section className="round-detail-panel" aria-label={`轮次详情：${label}`}>
      <div className="round-detail-header">
        <div className="round-detail-title">
          <h2>{label}</h2>
          <span className={`batch-status ${roundStatusClass(summary)}`.trim()}>
            {roundStatusLabel(summary)}
          </span>
          {summary.status === "running" && canReadLogs ? (
            <span className="status-badge">实时更新</span>
          ) : null}
        </div>
        {canReadLogs ? (
          <Button
            className="button button-secondary compact-button"
            onClick={() => onOpenScheduling(undefined)}
            type="button"
          >
            <ScrollText size={15} /> 总体调度日志
          </Button>
        ) : null}
      </div>
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
              ariaLabel={`截至本轮总体通过进度：累计通过 ${passedRunsSoFar} 个用例，共 ${summary.totalRuns} 个`}
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
              cancelPending={cancelPending}
              onCancelRun={onCancelRun}
              onOpenLogs={onOpenLogs}
            />
          ) : (
            <RoundRunnerCards
              batch={batch}
              round={summary.round}
              canReadLogs={canReadLogs}
              onOpenScheduling={onOpenScheduling}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function RoundCasesTable({
  batch,
  round,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
  cancelPending,
  onCancelRun,
  onOpenLogs,
}: {
  batch: RunBatchDetails;
  round: number;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
  cancelPending: boolean;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
}) {
  const rows = useMemo<RoundCaseRowModel[]>(
    () =>
      batch.runs.map((run) => ({
        run,
        attempt: batch.attempts.find(
          (attempt) => attempt.executionRunId === run.id && attempt.attemptNumber === round,
        ),
      })),
    [batch.attempts, batch.runs, round],
  );
  const [statusFilter, setStatusFilter] = useState<CaseStatusFilter>("all");
  const [nameQuery, setNameQuery] = useState("");
  const [page, setPage] = useState(1);
  // 单个用例的轮次默认展开行内详情，让结构化结果与产物无需额外点击即可见。
  const [expandedAttemptId, setExpandedAttemptId] = useState<string | undefined>(() => {
    if (rows.length !== 1) return undefined;
    const only = rows[0];
    if (!only?.attempt || !isTerminalAttemptStatus(only.attempt.status)) return undefined;
    return only.attempt.testNg || canReadArtifacts ? only.attempt.id : undefined;
  });

  const filteredRows = useMemo(() => {
    const keyword = nameQuery.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "all" && rowStatusKey(row) !== statusFilter) return false;
      if (!keyword) return true;
      return `${row.run.displayName} ${row.run.className}`.toLowerCase().includes(keyword);
    });
  }, [nameQuery, rows, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / CASE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filteredRows.slice(
    (currentPage - 1) * CASE_PAGE_SIZE,
    currentPage * CASE_PAGE_SIZE,
  );

  function rowStatusKey(row: RoundCaseRowModel): CaseStatusFilter {
    if (!row.attempt) return "pending";
    if (row.attempt.status === "assigned" || row.attempt.status === "running") return "all";
    return row.attempt.status;
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
          <table className="data-table">
            <thead>
              <tr>
                <th>用例</th>
                <th>本轮状态</th>
                <th>Runner</th>
                <th>耗时</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <RoundCaseRow
                  key={row.run.id}
                  row={row}
                  expanded={expandedAttemptId === row.attempt?.id}
                  onToggleDetail={() =>
                    setExpandedAttemptId((current) =>
                      current === row.attempt?.id ? undefined : row.attempt?.id,
                    )
                  }
                  canCancelRuns={canCancelRuns}
                  canReadLogs={canReadLogs}
                  canReadArtifacts={canReadArtifacts}
                  cancelPending={cancelPending}
                  onCancelRun={onCancelRun}
                  onOpenLogs={onOpenLogs}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filteredRows.length > CASE_PAGE_SIZE ? (
        <div className="round-pagination">
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
      ) : null}
    </div>
  );
}

function RoundCaseRow({
  row,
  expanded,
  onToggleDetail,
  canCancelRuns,
  canReadLogs,
  canReadArtifacts,
  cancelPending,
  onCancelRun,
  onOpenLogs,
}: {
  row: RoundCaseRowModel;
  expanded: boolean;
  onToggleDetail: () => void;
  canCancelRuns: boolean;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
  cancelPending: boolean;
  onCancelRun: (runId: string) => void;
  onOpenLogs: (attempt: RunAttempt) => void;
}) {
  const { run, attempt } = row;
  const runnerId = attempt?.runnerId ?? run.assignedRunnerId;
  const hasDetail =
    attempt !== undefined &&
    isTerminalAttemptStatus(attempt.status) &&
    (attempt.testNg !== undefined || canReadArtifacts);
  return (
    <>
      <tr>
        <td>
          <strong>{run.displayName}</strong>
          <small className="table-secondary">{run.className}</small>
        </td>
        <td>
          {attempt ? (
            <>
              <span className={`batch-status ${attemptStatusClass(attempt)}`.trim()}>
                {attemptStatusLabel(attempt)}
              </span>
              {/* 终态失败原因码直接露出，无需展开详情即可定位 AGENT_RESTARTED 等调度失败。 */}
              {isTerminalAttemptStatus(attempt.status) &&
              attempt.status !== "succeeded" &&
              attempt.resultCode ? (
                <small className="table-secondary">{attempt.resultCode}</small>
              ) : null}
            </>
          ) : (
            <span className="batch-status batch-status-neutral">未执行</span>
          )}
        </td>
        <td>{runnerId ? <span title={runnerId}>{shortId(runnerId)}</span> : "—"}</td>
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
            {canCancelRuns && ["queued", "assigned", "running"].includes(run.status) ? (
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
        </td>
      </tr>
      {expanded && attempt ? (
        <tr className="round-detail-row">
          <td colSpan={5}>
            <AttemptInlineDetail attempt={attempt} canReadArtifacts={canReadArtifacts} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AttemptInlineDetail({
  attempt,
  canReadArtifacts,
}: {
  attempt: RunAttempt;
  canReadArtifacts: boolean;
}) {
  const [artifacts, setArtifacts] = useState<AttemptArtifactList["items"] | undefined>();
  const [events, setEvents] = useState<AttemptEventPage["items"] | undefined>();
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const load = async (): Promise<void> => {
      setError("");
      try {
        const [artifactResponse, eventResponse] = await Promise.all([
          canReadArtifacts
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
        if (artifactResponse) {
          setArtifacts(((await artifactResponse.json()) as AttemptArtifactList).items);
        }
        setEvents(((await eventResponse.json()) as AttemptEventPage).items);
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
  }, [attempt.id, canReadArtifacts]);

  return (
    <div className="attempt-inline-detail">
      {error ? <p className="form-error">{error}</p> : null}
      {attempt.testNg ? (
        <div className="attempt-inline-block">
          <h3>结构化测试结果</h3>
          <TestNgResults result={attempt.testNg} />
        </div>
      ) : null}
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
  onOpenScheduling,
}: {
  batch: RunBatchDetails;
  round: number;
  canReadLogs: boolean;
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
      {cards.map(([runnerId, card]) => (
        <div className="runner-card" key={runnerId}>
          <div className="runner-card-heading">
            <strong title={runnerId}>{shortId(runnerId)}</strong>
            <span className="muted">本轮执行 {card.executed} 个</span>
          </div>
          <div className="runner-card-stats">
            <span>通过 {card.passed}</span>
            <span>失败 {card.failed}</span>
          </div>
          <small className="muted">
            最后活动{" "}
            <time title={`UTC ${card.lastActivity}`}>{formatLocalDateTime(card.lastActivity)}</time>
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
      ))}
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
