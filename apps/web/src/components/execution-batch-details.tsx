"use client";

import type { AttemptArtifactList, AttemptEventPage, AttemptLogPage } from "@autoforge/contracts";
import type { RunBatchDetails } from "@autoforge/domain";
import { Activity, Download, FileText, RefreshCw, Search, TestTube2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { runBatchStatusLabel } from "@/lib/run-batch-presentation";

type LogStream = "stdout" | "stderr" | "agent";

export function ExecutionBatchDetails({
  batch,
  canReadLogs,
  canReadArtifacts,
}: {
  batch: RunBatchDetails;
  canReadLogs: boolean;
  canReadArtifacts: boolean;
}) {
  const [attemptId, setAttemptId] = useState(batch.attempts.at(-1)?.id ?? "");
  const [stream, setStream] = useState<LogStream>("stdout");
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [logs, setLogs] = useState<AttemptLogPage["items"]>([]);
  const [nextSequence, setNextSequence] = useState<number | undefined>();
  const [artifacts, setArtifacts] = useState<AttemptArtifactList["items"]>([]);
  const [events, setEvents] = useState<AttemptEventPage["items"]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const attemptsByRun = useMemo(
    () => new Map(batch.attempts.map((attempt) => [attempt.executionRunId, attempt])),
    [batch.attempts],
  );
  const selectedAttempt = useMemo(
    () => batch.attempts.find((attempt) => attempt.id === attemptId),
    [attemptId, batch.attempts],
  );

  const loadAttempt = useCallback(
    async (
      selectedAttemptId: string,
      selectedStream: LogStream,
      search: string,
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
      void loadAttempt(attemptId, stream, activeQuery, -1, true);
    }, 0);
    return () => window.clearTimeout(scheduledLoad);
  }, [activeQuery, attemptId, canReadArtifacts, canReadLogs, loadAttempt, stream]);

  return (
    <div className="execution-detail-layout">
      <section className="execution-summary-band" aria-label="批次概览">
        <Summary label="状态" value={runBatchStatusLabel(batch.status)} />
        <Summary label="用例" value={String(batch.totalRuns)} />
        <Summary label="成功" value={String(batch.succeededRuns)} />
        <Summary label="失败" value={String(batch.failedRuns + batch.timedOutRuns)} />
        <Summary label="创建时间" value={formatDate(batch.createdAt)} />
      </section>

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
                <th>结果</th>
                <th>耗时</th>
                <th>尝试</th>
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
                    <td>{attempt?.resultCode ?? "-"}</td>
                    <td>
                      {attempt?.durationMs === undefined ? "-" : formatDuration(attempt.durationMs)}
                    </td>
                    <td>
                      {attempt ? (
                        <button
                          className="button button-secondary compact-button"
                          type="button"
                          onClick={() => setAttemptId(attempt.id)}
                        >
                          #{attempt.attemptNumber}
                        </button>
                      ) : (
                        "-"
                      )}
                    </td>
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

      <section className="execution-output-section">
        <div className="section-heading">
          <div>
            <span className="step-label">OUTPUT</span>
            <h2>日志与产物</h2>
          </div>
          <select
            aria-label="执行尝试"
            value={attemptId}
            onChange={(event) => setAttemptId(event.target.value)}
          >
            {batch.attempts.map((attempt) => (
              <option key={attempt.id} value={attempt.id}>
                Attempt #{attempt.attemptNumber} · {attempt.status}
              </option>
            ))}
          </select>
        </div>
        {!attemptId ? (
          <div className="inline-empty">批次尚未生成执行尝试。</div>
        ) : (
          <>
            <div className="log-toolbar">
              <div className="segmented-control" aria-label="日志流">
                {(["stdout", "stderr", "agent"] as const).map((value) => (
                  <button
                    aria-pressed={stream === value}
                    className={stream === value ? "active" : ""}
                    key={value}
                    onClick={() => setStream(value)}
                    type="button"
                  >
                    {value}
                  </button>
                ))}
              </div>
              <form
                className="log-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (query === activeQuery) {
                    void loadAttempt(attemptId, stream, activeQuery, -1, true);
                  } else {
                    setActiveQuery(query);
                  }
                }}
              >
                <Search size={15} />
                <input
                  aria-label="搜索日志"
                  placeholder="搜索当前日志流"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </form>
            </div>
            {error ? <p className="form-error">{error}</p> : null}
            {canReadLogs ? (
              <pre className="execution-log" aria-live="polite">
                {logs.length > 0
                  ? logs.map((chunk) => chunk.content).join("")
                  : loading
                    ? "正在读取日志..."
                    : "当前日志流暂无内容。"}
              </pre>
            ) : (
              <div className="inline-empty">当前账号没有读取执行日志的权限。</div>
            )}
            {nextSequence !== undefined ? (
              <button
                className="button button-secondary compact-button"
                disabled={loading}
                onClick={() =>
                  void loadAttempt(attemptId, stream, activeQuery, nextSequence, false)
                }
                type="button"
              >
                <RefreshCw size={15} /> 加载更多
              </button>
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
                        <a
                          className="icon-button small-icon-button"
                          href={artifact.downloadPath}
                          aria-label={`下载 ${artifact.relativePath}`}
                        >
                          <Download size={15} />
                        </a>
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
