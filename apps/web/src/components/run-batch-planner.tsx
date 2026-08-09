"use client";

import type { CaseSuite, RunBatch, Runner } from "@autoforge/domain";
import { Activity, Check, Cpu, MemoryStick, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type SchedulerPolicy = {
  maximumCpuUtilizationPercent: number;
  maximumMemoryUtilizationPercent: number;
  maximumLoadPerCpu: number;
  metricsMaximumAgeSeconds: number;
};

type EnvironmentRow = { id: number; name: string; value: string };

export function RunBatchPlanner({
  initialSuites,
  initialRunners,
  initialBatches,
  policy,
}: {
  initialSuites: CaseSuite[];
  initialRunners: Runner[];
  initialBatches: RunBatch[];
  policy: SchedulerPolicy;
}) {
  const [suiteId, setSuiteId] = useState(initialSuites[0]?.id ?? "");
  const [runnerIds, setRunnerIds] = useState<string[]>([]);
  const [retryLimit, setRetryLimit] = useState(0);
  const [environmentRows, setEnvironmentRows] = useState<EnvironmentRow[]>([]);
  const [nextEnvironmentId, setNextEnvironmentId] = useState(1);
  const [batches, setBatches] = useState(initialBatches);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [refreshPaused, setRefreshPaused] = useState(false);
  const selectedSuite = useMemo(
    () => initialSuites.find((suite) => suite.id === suiteId),
    [initialSuites, suiteId],
  );

  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch("/api/v1/run-batches?limit=100", { cache: "no-store" });
        if (!response.ok) return;
        const result = (await response.json()) as { items: RunBatch[] };
        setBatches(result.items);
        setRefreshPaused(false);
      } catch {
        setRefreshPaused(true);
      }
    }, 5_000);
    return () => window.clearInterval(interval);
  }, []);

  async function createBatch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!suiteId || runnerIds.length === 0) {
      setError("请选择用例任务和至少一台执行机。");
      return;
    }
    const environmentVariables = environmentRows
      .map((row) => ({ name: row.name.trim(), value: row.value }))
      .filter((variable) => variable.name.length > 0);
    setSubmitting(true);
    try {
      const response = await fetch("/api/v1/run-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suiteId, runnerIds, retryLimit, environmentVariables }),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(apiMessage(result));
      const created = result as RunBatch;
      setBatches((current) => [created, ...current.filter((batch) => batch.id !== created.id)]);
      setError("");
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "创建执行批次失败。");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleRunner(runnerId: string) {
    setRunnerIds((current) =>
      current.includes(runnerId)
        ? current.filter((selected) => selected !== runnerId)
        : [...current, runnerId],
    );
  }

  function addEnvironmentRow() {
    setEnvironmentRows((current) => [...current, { id: nextEnvironmentId, name: "", value: "" }]);
    setNextEnvironmentId((current) => current + 1);
  }

  return (
    <div className="run-batch-layout">
      <form className="card run-batch-form" onSubmit={createBatch}>
        <div className="section-heading">
          <div>
            <span className="step-label">01</span>
            <h2>选择用例任务</h2>
          </div>
          <span className="muted">固定任务版本快照</span>
        </div>
        <label className="field-stack">
          <span>用例任务</span>
          <select value={suiteId} onChange={(event) => setSuiteId(event.target.value)} required>
            {initialSuites.length === 0 ? <option value="">暂无可执行任务</option> : null}
            {initialSuites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name} · {suite.caseCount} 个用例 · v{suite.version}
              </option>
            ))}
          </select>
        </label>
        {selectedSuite ? (
          <div className="selection-summary">
            <Check size={16} />
            <span>
              将为 <strong>{selectedSuite.caseCount}</strong> 个用例创建独立 ExecutionRun
            </span>
          </div>
        ) : null}

        <div className="section-heading scheduler-step">
          <div>
            <span className="step-label">02</span>
            <h2>勾选执行机</h2>
          </div>
          <span className="muted">已选 {runnerIds.length} 台</span>
        </div>
        <div className="runner-choice-grid">
          {initialRunners.length === 0 ? (
            <div className="inline-empty">暂无执行机，请先注册 Runner Agent。</div>
          ) : (
            initialRunners.map((runner) => {
              const metrics = runner.resourceSnapshot;
              const selected = runnerIds.includes(runner.id);
              return (
                <label
                  className={`runner-choice ${selected ? "runner-choice-selected" : ""} ${runner.state === "disabled" ? "runner-choice-disabled" : ""}`}
                  key={runner.id}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={runner.state === "disabled"}
                    onChange={() => toggleRunner(runner.id)}
                  />
                  <span className="runner-choice-title">
                    <strong>{runner.name}</strong>
                    <small className={`runner-state runner-state-${runner.state}`}>
                      <i /> {stateLabel(runner.state)}
                    </small>
                  </span>
                  <span className="runner-choice-metrics">
                    <small>
                      <Cpu size={13} /> CPU{" "}
                      {metrics ? `${metrics.cpuUtilizationPercent}%` : "待上报"}
                    </small>
                    <small>
                      <MemoryStick size={13} /> 内存{" "}
                      {metrics ? `${metrics.memoryUtilizationPercent}%` : "待上报"}
                    </small>
                    <small>
                      <Activity size={13} /> 负载{" "}
                      {metrics
                        ? (metrics.loadAverage1m / metrics.logicalCpuCount).toFixed(2)
                        : "待上报"}
                      {metrics ? "/CPU" : ""}
                    </small>
                  </span>
                  <span className="runner-choice-capacity">
                    槽位 {runner.busySlots}/{runner.maxConcurrency}
                  </span>
                </label>
              );
            })
          )}
        </div>

        <div className="form-grid scheduler-step">
          <label className="field-stack">
            <span>失败用例重跑次数</span>
            <select
              value={retryLimit}
              onChange={(event) => setRetryLimit(Number(event.target.value))}
            >
              {Array.from({ length: 11 }, (_, value) => (
                <option key={value} value={value}>
                  {value === 0 ? "不重跑" : `${value} 次`}
                </option>
              ))}
            </select>
          </label>
          <div className="policy-summary" aria-label="当前调度阈值">
            <strong>当前准入阈值</strong>
            <span>CPU ≤ {policy.maximumCpuUtilizationPercent}%</span>
            <span>内存 ≤ {policy.maximumMemoryUtilizationPercent}%</span>
            <span>负载/CPU ≤ {policy.maximumLoadPerCpu}</span>
          </div>
        </div>

        <div className="section-heading scheduler-step">
          <div>
            <span className="step-label">03</span>
            <h2>测试环境变量</h2>
          </div>
          <button
            className="button button-secondary compact-button"
            type="button"
            onClick={addEnvironmentRow}
          >
            <Plus size={15} /> 添加变量
          </button>
        </div>
        <p className="field-hint">
          变量会随批次保存为快照；当前未提供密文存储，请勿填写密码或令牌。
        </p>
        <div className="environment-list">
          {environmentRows.length === 0 ? (
            <div className="inline-empty">未配置变量，执行时使用 Runner 受控基础环境。</div>
          ) : (
            environmentRows.map((row) => (
              <div className="environment-row" key={row.id}>
                <input
                  aria-label="环境变量名"
                  placeholder="TEST_ENV"
                  value={row.name}
                  onChange={(event) =>
                    setEnvironmentRows((current) =>
                      current.map((item) =>
                        item.id === row.id ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                />
                <input
                  aria-label="环境变量值"
                  placeholder="staging"
                  value={row.value}
                  onChange={(event) =>
                    setEnvironmentRows((current) =>
                      current.map((item) =>
                        item.id === row.id ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  className="icon-button small-icon-button"
                  type="button"
                  aria-label="删除环境变量"
                  onClick={() =>
                    setEnvironmentRows((current) => current.filter((item) => item.id !== row.id))
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          )}
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <button
          className="button button-primary run-batch-submit"
          type="submit"
          disabled={submitting || initialSuites.length === 0 || runnerIds.length === 0}
        >
          {submitting ? <RefreshCw className="spin" size={17} /> : <Activity size={17} />}
          {submitting ? "正在计算分配…" : "开始调度"}
        </button>
      </form>

      <section className="card run-batch-history">
        <div className="section-heading">
          <div>
            <span className="step-label">LIVE</span>
            <h2>调度队列</h2>
          </div>
          <span className="refresh-label">
            <i className={refreshPaused ? "refresh-dot-paused" : ""} />
            {refreshPaused ? "刷新暂时中断" : "每 5 秒刷新"}
          </span>
        </div>
        <div className="implementation-notice">
          当前阶段只生成执行分配和 RunAttempt，Agent 领取、TestNG 执行及结果回收将在执行闭环中接入。
        </div>
        {batches.length === 0 ? (
          <div className="inline-empty history-empty">尚未创建执行批次。</div>
        ) : (
          <div className="batch-list">
            {batches.map((batch) => {
              const progress =
                batch.totalRuns === 0 ? 0 : (batch.assignedRuns / batch.totalRuns) * 100;
              return (
                <article className="batch-row" key={batch.id}>
                  <div className="batch-row-main">
                    <span className={`batch-status batch-status-${batch.status}`}>
                      {batchStatusLabel(batch.status)}
                    </span>
                    <span>
                      <strong>{batch.suiteName}</strong>
                      <small>
                        任务 v{batch.suiteVersion} · {batch.selectedRunnerIds.length} 台执行机 ·
                        失败重跑 {batch.retryLimit} 次
                      </small>
                    </span>
                    <time dateTime={batch.createdAt}>{formatDate(batch.createdAt)}</time>
                  </div>
                  <div className="batch-progress-line">
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <div className="batch-counts">
                    <span>已分配 {batch.assignedRuns}</span>
                    <span>等待资源 {batch.queuedRuns}</span>
                    <span>总计 {batch.totalRuns}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function apiMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return "创建执行批次失败。";
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "创建执行批次失败。";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "创建执行批次失败。";
}

function stateLabel(state: Runner["state"]): string {
  if (state === "online") return "在线";
  if (state === "offline") return "离线";
  return "已禁用";
}

function batchStatusLabel(status: RunBatch["status"]): string {
  const labels: Record<RunBatch["status"], string> = {
    queued: "等待资源",
    dispatching: "分配中",
    scheduled: "已生成分配",
    running: "执行中",
    succeeded: "已成功",
    failed: "已失败",
    cancelled: "已取消",
  };
  return labels[status];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
