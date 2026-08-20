"use client";

import type {
  CaseDefinitionWithMethods,
  CaseSuite,
  ExecutionEnvironment,
  ExecutionEnvironmentDetails,
  RunBatch,
  Runner,
  RunnerGroup,
} from "@autoforge/domain";
import { Check, LoaderCircle, Play, Server, UsersRound, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button, Input, Select, Textarea } from "./ui";

const OPEN_RUN_DIALOG_EVENT = "autoforge:open-run-dialog";

type RunOptions = {
  suites: CaseSuite[];
  cases: CaseDefinitionWithMethods[];
  runners: Runner[];
  groups: RunnerGroup[];
  environments: ExecutionEnvironmentDetails[];
};

type RunKind = "suite" | "case";
type RunnerSelectionKind = "runners" | "group";

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

export function GlobalRunDialog({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RunOptions>();
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
  const [environmentVersionId, setEnvironmentVersionId] = useState("");
  const [retryLimit, setRetryLimit] = useState(0);
  const [retryMode, setRetryMode] = useState<"immediate" | "round">("immediate");
  const [executionTimeoutMinutes, setExecutionTimeoutMinutes] = useState(60);
  const [environmentVariables, setEnvironmentVariables] = useState("");
  const [parameters, setParameters] = useState("");
  const [adapterEnabled, setAdapterEnabled] = useState(false);
  const [adapterSuiteName, setAdapterSuiteName] = useState("");
  const [adapterTestName, setAdapterTestName] = useState("");
  const [environmentAddresses, setEnvironmentAddresses] = useState("");

  const selectedSuite = options?.suites.find((suite) => suite.id === suiteId);
  const selectedCase = options?.cases.find((definition) => definition.id === caseDefinitionId);
  const selectedProjectId =
    runKind === "suite" ? selectedSuite?.projectId : selectedCase?.projectId;
  const availableEnvironments = useMemo(
    () =>
      options?.environments.filter(
        (environment) =>
          environment.projectId === selectedProjectId && environment.status === "active",
      ) ?? [],
    [options?.environments, selectedProjectId],
  );
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
      setOpen(true);
      if (loading) return;
      if (options) {
        if (
          !requestedCaseId ||
          options.cases.some((candidate) => candidate.id === requestedCaseId)
        ) {
          return;
        }
        setLoading(true);
        setError("");
        void requestJson<CaseDefinitionWithMethods>(
          `/api/v1/case-definitions/${encodeURIComponent(requestedCaseId)}`,
        )
          .then((definition) => {
            setOptions((current) =>
              current
                ? {
                    ...current,
                    cases: [
                      definition,
                      ...current.cases.filter((candidate) => candidate.id !== definition.id),
                    ],
                  }
                : current,
            );
          })
          .catch((problem: unknown) => {
            setError(problem instanceof Error ? problem.message : "用例加载失败。");
          })
          .finally(() => setLoading(false));
        return;
      }
      setLoading(true);
      setError("");
      void loadRunOptions(requestedCaseId)
        .then((loaded) => {
          setOptions(loaded);
          setSuiteId((current) => current || loaded.suites[0]?.id || "");
          setCaseDefinitionId((current) => current || loaded.cases[0]?.id || "");
        })
        .catch((problem: unknown) => {
          setError(problem instanceof Error ? problem.message : "执行配置加载失败。");
        })
        .finally(() => setLoading(false));
    },
    [loading, options],
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
    if (runnerSelectionKind === "runners" && runnerIds.length === 0) {
      setError("请至少选择一台执行机。");
      return;
    }
    if (runnerSelectionKind === "group" && !runnerGroupId) {
      setError("请选择执行机组。");
      return;
    }
    setSubmitting(true);
    try {
      const common = {
        projectId: selectedProjectId,
        runnerIds: runnerSelectionKind === "runners" ? runnerIds : [],
        ...(runnerSelectionKind === "group" ? { runnerGroupId } : {}),
        retryLimit,
        retryMode,
        executionTimeoutMs: executionTimeoutMinutes * 60_000,
        ...(environmentVersionId
          ? { environmentVersionId, environmentVariables: [] }
          : { environmentVariables: parseKeyValues(environmentVariables) }),
      };
      let batch: RunBatch;
      if (runKind === "suite") {
        const requestBody = { ...common, suiteId };
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
              ...common,
              parameters: parseParameterRecord(parameters),
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
                    <p>选择用例、执行资源与运行参数，提交前会执行相同的权威预检。</p>
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
                  <div className="global-run-loading">
                    <LoaderCircle className="spin" size={22} /> 正在读取执行配置…
                  </div>
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
                            setEnvironmentVersionId("");
                          }}
                          type="button"
                        >
                          用例任务
                        </Button>
                        <Button
                          aria-pressed={runKind === "case"}
                          onClick={() => {
                            setRunKind("case");
                            setEnvironmentVersionId("");
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
                              setEnvironmentVersionId("");
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
                                setEnvironmentVersionId("");
                              }}
                              value={caseDefinitionId}
                            >
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
                              runner.state === "disabled" || Boolean(runner.purgedAt);
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
                                    {runner.state} · 可用槽位{" "}
                                    {Math.max(0, runner.maxConcurrency - runner.busySlots)}
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
                          <h3>运行参数</h3>
                          <p>环境版本与手工变量互斥；单用例可配置 Adapter 环境 IP。</p>
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
                        <label className="field-stack">
                          <span>执行超时（分钟）</span>
                          <Input
                            aria-label="执行超时分钟"
                            max={1440}
                            min={1}
                            onChange={(event) =>
                              setExecutionTimeoutMinutes(Number(event.target.value))
                            }
                            type="number"
                            value={executionTimeoutMinutes}
                          />
                        </label>
                        <label className="field-stack">
                          <span>受管环境</span>
                          <Select
                            aria-label="受管执行环境"
                            onChange={(event) => setEnvironmentVersionId(event.target.value)}
                            value={environmentVersionId}
                          >
                            <option value="">不使用受管环境</option>
                            {availableEnvironments.map((environment) => (
                              <option key={environment.id} value={environment.current.id}>
                                {environment.name} · v{environment.current.version}
                              </option>
                            ))}
                          </Select>
                        </label>
                      </div>
                      {!environmentVersionId ? (
                        <label className="field-stack">
                          <span>环境变量（每行 KEY=VALUE）</span>
                          <Textarea
                            aria-label="执行环境变量"
                            onChange={(event) => setEnvironmentVariables(event.target.value)}
                            rows={2}
                            value={environmentVariables}
                          />
                        </label>
                      ) : null}
                      {runKind === "case" ? (
                        <div className="single-run-advanced">
                          <label className="field-stack">
                            <span>参数覆盖（每行 KEY=VALUE）</span>
                            <Textarea
                              aria-label="单用例参数覆盖"
                              onChange={(event) => setParameters(event.target.value)}
                              rows={2}
                              value={parameters}
                            />
                          </label>
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
                                  onChange={(event) => setEnvironmentAddresses(event.target.value)}
                                  placeholder="10.0.0.21"
                                  rows={2}
                                  value={environmentAddresses}
                                />
                              </label>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
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
                      <Button disabled={submitting || loading} type="submit" variant="primary">
                        {submitting ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <Play size={16} />
                        )}
                        {submitting ? "正在创建…" : "确认并开始执行"}
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

async function loadRunOptions(requestedCaseId?: string): Promise<RunOptions> {
  const [suitePage, casePage, requestedCase, runnerPage, groupPage, environments] =
    await Promise.all([
      requestJson<{ items: CaseSuite[] }>("/api/v1/case-suites?limit=200"),
      requestJson<{ items: CaseDefinitionWithMethods[] }>("/api/v1/case-definitions?limit=100"),
      requestedCaseId
        ? requestJson<CaseDefinitionWithMethods>(
            `/api/v1/case-definitions/${encodeURIComponent(requestedCaseId)}`,
          )
        : Promise.resolve(undefined),
      requestJson<{ items: Runner[] }>("/api/v1/runners?limit=500"),
      requestJson<{ items: RunnerGroup[] }>("/api/v1/runner-groups"),
      loadExecutionEnvironmentOptions(),
    ]);
  const cases = requestedCase
    ? [requestedCase, ...casePage.items.filter((candidate) => candidate.id !== requestedCase.id)]
    : casePage.items;
  return {
    suites: suitePage.items.filter((suite) => suite.enabled && suite.status === "active"),
    cases: cases.filter((definition) => definition.enabled && !definition.archived),
    runners: runnerPage.items,
    groups: groupPage.items,
    environments,
  };
}

async function loadExecutionEnvironmentOptions(): Promise<ExecutionEnvironmentDetails[]> {
  const environmentPage = await optionalRequest<{ items: ExecutionEnvironment[] }>(
    "/api/v1/execution-environments",
    { items: [] },
  );
  return Promise.all(
    environmentPage.items
      .filter((environment) => environment.status === "active")
      .map((environment) =>
        requestJson<ExecutionEnvironmentDetails>(
          `/api/v1/execution-environments/${encodeURIComponent(environment.id)}`,
        ),
      ),
  );
}

async function optionalRequest<T>(path: string, fallback: T): Promise<T> {
  try {
    return await requestJson<T>(path);
  } catch {
    return fallback;
  }
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

function parseKeyValues(value: string): Array<{ name: string; value: string }> {
  return parseLines(value).flatMap((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) return [];
    return [{ name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }];
  });
}

function parseParameterRecord(value: string): Record<string, string> {
  return Object.fromEntries(
    parseKeyValues(value).map(({ name, value: parameterValue }) => [name, parameterValue]),
  );
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
