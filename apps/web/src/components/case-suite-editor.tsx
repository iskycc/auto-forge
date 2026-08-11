"use client";

import { apiErrorSchema, type CaseSuiteSchedule } from "@autoforge/contracts";
import type { CaseSuiteDetails } from "@autoforge/domain";
import { CalendarClock, Copy, LoaderCircle, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export function CaseSuiteEditor({
  suite,
  schedule,
  canManage,
}: {
  suite: CaseSuiteDetails;
  schedule?: CaseSuiteSchedule;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
            priority: Number(form.get("priority")),
            concurrency: Number(form.get("concurrency")),
            retryLimit: Number(form.get("retryLimit")),
            queueTimeoutMs: Math.round(Number(form.get("queueTimeoutMinutes")) * 60_000),
            executionTimeoutMs: Math.round(Number(form.get("executionTimeoutMinutes")) * 60_000),
            runnerLabels,
            parameters,
            artifactPatterns,
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
        <form className="settings-grid-form" onSubmit={(event) => void submit(event)}>
          <label>
            任务名称
            <input name="name" required maxLength={120} defaultValue={suite.name} />
          </label>
          <label>
            优先级（-100 到 100）
            <input
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
            <input
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
            <input
              name="retryLimit"
              type="number"
              min={0}
              max={10}
              step={1}
              defaultValue={suite.policy.retryLimit}
            />
          </label>
          <label>
            排队超时（分钟）
            <input
              name="queueTimeoutMinutes"
              type="number"
              min={1}
              max={10080}
              step={1}
              defaultValue={Math.round(suite.policy.queueTimeoutMs / 60_000)}
            />
          </label>
          <label>
            执行超时（分钟）
            <input
              name="executionTimeoutMinutes"
              type="number"
              min={1}
              max={1440}
              step={1}
              defaultValue={Math.round(suite.policy.executionTimeoutMs / 60_000)}
            />
          </label>
          <label>
            执行器
            <select name="executor" defaultValue={suite.policy.executor}>
              <option value="testng">Process · 主机工具链</option>
              <option value="testng-container">Container · 离线不可变镜像</option>
            </select>
          </label>
          <label>
            Runner 标签（逗号分隔）
            <input
              name="runnerLabels"
              maxLength={2000}
              defaultValue={suite.policy.runnerLabels.join(", ")}
            />
          </label>
          <label className="settings-wide-field">
            任务说明
            <textarea
              name="description"
              rows={2}
              maxLength={500}
              defaultValue={suite.description}
            />
          </label>
          <label className="settings-wide-field">
            参数模板（每行一个 KEY=VALUE，用例参数优先）
            <textarea
              name="parameters"
              rows={3}
              defaultValue={Object.entries(suite.policy.parameters)
                .map(([key, value]) => `${key}=${value}`)
                .join("\n")}
            />
          </label>
          <label className="settings-wide-field">
            产物规则（每行一个相对路径 glob）
            <textarea
              name="artifactPatterns"
              rows={2}
              defaultValue={suite.policy.artifactPatterns.join("\n")}
            />
          </label>
          <label className="checkbox-field">
            <input name="enabled" type="checkbox" defaultChecked={suite.enabled} />
            启用（停用后不能创建新批次，在途批次继续）
          </label>
          <label className="checkbox-field">
            <input name="archived" type="checkbox" defaultChecked={suite.status === "archived"} />
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
            <button className="primary-button" disabled={pending} type="submit">
              {pending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} 保存修改
            </button>
          </div>
        </form>
        <form className="settings-inline-form" onSubmit={(event) => void copySuite(event)}>
          <label>
            复制为新任务
            <input name="copyName" required maxLength={120} placeholder={`${suite.name} 副本`} />
          </label>
          <button className="button button-secondary" disabled={copying} type="submit">
            {copying ? <LoaderCircle className="spin" size={15} /> : <Copy size={15} />} 复制任务
          </button>
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
            <input
              defaultValue={schedule?.cronExpression ?? "0 9 * * 1-5"}
              name="cronExpression"
              required
            />
          </label>
          <label>
            IANA 时区
            <input
              defaultValue={schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
              name="timeZone"
              required
            />
          </label>
          <label>
            错过触发
            <select defaultValue={schedule?.missedRunPolicy ?? "run-once"} name="missedRunPolicy">
              <option value="run-once">恢复后补跑一次</option>
              <option value="skip">跳过错过时刻</option>
            </select>
          </label>
          <label className="checkbox-field">
            <input
              defaultChecked={schedule?.enabled ?? true}
              name="scheduleEnabled"
              type="checkbox"
            />
            启用计划
          </label>
          <span className="schedule-actions">
            <button className="button button-primary" disabled={pending} type="submit">
              <Save size={15} /> 保存计划
            </button>
            {schedule ? (
              <button
                className="button button-danger"
                disabled={pending}
                onClick={() => void deleteSchedule()}
                type="button"
              >
                <Trash2 size={15} /> 删除
              </button>
            ) : null}
          </span>
        </form>
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
