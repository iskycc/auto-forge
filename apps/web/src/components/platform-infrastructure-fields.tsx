"use client";

import { useState, type ReactNode } from "react";
import { Alert, Card, Tag, Typography } from "antd";
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
  checking,
  onCheckingChange,
}: {
  configured: boolean;
  checking: boolean;
  onCheckingChange: (pending: boolean) => void;
}) {
  const [logsEnabled, setLogsEnabled] = useState(!configured);
  return (
    <div className="grid min-w-0 gap-4 border-t border-border pt-4">
      <div className="grid gap-1">
        <Typography.Title level={5} className="!m-0">
          Full 基础设施
        </Typography.Title>
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
        component="postgres"
        configured={configured}
        onCheckingChange={onCheckingChange}
      />
      <div className="grid gap-3">
        <label>
          <span>日志存储</span>
          <Select
            name="logs.enabled"
            disabled={checking}
            value={String(logsEnabled)}
            onChange={(event) => setLogsEnabled(event.target.value === "true")}
          >
            <option value="true">独立 PostgreSQL 日志服务（推荐）</option>
            <option value="false">{configured ? "保留现有日志存储配置" : "本地日志存储"}</option>
          </Select>
        </label>
        {logsEnabled ? (
          <InfrastructureCard
            component="logs"
            configured={false}
            onCheckingChange={onCheckingChange}
          />
        ) : (
          <Alert
            type="info"
            title={
              configured
                ? "现有日志库配置保持不变。"
                : "日志暂存平台数据目录，可在平台设置 → 日志数据库中接入独立日志服务器。"
            }
            showIcon
          />
        )}
      </div>
      <InfrastructureCard
        component="redis"
        configured={configured}
        onCheckingChange={onCheckingChange}
      />
      <InfrastructureCard
        component="nats"
        configured={configured}
        onCheckingChange={onCheckingChange}
      />
      <InfrastructureCard
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
}: {
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
      if (bootstrapToken.length < 32) throw new Error("请先填写页面上方的平台配置引导令牌。");
      const target = infrastructureTargetFromForm(form, component);
      setPending(true);
      onCheckingChange(true);
      checkStarted = true;
      const response = await fetch("/api/v1/auth/setup-platform/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bootstrapToken, target }),
        signal: AbortSignal.timeout(15000),
      });
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
          disabled={pending}
          className="m-0 grid min-w-0 grid-cols-2 gap-3 border-0 p-0 max-[1121px]:grid-cols-1"
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
              <Select name={`${component}.sslMode`} defaultValue="disable" disabled={pending}>
                <option value="disable">不启用 SSL</option>
                <option value="require">SSL 加密（不验证证书）</option>
                <option value="verify-full">SSL 加密并验证证书</option>
              </Select>
            ) : (
              <Select name={`${component}.tls`} defaultValue="false" disabled={pending}>
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
            disabled={pending}
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
