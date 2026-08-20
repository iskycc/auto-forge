"use client";

import { Button, Input, Select, Textarea } from "@/components/ui";

import { apiErrorSchema, type CaseSuiteSchedule } from "@autoforge/contracts";
import type { CaseSuiteDetails, ProjectVersion, Runner, RunnerGroup } from "@autoforge/domain";
import { CalendarClock, Copy, LoaderCircle, Save, Server, Trash2, UsersRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

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
  const [pending, setPending] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [runnerSelectionKind, setRunnerSelectionKind] = useState<"runners" | "group">(
    suite.policy.runnerGroupId ? "group" : "runners",
  );

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const runnerLabels = String(form.get("runnerLabels") ?? "")
      .split(/[,，]/)
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    const parameters = parseKeyValueLines(String(form.get("parameters") ?? ""));
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
    setMessage(null);
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
            retryLimit: Number(form.get("retryLimit")),
            retryMode: form.get("retryMode"),
            queueTimeoutMs: Math.round(Number(form.get("queueTimeoutMinutes")) * 60_000),
            claimTimeoutMs: Math.round(Number(form.get("claimTimeoutMinutes")) * 60_000),
            uploadTimeoutMs: Math.round(Number(form.get("uploadTimeoutMinutes")) * 60_000),
            projectVersionId: String(form.get("projectVersionId") ?? ""),
            runnerIds: runnerSelectionKind === "runners" ? runnerIds : [],
            runnerGroupId:
              runnerSelectionKind === "group" ? String(form.get("runnerGroupId") ?? "") : "",
            runnerLabels,
            parameters,
            artifactPatterns: artifactsEnabled ? artifactPatterns : [],
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
      setMessage("用例任务已更新。");
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
    setMessage(null);
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
      const created = (await response.json()) as CaseSuiteDetails;
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
    if (!schedule || !window.confirm("删除此计划触发？历史触发记录会保留。")) return;
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
    setMessage(null);
    try {
      const response = await responsePromise;
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(parsed.success ? parsed.data.error.message : "计划操作失败。");
      }
      setMessage(success);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "计划操作失败。");
    } finally {
      setPending(false);
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
                max={64}
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
                defaultValue={suite.policy.retryLimit}
              />
            </label>
            <label>
              失败重跑方式
              <Select name="retryMode" defaultValue={suite.policy.retryMode}>
                <option value="immediate">立即重跑（失败后马上重试）</option>
                <option value="round">整轮轮次（本轮结束后统一重试）</option>
              </Select>
            </label>
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
              <Select name="projectVersionId" defaultValue={suite.policy.projectVersionId ?? ""}>
                <option value="">项目默认依赖</option>
                {projectVersions
                  .filter((version) => version.status === "active")
                  .map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.name}
                    </option>
                  ))}
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
              Adapter 环境 IP / 地址（每行一个，按用例轮询）
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
            <label className="settings-wide-field">
              参数模板（每行一个 KEY=VALUE，用例参数优先）
              <Textarea
                name="parameters"
                rows={3}
                defaultValue={Object.entries(suite.policy.parameters)
                  .map(([key, value]) => `${key}=${value}`)
                  .join("\n")}
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
              {message ? (
                <small className="inline-success" role="status">
                  {message}
                </small>
              ) : null}
              <Button className="primary-button" disabled={pending} type="submit">
                {pending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{" "}
                保存修改
              </Button>
            </div>
          </form>
          <form
            className="settings-inline-form suite-copy-form"
            onSubmit={(event) => void copySuite(event)}
          >
            <label>
              复制为新任务
              <Input name="copyName" required maxLength={120} placeholder={`${suite.name} 副本`} />
            </label>
            <Button className="button button-secondary" disabled={copying} type="submit">
              {copying ? <LoaderCircle className="spin" size={15} /> : <Copy size={15} />} 复制任务
            </Button>
          </form>
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
                defaultValue={
                  schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
                }
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function parseKeyValueLines(text: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    parameters[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return parameters;
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
