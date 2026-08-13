"use client";

import { Button, Input, Select } from "@/components/ui";

import type { AttemptArtifactList, AttemptEventPage, AttemptLogPage } from "@autoforge/contracts";
import type { RunBatchDetails } from "@autoforge/domain";
import {
  Activity,
  Download,
  Eye,
  FileText,
  RefreshCw,
  RotateCcw,
  Search,
  TestTube2,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { runBatchStatusLabel } from "@/lib/run-batch-presentation";
import { parseSafeAnsi } from "@/lib/safe-ansi";

type LogStream = "stdout" | "stderr" | "agent";

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
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionPending, setActionPending] = useState<"cancel" | "retry" | undefined>();
  const attemptsByRun = useMemo(
    () => new Map(batch.attempts.map((attempt) => [attempt.executionRunId, attempt])),
    [batch.attempts],
  );
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
      replace: boolean,
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
          setLogs((current) => (replace ? logPage.items : [...current, ...logPage.items]));
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
      void loadAttempt(attemptId, stream, activeQuery, activeTimeRange, -1, true);
    }, 0);
    return () => window.clearTimeout(scheduledLoad);
  }, [activeQuery, activeTimeRange, attemptId, canReadArtifacts, canReadLogs, loadAttempt, stream]);

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
    () => parseSafeAnsi(logs.map((chunk) => chunk.content).join("")),
    [logs],
  );

  return (
    <div className="execution-detail-layout">
      <section className="execution-summary-band" aria-label="批次概览">
        <Summary label="状态" value={runBatchStatusLabel(batch.status)} />
        <Summary label="用例" value={String(batch.totalRuns)} />
        <Summary label="成功" value={String(batch.succeededRuns)} />
        <Summary label="失败" value={String(batch.failedRuns + batch.timedOutRuns)} />
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
                    <td>{attempt?.resultCode ?? run.terminalReasonCode ?? "-"}</td>
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
                    void loadAttempt(attemptId, stream, activeQuery, activeTimeRange, -1, true);
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
                <Input
                  aria-label="日志开始时间"
                  type="datetime-local"
                  value={recordedAfter}
                  onChange={(event) => setRecordedAfter(event.target.value)}
                />
                <Input
                  aria-label="日志结束时间"
                  type="datetime-local"
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
                    false,
                  )
                }
                type="button"
              >
                <RefreshCw size={15} /> 加载更多
              </Button>
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
