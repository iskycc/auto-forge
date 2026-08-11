"use client";

import type { PlatformConfigurationView } from "@autoforge/contracts";
import { Database, RotateCw } from "lucide-react";
import { useState, type FormEvent } from "react";

export function PlatformInitialization({ initial }: { initial: PlatformConfigurationView }) {
  const [mode, setMode] = useState(initial.mode);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/auth/setup-platform", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bootstrapToken: stringValue(form, "bootstrapToken"),
          configuration: {
            revision: initial.revision,
            mode,
            web: {
              ...initial.web,
              ...(stringValue(form, "publicBaseUrl")
                ? { publicBaseUrl: stringValue(form, "publicBaseUrl") }
                : {}),
            },
            limits: initial.limits,
            scheduler: initial.scheduler,
            worker: initial.worker,
            ...(mode === "full" ? { full: fullConfiguration(form) } : {}),
          },
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "首次平台配置失败。");
      setCompleted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "首次平台配置失败。");
      setPending(false);
    }
  }

  return (
    <section className="auth-card setup-platform-card" aria-labelledby="platform-setup-title">
      <div className="auth-brand-mark setup-platform-mark" aria-hidden="true">
        <Database size={22} />
      </div>
      <p className="eyebrow">运行模式初始化</p>
      <h1 id="platform-setup-title">先配置平台（可选）</h1>
      <p className="auth-intro">
        默认 Lite 已可独立运行。需要 Full 或自动安装 Agent
        时，可在创建管理员前配置基础设施与执行机可访问地址；保存后重启平台，再继续管理员初始化。
      </p>
      {completed ? (
        <div className="inline-success setup-restart-message" role="status">
          <RotateCw size={18} />{" "}
          配置已安全写入。请重启主平台；重启后仍使用同一个一次性令牌创建管理员。
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <label>
            平台配置引导令牌
            <input autoComplete="off" name="bootstrapToken" required type="password" />
          </label>
          <label>
            部署模式
            <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
              <option value="lite">Lite · 单机独立运行</option>
              <option value="full">Full · 外部基础设施</option>
            </select>
          </label>
          <label>
            执行机可访问地址
            <input
              defaultValue={initial.web.publicBaseUrl ?? ""}
              name="publicBaseUrl"
              placeholder="https://autoforge.internal"
              type="url"
            />
            <small>自动安装 Agent 前必须设置 HTTPS 地址；本机开发可使用 loopback HTTP。</small>
          </label>
          {mode === "full" ? (
            <FullInfrastructureFields configured={initial.fullConfigured} />
          ) : null}
          <button className="button button-secondary auth-submit" disabled={pending} type="submit">
            {pending ? "正在保存…" : "保存平台配置"}
          </button>
          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}

function FullInfrastructureFields({ configured }: { configured: boolean }) {
  const placeholder = configured ? "已配置；留空保留" : "首次启用必填";
  return (
    <div className="setup-full-fields">
      <label>
        PostgreSQL URL
        <input autoComplete="off" name="databaseUrl" placeholder={placeholder} type="password" />
      </label>
      <label>
        NATS 地址（逗号分隔）
        <input name="natsServers" placeholder="nats://nats:4222" />
      </label>
      <label>
        Redis URL
        <input autoComplete="off" name="redisUrl" placeholder={placeholder} type="password" />
      </label>
      <label>
        MinIO 地址
        <input name="minioEndpoint" placeholder="http://minio:9000" type="url" />
      </label>
      <label>
        MinIO Access Key
        <input autoComplete="off" name="minioAccessKey" placeholder={placeholder} type="password" />
      </label>
      <label>
        MinIO Secret Key
        <input autoComplete="off" name="minioSecretKey" placeholder={placeholder} type="password" />
      </label>
      <label>
        MinIO Bucket
        <input name="minioBucket" placeholder="autoforge-objects" />
      </label>
      <label>
        MinIO Region
        <input name="minioRegion" placeholder="us-east-1" />
      </label>
    </div>
  );
}

function fullConfiguration(form: FormData): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const name of [
    "databaseUrl",
    "redisUrl",
    "minioEndpoint",
    "minioAccessKey",
    "minioSecretKey",
    "minioBucket",
    "minioRegion",
  ]) {
    const value = stringValue(form, name);
    if (value) result[name] = value;
  }
  const natsServers = stringValue(form, "natsServers")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (natsServers.length > 0) result.natsServers = natsServers;
  return result;
}

function stringValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}
