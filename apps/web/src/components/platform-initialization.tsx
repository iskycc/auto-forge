"use client";

import {
  apiErrorSchema,
  initializePlatformConfigurationInputSchema,
  type PlatformConfigurationView,
} from "@autoforge/contracts";
import { Boxes, Database, RotateCw, Server } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button, Input } from "@/components/ui";
import { platformInitializationValidationMessage } from "@/lib/platform-initialization-validation";

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
      const parsed = initializePlatformConfigurationInputSchema.safeParse({
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
      });
      if (!parsed.success) {
        throw new Error(
          platformInitializationValidationMessage(parsed.error.issues) ?? "请检查平台初始化字段。",
        );
      }
      const response = await fetch("/api/v1/auth/setup-platform", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const apiError = apiErrorSchema.safeParse(body);
        throw new Error(
          (apiError.success
            ? (platformInitializationValidationMessage(apiError.data.error.details) ??
              apiError.data.error.message)
            : undefined) ?? "首次平台配置失败。",
        );
      }
      setCompleted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "首次平台配置失败。");
      setPending(false);
    }
  }

  return (
    <section className="setup-card setup-runtime-card" aria-labelledby="platform-setup-title">
      <div className="setup-card-heading">
        <span className="setup-step-number">01</span>
        <span className="setup-heading-icon setup-heading-icon-blue" aria-hidden="true">
          <Database size={20} />
        </span>
        <div>
          <span className="setup-kicker">运行环境</span>
          <h2 id="platform-setup-title">配置部署模式</h2>
          <p>Lite 开箱即用；需要集群能力时再接入 Full 基础设施。</p>
        </div>
        <span className="setup-optional-badge">可选</span>
      </div>
      {completed ? (
        <div className="inline-success setup-restart-message" role="status">
          <RotateCw size={18} />{" "}
          配置已安全写入。请重启主平台；重启后仍使用同一个一次性令牌创建管理员。
        </div>
      ) : (
        <form className="setup-form" noValidate onSubmit={submit}>
          <fieldset className="setup-mode-fieldset">
            <legend>部署模式</legend>
            <div className="setup-mode-grid">
              <Button
                aria-pressed={mode === "lite"}
                className="setup-mode-option"
                onClick={() => setMode("lite")}
                type="button"
                variant="ghost"
              >
                <Server size={18} />
                <span>
                  <strong>Lite</strong>
                  <small>SQLite · 本地对象 · 进程内工作器</small>
                </span>
              </Button>
              <Button
                aria-pressed={mode === "full"}
                className="setup-mode-option"
                onClick={() => setMode("full")}
                type="button"
                variant="ghost"
              >
                <Boxes size={18} />
                <span>
                  <strong>Full</strong>
                  <small>PostgreSQL · NATS · MinIO · Redis</small>
                </span>
              </Button>
            </div>
          </fieldset>
          <div className="setup-field-grid">
            <label>
              <span>平台配置引导令牌</span>
              <Input
                autoComplete="off"
                minLength={32}
                name="bootstrapToken"
                placeholder="粘贴 initial-admin-token 的完整内容"
                required
                type="password"
              />
              <small>与管理员创建使用同一个一次性令牌，不会写入日志。</small>
            </label>
            <label>
              <span>执行机可访问地址</span>
              <Input
                defaultValue={initial.web.publicBaseUrl ?? ""}
                name="publicBaseUrl"
                placeholder="https://autoforge.internal"
                type="url"
              />
              <small>自动安装 Agent 前设置；生产环境应使用可信 HTTPS。</small>
            </label>
          </div>
          {mode === "full" ? (
            <FullInfrastructureFields configured={initial.fullConfigured} />
          ) : null}
          <Button disabled={pending} size="large" type="submit" variant="secondary">
            {pending ? "正在保存…" : "保存平台配置"}
          </Button>
          {error ? (
            <p className="setup-form-error" role="alert">
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
  const required = !configured;
  return (
    <div className="setup-full-fields">
      <label>
        PostgreSQL URL
        <Input
          autoComplete="off"
          name="databaseUrl"
          placeholder={placeholder}
          required={required}
          type="password"
        />
      </label>
      <label>
        NATS 地址（逗号分隔）
        <Input name="natsServers" placeholder="nats://nats:4222" required={required} />
      </label>
      <label>
        Redis URL
        <Input
          autoComplete="off"
          name="redisUrl"
          placeholder={placeholder}
          required={required}
          type="password"
        />
      </label>
      <label>
        MinIO 地址
        <Input
          name="minioEndpoint"
          placeholder="http://minio:9000"
          required={required}
          type="url"
        />
      </label>
      <label>
        MinIO Access Key
        <Input
          autoComplete="off"
          name="minioAccessKey"
          placeholder={placeholder}
          required={required}
          type="password"
        />
      </label>
      <label>
        MinIO Secret Key
        <Input
          autoComplete="off"
          name="minioSecretKey"
          placeholder={placeholder}
          required={required}
          type="password"
        />
      </label>
      <label>
        MinIO Bucket
        <Input name="minioBucket" placeholder="autoforge-objects" required={required} />
      </label>
      <label>
        MinIO Region
        <Input name="minioRegion" placeholder="us-east-1" required={required} />
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
