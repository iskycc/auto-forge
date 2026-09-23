"use client";
import { Segmented } from "./ui/segmented";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { usePlatformNow } from "./platform-time";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import {
  defaultCaseSuiteExecutionPolicy,
  type CaseDefinitionWithMethods,
  type DdtCaseSummary,
  type CaseSuite,
  type RunBatch,
  type Runner,
  type RunnerGroup,
} from "@autoforge/domain";
import { Check, Clock3, LoaderCircle, Play, Server, UsersRound, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Dialog } from "./ui/dialog";

import { Button, Input, Select, Textarea } from "./ui";
import { LoadingState } from "./loading-state";
import {
  executionSuitePreferenceKey,
  preferredExecutionSuiteId,
  readExecutionSuitePreference,
  writeExecutionSuitePreference,
} from "@/lib/execution-suite-preference";

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
  ddtCase,
  disabled,
  className,
  variant = "neutral",
  children = "执行此用例",
}: {
  caseDefinitionId?: string;
  ddtCase?: DdtCaseSummary;
  disabled?: boolean;
  className?: string;
  variant?: "neutral" | "primary";
  children?: ReactNode;
}) {
  return (
    <Button
      className={className}
      variant={variant}
      disabled={disabled}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent(OPEN_RUN_DIALOG_EVENT, {
            detail: ddtCase ? { ddtCase } : caseDefinitionId ? { caseDefinitionId } : {},
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
  userId,
  projectId,
  projectVersionId,
  testStageId,
}: {
  enabled: boolean;
  userId: string;
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
  const [ddtCase, setDdtCase] = useState<DdtCaseSummary>();
  const openRequest = useRef(0);
  const [caseQuery, setCaseQuery] = useState("");
  const [runnerSelectionKind, setRunnerSelectionKind] = useState<RunnerSelectionKind>("runners");
  const [runnerIds, setRunnerIds] = useState<string[]>([]);
  const [runnerGroupId, setRunnerGroupId] = useState("");
  const [retryLimit, setRetryLimit] = useState(0);
  const [retryMode, setRetryMode] = useState(defaultCaseSuiteExecutionPolicy.retryMode);
  const [adapterEnabled, setAdapterEnabled] = useState(true);
  const [adapterSuiteName, setAdapterSuiteName] = useState("");
  const [adapterTestName, setAdapterTestName] = useState("");
  const [environmentAddresses, setEnvironmentAddresses] = useState("");
  const [startMode, setStartMode] = useState<StartMode>("immediate");
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [delaySecondsPart, setDelaySecondsPart] = useState(0);
  const delayStartPanel = useRef<HTMLDivElement>(null);
  const previewNowMs = usePlatformNow(open && startMode === "delayed");
  const preferenceKey = executionSuitePreferenceKey({
    userId,
    projectId: projectId ?? "",
    projectVersionId: projectVersionId ?? "",
  });
  const rememberedSuites = useRef(new Map<string, string>());
  const contextKey = `${preferenceKey}:${testStageId ?? ""}`;
  const options = projectOptions?.contextKey === contextKey ? projectOptions.value : undefined;

  const selectedSuite = options?.suites.find((suite) => suite.id === suiteId);
  const selectedCase = options?.cases.find((definition) => definition.id === caseDefinitionId);
  const suiteExecutionResourceConfigured = selectedSuite
    ? suiteHasExecutionResource(selectedSuite, options)
    : false;
  const selectedProjectId =
    runKind === "suite"
      ? selectedSuite?.projectId
      : (ddtCase?.projectId ?? selectedCase?.projectId);
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
    (requestedCaseId?: string, requestedDdtCase?: DdtCaseSummary) => {
      const request = ++openRequest.current;
      setProjectOptions(undefined);
      setCaseDefinitionId("");
      setDdtCase(requestedDdtCase);
      if (requestedDdtCase) {
        requestedCaseId = requestedDdtCase.executionClass?.caseDefinitionId;
        setAdapterEnabled(true);
      }
      if (requestedCaseId) {
        setRunKind("case");
      }
      setOpen(true);
      setLoading(true);
      setError("");
      const loadOptions = async () => {
        const currentDdtCase = requestedDdtCase
          ? await requestJson<DdtCaseSummary>(
              `/api/v1/ddt/cases/${encodeURIComponent(requestedDdtCase.caseId)}/summary?${new URLSearchParams({ projectId: requestedDdtCase.projectId, projectVersionId: requestedDdtCase.projectVersionId, testStageId: requestedDdtCase.testStageId })}`,
            )
          : undefined;
        if (currentDdtCase && !currentDdtCase.executionClass)
          throw new Error("当前 DDT 用例尚未关联执行类，请刷新 SR 测试类关联后重试。");
        requestedCaseId = currentDdtCase?.executionClass?.caseDefinitionId ?? requestedCaseId;
        const loaded = await loadRunOptions(
          requestedCaseId,
          currentDdtCase?.projectId ?? projectId,
          currentDdtCase?.projectVersionId ?? projectVersionId,
          currentDdtCase?.testStageId ?? testStageId,
        );
        return { loaded, currentDdtCase };
      };
      void loadOptions()
        .then(({ loaded, currentDdtCase }) => {
          if (request !== openRequest.current) return;
          setDdtCase(currentDdtCase);
          setProjectOptions({ contextKey, value: loaded });
          const remembered =
            rememberedSuites.current.get(preferenceKey) ??
            readExecutionSuitePreference(() => window.localStorage, preferenceKey);
          const selectedId = preferredExecutionSuiteId(loaded.suites, remembered);
          setSuiteId(selectedId);
          if (selectedId) {
            rememberedSuites.current.set(preferenceKey, selectedId);
            writeExecutionSuitePreference(() => window.localStorage, preferenceKey, selectedId);
          }
          setCaseDefinitionId(
            requestedCaseId && loaded.cases.some((candidate) => candidate.id === requestedCaseId)
              ? requestedCaseId
              : "",
          );
        })
        .catch((problem: unknown) => {
          if (request !== openRequest.current) return;
          setError(problem instanceof Error ? problem.message : "执行配置加载失败。");
        })
        .finally(() => {
          if (request === openRequest.current) setLoading(false);
        });
    },
    [contextKey, preferenceKey, projectId, projectVersionId, testStageId],
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
      const detail = (event as CustomEvent<{ caseDefinitionId?: string; ddtCase?: DdtCaseSummary }>)
        .detail;
      if (detail?.ddtCase) {
        openDialog(undefined, detail.ddtCase);
        return;
      }
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
    openRequest.current += 1;
    setLoading(false);
    setOpen(false);
    setError("");
    if (!searchParams.has("run") && !searchParams.has("runCase")) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("run");
    next.delete("runCase");
    router.replace(next.size > 0 ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    if (open && !loading && startMode === "delayed")
      delayStartPanel.current?.scrollIntoView({ block: "nearest" });
  }, [open, loading, startMode]);

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
        const endpoint = ddtCase
          ? `/api/v1/ddt/cases/${encodeURIComponent(ddtCase.caseId)}/execute?${new URLSearchParams({ projectId: ddtCase.projectId, projectVersionId: ddtCase.projectVersionId, testStageId: ddtCase.testStageId })}`
          : `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/execute`;
        batch = await requestJson<RunBatch>(endpoint, {
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
        });
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
      <OpenRunDialogButton
        className={cn("global-run-trigger", globalRunDialogStyles["global-run-trigger"])}
        variant="primary"
      >
        开始执行
      </OpenRunDialogButton>
      <Dialog
        open={open}
        title="开始执行"
        onClose={closeDialog}
        closeDisabled={submitting}
        className={globalRunDialogStyles["global-run-dialog"]}
        backdropClassName="dialog-backdrop global-run-backdrop"
      >
        <section aria-label="开始执行" className="global-run-dialog">
          <header
            className={cn(
              "global-run-dialog-header",
              globalRunDialogStyles["global-run-dialog-header"],
            )}
          >
            <div>
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>NEW EXECUTION</span>

              <h2>开始执行</h2>

              <p>选择用例与执行资源，提交前会执行相同的权威预检。</p>
            </div>
            <Button
              aria-label="关闭执行弹窗"
              autoFocus
              className={cn("icon-button", uiPatterns["icon-button"])}
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
            <form
              className={cn("global-run-form", globalRunDialogStyles["global-run-form"])}
              onSubmit={(event) => void submit(event)}
            >
              <div
                className={cn(
                  "global-run-form-content",
                  globalRunDialogStyles["global-run-form-content"],
                )}
              >
                <section
                  className={cn("global-run-step", globalRunDialogStyles["global-run-step"])}
                >
                  <div
                    className={cn(
                      "global-run-step-title",
                      globalRunDialogStyles["global-run-step-title"],
                    )}
                  >
                    <span>1</span>
                    <div>
                      <h3>选择执行内容</h3>
                      <p>任务批跑与单用例共用同一套调度状态机。</p>
                    </div>
                  </div>
                  <Segmented
                    label="执行内容类型"
                    value={runKind}
                    onChange={setRunKind}
                    options={[
                      { value: "suite", label: "用例任务" },
                      { value: "case", label: ddtCase ? "DDT 用例" : "单个用例" },
                    ]}
                  />
                  {runKind === "suite" ? (
                    <label className={cn("field-stack", uiPatterns["field-stack"])}>
                      <span>用例任务</span>
                      <Select
                        aria-label="执行用例任务"
                        onChange={(event) => {
                          const selectedId = event.target.value;
                          setSuiteId(selectedId);
                          rememberedSuites.current.set(preferenceKey, selectedId);
                          writeExecutionSuitePreference(
                            () => window.localStorage,
                            preferenceKey,
                            selectedId,
                          );
                        }}
                        value={suiteId}
                      >
                        <option value="" disabled>
                          请选择可执行任务
                        </option>
                        {(options?.suites ?? []).map((suite) => (
                          <option key={suite.id} value={suite.id}>
                            {suite.name} · {suite.caseCount} 个用例 · v{suite.version}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : ddtCase ? (
                    <Notice
                      tone="info"
                      className={cn(
                        "inline-notice single-ddt-run-selection",
                        uiPatterns["inline-notice"],
                        globalRunDialogStyles["single-ddt-run-selection"],
                      )}
                      role="status"
                    >
                      <p>
                        <strong>{ddtCase.caseId}</strong> · SR {ddtCase.srNum}
                      </p>
                      <p>执行类：{selectedCase?.className ?? ddtCase.executionClass?.className}</p>
                      <p>执行时使用当前已保存的 DDT 数据及 SR 测试类关联。</p>
                    </Notice>
                  ) : (
                    <div
                      className={cn(
                        "single-case-picker",
                        globalRunDialogStyles["single-case-picker"],
                      )}
                    >
                      <label className={cn("field-stack", uiPatterns["field-stack"])}>
                        <span>搜索用例</span>
                        <Input
                          aria-label="搜索待执行用例"
                          onChange={(event) => setCaseQuery(event.target.value)}
                          placeholder="名称或类路径"
                          value={caseQuery}
                        />
                      </label>
                      <label className={cn("field-stack", uiPatterns["field-stack"])}>
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
                  <section
                    className={cn(
                      "global-run-step suite-run-summary",
                      globalRunDialogStyles["global-run-step"],
                    )}
                  >
                    <div
                      className={cn(
                        "global-run-step-title",
                        globalRunDialogStyles["global-run-step-title"],
                      )}
                    >
                      <span>✓</span>
                      <div>
                        <h3>使用任务配置直接执行</h3>
                        <p>执行资源、重试策略和 Adapter 地址均读取任务当前版本。</p>
                      </div>
                    </div>
                    {selectedSuite ? (
                      <>
                        {!suiteExecutionResourceConfigured ? (
                          <Notice
                            tone="warning"
                            className={cn(
                              "inline-notice warning-notice",
                              uiPatterns["inline-notice"],
                              uiPatterns["warning-notice"],
                            )}
                            role="status"
                          >
                            任务尚未配置有效执行资源，请先进入任务详情完成配置。
                          </Notice>
                        ) : null}
                        <dl
                          className={cn(
                            "execution-config-summary",
                            globalRunDialogStyles["execution-config-summary"],
                          )}
                        >
                          <div>
                            <dt>执行资源</dt>
                            <dd>{suiteRunnerSummary(selectedSuite, options)}</dd>
                          </div>
                          <div>
                            <dt>失败重跑</dt>
                            <dd>
                              {selectedSuite.policy.retryLimit} 次 ·{" "}
                              {selectedSuite.policy.retryMode === "round" ? "整轮重跑" : "立即重跑"}
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
                            <dt>Adapter 地址</dt>
                            <dd>
                              {selectedSuite.policy.adapter.enabled
                                ? `${selectedSuite.policy.adapter.environmentAddresses.length} 个`
                                : "未启用 Adapter"}
                            </dd>
                          </div>
                        </dl>
                      </>
                    ) : (
                      <Notice
                        tone="warning"
                        className={cn(
                          "inline-notice warning-notice",
                          uiPatterns["inline-notice"],
                          uiPatterns["warning-notice"],
                        )}
                        role="status"
                      >
                        {options?.suites.length
                          ? "上次选择的任务当前不可用，请重新选择可执行任务。"
                          : "当前项目版本暂无可执行任务，请先创建或启用任务。"}
                      </Notice>
                    )}
                  </section>
                ) : (
                  <>
                    <section
                      className={cn("global-run-step", globalRunDialogStyles["global-run-step"])}
                    >
                      <div
                        className={cn(
                          "global-run-step-title",
                          globalRunDialogStyles["global-run-step-title"],
                        )}
                      >
                        <span>2</span>
                        <div>
                          <h3>选择执行资源</h3>
                          <p>可以直接指定多台执行机，也可以使用维护好的执行机组。</p>
                        </div>
                      </div>
                      <Segmented
                        block
                        label="执行资源类型"
                        value={runnerSelectionKind}
                        onChange={(value) => {
                          setRunnerSelectionKind(value);
                        }}
                        options={[
                          {
                            value: "runners",
                            label: (
                              <>
                                <Server size={17} />
                                指定执行机
                              </>
                            ),
                          },
                          {
                            value: "group",
                            label: (
                              <>
                                <UsersRound size={17} />
                                使用执行机组
                              </>
                            ),
                          },
                        ]}
                      />
                      {runnerSelectionKind === "runners" ? (
                        <div
                          className={cn(
                            "global-run-runner-grid",
                            globalRunDialogStyles["global-run-runner-grid"],
                          )}
                        >
                          {(options?.runners ?? []).map((runner) => {
                            const unavailable =
                              runner.state !== "online" || Boolean(runner.purgedAt);
                            const selected = runnerIds.includes(runner.id);
                            return (
                              <label
                                className={cn(
                                  globalRunDialogStyles["global-run-runner"],
                                  `global-run-runner ${selected ? "selected" : ""} ${unavailable ? "disabled" : ""}`,
                                )}
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
                        <label className={cn("field-stack", uiPatterns["field-stack"])}>
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
                    <section
                      className={cn("global-run-step", globalRunDialogStyles["global-run-step"])}
                    >
                      <div
                        className={cn(
                          "global-run-step-title",
                          globalRunDialogStyles["global-run-step-title"],
                        )}
                      >
                        <span>3</span>
                        <div>
                          <h3>执行策略</h3>
                          <p>单用例可临时配置重跑策略与 Adapter 环境 IP。</p>
                        </div>
                      </div>
                      <div
                        className={cn(
                          "global-run-fields",
                          globalRunDialogStyles["global-run-fields"],
                        )}
                      >
                        <label className={cn("field-stack", uiPatterns["field-stack"])}>
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
                        <label className={cn("field-stack", uiPatterns["field-stack"])}>
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
                      <div
                        className={cn(
                          "single-run-advanced",
                          globalRunDialogStyles["single-run-advanced"],
                        )}
                      >
                        <label
                          className={cn("adapter-toggle", globalRunDialogStyles["adapter-toggle"])}
                        >
                          <Input
                            checked={adapterEnabled}
                            disabled={Boolean(ddtCase)}
                            onChange={(event) => setAdapterEnabled(event.target.checked)}
                            type="checkbox"
                          />
                          使用 CoTest TestNG Adapter
                        </label>
                        {adapterEnabled ? (
                          <div
                            className={cn(
                              "adapter-run-fields",
                              globalRunDialogStyles["adapter-run-fields"],
                            )}
                          >
                            <label className={cn("field-stack", uiPatterns["field-stack"])}>
                              <span>Adapter Suite Name</span>
                              <Input
                                aria-label="单用例 Adapter Suite Name"
                                onChange={(event) => setAdapterSuiteName(event.target.value)}
                                value={adapterSuiteName}
                              />
                            </label>
                            <label className={cn("field-stack", uiPatterns["field-stack"])}>
                              <span>Adapter Test Name</span>
                              <Input
                                aria-label="单用例 Adapter Test Name"
                                onChange={(event) => setAdapterTestName(event.target.value)}
                                value={adapterTestName}
                              />
                            </label>
                            <label
                              className={cn(
                                "field-stack adapter-address-field",
                                uiPatterns["field-stack"],
                                globalRunDialogStyles["adapter-address-field"],
                              )}
                            >
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
                    </section>
                  </>
                )}

                <section
                  className={cn(
                    "global-run-step global-run-start-step",
                    globalRunDialogStyles["global-run-step"],
                    globalRunDialogStyles["global-run-start-step"],
                  )}
                >
                  <div
                    className={cn(
                      "global-run-step-title",
                      globalRunDialogStyles["global-run-step-title"],
                    )}
                  >
                    <span>
                      <Clock3 aria-hidden="true" size={15} />
                    </span>
                    <div>
                      <h3>设置开始时间</h3>
                      <p>倒计时由服务端持久化，页面关闭或服务重启都不会丢失。</p>
                    </div>
                  </div>
                  <div
                    className={cn("start-mode-layout", globalRunDialogStyles["start-mode-layout"])}
                  >
                    <Segmented
                      label="开始方式"
                      value={startMode}
                      onChange={setStartMode}
                      options={[
                        { value: "immediate", label: "立即执行" },
                        { value: "delayed", label: "倒计时执行" },
                      ]}
                    />
                    {startMode === "delayed" ? (
                      <div
                        className={cn(
                          "delay-start-panel",
                          globalRunDialogStyles["delay-start-panel"],
                        )}
                        ref={delayStartPanel}
                      >
                        <div
                          className={cn(
                            "delay-time-fields",
                            globalRunDialogStyles["delay-time-fields"],
                          )}
                        >
                          <label className={cn("field-stack", uiPatterns["field-stack"])}>
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
                          <label className={cn("field-stack", uiPatterns["field-stack"])}>
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
                        <div
                          className={cn("delay-presets", globalRunDialogStyles["delay-presets"])}
                          aria-label="常用倒计时"
                        >
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
                        <div
                          className={cn(
                            "delay-start-preview",
                            globalRunDialogStyles["delay-start-preview"],
                          )}
                          role="status"
                        >
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
                      <p
                        className={cn(
                          "immediate-start-note",
                          globalRunDialogStyles["immediate-start-note"],
                        )}
                      >
                        提交并通过预检后立即进入资源调度。
                      </p>
                    )}
                  </div>
                </section>

                {error ? (
                  <Notice
                    tone="error"
                    className={cn(
                      "form-error global-run-error",
                      uiPatterns["form-error"],
                      globalRunDialogStyles["global-run-error"],
                    )}
                    role="alert"
                  >
                    {error}
                  </Notice>
                ) : null}
              </div>
              <footer
                className={cn(
                  "global-run-dialog-actions",
                  globalRunDialogStyles["global-run-dialog-actions"],
                )}
              >
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
                    <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />
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
      </Dialog>
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

const globalRunDialogStyles = {
  "adapter-address-field": "[grid-column:span_2]",
  "adapter-run-fields": "grid gap-3 grid-cols-2",
  "adapter-toggle": "flex items-center gap-2 mt-3 text-muted-foreground text-xs font-semibold",
  "delay-presets":
    "flex flex-wrap [align-content:center] gap-1.5 [&_button]:min-h-8 [&_button]:px-2.5 [&_button]:[border-color:color-mix(in_srgb,_var(--info)_16%,_var(--border))] [&_button]:[background:color-mix(in_srgb,_var(--card)_86%,_transparent)] [&_button]:text-xs",
  "delay-start-panel":
    "grid grid-cols-[180px_minmax(0,_1fr)] gap-[9px_12px] border border-solid border-border rounded-lg p-[11px] bg-card",
  "delay-start-preview":
    "grid col-span-full grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-[9px] border-t border-solid border-transparent pt-[9px] text-info [&_span]:grid [&_span]:gap-px [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:[text-transform:uppercase] [&_small]:tracking-normal [&_strong]:text-foreground [&_strong]:text-sm [&_em]:rounded-full [&_em]:py-[5px] [&_em]:px-[9px] [&_em]:bg-card [&_em]:text-info [&_em]:text-xs [&_em]:[font-style:normal] [&_em]:font-semibold [&_em]:whitespace-nowrap",
  "delay-time-fields": "grid grid-cols-2 gap-2 [&_.field-stack]:mt-0",
  "execution-config-summary":
    "grid grid-cols-2 gap-3 m-0 [&_>_div]:min-w-0 [&_>_div]:border [&_>_div]:border-solid [&_>_div]:border-border [&_>_div]:rounded-lg [&_>_div]:p-3 [&_>_div]:bg-muted [&_dt]:text-muted-foreground [&_dt]:text-sm [&_dd]:[margin:4px_0_0] [&_dd]:font-semibold [&_dd]:[overflow-wrap:anywhere]",
  "global-run-dialog":
    'flex w-[min(900px,_calc(100dvw_-_36px))] h-[min(760px,_calc(100dvh_-_36px))] min-h-0 max-h-[calc(100dvh_-_36px)] flex-col overflow-hidden border border-solid border-border rounded-xl bg-card shadow-lg [&_.segmented-control_button[aria-pressed="true"]]:border-info/10 [&_.segmented-control_button[aria-pressed="true"]]:bg-card [&_.segmented-control_button[aria-pressed="true"]]:text-info [&_.segmented-control_button[aria-pressed="true"]]:shadow-lg [&_.delay-time-fields_.field-stack]:mt-0 [&_.field-stack]:mt-[11px]',
  "global-run-dialog-actions":
    "flex [flex:0_0_auto] justify-end gap-[9px] border-t border-solid border-border py-[13px] px-5.5 bg-card",
  "global-run-dialog-header":
    "flex [flex:0_0_auto] items-start justify-between gap-6 border-b border-solid border-border [padding:20px_22px_17px] bg-card [&_h2]:[margin:4px_0_3px] [&_h2]:text-2xl [&_h2]:tracking-normal [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-xs",
  "global-run-error": "[margin:13px_0_0]",
  "global-run-fields": "grid gap-3 grid-cols-4 max-[1181px]:grid-cols-2",
  "global-run-form": "flex [flex:1_1_auto] min-h-0 flex-col overflow-hidden",
  "global-run-form-content": "[flex:1_1_auto] min-h-0 overflow-y-auto py-0 px-5.5",
  "global-run-runner":
    "grid grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-2 min-h-13.5 border border-solid border-border rounded-lg py-2 px-2.5 bg-muted cursor-pointer [&.selected]:border-muted [&.selected]:bg-info/10 [&.selected]:text-info [&.disabled]:cursor-not-allowed [&.disabled]:opacity-52 [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:flex-col [&_>_span]:gap-0.5 [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal [&_strong]:text-foreground [&_strong]:text-xs [&_small]:[overflow-wrap:anywhere] [&_small]:whitespace-normal [&_small]:text-muted-foreground [&_small]:text-xs",
  "global-run-runner-grid":
    "grid grid-cols-3 gap-2 max-h-[152px] overflow-y-auto mt-[11px] pr-[3px] max-[1440px]:grid-cols-2",
  "global-run-start-step": "border-b-0",
  "global-run-step":
    "border-b border-solid border-border py-4.5 px-0 [&_>_.segmented-control]:mb-px",
  "global-run-step-title":
    "flex items-start gap-[11px] mb-[13px] [&_>_span]:inline-grid [&_>_span]:w-[25px] [&_>_span]:h-[25px] [&_>_span]:[flex:0_0_25px] [&_>_span]:place-items-center [&_>_span]:rounded-md [&_>_span]:bg-info/10 [&_>_span]:text-info [&_>_span]:text-xs [&_>_span]:font-semibold [&_h3]:[margin:0_0_2px] [&_h3]:text-sm [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-xs",
  "global-run-trigger": "min-h-9.5 px-3.5 shadow-xs",
  "immediate-start-note":
    "m-0 border border-solid border-border rounded-lg py-[11px] px-[13px] bg-muted text-muted-foreground text-xs",

  "single-case-picker": "grid gap-3 grid-cols-[minmax(0,_0.7fr)_minmax(0,_1.3fr)]",
  "single-ddt-run-selection": "grid gap-2 [overflow-wrap:anywhere] [&_p]:m-0",
  "single-run-advanced":
    "mt-[13px] border border-solid border-border rounded-lg [padding:0_13px_13px] bg-muted",
  "start-mode-control": "grid-cols-2",
  "start-mode-layout":
    "grid grid-cols-[210px_minmax(0,_1fr)] items-start gap-3.5 max-[1181px]:grid-cols-[1fr]",
} as const;
