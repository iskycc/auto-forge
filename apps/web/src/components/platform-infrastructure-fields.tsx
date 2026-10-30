"use client";

import { useState, type ReactNode } from "react";
import { Alert, Card, Tag, Typography } from "antd";
import Link from "next/link";
import { Database, HardDrive, Network, Server, Zap } from "lucide-react";
import {
  platformInfrastructureCheckResultSchema,
  type PlatformInfrastructureComponent,
  type PlatformInfrastructureCheckResult,
} from "@autoforge/contracts";
import { Button, Select } from "@/components/ui";
import { PlatformInitializationInput } from "./platform-initialization-input";
import {
  infrastructureLabels,
  infrastructureTargetFromForm,
} from "@/lib/platform-infrastructure-form";
import { readApiError } from "@/lib/client-api";

type Field = {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  type?: "password" | "number";
  max?: number;
};
const definitions: Record<
  PlatformInfrastructureComponent,
  { description: string; icon: ReactNode; fields: Field[] }
> = {
  postgres: {
    description: "保存用例、任务、身份及执行结果。请先创建主库。",
    icon: <Database size={17} />,
    fields: [
      { key: "host", label: "IP / 主机名", placeholder: "10.20.0.12" },
      { key: "port", label: "端口", type: "number", value: "5432" },
      { key: "database", label: "数据库名", value: "autoforge" },
      { key: "username", label: "用户名", placeholder: "autoforge" },
      { key: "password", label: "密码", type: "password", max: 4096 },
    ],
  },
  logs: {
    description: "独立填写日志服务器。使用具有 CREATEDB 权限的账号，按北京时间每日自动创建日志库。",
    icon: <HardDrive size={17} />,
    fields: [
      { key: "host", label: "IP / 主机名", placeholder: "10.20.0.13" },
      { key: "port", label: "端口", type: "number", value: "5432" },
      { key: "maintenanceDatabase", label: "维护数据库", value: "postgres" },
      { key: "databasePrefix", label: "每日库名前缀", value: "autoforge_logs" },
      { key: "username", label: "管理员用户名", placeholder: "postgres" },
      { key: "password", label: "管理员密码", type: "password", max: 4096 },
    ],
  },
  redis: {
    description: "用于可重建缓存；未启用认证时，用户名和密码留空。",
    icon: <Zap size={17} />,
    fields: [
      { key: "host", label: "IP / 主机名", placeholder: "10.20.0.12" },
      { key: "port", label: "端口", type: "number", value: "6379" },
      { key: "username", label: "用户名（可选）", placeholder: "default" },
      { key: "password", label: "密码（可选）", type: "password", max: 4096 },
      { key: "database", label: "逻辑库编号", type: "number", value: "0" },
    ],
  },
  nats: {
    description: "调度消息队列，需要开启 JetStream。未启用认证时，Token 留空。",
    icon: <Network size={17} />,
    fields: [
      { key: "host", label: "IP / 主机名", placeholder: "10.20.0.12" },
      { key: "port", label: "端口", type: "number", value: "4222" },
      { key: "token", label: "认证 Token（可选，至少 16 位）", type: "password", max: 4096 },
    ],
  },
  minio: {
    description: "保存依赖、产物及归档包。填写 API 端口，通常是 9000；请先创建 Bucket。",
    icon: <Server size={17} />,
    fields: [
      { key: "host", label: "IP / 主机名", placeholder: "10.20.0.13" },
      { key: "port", label: "API 端口", type: "number", value: "9000" },
      { key: "accessKey", label: "Access Key", max: 1024 },
      { key: "secretKey", label: "Secret Key", type: "password", max: 4096 },
      { key: "bucket", label: "Bucket", value: "autoforge-objects", max: 63 },
      { key: "region", label: "Region", value: "us-east-1", max: 128 },
    ],
  },
};

export function PlatformInfrastructureFields({
  configured,
  onCheckingChange,
  usage = "initialization",
  disabled = false,
}: {
  usage?: "initialization" | "settings";
  disabled?: boolean;
  configured: boolean;
  checking: boolean;
  onCheckingChange: (pending: boolean) => void;
}) {
  return (
    <div className="grid min-w-0 gap-4 border-t border-border pt-4">
      <div className="grid gap-1">
        {usage === "initialization" ? (
          <Typography.Title level={5} className="!m-0">
            Full 基础设施
          </Typography.Title>
        ) : null}
        <Typography.Text type="secondary">
          直接填写连接信息；检查从平台所在主机发起，尚未保存的配置也可检查。
        </Typography.Text>
        {configured ? (
          <Typography.Text type="secondary">
            已有配置不会回显。整块留空可保留；修改某个组件时请完整填写该组件。
          </Typography.Text>
        ) : null}
      </div>
      <InfrastructureCard
        usage={usage}
        disabled={disabled}
        component="postgres"
        configured={configured}
        onCheckingChange={onCheckingChange}
      />
      {usage === "initialization" ? (
        <InfrastructureCard
          component="logs"
          configured={false}
          usage={usage}
          disabled={disabled}
          onCheckingChange={onCheckingChange}
        />
      ) : (
        <Card
          size="small"
          title={
            <span className="inline-flex items-center gap-2">
              <HardDrive size={17} />
              PostgreSQL 日志库
            </span>
          }
        >
          <div className="grid gap-2">
            <Typography.Text>
              Full 执行日志必须写入独立 PostgreSQL 日志服务器，不支持本地 SQLite 写入。
            </Typography.Text>
            <Typography.Text type="secondary">
              日志服务器的连接、检查与写入库切换在同一入口管理，修改实时生效，历史日志保持原路由。
            </Typography.Text>
            <Link href="/settings/platform?section=logs">管理日志数据库</Link>
          </div>
        </Card>
      )}
      <InfrastructureCard
        usage={usage}
        disabled={disabled}
        component="redis"
        configured={configured}
        onCheckingChange={onCheckingChange}
      />
      <InfrastructureCard
        usage={usage}
        disabled={disabled}
        component="nats"
        configured={configured}
        onCheckingChange={onCheckingChange}
      />
      <InfrastructureCard
        usage={usage}
        disabled={disabled}
        component="minio"
        configured={configured}
        onCheckingChange={onCheckingChange}
      />
    </div>
  );
}

function InfrastructureCard({
  component,
  configured,
  onCheckingChange,
  usage,
  disabled,
}: {
  usage: "initialization" | "settings";
  disabled: boolean;
  component: PlatformInfrastructureComponent;
  configured: boolean;
  onCheckingChange: (pending: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PlatformInfrastructureCheckResult>();
  const [error, setError] = useState("");
  const definition = definitions[component];

  async function check(button: HTMLButtonElement) {
    if (!button.form) return;
    setError("");
    setResult(undefined);
    const form = new FormData(button.form);
    let checkStarted = false;
    try {
      const bootstrapToken = String(form.get("bootstrapToken") ?? "");
      if (usage === "initialization" && bootstrapToken.length < 32)
        throw new Error("请先填写页面上方的平台配置引导令牌。");
      const target = infrastructureTargetFromForm(form, component);
      setPending(true);
      onCheckingChange(true);
      checkStarted = true;
      const response = await fetch(
        usage === "initialization"
          ? "/api/v1/auth/setup-platform/check"
          : "/api/v1/settings/platform/check",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(usage === "initialization" ? { bootstrapToken, target } : target),
          signal: AbortSignal.timeout(15000),
        },
      );
      const apiError = await readApiError(response, "连接检查失败。");
      if (apiError) throw apiError;
      setResult(platformInfrastructureCheckResultSchema.parse(await response.json()));
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== "TimeoutError"
          ? cause.message
          : "连接检查超时，请检查网络及目标服务。",
      );
    } finally {
      setPending(false);
      if (checkStarted) onCheckingChange(false);
    }
  }

  // Disabling card controls during a check prevents a stale success for edited credentials.
  return (
    <Card
      size="small"
      className="min-w-0"
      title={
        <span className="inline-flex items-center gap-2">
          {definition.icon}
          {infrastructureLabels[component]}
        </span>
      }
    >
      <div
        className="grid min-w-0 gap-3"
        data-component={component}
        onChangeCapture={() => {
          setResult(undefined);
          setError("");
        }}
      >
        <Typography.Text type="secondary">{definition.description}</Typography.Text>
        <fieldset
          disabled={pending || disabled}
          className="m-0 grid min-w-0 grid-cols-2 gap-3 border-0 p-0 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-2 [&_label]:text-xs [&_label]:font-medium max-[1121px]:grid-cols-1"
        >
          {definition.fields.map((field) => (
            <label key={field.key}>
              <span>{field.label}</span>
              <PlatformInitializationInput
                name={`${component}.${field.key}`}
                defaultValue={
                  configured
                    ? field.key === "port" || field.key === "database"
                      ? field.value
                      : undefined
                    : field.value
                }
                placeholder={
                  configured && !field.value ? "已配置，整块留空保留" : field.placeholder
                }
                maxLength={field.type === "number" ? 5 : (field.max ?? 255)}
                type={field.type === "password" ? "password" : "text"}
                inputMode={field.type === "number" ? "numeric" : "text"}
                {...(field.type === "number"
                  ? {
                      min: field.key === "database" ? 0 : 1,
                      max: field.key === "database" ? 15 : 65535,
                    }
                  : {})}
              />
            </label>
          ))}
          <label>
            <span>
              {component === "postgres" || component === "logs" ? "SSL 模式" : "加密连接"}
            </span>
            {component === "postgres" || component === "logs" ? (
              <Select
                name={`${component}.sslMode`}
                defaultValue="disable"
                disabled={pending || disabled}
              >
                <option value="disable">不启用 SSL</option>
                <option value="require">SSL 加密（不验证证书）</option>
                <option value="verify-full">SSL 加密并验证证书</option>
              </Select>
            ) : (
              <Select name={`${component}.tls`} defaultValue="false" disabled={pending || disabled}>
                <option value="false">不启用 TLS</option>
                <option value="true">启用 TLS</option>
              </Select>
            )}
          </label>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="neutral"
            disabled={pending || disabled}
            onClick={(event) => void check(event.currentTarget)}
            aria-label={`检查${infrastructureLabels[component]}连接`}
          >
            {pending ? "正在检查…" : "检查连接"}
          </Button>
          {result ? (
            <Tag color={result.ok ? "success" : "error"}>
              {result.ok ? "检查通过" : "检查未通过"}
            </Tag>
          ) : null}
          {pending ? <Typography.Text type="secondary">检查中，请稍候</Typography.Text> : null}
        </div>
        {result || error ? (
          <Alert
            type={error || !result?.ok ? "error" : "success"}
            title={error || result?.message}
            showIcon
          />
        ) : null}
      </div>
    </Card>
  );
}
