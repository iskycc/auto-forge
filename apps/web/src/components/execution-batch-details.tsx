"use client";

import { Button, DatetimeInput, Input, Select } from "@/components/ui";

import type {
  AttemptArtifactList,
  AttemptEventPage,
  AttemptLogPage,
  LogChunk,
} from "@autoforge/contracts";
import type { RunBatchDetails } from "@autoforge/domain";
import {
  Activity,
  Download,
  Eye,
  FileText,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  Terminal,
  TestTube2,
  X,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  batchTestNames,
  formatBatchDuration,
  runBatchDurationMs,
  runBatchPassRate,
  runBatchStatusLabel,
} from "@/lib/run-batch-presentation";
import { highlightLogLevels } from "@/lib/log-levels";
import { parseSafeAnsi } from "@/lib/safe-ansi";

type LogStream = "stdout" | "stderr" | "agent";

function parseLiveLogMessage(value: unknown): { chunks: LogChunk[] } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: unknown;
      type?: unknown;
      chunks?: unknown;
    };
    if (parsed.schemaVersion !== 1 || parsed.type !== "chunks" || !Array.isArray(parsed.chunks)) {
      return null;
    }
    const chunks = parsed.chunks.filter(
      (chunk): chunk is LogChunk =>
        typeof chunk === "object" &&
        chunk !== null &&
        ["stdout", "stderr", "agent"].includes(String((chunk as LogChunk).stream)) &&
        Number.isInteger((chunk as LogChunk).sequence) &&
        typeof (chunk as LogChunk).content === "string" &&
        typeof (chunk as LogChunk).recordedAt === "string",
    );
    return { chunks };
  } catch {
    return null;
  }
}

function mergeLogChunks(current: LogChunk[], incoming: LogChunk[]): LogChunk[] {
  const bySequence = new Map(current.map((chunk) => [chunk.sequence, chunk]));
  for (const chunk of incoming) bySequence.set(chunk.sequence, chunk);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

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
  const [attemptId, setAttemptId] = useState(batch.attempts.at(-1)?.id ?? "");
  const [stream, setStream] = useState<LogStream>("stdout");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [recordedAfter, setRecordedAfter] = useState("");
  const [recordedBefore, setRecordedBefore] = useState("");
  const [activeTimeRange, setActiveTimeRange] = useState({ after: "", before: "" });
  const [darkLogs, setDarkLogs] = useState(true);
  const [logs, setLogs] = useState<AttemptLogPage["items"]>([]);
  const [nextSequence, setNextSequence] = useState<number | undefined>();
  const [logsTruncated, setLogsTruncated] = useState(false);
  const [artifacts, setArtifacts] = useState<AttemptArtifactList["items"]>([]);
  const [events, setEvents] = useState<AttemptEventPage["items"]>([]);
  const [loading, setLoading] = useState(false);
  const [liveLogs, setLiveLogs] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [schedulingViewer, setSchedulingViewer] = useState<
    { runnerId?: string; title: string } | undefined
  >();
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionPending, setActionPending] = useState<"cancel" | "retry" | undefined>();
  const attemptsByRun = useMemo(
    () => new Map(batch.attempts.map((attempt) => [attempt.executionRunId, attempt])),
    [batch.attempts],
  );
  const runnerSchedulingRows = useMemo(() => {
    const runCountByRunner = new Map<string, number>();
    for (const run of batch.runs) {
      if (!run.assignedRunnerId) continue;
      runCountByRunner.set(
        run.assignedRunnerId,
        (runCountByRunner.get(run.assignedRunnerId) ?? 0) + 1,
      );
    }
    for (const attempt of batch.attempts) {
      if (!runCountByRunner.has(attempt.runnerId)) runCountByRunner.set(attempt.runnerId, 0);
    }
    return [...runCountByRunner.entries()];
  }, [batch.attempts, batch.runs]);
  const selectedAttempt = useMemo(
    () => batch.attempts.find((attempt) => attempt.id === attemptId),
    [attemptId, batch.attempts],
  );
  const selectedLease = useMemo(() => {
    const claimed = [...events].reverse().find((event) => event.eventType === "assignment.claimed");
    if (!claimed) return undefined;
    const leaseId = stringDetail(claimed.details, "leaseId");
    const expiresAt = stringDetail(claimed.details, "leaseExpiresAt");
    return leaseId ? { leaseId, expiresAt } : undefined;
  }, [events]);
  const activeBatch = ["queued", "dispatching", "scheduled", "running"].includes(batch.status);
  const retryBlockedByLegacySecrets =
    batch.secretBindings.length > 0 && batch.environmentVersionId === undefined;

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
      if (!response.ok) throw new Error(await responseMessage(response, "取消批次失败。"));
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
      if (!response.ok) throw new Error(await responseMessage(response, "重新执行失败。"));
      const created = (await response.json()) as { id?: string };
      if (!created.id) throw new Error("平台未返回新批次标识。");
      router.push(`/run-batches/${encodeURIComponent(created.id)}`);
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "重新执行失败。");
    } finally {
      setActionPending(undefined);
    }
  }

  async function cancelRun(runId: string): Promise<void> {
    const reason = window.prompt(
      "请输入取消该用例执行的原因：",
      "Cancelled from execution details.",
    );
    if (!reason?.trim()) return;
    setActionPending("cancel");
    setActionError("");
    try {
      const response = await fetch(`/api/v1/execution-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, "取消用例执行失败。"));
      router.refresh();
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : "取消用例执行失败。");
    } finally {
      setActionPending(undefined);
    }
  }

  const loadAttempt = useCallback(
    async (
      selectedAttemptId: string,
      selectedStream: LogStream,
      search: string,
      timeRange: { after: string; before: string },
      afterSequence: number,
    ) => {
      await Promise.resolve();
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({
          stream: selectedStream,
          afterSequence: String(afterSequence),
          limit: "200",
        });
        if (search.trim()) parameters.set("query", search.trim());
        const afterTimestamp = toIsoFilter(timeRange.after);
        const beforeTimestamp = toIsoFilter(timeRange.before);
        if (afterTimestamp) parameters.set("recordedAfter", afterTimestamp);
        if (beforeTimestamp) parameters.set("recordedBefore", beforeTimestamp);
        const [logResponse, artifactResponse, eventResponse] = await Promise.all([
          canReadLogs
            ? fetch(
                `/api/v1/run-attempts/${encodeURIComponent(selectedAttemptId)}/logs?${parameters}`,
                { cache: "no-store" },
              )
            : null,
          canReadArtifacts
            ? fetch(`/api/v1/run-attempts/${encodeURIComponent(selectedAttemptId)}/artifacts`, {
                cache: "no-store",
              })
            : null,
          fetch(`/api/v1/run-attempts/${encodeURIComponent(selectedAttemptId)}/events?limit=200`, {
            cache: "no-store",
          }),
        ]);
        if (logResponse && !logResponse.ok) {
          throw new Error(await responseMessage(logResponse, "读取日志失败。"));
        }
        if (artifactResponse && !artifactResponse.ok) {
          throw new Error(await responseMessage(artifactResponse, "读取产物失败。"));
        }
        if (!eventResponse.ok) {
          throw new Error(await responseMessage(eventResponse, "读取执行时间线失败。"));
        }
        if (logResponse) {
          const logPage = (await logResponse.json()) as AttemptLogPage;
          setLogs((current) => mergeLogChunks(current, logPage.items));
          setNextSequence(logPage.nextSequence);
          setLogsTruncated(logPage.truncated);
        }
        if (artifactResponse) {
          const artifactList = (await artifactResponse.json()) as AttemptArtifactList;
          setArtifacts(artifactList.items);
        }
        const eventPage = (await eventResponse.json()) as AttemptEventPage;
        setEvents(eventPage.items);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "读取执行详情失败。");
      } finally {
        setLoading(false);
      }
    },
    [canReadArtifacts, canReadLogs],
  );

  useEffect(() => {
    if (!attemptId) return;
    const scheduledLoad = window.setTimeout(() => {
      setLogs([]);
      setNextSequence(undefined);
      setLogsTruncated(false);
      void loadAttempt(attemptId, stream, activeQuery, activeTimeRange, -1);
    }, 0);
    return () => window.clearTimeout(scheduledLoad);
  }, [activeQuery, activeTimeRange, attemptId, canReadArtifacts, canReadLogs, loadAttempt, stream]);

  useEffect(() => {
    if (
      !attemptId ||
      !canReadLogs ||
      activeQuery ||
      activeTimeRange.after ||
      activeTimeRange.before
    ) {
      return;
    }
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    const connect = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/v1/run-attempts/${encodeURIComponent(attemptId)}/log-stream-ticket`,
          { method: "POST" },
        );
        if (!response.ok || disposed) return;
        const payload = (await response.json()) as { ticket?: string };
        if (!payload.ticket || disposed) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(
          `${protocol}//${window.location.host}/api/v1/log-stream`,
          `autoforge-log.${payload.ticket}`,
        );
        socket.onopen = () => {
          setLiveLogs(true);
          void loadAttempt(attemptId, stream, "", { after: "", before: "" }, -1);
        };
        socket.onmessage = (event) => {
          const message = parseLiveLogMessage(event.data);
          if (!message) return;
          const incoming = message.chunks.filter((chunk) => chunk.stream === stream);
          if (incoming.length === 0) return;
          setLogs((current) => mergeLogChunks(current, incoming));
        };
        socket.onclose = () => {
          setLiveLogs(false);
          if (!disposed) reconnectTimer = window.setTimeout(() => void connect(), 2_000);
        };
        socket.onerror = () => socket?.close();
      } catch {
        setLiveLogs(false);
        if (!disposed) reconnectTimer = window.setTimeout(() => void connect(), 5_000);
      }
    };
    void connect();
    return () => {
      disposed = true;
      setLiveLogs(false);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close(1000, "Log view changed");
    };
  }, [activeQuery, activeTimeRange, attemptId, canReadLogs, loadAttempt, stream]);

  const sequenceGaps = useMemo(() => {
    const gaps: Array<{ after: number; before: number }> = [];
    for (let index = 1; index < logs.length; index += 1) {
      const previous = logs[index - 1];
      const current = logs[index];
      if (previous && current && current.sequence > previous.sequence + 1) {
        gaps.push({ after: previous.sequence, before: current.sequence });
      }
    }
    return gaps;
  }, [logs]);
  const renderedLogs = useMemo(
    () => highlightLogLevels(parseSafeAnsi(logs.map((chunk) => chunk.content).join(""))),
    [logs],
  );

  return (
    <div className="execution-detail-layout">
      <section className="execution-summary-band" aria-label="批次概览">
        <Summary label="状态" value={runBatchStatusLabel(batch.status)} />
        <Summary label="Suite" value={batch.suiteName} />
        <Summary
          label="Test Name"
          value={batchTestNames(batch.attempts).join("、") || "尚无 TestNG 结果"}
        />
        <Summary label="通过率" value={`${runBatchPassRate(batch)}%`} />
        <Summary label="用例" value={String(batch.totalRuns)} />
        <Summary label="已通过" value={String(batch.succeededRuns)} />
        <Summary label="已失败" value={String(batch.failedRuns + batch.timedOutRuns)} />
        <Summary
          label="当前轮次"
          value={batch.retryMode === "round" ? `第 ${batch.currentRound} 轮` : "立即重跑模式"}
        />
        <Summary
          label="执行耗时"
          value={activeBatch ? "执行中" : formatBatchDuration(runBatchDurationMs(batch))}
        />
        <Summary label="创建时间" value={formatDate(batch.createdAt)} />
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

      <section className="execution-runs-section">
        <div className="section-heading">
          <div>
            <span className="step-label">RUNS</span>
            <h2>用例与尝试</h2>
          </div>
          <span className="muted">UTC {batch.updatedAt}</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>用例</th>
                <th>状态</th>
                <th>Runner</th>
                <th>结果 / 失败阶段</th>
                <th>耗时</th>
                <th>尝试</th>
                {canCancelRuns ? <th>操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {batch.runs.map((run) => {
                const attempt = attemptsByRun.get(run.id);
                return (
                  <tr key={run.id}>
                    <td>
                      <strong>{run.displayName}</strong>
                      <small className="table-secondary">{run.className}</small>
                    </td>
                    <td>{run.status}</td>
                    <td>{run.assignedRunnerId ?? "等待分配"}</td>
                    <td>
                      {attempt?.resultCode ?? run.terminalReasonCode ?? "-"}
                      {attempt?.resultSummary ? (
                        <small className="run-result-summary" title={attempt.resultSummary}>
                          {attempt.resultSummary}
                        </small>
                      ) : null}
                    </td>
                    <td>
                      {attempt?.durationMs === undefined ? "-" : formatDuration(attempt.durationMs)}
                    </td>
                    <td>
                      {attempt ? (
                        <Button
                          className="button button-secondary compact-button"
                          type="button"
                          onClick={() => setAttemptId(attempt.id)}
                        >
                          #{attempt.attemptNumber}
                        </Button>
                      ) : (
                        "-"
                      )}
                    </td>
                    {canCancelRuns ? (
                      <td>
                        {["queued", "assigned", "running"].includes(run.status) ? (
                          <Button
                            className="danger-text-button"
                            disabled={actionPending !== undefined}
                            onClick={() => void cancelRun(run.id)}
                            type="button"
                          >
                            取消该用例
                          </Button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {runnerSchedulingRows.length > 0 ? (
        <section className="execution-runs-section" aria-label="执行机调度日志">
          <div className="section-heading">
            <div>
              <span className="step-label">RUNNERS</span>
              <h2>执行机调度日志</h2>
            </div>
            <span className="muted">{runnerSchedulingRows.length} 台执行机</span>
          </div>
          <div className="runner-scheduling-list">
            {runnerSchedulingRows.map(([runnerId, runCount]) => (
              <div className="runner-scheduling-row" key={runnerId}>
                <div className="runner-scheduling-info">
                  <strong>{runnerId.slice(0, 8)}</strong>
                  <small>{runCount} 个关联用例</small>
                </div>
                {canReadLogs ? (
                  <Button
                    className="button button-secondary compact-button"
                    onClick={() =>
                      setSchedulingViewer({
                        runnerId,
                        title: `runner ${runnerId.slice(0, 8)} · 调度日志`,
                      })
                    }
                    type="button"
                  >
                    <ScrollText size={15} /> 日志
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {selectedAttempt?.testNg ? (
        <section className="execution-results-section">
          <div className="section-heading">
            <div>
              <span className="step-label">TESTNG</span>
              <h2>结构化测试结果</h2>
            </div>
            <TestTube2 size={19} aria-hidden="true" />
          </div>
          <TestNgResults result={selectedAttempt.testNg} />
        </section>
      ) : null}

      {selectedAttempt ? (
        <section className="execution-attempt-metadata" aria-label="当前尝试与租约">
          <Summary label="Attempt ID" value={selectedAttempt.id} />
          <Summary label="Runner" value={selectedAttempt.runnerId} />
          <Summary label="状态" value={selectedAttempt.status} />
          <Summary label="Lease ID" value={selectedLease?.leaseId ?? "尚未领取或已无租约"} />
          <Summary
            label="初始租约到期（UTC）"
            value={selectedLease?.expiresAt ?? "等待 Runner 领取"}
          />
        </section>
      ) : null}

      <section className="execution-output-section">
        <div className="section-heading">
          <div>
            <span className="step-label">OUTPUT</span>
            <h2>日志与产物</h2>
            {liveLogs ? <span className="status-badge">实时更新</span> : null}
          </div>
          <Select
            aria-label="执行尝试"
            value={attemptId}
            onChange={(event) => setAttemptId(event.target.value)}
          >
            {batch.attempts.map((attempt) => (
              <option key={attempt.id} value={attempt.id}>
                Attempt #{attempt.attemptNumber} · {attempt.status}
              </option>
            ))}
          </Select>
        </div>
        {!attemptId ? (
          <div className="inline-empty">批次尚未生成执行尝试。</div>
        ) : (
          <>
            <div className="log-entry-row">
              <div className="log-entry-summary">
                <Terminal size={16} aria-hidden="true" />
                <span>
                  执行日志 · {stream} · {logs.length} 段{liveLogs ? " · 实时更新中" : ""}
                </span>
              </div>
              <div className="button-row">
                {canReadLogs ? (
                  <Button
                    className="button button-secondary compact-button"
                    onClick={() => setSchedulingViewer({ title: "总体调度日志" })}
                    type="button"
                  >
                    <ScrollText size={15} /> 总体日志
                  </Button>
                ) : null}
                <Button
                  className="button button-secondary compact-button"
                  onClick={() => setLogViewerOpen(true)}
                  type="button"
                >
                  <Eye size={15} /> 查看日志
                </Button>
              </div>
            </div>
            {logViewerOpen ? (
              <TerminalLogViewer
                title={`attempt ${attemptId.slice(0, 8)} · ${stream}${liveLogs ? " · live" : ""}`}
                onClose={() => setLogViewerOpen(false)}
              >
                <div className="log-toolbar">
                  <div className="segmented-control" aria-label="日志流">
                    {(["stdout", "stderr", "agent"] as const).map((value) => (
                      <Button
                        aria-pressed={stream === value}
                        className={stream === value ? "active" : ""}
                        key={value}
                        onClick={() => setStream(value)}
                        type="button"
                      >
                        {value}
                      </Button>
                    ))}
                  </div>
                  <form
                    className="log-search"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (query === activeQuery) {
                        void loadAttempt(attemptId, stream, activeQuery, activeTimeRange, -1);
                      } else {
                        setActiveQuery(query);
                      }
                      setActiveTimeRange({ after: recordedAfter, before: recordedBefore });
                    }}
                  >
                    <Search size={15} />
                    <Input
                      aria-label="搜索日志"
                      placeholder="搜索当前日志流"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <DatetimeInput
                      aria-label="日志开始时间"
                      value={recordedAfter}
                      onChange={(event) => setRecordedAfter(event.target.value)}
                    />
                    <DatetimeInput
                      aria-label="日志结束时间"
                      value={recordedBefore}
                      onChange={(event) => setRecordedBefore(event.target.value)}
                    />
                    <Button className="button button-secondary compact-button" type="submit">
                      筛选
                    </Button>
                  </form>
                  <Button
                    aria-pressed={darkLogs}
                    className="button button-secondary compact-button"
                    onClick={() => setDarkLogs((current) => !current)}
                    type="button"
                  >
                    {darkLogs ? "浅色日志" : "深色日志"}
                  </Button>
                </div>
                {error ? <p className="form-error">{error}</p> : null}
                {logsTruncated ? (
                  <p className="status-warning" role="status">
                    日志已达到保留上限，后续内容被明确截断。
                  </p>
                ) : null}
                {sequenceGaps.length > 0 ? (
                  <p className="status-warning" role="status">
                    检测到 {sequenceGaps.length} 个序号缺口；Agent 补传后刷新即可恢复连续内容。
                  </p>
                ) : null}
                {canReadLogs ? (
                  <pre
                    className={`execution-log ${darkLogs ? "execution-log-dark" : ""}`}
                    aria-live="polite"
                  >
                    {logs.length > 0
                      ? renderedLogs.map((segment, index) => (
                          <span className={segment.classes.join(" ")} key={index}>
                            {segment.text}
                          </span>
                        ))
                      : loading
                        ? "正在读取日志..."
                        : "当前日志流暂无内容。"}
                  </pre>
                ) : (
                  <div className="inline-empty">当前账号没有读取执行日志的权限。</div>
                )}
                {nextSequence !== undefined ? (
                  <Button
                    className="button button-secondary compact-button"
                    disabled={loading}
                    onClick={() =>
                      void loadAttempt(
                        attemptId,
                        stream,
                        activeQuery,
                        activeTimeRange,
                        nextSequence,
                      )
                    }
                    type="button"
                  >
                    <RefreshCw size={15} /> 加载更多
                  </Button>
                ) : null}
              </TerminalLogViewer>
            ) : null}
            <div className="artifact-list">
              {!canReadArtifacts ? (
                <div className="inline-empty">当前账号没有读取执行产物的权限。</div>
              ) : null}
              {canReadArtifacts && artifacts.length === 0 ? (
                <div className="inline-empty">当前尝试没有已声明产物。</div>
              ) : null}
              {canReadArtifacts
                ? artifacts.map((artifact) => (
                    <div className="artifact-row" key={artifact.artifactId}>
                      <FileText size={17} />
                      <span>
                        <strong>{artifact.relativePath}</strong>
                        <small>
                          {formatBytes(artifact.sizeBytes)} · {artifact.status}
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
                  ))
                : null}
            </div>
          </>
        )}
      </section>

      <section className="execution-timeline-section">
        <div className="section-heading">
          <div>
            <span className="step-label">TIMELINE</span>
            <h2>执行时间线</h2>
          </div>
          <Activity size={19} aria-hidden="true" />
        </div>
        {!attemptId ? (
          <div className="inline-empty">批次尚未生成执行尝试。</div>
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
      </section>

      {schedulingViewer ? (
        <SchedulingLogViewer
          batchId={batch.id}
          runnerId={schedulingViewer.runnerId}
          title={schedulingViewer.title}
          onClose={() => setSchedulingViewer(undefined)}
        />
      ) : null}
    </div>
  );
}

function toIsoFilter(value: string): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
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

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TestNgResults({
  result,
}: {
  result: NonNullable<RunBatchDetails["attempts"][number]["testNg"]>;
}) {
  return (
    <div className="testng-results">
      <div className="testng-counts" aria-label="TestNG 结果汇总">
        <Summary label="总计" value={String(result.total)} />
        <Summary label="通过" value={String(result.passed)} />
        <Summary label="失败" value={String(result.failed)} />
        <Summary label="跳过" value={String(result.skipped)} />
        <Summary label="配置失败" value={String(result.configurationFailures)} />
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
              {suite.passed}/{suite.total} 通过 · {formatDuration(suite.durationMs)}
            </small>
          </summary>
          {suite.tests.map((test, testIndex) => (
            <div className="testng-test" key={`${test.name}-${testIndex}`}>
              <div className="testng-scope-heading">
                <strong>{test.name}</strong>
                <span>{formatDuration(test.durationMs)}</span>
              </div>
              {test.classes.map((classResult, classIndex) => (
                <div className="testng-class" key={`${classResult.name}-${classIndex}`}>
                  <div className="testng-scope-heading">
                    <code>{classResult.name}</code>
                    <span>{formatDuration(classResult.durationMs)}</span>
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
                            <td>{formatDuration(method.durationMs)}</td>
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

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)} s`;
  return `${Math.floor(value / 60_000)} min ${Math.round((value % 60_000) / 1_000)} s`;
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

function stringDetail(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type SchedulingEventType =
  | "batch_scheduled"
  | "run_assigned"
  | "attempt_claimed"
  | "attempt_completed"
  | "run_held_for_round"
  | "runner_metrics";

type SchedulingEvent = {
  id: string;
  batchId: string;
  runnerId?: string;
  executionRunId?: string;
  attemptId?: string;
  eventType: SchedulingEventType;
  message: string;
  payload?: Record<string, unknown>;
  recordedAt: string;
};

type SchedulingEventPage = {
  items: SchedulingEvent[];
  nextAfterId?: string;
};

const SCHEDULING_EVENT_CLASS: Record<SchedulingEventType, string> = {
  batch_scheduled: "scheduling-event-blue",
  run_assigned: "scheduling-event-green",
  attempt_claimed: "scheduling-event-blue",
  attempt_completed: "",
  run_held_for_round: "scheduling-event-yellow",
  runner_metrics: "scheduling-event-blue",
};

function schedulingEventClass(event: SchedulingEvent): string {
  if (event.eventType === "attempt_completed") {
    const outcome = event.payload?.outcome;
    return outcome === "succeeded" ? "scheduling-event-green" : "scheduling-event-red";
  }
  return SCHEDULING_EVENT_CLASS[event.eventType];
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 共享的终端弹窗外壳：遮罩、macOS 风格标题栏、Esc 关闭、滚动内容区。 */
function TerminalLogViewer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="log-viewer-overlay" role="presentation" onClick={onClose}>
      <div
        className="log-viewer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="log-viewer-titlebar">
          <div className="log-viewer-title">
            <span className="log-viewer-dot log-viewer-dot-red" />
            <span className="log-viewer-dot log-viewer-dot-yellow" />
            <span className="log-viewer-dot log-viewer-dot-green" />
            <span className="log-viewer-name">{title}</span>
          </div>
          <Button
            className="icon-button small-icon-button log-viewer-close"
            onClick={onClose}
            type="button"
            aria-label="关闭日志终端"
          >
            <X size={16} />
          </Button>
        </div>
        <div className="log-viewer-body">{children}</div>
      </div>
    </div>
  );
}

/** 调度日志弹窗：批次级或单 Runner 级调度事件流，支持游标翻页与打开期间轮询。 */
function SchedulingLogViewer({
  batchId,
  runnerId,
  title,
  onClose,
}: {
  batchId: string;
  runnerId: string | undefined;
  title: string;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<SchedulingEvent[]>([]);
  const [nextAfterId, setNextAfterId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement | null>(null);
  const lastEventIdRef = useRef<string | undefined>(undefined);

  const fetchPage = useCallback(
    async (afterId: string | undefined) => {
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({ limit: "200" });
        if (runnerId) parameters.set("runnerId", runnerId);
        if (afterId) parameters.set("afterId", afterId);
        const response = await fetch(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}/scheduling-events?${parameters}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(await responseMessage(response, "读取调度日志失败。"));
        const page = (await response.json()) as SchedulingEventPage;
        setEvents((current) => {
          const knownIds = new Set(current.map((event) => event.id));
          const additions = page.items.filter((event) => !knownIds.has(event.id));
          return additions.length > 0 ? [...current, ...additions] : current;
        });
        const newest = page.items.at(-1);
        if (newest) lastEventIdRef.current = newest.id;
        setNextAfterId(page.nextAfterId);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "读取调度日志失败。");
      } finally {
        setLoading(false);
      }
    },
    [batchId, runnerId],
  );

  // 首次加载与打开期间的增量轮询合并为一个 effect：
  // 通过 setTimeout/setInterval 回调触发异步拉取，避免在 effect 体内同步 setState。
  useEffect(() => {
    const kick = window.setTimeout(() => void fetchPage(undefined), 0);
    const timer = window.setInterval(() => void fetchPage(lastEventIdRef.current), 3_000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [fetchPage]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [events]);

  return (
    <TerminalLogViewer title={title} onClose={onClose}>
      {error ? <p className="form-error">{error}</p> : null}
      <pre
        className="execution-log execution-log-dark scheduling-log"
        aria-live="polite"
        ref={logRef}
      >
        {events.length > 0
          ? events.map((event) => (
              <span className={`scheduling-event ${schedulingEventClass(event)}`} key={event.id}>
                <span className="ansi-bright-black">[{formatEventTime(event.recordedAt)}]</span>{" "}
                {event.message}
                {"\n"}
              </span>
            ))
          : loading
            ? "正在读取调度日志..."
            : "暂无调度日志"}
      </pre>
      {nextAfterId !== undefined ? (
        <Button
          className="button button-secondary compact-button"
          disabled={loading}
          onClick={() => void fetchPage(nextAfterId)}
          type="button"
        >
          <RefreshCw size={15} /> 加载更多
        </Button>
      ) : null}
    </TerminalLogViewer>
  );
}
