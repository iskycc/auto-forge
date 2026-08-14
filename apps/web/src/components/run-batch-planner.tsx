"use client";

import { Button, Input, Select } from "@/components/ui";

import {
  assessRunnerCompatibility,
  type CaseSuite,
  type ExecutionEnvironmentDetails,
  type RunBatch,
  type Runner,
} from "@autoforge/domain";
import type { RunBatchPreflightResult } from "@autoforge/contracts";
import { Activity, Check, Cpu, MemoryStick, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { runBatchCoveragePercent, runBatchStatusLabel } from "@/lib/run-batch-presentation";
import { runnerCompatibilityLabel, runnerCompatibilitySummary } from "@/lib/runner-compatibility";

type SchedulerPolicy = {
  maximumCpuUtilizationPercent: number;
  maximumMemoryUtilizationPercent: number;
  maximumLoadPerCpu: number;
  metricsMaximumAgeSeconds: number;
};

type EnvironmentRow = { id: number; name: string; value: string };

export function RunBatchPlanner({
  canCreate,
  initialSuites,
  initialRunners,
  initialEnvironments,
  initialBatches,
  historyRefreshUrl,
  nextPageHref,
  policy,
}: {
  canCreate: boolean;
  initialSuites: CaseSuite[];
  initialRunners: Runner[];
  initialEnvironments: ExecutionEnvironmentDetails[];
  initialBatches: RunBatch[];
  historyRefreshUrl: string;
  nextPageHref?: string;
  policy: SchedulerPolicy;
}) {
  const [suiteId, setSuiteId] = useState(initialSuites[0]?.id ?? "");
  const [runnerIds, setRunnerIds] = useState<string[]>([]);
  const [retryLimit, setRetryLimit] = useState<number | "">("");
  const [environmentVersionId, setEnvironmentVersionId] = useState("");
  const [environmentRows, setEnvironmentRows] = useState<EnvironmentRow[]>([]);
  const [nextEnvironmentId, setNextEnvironmentId] = useState(1);
  const [batches, setBatches] = useState(initialBatches);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [preflightBlockers, setPreflightBlockers] = useState<RunBatchPreflightResult["blockers"]>(
    [],
  );
  const [refreshPaused, setRefreshPaused] = useState(false);
  const selectedSuite = useMemo(
    () => initialSuites.find((suite) => suite.id === suiteId),
    [initialSuites, suiteId],
  );
  const availableEnvironments = useMemo(
    () =>
      initialEnvironments.filter(
        (environment) =>
          environment.projectId === selectedSuite?.projectId && environment.status === "active",
      ),
    [initialEnvironments, selectedSuite?.projectId],
  );

  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(historyRefreshUrl, { cache: "no-store" });
        if (!response.ok) return;
        const result = (await response.json()) as { items: RunBatch[] };
        setBatches(result.items);
        setRefreshPaused(false);
      } catch {
        setRefreshPaused(true);
      }
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [historyRefreshUrl]);

  async function createBatch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPreflightBlockers([]);
    if (!selectedSuite || runnerIds.length === 0) {
      setError("请选择用例任务和至少一台执行机。");
      return;
    }
    const environmentVariables = environmentVersionId
      ? []
      : environmentRows
          .map((row) => ({ name: row.name.trim(), value: row.value }))
          .filter((variable) => variable.name.length > 0);
    setSubmitting(true);
    try {
      const requestBody = {
        suiteId,
        projectId: selectedSuite.projectId,
        runnerIds,
        ...(retryLimit === "" ? {} : { retryLimit }),
        ...(environmentVersionId
          ? { environmentVersionId, environmentVariables: [] }
          : { environmentVariables }),
      };
      const preflightResponse = await fetch("/api/v1/run-batches/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const preflightResult: unknown = await preflightResponse.json();
      if (!preflightResponse.ok) throw new Error(apiMessage(preflightResult));
      const preflight = asPreflightResult(preflightResult);
      if (!preflight.ready) {
        setPreflightBlockers(preflight.blockers);
        setError("执行配置仍有阻塞项，请逐项处理后重试。");
        return;
      }
      const response = await fetch("/api/v1/run-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
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
      {canCreate ? (
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
            <Select
              aria-label="执行用例任务"
              value={suiteId}
              onChange={(event) => {
                setSuiteId(event.target.value);
                setEnvironmentVersionId("");
              }}
              required
            >
              {initialSuites.length === 0 ? <option value="">暂无可执行任务</option> : null}
              {initialSuites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name} · {suite.caseCount} 个用例 · v{suite.version}
                </option>
              ))}
            </Select>
          </label>
          {selectedSuite ? (
            <div className="selection-summary">
              <Check size={16} />
              <span>
                将为 <strong>{selectedSuite.caseCount}</strong> 个用例创建独立 ExecutionRun
              </span>
            </div>
          ) : null}
          {selectedSuite ? (
            <p className="field-hint">
              任务策略：优先级 {selectedSuite.policy.priority} · 并发{" "}
              {selectedSuite.policy.concurrency} · 重跑 {selectedSuite.policy.retryLimit} 次 · 排队{" "}
              {Math.round(selectedSuite.policy.queueTimeoutMs / 60_000)} 分钟 · 执行{" "}
              {Math.round(selectedSuite.policy.executionTimeoutMs / 60_000)} 分钟
              {selectedSuite.policy.runnerLabels.length > 0
                ? ` · 要求标签 ${selectedSuite.policy.runnerLabels.join("、")}`
                : ""}
            </p>
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
                const compatibility = assessRunnerCompatibility(runner);
                const unavailable = runner.state === "disabled" || !compatibility.compatible;
                return (
                  <label
                    className={`runner-choice ${selected ? "runner-choice-selected" : ""} ${unavailable ? "runner-choice-disabled" : ""}`}
                    key={runner.id}
                    title={runnerCompatibilitySummary(compatibility)}
                  >
                    <Input
                      type="checkbox"
                      checked={selected}
                      disabled={unavailable}
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
                      槽位 {runner.busySlots}/{runner.maxConcurrency} ·{" "}
                      {runnerCompatibilityLabel(compatibility.status)}
                    </span>
                  </label>
                );
              })
            )}
          </div>

          <div className="form-grid scheduler-step">
            <label className="field-stack">
              <span>失败用例重跑次数</span>
              <Select
                value={retryLimit}
                onChange={(event) =>
                  setRetryLimit(event.target.value === "" ? "" : Number(event.target.value))
                }
              >
                <option value="">
                  继承任务策略{selectedSuite ? `（${selectedSuite.policy.retryLimit} 次）` : ""}
                </option>
                {Array.from({ length: 11 }, (_, value) => (
                  <option key={value} value={value}>
                    {value === 0 ? "不重跑" : `${value} 次`}
                  </option>
                ))}
              </Select>
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
              <h2>执行环境</h2>
            </div>
            <Button
              className="button button-secondary compact-button"
              type="button"
              disabled={Boolean(environmentVersionId)}
              onClick={addEnvironmentRow}
            >
              <Plus size={15} /> 添加变量
            </Button>
          </div>
          <label className="field-stack">
            <span>受管环境版本</span>
            <Select
              aria-label="受管环境版本"
              value={environmentVersionId}
              onChange={(event) => setEnvironmentVersionId(event.target.value)}
            >
              <option value="">不使用受管环境（手工变量）</option>
              {availableEnvironments.map((environment) => (
                <option key={environment.current.id} value={environment.current.id}>
                  {environment.name} · v{environment.current.version} ·{" "}
                  {environment.current.variables.length}
                  个变量 · {environment.current.secretBindings.length} 个密文
                </option>
              ))}
            </Select>
          </label>
          <p className="field-hint">
            {environmentVersionId
              ? "批次会固定引用当前选中的不可变环境版本；密文由 Agent 在有效 Lease 内按需领取。"
              : "手工变量会随批次保存为快照；敏感值必须先在密文管理中创建并绑定到受管环境。"}
          </p>
          <div className="environment-list">
            {environmentVersionId ? (
              <div className="inline-empty">已选择受管环境，不能同时提交手工变量。</div>
            ) : environmentRows.length === 0 ? (
              <div className="inline-empty">未配置变量，执行时使用 Runner 受控基础环境。</div>
            ) : (
              environmentRows.map((row) => (
                <div className="environment-row" key={row.id}>
                  <Input
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
                  <Input
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
                  <Button
                    className="icon-button small-icon-button"
                    type="button"
                    aria-label="删除环境变量"
                    onClick={() =>
                      setEnvironmentRows((current) => current.filter((item) => item.id !== row.id))
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))
            )}
          </div>
          {preflightBlockers.length > 0 ? (
            <ul className="preflight-blockers" aria-label="执行配置阻塞项">
              {preflightBlockers.map((blocker, index) => (
                <li key={`${blocker.code}-${blocker.runnerId ?? blocker.sourceId ?? index}`}>
                  <strong>{preflightCategoryLabel(blocker.category)}</strong>
                  <span>{blocker.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
          <Button
            className="button button-primary run-batch-submit"
            type="submit"
            disabled={submitting || initialSuites.length === 0 || runnerIds.length === 0}
          >
            {submitting ? <RefreshCw className="spin" size={17} /> : <Activity size={17} />}
            {submitting ? "正在计算分配…" : "开始调度"}
          </Button>
        </form>
      ) : null}

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
          执行机领取、租约续期、TestNG 执行、日志续传和产物上传均使用同一执行闭环。
        </div>
        {batches.length === 0 ? (
          <div className="inline-empty history-empty">尚未创建执行批次。</div>
        ) : (
          <div className="batch-list">
            {batches.map((batch) => {
              const progress = runBatchCoveragePercent(batch);
              return (
                <article className="batch-row" key={batch.id}>
                  <div className="batch-row-main">
                    <span className={`batch-status batch-status-${batch.status}`}>
                      {runBatchStatusLabel(batch.status)}
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
                    <Link href={`/run-batches/${encodeURIComponent(batch.id)}`}>查看详情</Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {nextPageHref ? (
          <Link className="button button-secondary batch-next-page" href={nextPageHref}>
            查看更早记录
          </Link>
        ) : null}
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

function asPreflightResult(value: unknown): RunBatchPreflightResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("执行配置预检响应无效。");
  }
  const candidate = value as { ready?: unknown; blockers?: unknown };
  if (typeof candidate.ready !== "boolean" || !Array.isArray(candidate.blockers)) {
    throw new Error("执行配置预检响应无效。");
  }
  return value as RunBatchPreflightResult;
}

function preflightCategoryLabel(
  category: RunBatchPreflightResult["blockers"][number]["category"],
): string {
  if (category === "environment") return "环境";
  if (category === "runner") return "执行机";
  if (category === "toolchain") return "工具链";
  if (category === "input") return "执行输入";
  if (category === "resource") return "资源";
  return "参数";
}

function stateLabel(state: Runner["state"]): string {
  if (state === "online") return "在线";
  if (state === "offline") return "离线";
  if (state === "draining") return "排空中";
  return "已禁用";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
