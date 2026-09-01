"use client";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import type {
  CaseDefinitionWithMethods,
  CaseSuite,
  RunBatch,
  Runner,
  RunnerGroup,
} from "@autoforge/domain";
import { Check, Clock3, LoaderCircle, Play, Server, UsersRound, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button, Input, Select, Textarea } from "./ui";
import { LoadingState } from "./loading-state";

const OPEN_RUN_DIALOG_EVENT = "autoforge:open-run-dialog";

type RunOptions = {
  suites: CaseSuite[];
  cases: CaseDefinitionWithMethods[];
  runners: Runner[];
  groups: RunnerGroup[];
};

type ProjectRunOptions = {
  contextKey: string;
  value: RunOptions;
};

type RunKind = "suite" | "case";
type RunnerSelectionKind = "runners" | "group";
type StartMode = "immediate" | "delayed";

export function OpenRunDialogButton({
  caseDefinitionId,
  className,
  children = "执行此用例",
}: {
  caseDefinitionId?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Button
      className={className}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent(OPEN_RUN_DIALOG_EVENT, {
            detail: caseDefinitionId ? { caseDefinitionId } : {},
          }),
        )
      }
      type="button"
    >
      <Play aria-hidden="true" size={16} /> {children}
    </Button>
  );
}

export function GlobalRunDialog({
  enabled,
  projectId,
  projectVersionId,
  testStageId,
}: {
  enabled: boolean;
  projectId?: string;
  projectVersionId?: string;
  testStageId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [projectOptions, setProjectOptions] = useState<ProjectRunOptions>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [runKind, setRunKind] = useState<RunKind>("suite");
  const [suiteId, setSuiteId] = useState("");
  const [caseDefinitionId, setCaseDefinitionId] = useState("");
  const [caseQuery, setCaseQuery] = useState("");
  const [runnerSelectionKind, setRunnerSelectionKind] = useState<RunnerSelectionKind>("runners");
  const [runnerIds, setRunnerIds] = useState<string[]>([]);
  const [runnerGroupId, setRunnerGroupId] = useState("");
  const [retryLimit, setRetryLimit] = useState(0);
  const [retryMode, setRetryMode] = useState<"immediate" | "round">("immediate");
  const [adapterEnabled, setAdapterEnabled] = useState(true);
  const [adapterSuiteName, setAdapterSuiteName] = useState("");
  const [adapterTestName, setAdapterTestName] = useState("");
  const [environmentAddresses, setEnvironmentAddresses] = useState("");
  const [startMode, setStartMode] = useState<StartMode>("immediate");
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [delaySecondsPart, setDelaySecondsPart] = useState(0);
  const [previewNowMs, setPreviewNowMs] = useState(() => Date.now());
  const contextKey = `${projectId ?? ""}:${projectVersionId ?? ""}:${testStageId ?? ""}`;
  const options = projectOptions?.contextKey === contextKey ? projectOptions.value : undefined;

  const selectedSuite = options?.suites.find((suite) => suite.id === suiteId);
  const selectedCase = options?.cases.find((definition) => definition.id === caseDefinitionId);
  const suiteExecutionResourceConfigured = selectedSuite
    ? suiteHasExecutionResource(selectedSuite, options)
    : false;
  const selectedProjectId =
    runKind === "suite" ? selectedSuite?.projectId : selectedCase?.projectId;
  const configuredDelaySeconds = startMode === "delayed" ? delayMinutes * 60 + delaySecondsPart : 0;
  const visibleCases = useMemo(() => {
    const normalizedQuery = caseQuery.trim().toLocaleLowerCase("zh-CN");
    if (!normalizedQuery) return options?.cases ?? [];
    return (options?.cases ?? []).filter((definition) =>
      `${definition.displayName} ${definition.className}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery),
    );
  }, [caseQuery, options?.cases]);

  const openDialog = useCallback(
    (requestedCaseId?: string) => {
      if (requestedCaseId) {
        setRunKind("case");
        setCaseDefinitionId(requestedCaseId);
      }
      setPreviewNowMs(Date.now());
      setOpen(true);
      if (loading) return;
      setLoading(true);
      setError("");
      void loadRunOptions(requestedCaseId, projectId, projectVersionId, testStageId)
        .then((loaded) => {
          setProjectOptions({ contextKey, value: loaded });
          setSuiteId(loaded.suites[0]?.id ?? "");
          setCaseDefinitionId(
            requestedCaseId && loaded.cases.some((candidate) => candidate.id === requestedCaseId)
              ? requestedCaseId
              : "",
          );
        })
        .catch((problem: unknown) => {
          setError(problem instanceof Error ? problem.message : "执行配置加载失败。");
        })
        .finally(() => setLoading(false));
    },
    [contextKey, loading, projectId, projectVersionId, testStageId],
  );

  useEffect(() => {
    if (!enabled) return;
    const requestedCaseId = searchParams.get("runCase");
    if (searchParams.get("run") !== "1" && !requestedCaseId) return;
    const timer = window.setTimeout(() => openDialog(requestedCaseId ?? undefined), 0);
    return () => window.clearTimeout(timer);
  }, [enabled, openDialog, searchParams]);

  useEffect(() => {
    if (!enabled) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ caseDefinitionId?: string }>).detail;
      if (detail?.caseDefinitionId) {
        openDialog(detail.caseDefinitionId);
        return;
      }
      openDialog();
    };
    window.addEventListener(OPEN_RUN_DIALOG_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_RUN_DIALOG_EVENT, onOpen);
  }, [enabled, openDialog]);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setError("");
    if (!searchParams.has("run") && !searchParams.has("runCase")) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("run");
    next.delete("runCase");
    router.replace(next.size > 0 ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) closeDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeDialog, open, submitting]);

  useEffect(() => {
    if (!open || startMode !== "delayed") return;
    const timer = window.setInterval(() => setPreviewNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, startMode]);

  function toggleRunner(runnerId: string): void {
    setRunnerIds((current) =>
      current.includes(runnerId)
        ? current.filter((candidate) => candidate !== runnerId)
        : [...current, runnerId],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    const targetId = runKind === "suite" ? suiteId : caseDefinitionId;
    if (!targetId || !selectedProjectId) {
      setError(runKind === "suite" ? "请选择用例任务。" : "请选择单个用例。");
      return;
    }
    if (runKind === "suite" && !suiteExecutionResourceConfigured) {
      setError("任务尚未配置有效执行资源，请先编辑任务。");
      return;
    }
    if (runKind === "case" && runnerSelectionKind === "runners" && runnerIds.length === 0) {
      setError("请至少选择一台执行机。");
      return;
    }
    if (runKind === "case" && runnerSelectionKind === "group" && !runnerGroupId) {
      setError("请选择执行机组。");
      return;
    }
    if (startMode === "delayed" && configuredDelaySeconds <= 0) {
      setError("倒计时必须大于 0 秒。");
      return;
    }
    if (configuredDelaySeconds > 604_800) {
      setError("倒计时最长为 7 天。");
      return;
    }
    setSubmitting(true);
    try {
      let batch: RunBatch;
      if (runKind === "suite") {
        const requestBody = { suiteId, delaySeconds: configuredDelaySeconds };
        const preflight = await requestJson<{
          ready: boolean;
          blockers: Array<{ message: string }>;
        }>("/api/v1/run-batches/preflight", { method: "POST", body: requestBody });
        if (!preflight.ready) {
          throw new Error(preflight.blockers.map((blocker) => blocker.message).join("；"));
        }
        batch = await requestJson<RunBatch>("/api/v1/run-batches", {
          method: "POST",
          body: requestBody,
        });
      } else {
        batch = await requestJson<RunBatch>(
          `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/execute`,
          {
            method: "POST",
            body: {
              projectId: selectedProjectId,
              delaySeconds: configuredDelaySeconds,
              runnerIds: runnerSelectionKind === "runners" ? runnerIds : [],
              ...(runnerSelectionKind === "group" ? { runnerGroupId } : {}),
              retryLimit,
              retryMode,
              artifactPatterns: ["reports/testng/**"],
              adapter: {
                enabled: adapterEnabled,
                suiteName: adapterSuiteName,
                testName: adapterTestName,
                environmentAddresses: parseLines(environmentAddresses),
              },
            },
          },
        );
      }
      setOpen(false);
      router.push(`/run-batches/${encodeURIComponent(batch.id)}`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "创建执行失败。");
    } finally {
      setSubmitting(false);
    }
  }

  if (!enabled) return null;
  return (
    <>
      <OpenRunDialogButton className="global-run-trigger">开始执行</OpenRunDialogButton>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="dialog-backdrop global-run-backdrop"
              onMouseDown={() => {
                if (!submitting) closeDialog();
              }}
            >
              <section
                aria-label="开始执行"
                aria-modal="true"
                className="global-run-dialog"
                onMouseDown={(event) => event.stopPropagation()}
                role="dialog"
              >
                <header className="global-run-dialog-header">
                  <div>
                    <span className="eyebrow">NEW EXECUTION</span>
                    <h2>开始执行</h2>
                    <p>选择用例与执行资源，提交前会执行相同的权威预检。</p>
                  </div>
                  <Button
                    aria-label="关闭执行弹窗"
                    autoFocus
                    className="icon-button"
                    disabled={submitting}
                    onClick={closeDialog}
                    type="button"
                  >
                    <X size={18} />
                  </Button>
                </header>

                {loading ? (
                  <LoadingState compact label="正在读取执行配置" />
                ) : (
                  <form className="global-run-form" onSubmit={(event) => void submit(event)}>
                    <section className="global-run-step">
                      <div className="global-run-step-title">
                        <span>1</span>
                        <div>
                          <h3>选择执行内容</h3>
                          <p>任务批跑与单用例共用同一套调度状态机。</p>
                        </div>
                      </div>
                      <div className="segmented-control" aria-label="执行内容类型">
                        <Button
                          aria-pressed={runKind === "suite"}
                          onClick={() => {
                            setRunKind("suite");
                          }}
                          type="button"
                        >
                          用例任务
                        </Button>
                        <Button
                          aria-pressed={runKind === "case"}
                          onClick={() => {
                            setRunKind("case");
                          }}
                          type="button"
                        >
                          单个用例
                        </Button>
                      </div>
                      {runKind === "suite" ? (
                        <label className="field-stack">
                          <span>用例任务</span>
                          <Select
                            aria-label="执行用例任务"
                            onChange={(event) => {
                              setSuiteId(event.target.value);
                            }}
                            value={suiteId}
                          >
                            {(options?.suites ?? []).map((suite) => (
                              <option key={suite.id} value={suite.id}>
                                {suite.name} · {suite.caseCount} 个用例 · v{suite.version}
                              </option>
                            ))}
                          </Select>
                        </label>
                      ) : (
                        <div className="single-case-picker">
                          <label className="field-stack">
                            <span>搜索用例</span>
                            <Input
                              aria-label="搜索待执行用例"
                              onChange={(event) => setCaseQuery(event.target.value)}
                              placeholder="名称或类路径"
                              value={caseQuery}
                            />
                          </label>
                          <label className="field-stack">
                            <span>单个用例</span>
                            <Select
                              aria-label="待执行单个用例"
                              onChange={(event) => {
                                setCaseDefinitionId(event.target.value);
                              }}
                              value={caseDefinitionId}
                            >
                              <option value="">请选择用例</option>
                              {visibleCases.map((definition) => (
                                <option key={definition.id} value={definition.id}>
                                  {definition.displayName} · {definition.className}
                                </option>
                              ))}
                            </Select>
                          </label>
                        </div>
                      )}
                    </section>

                    {runKind === "suite" ? (
                      <section className="global-run-step suite-run-summary">
                        <div className="global-run-step-title">
                          <span>✓</span>
                          <div>
                            <h3>使用任务配置直接执行</h3>
                            <p>执行资源、重试策略和 Adapter 地址均读取任务当前版本。</p>
                          </div>
                        </div>
                        {selectedSuite ? (
                          <>
                            {!suiteExecutionResourceConfigured ? (
                              <p className="inline-notice warning-notice" role="status">
                                任务尚未配置有效执行资源，请先进入任务详情完成配置。
                              </p>
                            ) : null}
                            <dl className="summary-grid">
                              <div>
                                <dt>执行资源</dt>
                                <dd>{suiteRunnerSummary(selectedSuite, options)}</dd>
                              </div>
                              <div>
                                <dt>失败重跑</dt>
                                <dd>
                                  {selectedSuite.policy.retryLimit} 次 ·{" "}
                                  {selectedSuite.policy.retryMode === "round"
                                    ? "整轮重跑"
                                    : "立即重跑"}
                                </dd>
                              </div>
                              <div>
                                <dt>执行器</dt>
                                <dd>
                                  {selectedSuite.policy.executor === "testng-container"
                                    ? "Container"
                                    : "Process"}
                                </dd>
                              </div>
                              <div>
                                <dt>环境地址</dt>
                                <dd>
                                  {selectedSuite.policy.adapter.enabled
                                    ? `${selectedSuite.policy.adapter.environmentAddresses.length} 个`
                                    : "未启用 Adapter"}
                                </dd>
                              </div>
                            </dl>
                          </>
                        ) : null}
                      </section>
                    ) : (
                      <>
                        <section className="global-run-step">
                          <div className="global-run-step-title">
                            <span>2</span>
                            <div>
                              <h3>选择执行资源</h3>
                              <p>可以直接指定多台执行机，也可以使用维护好的执行机组。</p>
                            </div>
                          </div>
                          <div className="resource-mode-grid">
                            <Button
                              aria-pressed={runnerSelectionKind === "runners"}
                              onClick={() => setRunnerSelectionKind("runners")}
                              type="button"
                            >
                              <Server size={17} /> 指定执行机
                            </Button>
                            <Button
                              aria-pressed={runnerSelectionKind === "group"}
                              onClick={() => setRunnerSelectionKind("group")}
                              type="button"
                            >
                              <UsersRound size={17} /> 使用执行机组
                            </Button>
                          </div>
                          {runnerSelectionKind === "runners" ? (
                            <div className="global-run-runner-grid">
                              {(options?.runners ?? []).map((runner) => {
                                const unavailable =
                                  runner.state !== "online" || Boolean(runner.purgedAt);
                                const selected = runnerIds.includes(runner.id);
                                return (
                                  <label
                                    className={`global-run-runner ${selected ? "selected" : ""} ${unavailable ? "disabled" : ""}`}
                                    key={runner.id}
                                  >
                                    <Input
                                      checked={selected}
                                      disabled={unavailable}
                                      onChange={() => toggleRunner(runner.id)}
                                      type="checkbox"
                                    />
                                    <span>
                                      <strong>{runner.name}</strong>
                                      <small>
                                        {runnerStateLabel(runner.state)}
                                        {runner.state === "online"
                                          ? ` · 可用槽位 ${Math.max(0, runner.maxConcurrency - runner.busySlots)}`
                                          : " · 当前不可执行"}
                                      </small>
                                    </span>
                                    {selected ? <Check aria-hidden="true" size={16} /> : null}
                                  </label>
                                );
                              })}
                            </div>
                          ) : (
                            <label className="field-stack">
                              <span>执行机组</span>
                              <Select
                                aria-label="执行机组"
                                onChange={(event) => setRunnerGroupId(event.target.value)}
                                value={runnerGroupId}
                              >
                                <option value="">请选择执行机组</option>
                                {(options?.groups ?? []).map((group) => (
                                  <option
                                    disabled={group.runnerIds.length === 0}
                                    key={group.id}
                                    value={group.id}
                                  >
                                    {group.name} · {group.runnerIds.length} 台执行机
                                  </option>
                                ))}
                              </Select>
                            </label>
                          )}
                        </section>
                        <section className="global-run-step">
                          <div className="global-run-step-title">
                            <span>3</span>
                            <div>
                              <h3>执行策略</h3>
                              <p>单用例可临时配置重跑策略与 Adapter 环境 IP。</p>
                            </div>
                          </div>
                          <div className="global-run-fields">
                            <label className="field-stack">
                              <span>失败重跑</span>
                              <Select
                                aria-label="失败重跑次数"
                                onChange={(event) => setRetryLimit(Number(event.target.value))}
                                value={String(retryLimit)}
                              >
                                {Array.from({ length: 11 }, (_, value) => (
                                  <option key={value} value={value}>
                                    {value === 0 ? "不重跑" : `${value} 次`}
                                  </option>
                                ))}
                              </Select>
                            </label>
                            <label className="field-stack">
                              <span>重跑方式</span>
                              <Select
                                aria-label="失败重跑方式"
                                onChange={(event) =>
                                  setRetryMode(event.target.value as typeof retryMode)
                                }
                                value={retryMode}
                              >
                                <option value="immediate">失败后立即重跑</option>
                                <option value="round">本轮结束后统一重跑</option>
                              </Select>
                            </label>
                          </div>
                          <div className="single-run-advanced">
                            <label className="adapter-toggle">
                              <Input
                                checked={adapterEnabled}
                                onChange={(event) => setAdapterEnabled(event.target.checked)}
                                type="checkbox"
                              />
                              使用 CoTest TestNG Adapter
                            </label>
                            {adapterEnabled ? (
                              <div className="adapter-run-fields">
                                <label className="field-stack">
                                  <span>Adapter Suite Name</span>
                                  <Input
                                    aria-label="单用例 Adapter Suite Name"
                                    onChange={(event) => setAdapterSuiteName(event.target.value)}
                                    value={adapterSuiteName}
                                  />
                                </label>
                                <label className="field-stack">
                                  <span>Adapter Test Name</span>
                                  <Input
                                    aria-label="单用例 Adapter Test Name"
                                    onChange={(event) => setAdapterTestName(event.target.value)}
                                    value={adapterTestName}
                                  />
                                </label>
                                <label className="field-stack adapter-address-field">
                                  <span>执行环境 IP / 地址（每行一个）</span>
                                  <Textarea
                                    aria-label="单用例执行环境 IP 地址"
                                    onChange={(event) =>
                                      setEnvironmentAddresses(event.target.value)
                                    }
                                    placeholder="10.0.0.21"
                                    rows={2}
                                    value={environmentAddresses}
                                  />
                                </label>
                              </div>
                            ) : null}
                          </div>
                        </section>
                      </>
                    )}

                    <section className="global-run-step global-run-start-step">
                      <div className="global-run-step-title">
                        <span>
                          <Clock3 aria-hidden="true" size={15} />
                        </span>
                        <div>
                          <h3>设置开始时间</h3>
                          <p>倒计时由服务端持久化，页面关闭或服务重启都不会丢失。</p>
                        </div>
                      </div>
                      <div className="start-mode-layout">
                        <div className="segmented-control start-mode-control" aria-label="开始方式">
                          <Button
                            aria-pressed={startMode === "immediate"}
                            onClick={() => setStartMode("immediate")}
                            type="button"
                          >
                            立即执行
                          </Button>
                          <Button
                            aria-pressed={startMode === "delayed"}
                            onClick={() => setStartMode("delayed")}
                            type="button"
                          >
                            倒计时执行
                          </Button>
                        </div>
                        {startMode === "delayed" ? (
                          <div className="delay-start-panel">
                            <div className="delay-time-fields">
                              <label className="field-stack">
                                <span>分钟</span>
                                <Input
                                  aria-label="倒计时分钟"
                                  max={10_080}
                                  min={0}
                                  onChange={(event) => {
                                    const minutes = boundedInteger(event.target.value, 0, 10_080);
                                    setDelayMinutes(minutes);
                                    if (minutes === 10_080) setDelaySecondsPart(0);
                                  }}
                                  type="number"
                                  value={delayMinutes}
                                />
                              </label>
                              <label className="field-stack">
                                <span>秒</span>
                                <Input
                                  aria-label="倒计时秒"
                                  max={delayMinutes === 10_080 ? 0 : 59}
                                  min={0}
                                  onChange={(event) =>
                                    setDelaySecondsPart(
                                      boundedInteger(
                                        event.target.value,
                                        0,
                                        delayMinutes === 10_080 ? 0 : 59,
                                      ),
                                    )
                                  }
                                  type="number"
                                  value={delaySecondsPart}
                                />
                              </label>
                            </div>
                            <div className="delay-presets" aria-label="常用倒计时">
                              {[1, 5, 10, 30].map((minutes) => (
                                <Button
                                  key={minutes}
                                  onClick={() => {
                                    setDelayMinutes(minutes);
                                    setDelaySecondsPart(0);
                                  }}
                                  type="button"
                                >
                                  {minutes} 分钟
                                </Button>
                              ))}
                            </div>
                            <div className="delay-start-preview" role="status">
                              <Clock3 aria-hidden="true" size={18} />
                              <span>
                                <small>计划开始</small>
                                <strong>
                                  {configuredDelaySeconds > 0
                                    ? formatPlatformDateTime(
                                        previewNowMs + configuredDelaySeconds * 1_000,
                                        undefined,
                                        {
                                          month: "2-digit",
                                          day: "2-digit",
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          second: "2-digit",
                                        },
                                      )
                                    : "请设置有效倒计时"}
                                </strong>
                              </span>
                              <em>{formatCountdown(configuredDelaySeconds)}</em>
                            </div>
                          </div>
                        ) : (
                          <p className="immediate-start-note">提交并通过预检后立即进入资源调度。</p>
                        )}
                      </div>
                    </section>

                    {error ? (
                      <p className="form-error global-run-error" role="alert">
                        {error}
                      </p>
                    ) : null}
                    <footer className="global-run-dialog-actions">
                      <Button disabled={submitting} onClick={closeDialog} type="button">
                        取消
                      </Button>
                      <Button
                        disabled={
                          submitting ||
                          loading ||
                          (runKind === "suite" && !suiteExecutionResourceConfigured) ||
                          (runKind === "case" && !caseDefinitionId)
                        }
                        type="submit"
                        variant="primary"
                      >
                        {submitting ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <Play size={16} />
                        )}
                        {submitting
                          ? "正在创建…"
                          : startMode === "delayed"
                            ? "确认倒计时执行"
                            : "确认并开始执行"}
                      </Button>
                    </footer>
                  </form>
                )}
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

async function loadRunOptions(
  requestedCaseId?: string,
  projectId?: string,
  projectVersionId?: string,
  testStageId?: string,
): Promise<RunOptions> {
  const contextQuery = new URLSearchParams();
  if (projectId) contextQuery.set("projectId", projectId);
  if (projectVersionId) contextQuery.set("projectVersionId", projectVersionId);
  if (testStageId) contextQuery.set("testStageId", testStageId);
  const query = contextQuery.size > 0 ? `&${contextQuery.toString()}` : "";
  const [suitePage, casePage, requestedCase, runnerPage, groupPage] = await Promise.all([
    projectVersionId
      ? requestJson<{ items: CaseSuite[] }>(`/api/v1/case-suites?limit=200${query}`)
      : Promise.resolve({ items: [] }),
    requestJson<{ items: CaseDefinitionWithMethods[] }>(
      `/api/v1/case-definitions?limit=100${query}`,
    ),
    requestedCaseId
      ? requestJson<CaseDefinitionWithMethods>(
          `/api/v1/case-definitions/${encodeURIComponent(requestedCaseId)}`,
        )
      : Promise.resolve(undefined),
    requestJson<{ items: Runner[] }>("/api/v1/runners?limit=500"),
    requestJson<{ items: RunnerGroup[] }>("/api/v1/runner-groups"),
  ]);
  const cases = requestedCase
    ? [requestedCase, ...casePage.items.filter((candidate) => candidate.id !== requestedCase.id)]
    : casePage.items;
  return {
    // 顶栏版本约束可选任务；执行时仍只提交 suiteId，并由任务快照作为唯一配置来源。
    suites: suitePage.items.filter((suite) => suite.enabled && suite.status === "active"),
    cases: cases.filter((definition) => definition.enabled && !definition.archived),
    runners: runnerPage.items,
    groups: groupPage.items,
  };
}

function suiteRunnerSummary(suite: CaseSuite, options: RunOptions | undefined): string {
  if (suite.policy.runnerGroupId) {
    const group = options?.groups.find((candidate) => candidate.id === suite.policy.runnerGroupId);
    return group ? `${group.name}（${group.runnerIds.length} 台）` : "执行机组已失效";
  }
  const runnerNames = suite.policy.runnerIds.map(
    (runnerId) => options?.runners.find((runner) => runner.id === runnerId)?.name ?? "执行机已失效",
  );
  return runnerNames.length > 0 ? runnerNames.join("、") : "尚未配置，请先编辑任务";
}

function suiteHasExecutionResource(suite: CaseSuite, options: RunOptions | undefined): boolean {
  if (suite.policy.runnerGroupId) {
    const group = options?.groups.find((candidate) => candidate.id === suite.policy.runnerGroupId);
    return Boolean(group && group.runnerIds.length > 0);
  }
  return (
    suite.policy.runnerIds.length > 0 &&
    suite.policy.runnerIds.every((runnerId) =>
      options?.runners.some(
        (runner) => runner.id === runnerId && !runner.purgedAt && !runner.deregisteredAt,
      ),
    )
  );
}

function runnerStateLabel(state: Runner["state"]): string {
  const labels: Record<Runner["state"], string> = {
    online: "在线",
    offline: "离线",
    draining: "排空中",
    disabled: "已禁用",
  };
  return labels[state];
}

async function requestJson<T>(
  path: string,
  input?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    method: input?.method ?? "GET",
    ...(input?.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(body.error?.message ?? `请求失败（HTTP ${response.status}）。`);
  return body as T;
}

function parseLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function formatCountdown(totalSeconds: number): string {
  if (totalSeconds <= 0) return "未设置";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours} 小时`] : []),
    ...(minutes > 0 ? [`${minutes} 分`] : []),
    ...(seconds > 0 ? [`${seconds} 秒`] : []),
  ].join(" ");
}
