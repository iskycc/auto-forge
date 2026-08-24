"use client";

import { Button, Input, Textarea } from "@/components/ui";

import type { PlatformConfigurationView } from "@autoforge/contracts";
import { Save, ServerCog } from "lucide-react";
import { useState, type FormEvent } from "react";

export function PlatformSettings({
  initial,
  canManage,
}: {
  initial: Omit<PlatformConfigurationView, "configurationFile">;
  canManage: boolean;
}) {
  const [revision, setRevision] = useState(initial.revision);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    setPending(true);
    setMessage("");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/settings/platform", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision,
          mode: initial.mode,
          web: {
            hostname: form.get("hostname"),
            port: numberValue(form, "port"),
            ...(stringValue(form, "publicBaseUrl")
              ? { publicBaseUrl: stringValue(form, "publicBaseUrl") }
              : {}),
            publicDashboardRefreshSeconds: numberValue(form, "publicDashboardRefreshSeconds"),
          },
          limits: {
            maxJarBytes: mebibytesToBytes(numberValue(form, "maxJarMebibytes")),
            testNgTargetJavaVersion: numberValue(form, "testNgTargetJavaVersion"),
            runnerClaimRateLimitPerMinute: numberValue(form, "runnerClaimRateLimitPerMinute"),
            sessionTtlHours: numberValue(form, "sessionTtlHours"),
            authLoginAttemptsPerWindow: numberValue(form, "authLoginAttemptsPerWindow"),
            caseExecutionTimeoutSeconds: numberValue(form, "caseExecutionTimeoutSeconds"),
            artifactCollectionEnabled: form.get("artifactCollectionEnabled") === "on",
          },
          scheduler: {
            maximumCpuUtilizationPercent: numberValue(form, "maximumCpuUtilizationPercent"),
            maximumMemoryUtilizationPercent: numberValue(form, "maximumMemoryUtilizationPercent"),
            maximumLoadPerCpu: numberValue(form, "maximumLoadPerCpu"),
            metricsMaximumAgeSeconds: numberValue(form, "metricsMaximumAgeSeconds"),
            projectMaximumConcurrency: numberValue(form, "projectMaximumConcurrency"),
            priorityAgingIntervalMinutes: numberValue(form, "priorityAgingIntervalMinutes"),
          },
          worker: {
            concurrency: numberValue(form, "workerConcurrency"),
            healthPort: numberValue(form, "workerHealthPort"),
            metricsEnabled: form.get("workerMetricsEnabled") === "on",
            shutdownGraceMs: numberValue(form, "workerShutdownGraceMs"),
          },
          ...(initial.mode === "full" ? { full: fullConfiguration(form) } : {}),
        }),
      });
      const body = (await response.json()) as {
        revision?: number;
        appliedImmediatelyFields?: string[];
        restartRequiredFields?: string[];
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "平台配置保存失败。");
      if (body.revision !== undefined) setRevision(body.revision);
      const immediate = body.appliedImmediatelyFields ?? [];
      const restart = body.restartRequiredFields ?? [];
      setMessage(
        [
          "平台配置已保存。",
          immediate.length > 0 ? `${immediate.join("、")}已立即生效。` : "",
          restart.length > 0
            ? `${restart.join("、")}需要重启 Web${initial.mode === "full" ? " 和 worker" : ""} 后生效。`
            : "无需重启。",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "平台配置保存失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="settings-stack" onSubmit={submit}>
      {message ? <div className="inline-success">{message}</div> : null}
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}

      {!canManage ? (
        <div className="implementation-notice" role="status">
          当前账号只有平台配置查看权限；所有字段均为只读。
        </div>
      ) : null}

      <fieldset className="settings-form-fieldset" disabled={!canManage}>
        <section className="content-card settings-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Runtime</p>
              <h2>平台运行配置</h2>
            </div>
            <ServerCog size={22} aria-hidden="true" />
          </div>
          <p className="settings-note">
            配置保存在平台数据目录中。外部访问地址与产物收集保存后立即生效；进程监听、基础设施、容量和调度参数需要重启。
          </p>
          <div className="settings-grid-form">
            <div className="deployment-mode-display" aria-label="部署模式">
              <span>部署模式</span>
              <strong>
                {initial.mode === "lite"
                  ? "Lite · SQLite 与本地对象"
                  : "Full · PostgreSQL/NATS/MinIO/Redis"}
              </strong>
              <small>由部署配置决定，不能在运行中的管理页面切换。</small>
            </div>
            <label>
              监听地址
              <Input defaultValue={initial.web.hostname} name="hostname" required />
            </label>
            <label>
              HTTP 端口
              <Input
                defaultValue={initial.web.port}
                min={1}
                max={65_535}
                name="port"
                type="number"
              />
            </label>
            <label>
              外部访问地址
              <Input
                defaultValue={initial.web.publicBaseUrl ?? ""}
                name="publicBaseUrl"
                placeholder="http://10.20.30.10:3000"
                type="url"
              />
              <small>可信内网可使用 HTTP/IP 直连；跨不可信网络仍应使用 HTTPS。</small>
              <small>保存后立即用于新生成的分享链接、Jenkins 链接与 Runner 安装。</small>
            </label>
            <label>
              公开大盘刷新间隔（秒）
              <Input
                defaultValue={initial.web.publicDashboardRefreshSeconds}
                min={5}
                max={300}
                name="publicDashboardRefreshSeconds"
                type="number"
              />
            </label>
          </div>
        </section>

        {initial.mode === "full" ? (
          <section className="content-card settings-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Full Infrastructure</p>
                <h2>Full 基础设施</h2>
              </div>
            </div>
            <p className="settings-note">
              {initial.fullConfigured
                ? "凭据已配置；敏感字段留空会保留原值，页面永不回显。"
                : "首次启用 Full 模式必须完整填写以下连接信息。"}
            </p>
            <div className="settings-grid-form">
              <SecretInput
                label="PostgreSQL URL"
                name="databaseUrl"
                configured={initial.fullConfigured}
              />
              <label>
                NATS 地址（逗号或换行分隔）
                <Textarea name="natsServers" placeholder="nats://nats:4222" />
              </label>
              <SecretInput label="Redis URL" name="redisUrl" configured={initial.fullConfigured} />
              <label>
                MinIO 地址
                <Input name="minioEndpoint" placeholder="http://minio:9000" type="url" />
              </label>
              <SecretInput
                label="MinIO Access Key"
                name="minioAccessKey"
                configured={initial.fullConfigured}
              />
              <SecretInput
                label="MinIO Secret Key"
                name="minioSecretKey"
                configured={initial.fullConfigured}
              />
              <label>
                MinIO Bucket
                <Input name="minioBucket" placeholder="autoforge-objects" />
              </label>
              <label>
                MinIO Region
                <Input name="minioRegion" placeholder="us-east-1" />
              </label>
            </div>
          </section>
        ) : null}

        <section className="content-card settings-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Limits</p>
              <h2>容量、会话与调度阈值</h2>
            </div>
          </div>
          <div className="settings-grid-form">
            <label>
              JAR 大小上限（MiB）
              <Input
                defaultValue={bytesToMebibytes(initial.limits.maxJarBytes)}
                max={256}
                min={1}
                name="maxJarMebibytes"
                type="number"
              />
              <small>可配置范围 1–256 MiB；保存后重启 Web 和 worker 生效。</small>
            </label>
            <NumberInput
              label="目标 Java 版本"
              name="testNgTargetJavaVersion"
              value={initial.limits.testNgTargetJavaVersion}
            />
            <NumberInput
              label="Runner 每分钟领取上限"
              name="runnerClaimRateLimitPerMinute"
              value={initial.limits.runnerClaimRateLimitPerMinute}
            />
            <NumberInput
              label="会话有效期（小时）"
              name="sessionTtlHours"
              value={initial.limits.sessionTtlHours}
            />
            <NumberInput
              label="每 IP 登录尝试上限（15 分钟窗口）"
              name="authLoginAttemptsPerWindow"
              value={initial.limits.authLoginAttemptsPerWindow}
            />
            <NumberInput
              label="用例执行超时（秒）"
              name="caseExecutionTimeoutSeconds"
              value={initial.limits.caseExecutionTimeoutSeconds}
            />
            <label className="checkbox-field">
              <Input
                defaultChecked={initial.limits.artifactCollectionEnabled}
                name="artifactCollectionEnabled"
                type="checkbox"
              />
              启用产物收集（关闭后执行不扫描、不上传产物，详情页不展示产物）
              <small>保存后立即应用到新建批次；已创建批次保持原有执行快照。</small>
            </label>
            <NumberInput
              label="调度 CPU 上限（%）"
              name="maximumCpuUtilizationPercent"
              value={initial.scheduler.maximumCpuUtilizationPercent}
            />
            <NumberInput
              label="调度内存上限（%）"
              name="maximumMemoryUtilizationPercent"
              value={initial.scheduler.maximumMemoryUtilizationPercent}
            />
            <NumberInput
              label="每 CPU 负载上限"
              name="maximumLoadPerCpu"
              value={initial.scheduler.maximumLoadPerCpu}
              step="0.1"
            />
            <NumberInput
              label="指标最大年龄（秒）"
              name="metricsMaximumAgeSeconds"
              value={initial.scheduler.metricsMaximumAgeSeconds}
            />
            <NumberInput
              label="项目最大在途执行数"
              name="projectMaximumConcurrency"
              value={initial.scheduler.projectMaximumConcurrency}
            />
            <NumberInput
              label="优先级老化间隔（分钟）"
              name="priorityAgingIntervalMinutes"
              value={initial.scheduler.priorityAgingIntervalMinutes}
            />
            <NumberInput
              label="后台工作并发"
              name="workerConcurrency"
              value={initial.worker.concurrency}
            />
            <NumberInput
              label="Full worker 健康端口"
              name="workerHealthPort"
              value={initial.worker.healthPort}
            />
            <NumberInput
              label="后台工作排空期限（毫秒）"
              name="workerShutdownGraceMs"
              value={initial.worker.shutdownGraceMs}
            />
            <label className="checkbox-field">
              <Input
                defaultChecked={initial.worker.metricsEnabled}
                name="workerMetricsEnabled"
                type="checkbox"
              />
              启用后台 worker 指标端点
            </label>
          </div>
          <div className="settings-form-actions">
            <Button className="primary-button" disabled={pending} type="submit">
              <Save size={16} aria-hidden="true" /> {pending ? "正在保存…" : "保存平台配置"}
            </Button>
          </div>
        </section>
      </fieldset>
    </form>
  );
}

function NumberInput({
  label,
  name,
  value,
  step,
}: {
  label: string;
  name: string;
  value: number;
  step?: string;
}) {
  return (
    <label>
      {label}
      <Input defaultValue={value} name={name} step={step} type="number" />
    </label>
  );
}

function SecretInput({
  label,
  name,
  configured,
}: {
  label: string;
  name: string;
  configured: boolean;
}) {
  return (
    <label>
      {label}
      <Input
        autoComplete="off"
        name={name}
        placeholder={configured ? "留空以保留现有值" : "首次配置必填"}
        type="password"
      />
    </label>
  );
}

function fullConfiguration(form: FormData): Record<string, string | string[]> {
  const fields = [
    "databaseUrl",
    "redisUrl",
    "minioEndpoint",
    "minioAccessKey",
    "minioSecretKey",
    "minioBucket",
    "minioRegion",
  ] as const;
  const values: Record<string, string | string[]> = {};
  for (const field of fields) {
    const value = stringValue(form, field);
    if (value) values[field] = value;
  }
  const natsServers = stringValue(form, "natsServers")
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (natsServers.length > 0) values.natsServers = natsServers;
  return values;
}

function stringValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

function numberValue(form: FormData, name: string): number {
  return Number(form.get(name));
}

function bytesToMebibytes(bytes: number): number {
  return bytes / 1024 / 1024;
}

function mebibytesToBytes(mebibytes: number): number {
  return mebibytes * 1024 * 1024;
}
