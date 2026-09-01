"use client";

import { activePlatformTimeZone, formatPlatformDateTime } from "@/lib/platform-date-time";

import { Button, Input, Select, Textarea } from "@/components/ui";

import {
  apiErrorSchema,
  jenkinsJobInspectionSchema,
  type CaseSuiteSchedule,
  type JenkinsJobInspection,
} from "@autoforge/contracts";
import type {
  CaseSuite,
  CaseSuiteDetails,
  ProjectVersion,
  Runner,
  RunnerGroup,
} from "@autoforge/domain";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Copy,
  LoaderCircle,
  Plus,
  Save,
  Server,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { useConfirm, useToast } from "@/components/ui-feedback";

type EditableRetryConcurrencyRule = {
  id: string;
  executionRound: string;
  previousRoundPassRateMinimum: string;
  previousRoundPassRateMaximum: string;
  remainingRunsMinimum: string;
  remainingRunsMaximum: string;
  concurrency: string;
};

type EditableRoundRecoveryRule = {
  id: string;
  afterRound: string;
  jenkinsJobUrl: string;
  waitMinutes: string;
  apiKey: string;
  apiKeyConfigured: boolean;
};

type RecoveryInspectionState =
  { status: "succeeded"; inspection: JenkinsJobInspection } | { status: "failed"; message: string };

export function CaseSuiteEditor({
  suite,
  schedule,
  runners,
  runnerGroups,
  projectVersions,
  artifactsEnabled,
  canManage,
}: {
  suite: CaseSuiteDetails;
  schedule?: CaseSuiteSchedule;
  runners: Runner[];
  runnerGroups: RunnerGroup[];
  projectVersions: ProjectVersion[];
  artifactsEnabled: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runnerSelectionKind, setRunnerSelectionKind] = useState<"runners" | "group">(
    suite.policy.runnerGroupId ? "group" : "runners",
  );
  const [retryMode, setRetryMode] = useState(suite.policy.retryMode);
  const [retryLimit, setRetryLimit] = useState(String(suite.policy.retryLimit));
  const [retryConcurrencyRules, setRetryConcurrencyRules] = useState<
    EditableRetryConcurrencyRule[]
  >(() =>
    suite.policy.retryConcurrencyRules.map((rule) => ({
      id: rule.id,
      executionRound: String(rule.executionRound),
      previousRoundPassRateMinimum: optionalNumber(rule.previousRoundPassRateMinimum),
      previousRoundPassRateMaximum: optionalNumber(rule.previousRoundPassRateMaximum),
      remainingRunsMinimum: optionalNumber(rule.remainingRunsMinimum),
      remainingRunsMaximum: optionalNumber(rule.remainingRunsMaximum),
      concurrency: String(rule.concurrency),
    })),
  );
  const [roundRecoveryRules, setRoundRecoveryRules] = useState<EditableRoundRecoveryRule[]>(() =>
    suite.policy.roundRecoveryRules.map((rule) => ({
      id: rule.id,
      afterRound: String(rule.afterRound),
      jenkinsJobUrl: rule.jenkinsJobUrl,
      waitMinutes: String(rule.waitMinutes),
      apiKey: "",
      apiKeyConfigured: rule.apiKeyConfigured,
    })),
  );
  const [inspectingRecoveryRuleId, setInspectingRecoveryRuleId] = useState<string | null>(null);
  const [recoveryInspections, setRecoveryInspections] = useState<
    Record<string, RecoveryInspectionState>
  >({});
  const selectableProjectVersions = projectVersions.filter(
    (version) =>
      version.status === "active" ||
      (suite.policy.projectVersionId !== undefined && version.id === suite.policy.projectVersionId),
  );
  const selectedProjectVersionId =
    suite.policy.projectVersionId ?? selectableProjectVersions[0]?.id ?? "";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const runnerLabels = String(form.get("runnerLabels") ?? "")
      .split(/[,，]/)
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    const artifactPatterns = String(form.get("artifactPatterns") ?? "")
      .split("\n")
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0);
    const environmentAddresses = parseEnvironmentAddresses(
      String(form.get("adapterEnvironmentAddresses") ?? ""),
    );
    const runnerIds = form
      .getAll("runnerIds")
      .map(String)
      .filter((runnerId) => runnerId.length > 0);
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          description: form.get("description"),
          enabled: form.get("enabled") === "on",
          archived: form.get("archived") === "on",
          policy: {
            executor: form.get("executor"),
            adapter: {
              enabled: form.get("adapterEnabled") === "on",
              suiteName: form.get("adapterSuiteName"),
              testName: form.get("adapterTestName"),
              environmentAddresses,
            },
            priority: Number(form.get("priority")),
            concurrency: Number(form.get("concurrency")),
            retryLimit: Number(retryLimit),
            retryMode,
            queueTimeoutMs: Math.round(Number(form.get("queueTimeoutMinutes")) * 60_000),
            claimTimeoutMs: Math.round(Number(form.get("claimTimeoutMinutes")) * 60_000),
            uploadTimeoutMs: Math.round(Number(form.get("uploadTimeoutMinutes")) * 60_000),
            projectVersionId: String(form.get("projectVersionId") ?? ""),
            runnerIds: runnerSelectionKind === "runners" ? runnerIds : [],
            runnerGroupId:
              runnerSelectionKind === "group" ? String(form.get("runnerGroupId") ?? "") : "",
            runnerLabels,
            // 全局开关只影响新批次快照，不应在编辑其他任务字段时抹掉任务规则。
            artifactPatterns,
            retryConcurrencyRules: retryConcurrencyRules.map(toRetryConcurrencyRuleInput),
            roundRecoveryRules: roundRecoveryRules.map(toRoundRecoveryRuleInput),
          },
          expectedRevision: suite.revision,
        }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      toast.success("用例任务已更新，配置已保存并立即用于后续批次。");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新用例任务失败。");
    } finally {
      setPending(false);
    }
  }

  async function copySuite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCopying(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.get("copyName") }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      const created = (await response.json()) as CaseSuite;
      router.push(`/case-suites/${encodeURIComponent(created.id)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "复制用例任务失败。");
    } finally {
      setCopying(false);
    }
  }

  async function saveSchedule(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await scheduleMutation(
      fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cronExpression: form.get("cronExpression"),
          timeZone: form.get("timeZone"),
          missedRunPolicy: form.get("missedRunPolicy"),
          enabled: form.get("scheduleEnabled") === "on",
          ...(schedule ? { expectedRevision: schedule.revision } : {}),
        }),
      }),
      "计划触发已保存。",
    );
  }

  async function deleteSchedule(): Promise<void> {
    if (!schedule) return;
    if (
      !(await confirmAction({
        title: "删除计划触发",
        description: "删除后任务不再自动触发，历史触发记录与执行记录仍会保留。",
        confirmLabel: "确认删除",
        tone: "danger",
      }))
    )
      return;
    await scheduleMutation(
      fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/schedule`, {
        method: "DELETE",
      }),
      "计划触发已删除。",
    );
  }

  async function scheduleMutation(responsePromise: Promise<Response>, success: string) {
    setPending(true);
    setError(null);
    try {
      const response = await responsePromise;
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(parsed.success ? parsed.data.error.message : "计划操作失败。");
      }
      toast.success(success);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "计划操作失败。");
    } finally {
      setPending(false);
    }
  }

  function updateRetryRule(ruleId: string, patch: Partial<EditableRetryConcurrencyRule>): void {
    setRetryConcurrencyRules((rules) =>
      rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
    );
  }

  function updateRecoveryRule(ruleId: string, patch: Partial<EditableRoundRecoveryRule>): void {
    setRoundRecoveryRules((rules) =>
      rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
    );
    if (patch.jenkinsJobUrl !== undefined || patch.apiKey !== undefined) {
      setRecoveryInspections((inspections) => {
        const remaining = { ...inspections };
        delete remaining[ruleId];
        return remaining;
      });
    }
  }

  async function inspectRecoveryConfiguration(rule: EditableRoundRecoveryRule): Promise<void> {
    setInspectingRecoveryRuleId(rule.id);
    setRecoveryInspections((inspections) => {
      const remaining = { ...inspections };
      delete remaining[rule.id];
      return remaining;
    });
    try {
      const response = await fetch(
        `/api/v1/case-suites/${encodeURIComponent(suite.id)}/round-recovery/inspect`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ruleId: rule.id,
            jenkinsJobUrl: rule.jenkinsJobUrl,
            ...(rule.apiKey ? { apiKey: rule.apiKey } : {}),
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `验证失败（HTTP ${response.status}）。`,
        );
      }
      const inspection = jenkinsJobInspectionSchema.parse(payload);
      setRecoveryInspections((inspections) => ({
        ...inspections,
        [rule.id]: { status: "succeeded", inspection },
      }));
    } catch (caught) {
      setRecoveryInspections((inspections) => ({
        ...inspections,
        [rule.id]: {
          status: "failed",
          message: caught instanceof Error ? caught.message : "无法验证 Jenkins 配置。",
        },
      }));
    } finally {
      setInspectingRecoveryRuleId(null);
    }
  }

  return (
    <section className="card">
      <div className="section-title-row">
        <div>
          <span className="eyebrow">任务设置</span>
          <h2>基本信息与执行策略</h2>
        </div>
      </div>
      <fieldset disabled={!canManage} className="settings-form-fieldset">
        <div className="suite-settings-body">
          <form className="settings-grid-form" onSubmit={(event) => void submit(event)}>
            <label>
              任务名称
              <Input name="name" required maxLength={120} defaultValue={suite.name} />
            </label>
            <label>
              优先级（-100 到 100）
              <Input
                name="priority"
                type="number"
                min={-100}
                max={100}
                step={1}
                defaultValue={suite.policy.priority}
              />
            </label>
            <label>
              并发度（同时在途执行数）
              <Input
                name="concurrency"
                type="number"
                min={1}
                max={10000}
                step={1}
                defaultValue={suite.policy.concurrency}
              />
            </label>
            <label>
              重试次数上限
              <Input
                name="retryLimit"
                type="number"
                min={0}
                max={10}
                step={1}
                value={retryLimit}
                onChange={(event) => setRetryLimit(event.currentTarget.value)}
              />
            </label>
            <label>
              失败重跑方式
              <Select
                name="retryMode"
                value={retryMode}
                onChange={(event) =>
                  setRetryMode(event.currentTarget.value as "immediate" | "round")
                }
              >
                <option value="immediate">立即重跑（失败后马上重试）</option>
                <option value="round">整轮轮次（本轮结束后统一重试）</option>
              </Select>
            </label>
            <div className="settings-wide-field retry-orchestration-card">
              <div className="retry-orchestration-heading">
                <span>
                  <strong>动态重跑并发</strong>
                  <small>
                    每条规则只在指定轮次内判断；命中后从本轮起持续生效，只有其后的规则在指定轮次命中才会切换。
                    首条规则之前使用基础并发度。
                  </small>
                </span>
                <Button
                  size="compact"
                  type="button"
                  onClick={() =>
                    setRetryConcurrencyRules((rules) => [...rules, newRetryConcurrencyRule()])
                  }
                >
                  <Plus size={14} /> 添加规则
                </Button>
              </div>
              {retryMode !== "round" && retryConcurrencyRules.length > 0 ? (
                <small className="form-error" role="alert">
                  动态并发只适用于整轮轮次，请切换重跑方式或删除规则。
                </small>
              ) : null}
              {retryConcurrencyRules.length === 0 ? (
                <p className="retry-orchestration-empty">暂无规则，所有轮次使用基础并发度。</p>
              ) : (
                <div className="retry-rule-list">
                  {retryConcurrencyRules.map((rule, index) => (
                    <article className="retry-rule-row" key={rule.id}>
                      <div className="retry-rule-order" aria-label={`规则 ${index + 1}`}>
                        <strong>{index + 1}</strong>
                        <span>
                          <Button
                            aria-label="上移规则"
                            disabled={index === 0}
                            size="compact"
                            type="button"
                            onClick={() =>
                              setRetryConcurrencyRules((rules) => moveRule(rules, index, index - 1))
                            }
                          >
                            <ArrowUp size={13} />
                          </Button>
                          <Button
                            aria-label="下移规则"
                            disabled={index === retryConcurrencyRules.length - 1}
                            size="compact"
                            type="button"
                            onClick={() =>
                              setRetryConcurrencyRules((rules) => moveRule(rules, index, index + 1))
                            }
                          >
                            <ArrowDown size={13} />
                          </Button>
                        </span>
                      </div>
                      <div className="retry-rule-fields">
                        <label>
                          判断轮次
                          <Input
                            aria-label={`规则 ${index + 1} 判断轮次`}
                            min={2}
                            max={11}
                            required
                            type="number"
                            value={rule.executionRound}
                            onChange={(event) =>
                              updateRetryRule(rule.id, {
                                executionRound: event.currentTarget.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          上轮通过率 ≥ %
                          <Input
                            aria-label={`规则 ${index + 1} 上轮通过率下限`}
                            min={0}
                            max={100}
                            placeholder="不限"
                            type="number"
                            value={rule.previousRoundPassRateMinimum}
                            onChange={(event) =>
                              updateRetryRule(rule.id, {
                                previousRoundPassRateMinimum: event.currentTarget.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          上轮通过率 ≤ %
                          <Input
                            aria-label={`规则 ${index + 1} 上轮通过率上限`}
                            min={0}
                            max={100}
                            placeholder="不限"
                            type="number"
                            value={rule.previousRoundPassRateMaximum}
                            onChange={(event) =>
                              updateRetryRule(rule.id, {
                                previousRoundPassRateMaximum: event.currentTarget.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          本轮剩余用例 ≥
                          <Input
                            aria-label={`规则 ${index + 1} 剩余用例下限`}
                            min={0}
                            max={100000}
                            placeholder="不限"
                            type="number"
                            value={rule.remainingRunsMinimum}
                            onChange={(event) =>
                              updateRetryRule(rule.id, {
                                remainingRunsMinimum: event.currentTarget.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          本轮剩余用例 ≤
                          <Input
                            aria-label={`规则 ${index + 1} 剩余用例上限`}
                            min={0}
                            max={100000}
                            placeholder="不限"
                            type="number"
                            value={rule.remainingRunsMaximum}
                            onChange={(event) =>
                              updateRetryRule(rule.id, {
                                remainingRunsMaximum: event.currentTarget.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          命中后并发
                          <Input
                            aria-label={`规则 ${index + 1} 命中并发`}
                            min={1}
                            max={10000}
                            required
                            type="number"
                            value={rule.concurrency}
                            onChange={(event) =>
                              updateRetryRule(rule.id, { concurrency: event.currentTarget.value })
                            }
                          />
                        </label>
                      </div>
                      <Button
                        aria-label={`删除规则 ${index + 1}`}
                        size="compact"
                        type="button"
                        variant="danger"
                        onClick={() =>
                          setRetryConcurrencyRules((rules) =>
                            rules.filter((candidate) => candidate.id !== rule.id),
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div className="settings-wide-field retry-orchestration-card">
              <div className="retry-orchestration-heading">
                <span>
                  <strong>轮次间环境恢复</strong>
                  <small>
                    同一轮可配置多个环境并行 Rebuild；全部构建及各自等待均结束后才释放下一轮。
                  </small>
                </span>
                <Button
                  size="compact"
                  type="button"
                  onClick={() =>
                    setRoundRecoveryRules((rules) => [...rules, newRoundRecoveryRule()])
                  }
                >
                  <Plus size={14} /> 添加恢复步骤
                </Button>
              </div>
              {retryMode !== "round" && roundRecoveryRules.length > 0 ? (
                <small className="form-error" role="alert">
                  环境恢复只适用于整轮轮次，请切换重跑方式或删除恢复步骤。
                </small>
              ) : null}
              {roundRecoveryRules.length === 0 ? (
                <p className="retry-orchestration-empty">暂无轮次间环境恢复。</p>
              ) : (
                <div className="retry-rule-list">
                  {roundRecoveryRules.map((rule, index) => (
                    <article className="recovery-rule-row" key={rule.id}>
                      <label>
                        第几轮后暂停
                        <Input
                          aria-label={`恢复步骤 ${index + 1} 暂停轮次`}
                          min={1}
                          max={10}
                          required
                          type="number"
                          value={rule.afterRound}
                          onChange={(event) =>
                            updateRecoveryRule(rule.id, { afterRound: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label className="recovery-job-url">
                        Jenkins 任务链接
                        <Input
                          aria-label={`恢复步骤 ${index + 1} Jenkins 任务链接`}
                          maxLength={2048}
                          placeholder="https://jenkins.example/job/environment-reset/"
                          required
                          type="url"
                          value={rule.jenkinsJobUrl}
                          onChange={(event) =>
                            updateRecoveryRule(rule.id, {
                              jenkinsJobUrl: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        API 密钥
                        <Input
                          aria-label={`恢复步骤 ${index + 1} API 密钥`}
                          autoComplete="new-password"
                          placeholder={
                            rule.apiKeyConfigured ? "已配置；留空保持不变" : "用户名:API Token"
                          }
                          required={!rule.apiKeyConfigured}
                          type="password"
                          value={rule.apiKey}
                          onChange={(event) =>
                            updateRecoveryRule(rule.id, { apiKey: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label>
                        成功后等待（分钟）
                        <Input
                          aria-label={`恢复步骤 ${index + 1} 成功后等待分钟`}
                          min={0}
                          max={1440}
                          required
                          type="number"
                          value={rule.waitMinutes}
                          onChange={(event) =>
                            updateRecoveryRule(rule.id, { waitMinutes: event.currentTarget.value })
                          }
                        />
                      </label>
                      <span className="recovery-rule-status">
                        {rule.apiKeyConfigured
                          ? "密钥已加密保存"
                          : rule.apiKey
                            ? "保存后加密"
                            : "等待配置密钥"}
                      </span>
                      <span className="recovery-rule-actions">
                        <Button
                          aria-label={`测试恢复步骤 ${index + 1} Jenkins 配置`}
                          disabled={
                            !rule.jenkinsJobUrl ||
                            (!rule.apiKey && !rule.apiKeyConfigured) ||
                            inspectingRecoveryRuleId !== null
                          }
                          size="compact"
                          type="button"
                          onClick={() => void inspectRecoveryConfiguration(rule)}
                        >
                          {inspectingRecoveryRuleId === rule.id ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <CircleCheck size={14} />
                          )}
                          测试配置
                        </Button>
                        <Button
                          aria-label={`删除恢复步骤 ${index + 1}`}
                          size="compact"
                          type="button"
                          variant="danger"
                          onClick={() =>
                            setRoundRecoveryRules((rules) =>
                              rules.filter((candidate) => candidate.id !== rule.id),
                            )
                          }
                        >
                          <Trash2 size={14} />
                        </Button>
                      </span>
                      {recoveryInspections[rule.id] ? (
                        <RecoveryInspectionResult state={recoveryInspections[rule.id]} />
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
              <p className="form-help">
                API 密钥使用单个“用户名:API Token”字段，服务端加密保存；页面不会回显。Jenkins 需安装
                Rebuilder
                插件。同一暂停轮次的步骤会并行触发，任一步骤失败都会终止批次。“测试配置”只读取任务与上一构建信息，不会触发构建。
              </p>
            </div>
            <label>
              排队超时（分钟）
              <Input
                name="queueTimeoutMinutes"
                type="number"
                min={1}
                max={10080}
                step={1}
                defaultValue={Math.round(suite.policy.queueTimeoutMs / 60_000)}
              />
            </label>
            <label>
              领取超时（分钟）
              <Input
                name="claimTimeoutMinutes"
                type="number"
                min={1}
                max={60}
                step={1}
                defaultValue={Math.max(1, Math.round(suite.policy.claimTimeoutMs / 60_000))}
              />
            </label>
            <label>
              上传超时（分钟）
              <Input
                name="uploadTimeoutMinutes"
                type="number"
                min={1}
                max={60}
                step={1}
                defaultValue={Math.max(1, Math.round(suite.policy.uploadTimeoutMs / 60_000))}
              />
            </label>
            <label>
              执行器
              <Select name="executor" defaultValue={suite.policy.executor}>
                <option value="testng">Process · 主机工具链</option>
                <option value="testng-container">Container · 离线不可变镜像</option>
              </Select>
            </label>
            <label>
              项目版本
              <Select name="projectVersionId" defaultValue={selectedProjectVersionId} required>
                {selectableProjectVersions.length === 0 ? (
                  <option value="">暂无可用版本</option>
                ) : (
                  selectableProjectVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.name}
                      {version.status === "archived" ? "（已归档）" : ""}
                    </option>
                  ))
                )}
              </Select>
            </label>
            <label>
              Runner 标签（逗号分隔）
              <Input
                name="runnerLabels"
                maxLength={2000}
                defaultValue={suite.policy.runnerLabels.join(", ")}
              />
            </label>
            <div className="settings-wide-field suite-runner-selection">
              <span className="field-label">执行资源</span>
              <p className="form-help">任务执行时直接使用这里保存的执行机或执行机组。</p>
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
                  {runners.map((runner) => (
                    <label className="global-run-runner" key={runner.id}>
                      <Input
                        defaultChecked={suite.policy.runnerIds.includes(runner.id)}
                        disabled={runner.state === "disabled" || Boolean(runner.purgedAt)}
                        name="runnerIds"
                        type="checkbox"
                        value={runner.id}
                      />
                      <span>
                        <strong>{runner.name}</strong>
                        <small>
                          {runner.state} · {runner.os}/{runner.architecture}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <label className="field-stack">
                  <span>执行机组</span>
                  <Select name="runnerGroupId" defaultValue={suite.policy.runnerGroupId ?? ""}>
                    <option value="">请选择执行机组</option>
                    {runnerGroups.map((group) => (
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
            </div>
            <label className="checkbox-field">
              <Input
                name="adapterEnabled"
                type="checkbox"
                defaultChecked={suite.policy.adapter.enabled}
              />
              使用 CoTest TestNG Adapter
            </label>
            <label>
              Adapter Suite Name
              <Input
                name="adapterSuiteName"
                maxLength={512}
                defaultValue={suite.policy.adapter.suiteName}
              />
            </label>
            <label>
              Adapter Test Name
              <Input
                name="adapterTestName"
                maxLength={512}
                defaultValue={suite.policy.adapter.testName}
              />
            </label>
            <label className="settings-wide-field">
              Adapter 环境 IP / 地址（每行一个，首轮按用例、重试按环境池轮询）
              <Textarea
                name="adapterEnvironmentAddresses"
                rows={3}
                defaultValue={suite.policy.adapter.environmentAddresses.join("\n")}
              />
            </label>
            <label className="settings-wide-field">
              任务说明
              <Textarea
                name="description"
                rows={2}
                maxLength={500}
                defaultValue={suite.description}
              />
            </label>
            {artifactsEnabled ? (
              <label className="settings-wide-field">
                产物规则（每行一个相对路径 glob）
                <Textarea
                  name="artifactPatterns"
                  rows={2}
                  defaultValue={suite.policy.artifactPatterns.join("\n")}
                />
              </label>
            ) : null}
            <label className="checkbox-field">
              <Input name="enabled" type="checkbox" defaultChecked={suite.enabled} />
              启用（停用后不能创建新批次，在途批次继续）
            </label>
            <label className="checkbox-field">
              <Input name="archived" type="checkbox" defaultChecked={suite.status === "archived"} />
              归档（保留历史记录，不能创建新批次）
            </label>
            <div className="settings-form-actions">
              {error ? (
                <small className="form-error" role="alert">
                  {error}
                </small>
              ) : null}
              <Button className="primary-button" disabled={pending} type="submit">
                {pending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{" "}
                保存修改
              </Button>
            </div>
          </form>
          <div className="suite-secondary-actions">
            <Button onClick={() => setCopyOpen(true)} type="button">
              <Copy size={15} /> 复制任务
            </Button>
          </div>
          <ActionDialog
            description="复制当前任务的用例成员和执行策略，历史执行记录不会复制。"
            onClose={() => !copying && setCopyOpen(false)}
            open={copyOpen}
            title="复制用例任务"
          >
            <form
              className="settings-inline-form suite-copy-form action-dialog-form"
              onSubmit={(event) => void copySuite(event)}
            >
              <label>
                复制为新任务
                <Input
                  name="copyName"
                  required
                  maxLength={120}
                  placeholder={`${suite.name} 副本`}
                />
              </label>
              <Button className="button button-secondary" disabled={copying} type="submit">
                {copying ? <LoaderCircle className="spin" size={15} /> : <Copy size={15} />}{" "}
                复制任务
              </Button>
            </form>
          </ActionDialog>
          <form className="schedule-form" onSubmit={(event) => void saveSchedule(event)}>
            <div className="section-title-row">
              <span>
                <CalendarClock size={18} />
                <strong>离线计划触发</strong>
              </span>
              {schedule ? (
                <small>
                  下次：{formatDate(schedule.nextTriggerAt)} · UTC {schedule.nextTriggerAt}
                </small>
              ) : (
                <small>尚未配置</small>
              )}
            </div>
            <label>
              Cron（分 时 日 月 周）
              <Input
                defaultValue={schedule?.cronExpression ?? "0 9 * * 1-5"}
                name="cronExpression"
                required
              />
            </label>
            <label>
              IANA 时区
              <Input
                defaultValue={schedule?.timeZone ?? activePlatformTimeZone()}
                name="timeZone"
                required
              />
            </label>
            <label>
              错过触发
              <Select defaultValue={schedule?.missedRunPolicy ?? "run-once"} name="missedRunPolicy">
                <option value="run-once">恢复后补跑一次</option>
                <option value="skip">跳过错过时刻</option>
              </Select>
            </label>
            <label className="checkbox-field schedule-enable-field">
              <Input
                defaultChecked={schedule?.enabled ?? true}
                name="scheduleEnabled"
                type="checkbox"
              />
              启用计划
            </label>
            <span className="schedule-actions">
              <Button className="button button-primary" disabled={pending} type="submit">
                <Save size={15} /> 保存计划
              </Button>
              {schedule ? (
                <Button
                  className="button button-danger"
                  disabled={pending}
                  onClick={() => void deleteSchedule()}
                  type="button"
                >
                  <Trash2 size={15} /> 删除
                </Button>
              ) : null}
            </span>
          </form>
        </div>
      </fieldset>
    </section>
  );
}

function RecoveryInspectionResult({ state }: { state: RecoveryInspectionState | undefined }) {
  if (!state) return null;
  if (state.status === "failed") {
    return (
      <div className="recovery-inspection-result is-error" role="alert">
        <CircleAlert size={16} />
        <span>
          <strong>配置验证失败</strong>
          <small>{state.message}</small>
        </span>
      </div>
    );
  }
  const { inspection } = state;
  return (
    <div aria-live="polite" className="recovery-inspection-result is-success">
      <CircleCheck size={16} />
      <span>
        <strong>连接成功 · {inspection.fullName ?? inspection.name}</strong>
        <small>
          {inspection.buildable ? "允许构建" : "当前不可构建"} ·{" "}
          {inspection.inQueue ? "正在排队" : "未排队"}
          {inspection.lastBuild
            ? ` · 上一构建 #${inspection.lastBuild.number} ${jenkinsBuildResultLabel(inspection.lastBuild)}`
            : " · 暂无历史构建"}
        </small>
        {inspection.lastBuild?.startedAt ? (
          <small>
            开始于 {formatDate(inspection.lastBuild.startedAt)}
            {inspection.lastBuild.durationMs !== undefined
              ? ` · 用时 ${formatDuration(inspection.lastBuild.durationMs)}`
              : ""}
          </small>
        ) : null}
      </span>
    </div>
  );
}

function jenkinsBuildResultLabel(build: NonNullable<JenkinsJobInspection["lastBuild"]>): string {
  if (build.building) return "执行中";
  const labels: Record<string, string> = {
    SUCCESS: "成功",
    FAILURE: "失败",
    ABORTED: "已中止",
    UNSTABLE: "不稳定",
    NOT_BUILT: "未执行",
  };
  return build.result ? (labels[build.result] ?? build.result) : "状态未知";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} 毫秒`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatDate(value: string): string {
  return formatPlatformDateTime(value, undefined, { dateStyle: "medium", timeStyle: "short" });
}

function parseEnvironmentAddresses(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,，]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function optionalNumberInput(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}

function newRetryConcurrencyRule(): EditableRetryConcurrencyRule {
  return {
    id: createRuleId("retry"),
    executionRound: "2",
    previousRoundPassRateMinimum: "",
    previousRoundPassRateMaximum: "",
    remainingRunsMinimum: "",
    remainingRunsMaximum: "",
    concurrency: "4",
  };
}

function newRoundRecoveryRule(): EditableRoundRecoveryRule {
  return {
    id: createRuleId("recovery"),
    afterRound: "1",
    jenkinsJobUrl: "",
    waitMinutes: "5",
    apiKey: "",
    apiKeyConfigured: false,
  };
}

function createRuleId(prefix: "retry" | "recovery"): string {
  const bytes = new Uint8Array(16);
  // randomUUID 仅在安全上下文可用；AutoForge 离线部署也必须支持通过普通 HTTP/IP 访问。
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${suffix}`;
}

function toRetryConcurrencyRuleInput(rule: EditableRetryConcurrencyRule) {
  const previousRoundPassRateMinimum = optionalNumberInput(rule.previousRoundPassRateMinimum);
  const previousRoundPassRateMaximum = optionalNumberInput(rule.previousRoundPassRateMaximum);
  const remainingRunsMinimum = optionalNumberInput(rule.remainingRunsMinimum);
  const remainingRunsMaximum = optionalNumberInput(rule.remainingRunsMaximum);
  return {
    id: rule.id,
    executionRound: Number(rule.executionRound),
    ...(previousRoundPassRateMinimum === undefined ? {} : { previousRoundPassRateMinimum }),
    ...(previousRoundPassRateMaximum === undefined ? {} : { previousRoundPassRateMaximum }),
    ...(remainingRunsMinimum === undefined ? {} : { remainingRunsMinimum }),
    ...(remainingRunsMaximum === undefined ? {} : { remainingRunsMaximum }),
    concurrency: Number(rule.concurrency),
  };
}

function toRoundRecoveryRuleInput(rule: EditableRoundRecoveryRule) {
  return {
    id: rule.id,
    afterRound: Number(rule.afterRound),
    jenkinsJobUrl: rule.jenkinsJobUrl,
    waitMinutes: Number(rule.waitMinutes),
    apiKeyConfigured: rule.apiKeyConfigured,
    ...(rule.apiKey ? { apiKey: rule.apiKey } : {}),
  };
}

function moveRule<T>(rules: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= rules.length) return [...rules];
  const next = [...rules];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...rules];
  next.splice(to, 0, moved);
  return next;
}
