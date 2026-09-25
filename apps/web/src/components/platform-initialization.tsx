"use client";
import { Badge } from "@/components/ui/badge";

import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";

import {
  initializePlatformConfigurationInputSchema,
  type PlatformConfigurationView,
} from "@autoforge/contracts";
import { Boxes, Database, RotateCw, Server } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button, Input } from "@/components/ui";
import { platformInitializationValidationMessage } from "@/lib/platform-initialization-validation";
import { readApiError } from "@/lib/client-api";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";

export function PlatformInitialization({ initial }: { initial: PlatformConfigurationView }) {
  const showConcurrentModification = useConcurrentModificationFeedback();
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
            runnerBaseUrl: stringValue(form, "runnerBaseUrl") || null,
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
      const apiError = await readApiError(response, "首次平台配置失败。");
      if (apiError) {
        const validationMessage = platformInitializationValidationMessage(apiError.details);
        if (validationMessage) throw new Error(validationMessage);
        throw apiError;
      }
      setCompleted(true);
    } catch (cause) {
      if (await showConcurrentModification(cause)) {
        setPending(false);
        return;
      }
      setError(cause instanceof Error ? cause.message : "首次平台配置失败。");
      setPending(false);
    }
  }

  if (initial.configurationManaged) {
    return (
      <Notice
        tone="info"
        className={cn(
          "implementation-notice",
          platformInitializationStyles["implementation-notice"],
        )}
        role="status"
      >
        分布式平台已由部署文件配置。请在右侧创建首位管理员，随后在“平台节点”中填写节点 IP 和端口。
      </Notice>
    );
  }

  return (
    <section
      className={cn("setup-card setup-runtime-card", platformInitializationStyles["setup-card"])}
      aria-labelledby="platform-setup-title"
    >
      <div className={cn("setup-card-heading", platformInitializationStyles["setup-card-heading"])}>
        <span
          className={cn("setup-step-number", platformInitializationStyles["setup-step-number"])}
        >
          01
        </span>
        <span
          className={cn(
            "setup-heading-icon setup-heading-icon-blue",
            platformInitializationStyles["setup-heading-icon"],
            platformInitializationStyles["setup-heading-icon-blue"],
          )}
          aria-hidden="true"
        >
          <Database size={20} />
        </span>
        <div>
          <span className={cn("setup-kicker", platformInitializationStyles["setup-kicker"])}>
            运行环境
          </span>
          <h2 id="platform-setup-title">配置部署模式</h2>
          <p>Lite 开箱即用；需要集群能力时再接入 Full 基础设施。</p>
        </div>
        <Badge
          className={cn(
            "setup-optional-badge",
            platformInitializationStyles["setup-optional-badge"],
          )}
        >
          可选
        </Badge>
      </div>
      {completed ? (
        <Notice
          tone="success"
          className={cn(
            "inline-success setup-restart-message",
            platformInitializationStyles["inline-success"],
            platformInitializationStyles["setup-restart-message"],
          )}
          role="status"
        >
          <RotateCw size={18} />{" "}
          配置已安全写入。请重启主平台；重启后仍使用同一个一次性令牌创建管理员。
        </Notice>
      ) : (
        <form
          className={cn("setup-form", platformInitializationStyles["setup-form"])}
          noValidate
          onSubmit={submit}
        >
          <fieldset
            className={cn(
              "setup-mode-fieldset",
              platformInitializationStyles["setup-mode-fieldset"],
            )}
          >
            <legend>部署模式</legend>
            <div className={cn("setup-mode-grid", platformInitializationStyles["setup-mode-grid"])}>
              <Button
                aria-pressed={mode === "lite"}
                className={"setup-mode-option"}
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
                className={"setup-mode-option"}
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
          <div className={cn("setup-field-grid", platformInitializationStyles["setup-field-grid"])}>
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
              <span>外部访问地址</span>
              <Input
                defaultValue={initial.web.publicBaseUrl ?? ""}
                name="publicBaseUrl"
                placeholder="https://autoforge.example.com"
                type="url"
              />
              <small>用于分享、导出和 Jenkins 链接；面向用户访问时建议使用 HTTPS。</small>
            </label>
            <label>
              <span>内部访问地址（Runner）</span>
              <Input
                defaultValue={initial.web.runnerBaseUrl ?? ""}
                name="runnerBaseUrl"
                placeholder="http://10.20.30.10:3000"
                type="url"
              />
              <small>Agent 安装使用此地址；留空时回退到外部访问地址。</small>
            </label>
          </div>
          {mode === "full" ? (
            <FullInfrastructureFields configured={initial.fullConfigured} />
          ) : null}
          <Button disabled={pending} size="large" type="submit" variant="secondary">
            {pending ? "正在保存…" : "保存平台配置"}
          </Button>
          {error ? (
            <Notice
              tone="error"
              className={cn("setup-form-error", platformInitializationStyles["setup-form-error"])}
              role="alert"
            >
              {error}
            </Notice>
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
    <div className={cn("setup-full-fields", platformInitializationStyles["setup-full-fields"])}>
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
        NATS Token（可选）
        <Input name="natsToken" type="password" autoComplete="off" />
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
    "natsToken",
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

const platformInitializationStyles = {
  "implementation-notice":
    "mt-4 rounded-lg bg-warning/10 text-warning py-[11px] px-3 text-xs leading-[1.5]",
  "inline-success":
    "py-3 px-3.5 border border-solid border-border rounded-lg text-success bg-success/10",
  "setup-card":
    "grid gap-5.5 mb-4 border border-solid border-border rounded-xl [padding:clamp(20px,_2.4vw,_28px)] bg-card shadow-xs",
  "setup-card-heading":
    "grid grid-cols-[30px_42px_minmax(0,_1fr)_auto] items-start gap-3 [&_h2]:[margin:3px_0_5px] [&_h2]:text-lg [&_h2]:tracking-tight [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:leading-[1.55] [&_code]:text-info [&_code]:text-xs",
  "setup-field-grid": "grid gap-3.5 grid-cols-2 max-[1121px]:grid-cols-[1fr]",
  "setup-form":
    "grid gap-3.5 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-[7px] [&_label]:text-foreground [&_label]:text-xs [&_label]:font-semibold [&_label_small]:text-muted-foreground [&_label_small]:text-xs [&_label_small]:font-medium [&_label_small]:leading-[1.45] [&_>_.ui-button]:w-fit",
  "setup-form-error":
    "m-0 border border-solid border-border rounded-lg py-[11px] px-[13px] bg-destructive/10 text-destructive text-xs leading-[1.5]",
  "setup-full-fields":
    "grid gap-3.5 grid-cols-2 border-t border-solid border-border pt-4 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-[7px] [&_label]:text-foreground [&_label]:text-xs [&_label]:font-semibold max-[1121px]:grid-cols-[1fr]",
  "setup-heading-icon": "grid w-10 h-10 place-items-center rounded-lg",
  "setup-heading-icon-blue": "bg-info/10 text-info",
  "setup-kicker":
    "text-muted-foreground text-xs font-semibold tracking-normal [text-transform:uppercase]",
  "setup-mode-fieldset":
    "min-w-0 m-0 border-0 p-0 [&_legend]:mb-2 [&_legend]:text-muted-foreground [&_legend]:text-xs [&_legend]:font-semibold",
  "setup-mode-grid": "grid grid-cols-2 gap-2.5",
  "setup-optional-badge":
    "rounded-full py-[5px] px-2 text-xs font-semibold bg-muted text-muted-foreground",
  "setup-restart-message": "flex items-start gap-[9px] leading-[1.6]",
  "setup-step-number": "pt-1 text-muted-foreground font-mono text-xs font-semibold",
} as const;
