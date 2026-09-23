"use client";
import { Segmented } from "./ui/segmented";
import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import { Button, Input, Select, Textarea } from "@/components/ui";

import { jenkinsJobInspectionSchema, type JenkinsJobInspection } from "@autoforge/contracts";
import type { CaseSuite, ProjectStructure, Runner, RunnerGroup } from "@autoforge/domain";
import {
  ArrowDown,
  ArrowUp,
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
import { useCaseSuiteRevision } from "@/components/case-suite-revision";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { useToast } from "@/components/ui-feedback";
import { throwApiErrorResponse } from "@/lib/client-api";
import { caseSuiteAdapterDefaults } from "@/lib/case-suite-adapter-defaults";

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
  runners,
  runnerGroups,
  projectVersions,
  projectName,
  selectedTestStageId,
  artifactsEnabled,
  canManage,
}: {
  suite: CaseSuite;
  runners: Runner[];
  runnerGroups: RunnerGroup[];
  projectVersions: ProjectStructure["versions"];
  projectName: string;
  selectedTestStageId: string | undefined;
  artifactsEnabled: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const { revision, acceptMutation } = useCaseSuiteRevision();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
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
  const [selectedProjectVersionId, setSelectedProjectVersionId] = useState(
    suite.policy.projectVersionId ?? selectableProjectVersions[0]?.id ?? "",
  );
  const adapterDefaults = caseSuiteAdapterDefaults(
    projectName,
    selectableProjectVersions.find((version) => version.id === selectedProjectVersionId),
    selectedTestStageId,
  );
  // Only unconfigured fields follow defaults. User edits and persisted names stay literal.
  const [adapterSuiteName, setAdapterSuiteName] = useState<string | undefined>(
    suite.policy.adapter.suiteName || undefined,
  );
  const [adapterTestName, setAdapterTestName] = useState<string | undefined>(
    suite.policy.adapter.testName || undefined,
  );
  const [dirty, setDirty] = useState(
    (adapterSuiteName ?? adapterDefaults.suiteName) !== suite.policy.adapter.suiteName ||
      (adapterTestName ?? adapterDefaults.testName) !== suite.policy.adapter.testName,
  );

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
          expectedRevision: revision,
        }),
      });
      if (!response.ok) {
        await throwApiErrorResponse(response, `请求失败（HTTP ${response.status}）。`);
      }
      const savedSuite = (await response.json()) as CaseSuite;
      acceptMutation(revision, savedSuite.revision);
      setAdapterSuiteName(savedSuite.policy.adapter.suiteName);
      setAdapterTestName(savedSuite.policy.adapter.testName);
      setDirty(false);
      toast.success("用例任务已更新，配置已保存并立即用于后续批次。");
      router.refresh();
    } catch (caught) {
      if (await showConcurrentModification(caught)) return;
      setError(caught instanceof Error ? caught.message : "更新用例任务失败。");
    } finally {
      setPending(false);
    }
  }

  async function copySuite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCopying(true);
    setCopyError(null);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("copyName"),
          includeCases: form.get("configurationOnly") !== "on",
        }),
      });
      if (!response.ok) {
        await throwApiErrorResponse(response, `请求失败（HTTP ${response.status}）。`);
      }
      const created = (await response.json()) as CaseSuite;
      router.push(`/case-suites/${encodeURIComponent(created.id)}`);
    } catch (caught) {
      if (await showConcurrentModification(caught)) return;
      setCopyError(caught instanceof Error ? caught.message : "复制用例任务失败。");
    } finally {
      setCopying(false);
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
      if (!response.ok) {
        await throwApiErrorResponse(response, `验证失败（HTTP ${response.status}）。`);
      }
      const payload: unknown = await response.json().catch(() => null);
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
    <Card as="section" className={cn("card", uiPatterns["card"])}>
      <div className={cn("section-title-row", uiPatterns["section-title-row"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>任务设置</span>
          <h2>基本信息与执行策略</h2>
        </div>
      </div>
      <fieldset
        disabled={!canManage || pending}
        className={cn("settings-form-fieldset", caseSuiteEditorStyles["settings-form-fieldset"])}
      >
        <div className={cn("suite-settings-body", caseSuiteEditorStyles["suite-settings-body"])}>
          <form
            className={cn("settings-grid-form", uiPatterns["settings-grid-form"])}
            onChange={() => setDirty(true)}
            onSubmit={(event) => void submit(event)}
          >
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
            <div
              className={cn(
                "settings-wide-field retry-orchestration-card",
                uiPatterns["settings-wide-field"],
                caseSuiteEditorStyles["retry-orchestration-card"],
              )}
            >
              <div
                className={cn(
                  "retry-orchestration-heading",
                  caseSuiteEditorStyles["retry-orchestration-heading"],
                )}
              >
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
                  onClick={() => {
                    setDirty(true);
                    setRetryConcurrencyRules((rules) => [...rules, newRetryConcurrencyRule()]);
                  }}
                >
                  <Plus size={14} /> 添加规则
                </Button>
              </div>
              {retryMode !== "round" && retryConcurrencyRules.length > 0 ? (
                <small className={cn("form-error", uiPatterns["form-error"])} role="alert">
                  动态并发只适用于整轮轮次，请切换重跑方式或删除规则。
                </small>
              ) : null}
              {retryConcurrencyRules.length === 0 ? (
                <p
                  className={cn(
                    "retry-orchestration-empty",
                    caseSuiteEditorStyles["retry-orchestration-empty"],
                  )}
                >
                  暂无规则，所有轮次使用基础并发度。
                </p>
              ) : (
                <div className={cn("retry-rule-list", caseSuiteEditorStyles["retry-rule-list"])}>
                  {retryConcurrencyRules.map((rule, index) => (
                    <article
                      className={cn("retry-rule-row", caseSuiteEditorStyles["retry-rule-row"])}
                      key={rule.id}
                    >
                      <div
                        className={cn(
                          "retry-rule-order",
                          caseSuiteEditorStyles["retry-rule-order"],
                        )}
                        aria-label={`规则 ${index + 1}`}
                      >
                        <strong>{index + 1}</strong>
                        <span>
                          <Button
                            aria-label="上移规则"
                            disabled={index === 0}
                            size="compact"
                            type="button"
                            onClick={() => {
                              setDirty(true);
                              setRetryConcurrencyRules((rules) =>
                                moveRule(rules, index, index - 1),
                              );
                            }}
                          >
                            <ArrowUp size={13} />
                          </Button>
                          <Button
                            aria-label="下移规则"
                            disabled={index === retryConcurrencyRules.length - 1}
                            size="compact"
                            type="button"
                            onClick={() => {
                              setDirty(true);
                              setRetryConcurrencyRules((rules) =>
                                moveRule(rules, index, index + 1),
                              );
                            }}
                          >
                            <ArrowDown size={13} />
                          </Button>
                        </span>
                      </div>
                      <div
                        className={cn(
                          "retry-rule-fields",
                          caseSuiteEditorStyles["retry-rule-fields"],
                        )}
                      >
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
                        onClick={() => {
                          setDirty(true);
                          setRetryConcurrencyRules((rules) =>
                            rules.filter((candidate) => candidate.id !== rule.id),
                          );
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </article>
                  ))}
                </div>
              )}
            </div>
            <div
              className={cn(
                "settings-wide-field retry-orchestration-card",
                uiPatterns["settings-wide-field"],
                caseSuiteEditorStyles["retry-orchestration-card"],
              )}
            >
              <div
                className={cn(
                  "retry-orchestration-heading",
                  caseSuiteEditorStyles["retry-orchestration-heading"],
                )}
              >
                <span>
                  <strong>轮次间环境恢复</strong>
                  <small>
                    同一轮可配置多个环境并行 Rebuild；全部构建及各自等待均结束后才释放下一轮。
                  </small>
                </span>
                <Button
                  size="compact"
                  type="button"
                  onClick={() => {
                    setDirty(true);
                    setRoundRecoveryRules((rules) => [...rules, newRoundRecoveryRule()]);
                  }}
                >
                  <Plus size={14} /> 添加恢复步骤
                </Button>
              </div>
              {retryMode !== "round" && roundRecoveryRules.length > 0 ? (
                <small className={cn("form-error", uiPatterns["form-error"])} role="alert">
                  环境恢复只适用于整轮轮次，请切换重跑方式或删除恢复步骤。
                </small>
              ) : null}
              {roundRecoveryRules.length === 0 ? (
                <p
                  className={cn(
                    "retry-orchestration-empty",
                    caseSuiteEditorStyles["retry-orchestration-empty"],
                  )}
                >
                  暂无轮次间环境恢复。
                </p>
              ) : (
                <div className={cn("retry-rule-list", caseSuiteEditorStyles["retry-rule-list"])}>
                  {roundRecoveryRules.map((rule, index) => (
                    <article
                      className={cn(
                        "recovery-rule-row",
                        caseSuiteEditorStyles["recovery-rule-row"],
                      )}
                      key={rule.id}
                    >
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
                      <label
                        className={cn(
                          "recovery-job-url",
                          caseSuiteEditorStyles["recovery-job-url"],
                        )}
                      >
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
                      <span
                        className={cn(
                          "recovery-rule-status",
                          caseSuiteEditorStyles["recovery-rule-status"],
                        )}
                      >
                        {rule.apiKeyConfigured
                          ? "密钥已加密保存"
                          : rule.apiKey
                            ? "保存后加密"
                            : "等待配置密钥"}
                      </span>
                      <span
                        className={cn(
                          "recovery-rule-actions",
                          caseSuiteEditorStyles["recovery-rule-actions"],
                        )}
                      >
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
                            <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={14} />
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
                          onClick={() => {
                            setDirty(true);
                            setRoundRecoveryRules((rules) =>
                              rules.filter((candidate) => candidate.id !== rule.id),
                            );
                          }}
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
              <p className={"form-help"}>
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
              <Select
                name="projectVersionId"
                value={selectedProjectVersionId}
                onChange={(event) => setSelectedProjectVersionId(event.target.value)}
                required
              >
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
            <div
              className={cn(
                "settings-wide-field suite-runner-selection",
                uiPatterns["settings-wide-field"],
              )}
            >
              <span className={"field-label"}>执行资源</span>
              <p className={"form-help"}>任务执行时直接使用这里保存的执行机或执行机组。</p>
              <Segmented
                block
                label="执行资源类型"
                value={runnerSelectionKind}
                onChange={(value) => {
                  setDirty(true);
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
                    caseSuiteEditorStyles["global-run-runner-grid"],
                  )}
                >
                  {runners.map((runner) => (
                    <label
                      className={cn(
                        "global-run-runner",
                        caseSuiteEditorStyles["global-run-runner"],
                      )}
                      key={runner.id}
                    >
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
                <label className={cn("field-stack", uiPatterns["field-stack"])}>
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
            <label className={cn("checkbox-field", uiPatterns["checkbox-field"])}>
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
                value={adapterSuiteName ?? adapterDefaults.suiteName}
                onChange={(event) => setAdapterSuiteName(event.target.value)}
              />
            </label>
            <label>
              Adapter Test Name
              <Input
                name="adapterTestName"
                maxLength={512}
                value={adapterTestName ?? adapterDefaults.testName}
                onChange={(event) => setAdapterTestName(event.target.value)}
              />
            </label>
            <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
              Adapter 环境 IP / 地址（每行一个，首轮按用例、重试按环境池轮询）
              <Textarea
                name="adapterEnvironmentAddresses"
                rows={3}
                defaultValue={suite.policy.adapter.environmentAddresses.join("\n")}
              />
            </label>
            <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
              任务说明
              <Textarea
                name="description"
                rows={2}
                maxLength={500}
                defaultValue={suite.description}
              />
            </label>
            {artifactsEnabled ? (
              <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
                产物规则（每行一个相对路径 glob）
                <Textarea
                  name="artifactPatterns"
                  rows={2}
                  defaultValue={suite.policy.artifactPatterns.join("\n")}
                />
              </label>
            ) : null}
            <label className={cn("checkbox-field", uiPatterns["checkbox-field"])}>
              <Input name="enabled" type="checkbox" defaultChecked={suite.enabled} />
              启用（停用后不能创建新批次，在途批次继续）
            </label>
            <label className={cn("checkbox-field", uiPatterns["checkbox-field"])}>
              <Input name="archived" type="checkbox" defaultChecked={suite.status === "archived"} />
              归档（保留历史记录，不能创建新批次）
            </label>
            <div
              className={cn(
                "settings-form-actions suite-save-actions",
                caseSuiteEditorStyles["settings-form-actions"],
                caseSuiteEditorStyles["suite-save-actions"],
              )}
            >
              <span role="status">{dirty ? "任务配置有未保存的修改" : "任务配置已保存"}</span>
              {error ? (
                <small className={cn("form-error", uiPatterns["form-error"])} role="alert">
                  {error}
                </small>
              ) : null}
              <Button
                className={cn("primary-button", uiPatterns["primary-button"])}
                disabled={pending}
                type="submit"
              >
                {pending ? (
                  <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
                ) : (
                  <Save size={15} />
                )}{" "}
                保存修改
              </Button>
            </div>
          </form>
          <div className={"suite-secondary-actions"}>
            <Button
              onClick={() => {
                setCopyError(null);
                setCopyOpen(true);
              }}
              type="button"
            >
              <Copy size={15} /> 复制任务
            </Button>
          </div>
          <ActionDialog
            description="复制已保存的任务配置，可选择是否包含用例；历史执行记录不会复制。"
            onClose={() => !copying && setCopyOpen(false)}
            open={copyOpen}
            title="复制用例任务"
            protectUnsavedChanges
            closeDisabled={copying}
            footer={
              <>
                <Button
                  type="button"
                  data-dialog-dismiss
                  disabled={copying}
                  onClick={() => setCopyOpen(false)}
                >
                  取消
                </Button>{" "}
                <Button variant="primary" form="suite-copy-form" disabled={copying} type="submit">
                  {copying ? (
                    <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
                  ) : (
                    <Copy size={15} />
                  )}{" "}
                  复制任务
                </Button>
              </>
            }
          >
            <form
              id="suite-copy-form"
              className={cn(
                "stack-form suite-copy-form action-dialog-form",
                caseSuiteEditorStyles["stack-form"],
                caseSuiteEditorStyles["suite-copy-form"],
                caseSuiteEditorStyles["action-dialog-form"],
              )}
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
              <label
                className={cn("checkbox-field suite-copy-scope", uiPatterns["checkbox-field"])}
              >
                <Input type="checkbox" name="configurationOnly" disabled={copying} />
                仅复制配置，不复制用例
              </label>
              <p className={cn("field-hint", uiPatterns["field-hint"])}>
                勾选后保留执行策略、Adapter 和恢复配置，新任务不包含普通或 DDT 用例。
              </p>
              {copyError ? (
                <p
                  className={cn("inline-error", caseSuiteEditorStyles["inline-error"])}
                  role="alert"
                >
                  {copyError}
                </p>
              ) : null}
            </form>
          </ActionDialog>
        </div>
      </fieldset>
    </Card>
  );
}

function RecoveryInspectionResult({ state }: { state: RecoveryInspectionState | undefined }) {
  if (!state) return null;
  if (state.status === "failed") {
    return (
      <div
        className={cn(
          "recovery-inspection-result is-error",
          caseSuiteEditorStyles["recovery-inspection-result"],
        )}
        role="alert"
      >
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
    <div
      aria-live="polite"
      className={cn(
        "recovery-inspection-result is-success",
        caseSuiteEditorStyles["recovery-inspection-result"],
      )}
    >
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

const caseSuiteEditorStyles = {
  "action-dialog-form": "mt-0",
  "global-run-runner":
    "grid grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-2 min-h-13.5 border border-solid border-border rounded-lg py-2 px-2.5 bg-muted cursor-pointer [&.selected]:border-muted [&.selected]:bg-info/10 [&.selected]:text-info [&.disabled]:cursor-not-allowed [&.disabled]:opacity-52 [&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:flex-col [&_>_span]:gap-0.5 [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal [&_strong]:text-foreground [&_strong]:text-xs [&_small]:[overflow-wrap:anywhere] [&_small]:whitespace-normal [&_small]:text-muted-foreground [&_small]:text-xs",
  "global-run-runner-grid":
    "grid grid-cols-3 gap-2 max-h-[152px] overflow-y-auto mt-[11px] pr-[3px] max-[1440px]:grid-cols-2",
  "inline-error": "text-destructive text-xs leading-[1.35]",
  "recovery-inspection-result":
    "flex col-span-full items-start gap-2 py-2.5 px-3 border border-solid border-border rounded-lg bg-card [&_>_svg]:[flex:0_0_auto] [&_>_svg]:mt-0.5 [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-0.5 [&_strong]:[overflow-wrap:anywhere] [&_small]:[overflow-wrap:anywhere] [&_small]:text-muted-foreground [&.is-success_>_svg]:text-success [&.is-success_strong]:text-success [&.is-error_>_svg]:text-destructive [&.is-error_strong]:text-destructive",
  "recovery-job-url": "max-[1181px]:col-span-full",
  "recovery-rule-actions": "flex col-span-full justify-end gap-2 [&_>_.ui-button]:justify-self-end",
  "recovery-rule-row":
    "min-w-0 p-3 border border-solid border-transparent rounded-lg bg-muted grid grid-cols-[minmax(110px,_0.7fr)_minmax(240px,_2fr)_minmax(220px,_1.4fr)_minmax(_150px,_0.8fr_)] items-end gap-2.5 max-[1181px]:grid-cols-2",
  "recovery-rule-status": "self-center text-success text-xs font-semibold",

  "retry-orchestration-card":
    "grid min-w-0 gap-3 p-4 border border-solid border-border rounded-xl bg-card shadow-xs",
  "retry-orchestration-empty":
    "text-muted-foreground text-xs font-normal m-0 p-3.5 rounded-lg bg-muted text-center",
  "retry-orchestration-heading":
    "flex items-start justify-between gap-4 [&_>_span]:grid [&_>_span]:gap-1 [&_strong]:text-foreground [&_strong]:text-sm [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:font-normal",
  "retry-rule-fields": "grid min-w-0 grid-cols-[repeat(auto-fit,_minmax(128px,_1fr))] gap-[9px]",
  "retry-rule-list": "grid min-w-0 gap-2.5",
  "retry-rule-order":
    "grid self-stretch [align-content:space-between] justify-items-center gap-2 py-[5px] px-0 text-muted-foreground [&_>_strong]:grid [&_>_strong]:w-7 [&_>_strong]:h-7 [&_>_strong]:place-items-center [&_>_strong]:rounded-full [&_>_strong]:bg-info/10 [&_>_strong]:text-primary-text [&_>_span]:flex [&_>_span]:gap-1 [&_.ui-button]:min-w-6 [&_.ui-button]:px-[5px]",
  "retry-rule-row":
    "min-w-0 p-3 border border-solid border-transparent rounded-lg bg-muted grid grid-cols-[52px_minmax(0,_1fr)_auto] items-end gap-2.5",
  "settings-form-actions":
    "flex justify-end gap-2.5 [&.management-sticky-actions]:bottom-3 [&.management-sticky-actions]:border [&.management-sticky-actions]:border-solid [&.management-sticky-actions]:border-border [&.management-sticky-actions]:rounded-xl [&.management-sticky-actions]:shadow-xs",
  "settings-form-fieldset":
    "contents min-w-0 m-0 border-0 p-0 [&:disabled]:opacity-78 [&[hidden]]:hidden",
  "stack-form":
    'flex flex-col gap-3.5 mt-5 [&_label]:flex [&_label]:flex-col [&_label]:gap-[7px] [&_label]:text-muted-foreground [&_label]:text-xs [&_label]:font-semibold [&_.button]:self-start [&_.suite-create-mode_input[type="radio"]]:w-4.5 [&_.suite-create-mode_input[type="radio"]]:[flex:0_0_18px] [&_.suite-create-mode_input[type="radio"]]:mt-0.5 [&_.suite-create-mode_input[type="radio"]]:p-0 [&_.suite-adapter-fields_.checkbox-field]:flex-row [&_.suite-adapter-fields_.checkbox-field]:items-center [&_.suite-adapter-fields_input[type="checkbox"]]:w-4.5 [&_.suite-adapter-fields_input[type="checkbox"]]:[flex:0_0_18px] [&_.suite-adapter-fields_input[type="checkbox"]]:p-0 [&_.suite-copy-scope]:flex-row [&_.suite-copy-scope]:items-center [&_.suite-copy-scope]:gap-2 [&_.suite-copy-scope_input]:w-5 [&_.suite-copy-scope_input]:[flex:0_0_20px] [&_.suite-copy-scope_input]:p-0',
  "suite-copy-form":
    "min-w-0 [&_.field-hint]:m-0 [&_.field-hint]:text-muted-foreground [&_.field-hint]:text-xs [&_.field-hint]:leading-[1.6]",
  "suite-save-actions":
    "sticky bottom-3 z-2 border border-solid border-border rounded-lg p-3 bg-card shadow-xs [&_>_span]:mr-auto [&_>_span]:text-muted-foreground [&_>_span]:text-sm",
  "suite-settings-body": "[padding:20px_24px_24px]",
} as const;
