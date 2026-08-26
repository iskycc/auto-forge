"use client";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import { DEFAULT_WEBHOOK_BODY_TEMPLATE, WEBHOOK_BODY_VARIABLES } from "@autoforge/contracts";
import type {
  WebhookConfiguration,
  WebhookDelivery,
  WebhookRequestMethod,
} from "@autoforge/domain";
import {
  Activity,
  CheckCircle2,
  Clock3,
  Code2,
  LoaderCircle,
  Pencil,
  Plus,
  Send,
  Trash2,
  Webhook,
} from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { ActionDialog } from "./action-dialog";
import { Button, Input, Select, Textarea } from "./ui";

type EditorState = {
  id?: string;
  name: string;
  description: string;
  targetUrl: string;
  method: WebhookRequestMethod;
  bodyTemplate: string;
  enabled: boolean;
  revision?: number;
};

const EMPTY_EDITOR: EditorState = {
  name: "",
  description: "",
  targetUrl: "",
  method: "POST",
  bodyTemplate: DEFAULT_WEBHOOK_BODY_TEMPLATE,
  enabled: true,
};

export function WebhookSettings({
  projectId,
  initialConfigurations,
  initialDeliveries,
  canManage,
}: {
  projectId: string;
  initialConfigurations: WebhookConfiguration[];
  initialDeliveries: WebhookDelivery[];
  canManage: boolean;
}) {
  const [configurations, setConfigurations] = useState(initialConfigurations);
  const [deliveries] = useState(initialDeliveries);
  const [editor, setEditor] = useState<EditorState>();
  const [deleting, setDeleting] = useState<WebhookConfiguration>();
  const [pending, setPending] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [error, setError] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const enabledCount = configurations.filter((item) => item.enabled).length;
  const successfulCount = deliveries.filter((item) => item.status === "succeeded").length;
  const problemCount = deliveries.filter((item) => item.status === "failed").length;

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor) return;
    setPending(true);
    setError("");
    try {
      const payload = {
        name: editor.name,
        description: editor.description,
        targetUrl: editor.targetUrl,
        method: editor.method,
        ...(editor.method === "POST" ? { bodyTemplate: editor.bodyTemplate } : {}),
        enabled: editor.enabled,
      };
      const configuration = editor.id
        ? await requestJson<WebhookConfiguration>(
            `/api/v1/webhooks/${encodeURIComponent(editor.id)}`,
            {
              method: "PATCH",
              body: { ...payload, expectedRevision: editor.revision },
            },
          )
        : await requestJson<WebhookConfiguration>("/api/v1/webhooks", {
            method: "POST",
            body: { ...payload, projectId },
          });
      setConfigurations((current) =>
        [...current.filter((item) => item.id !== configuration.id), configuration].sort((a, b) =>
          a.name.localeCompare(b.name, "zh-CN"),
        ),
      );
      setEditor(undefined);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "保存 Webhook 失败。");
    } finally {
      setPending(false);
    }
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setPending(true);
    setError("");
    try {
      await requestJson(`/api/v1/webhooks/${encodeURIComponent(deleting.id)}`, {
        method: "DELETE",
      });
      setConfigurations((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(undefined);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "删除 Webhook 失败。");
    } finally {
      setPending(false);
    }
  }

  async function test(configuration: WebhookConfiguration): Promise<void> {
    setTestingId(configuration.id);
    setError("");
    setTestMessage("");
    try {
      const result = await requestJson<{
        statusCode: number;
        method: WebhookRequestMethod;
        presetPassRate: number;
      }>(`/api/v1/webhooks/${encodeURIComponent(configuration.id)}/test`, { method: "POST" });
      setTestMessage(
        `「${configuration.name}」测试成功：${result.method} · HTTP ${result.statusCode} · 预置通过率 ${result.presetPassRate}%。`,
      );
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Webhook 测试失败。");
    } finally {
      setTestingId("");
    }
  }

  function insertVariable(variable: string): void {
    if (!editor) return;
    const textarea = bodyRef.current;
    const token = `{{${variable}}}`;
    const start = textarea?.selectionStart ?? editor.bodyTemplate.length;
    const end = textarea?.selectionEnd ?? start;
    setEditor({
      ...editor,
      bodyTemplate: `${editor.bodyTemplate.slice(0, start)}${token}${editor.bodyTemplate.slice(end)}`,
    });
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="webhook-settings-stack">
      <section className="webhook-metric-grid" aria-label="Webhook 概览">
        <Metric icon={<Webhook size={18} />} label="已配置" value={configurations.length} />
        <Metric icon={<Activity size={18} />} label="启用中" value={enabledCount} tone="blue" />
        <Metric
          icon={<CheckCircle2 size={18} />}
          label="近期送达"
          value={successfulCount}
          tone="green"
        />
        <Metric icon={<Clock3 size={18} />} label="需关注" value={problemCount} tone="orange" />
      </section>

      <section className="card webhook-configurations-card">
        <div className="section-title-row webhook-section-title">
          <div>
            <span className="eyebrow">ENDPOINTS</span>
            <h2>通知端点</h2>
            <p>配置可复用于同一项目的多个任务；只有绑定后的新完成批次才会通知。</p>
          </div>
          {canManage ? (
            <Button onClick={() => setEditor({ ...EMPTY_EDITOR })} type="button" variant="primary">
              <Plus size={16} /> 新建 Webhook
            </Button>
          ) : null}
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {testMessage ? <p className="inline-success">{testMessage}</p> : null}
        {configurations.length === 0 ? (
          <div className="empty-state table-empty webhook-empty-state">
            <span className="empty-icon">
              <Webhook size={25} />
            </span>
            <strong>尚未配置通知端点</strong>
            <p>创建 GET 或 POST Webhook，然后前往任务详情绑定。</p>
          </div>
        ) : (
          <div className="webhook-card-grid">
            {configurations.map((configuration) => (
              <article className="webhook-endpoint-card" key={configuration.id}>
                <div className="webhook-endpoint-heading">
                  <span
                    className={`webhook-method webhook-method-${configuration.method.toLowerCase()}`}
                  >
                    {configuration.method}
                  </span>
                  <span
                    className={`webhook-state ${configuration.enabled ? "enabled" : "disabled"}`}
                  >
                    <i aria-hidden="true" />
                    {configuration.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
                <div>
                  <h3>{configuration.name}</h3>
                  <p>{configuration.description || "任务完成后发送批次状态与用例结果统计。"}</p>
                </div>
                <code title={configuration.targetUrl}>{configuration.targetUrl}</code>
                {canManage ? (
                  <div className="webhook-card-actions">
                    <Button
                      disabled={Boolean(testingId)}
                      onClick={() => void test(configuration)}
                      size="compact"
                      type="button"
                      variant="secondary"
                    >
                      {testingId === configuration.id ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Send size={14} />
                      )}
                      测试
                    </Button>
                    <Button
                      onClick={() => setEditor(toEditor(configuration))}
                      size="compact"
                      type="button"
                    >
                      <Pencil size={14} /> 编辑
                    </Button>
                    <Button
                      onClick={() => setDeleting(configuration)}
                      size="compact"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 size={14} /> 删除
                    </Button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="card webhook-deliveries-card">
        <div className="section-title-row webhook-section-title">
          <div>
            <span className="eyebrow">DELIVERIES</span>
            <h2>最近投递</h2>
            <p>保留响应码、尝试次数和最后错误，便于快速定位接收端问题。</p>
          </div>
          <span className="table-count">最近 {deliveries.length} 条</span>
        </div>
        {deliveries.length === 0 ? (
          <div className="empty-state table-empty">
            <span className="empty-icon">
              <Send size={24} />
            </span>
            <strong>暂无投递记录</strong>
            <p>任务绑定 Webhook 并执行完成后，投递结果会显示在这里。</p>
          </div>
        ) : (
          <div className="webhook-delivery-table-wrap">
            <table className="data-table webhook-delivery-table">
              <thead>
                <tr>
                  <th>端点 / 任务</th>
                  <th>状态</th>
                  <th>响应</th>
                  <th>尝试</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <DeliveryRow delivery={delivery} key={delivery.id} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ActionDialog
        className="webhook-editor-dialog"
        description="通知失败不影响任务执行结果；系统会自动进行有限重试。"
        onClose={() => !pending && setEditor(undefined)}
        open={Boolean(editor)}
        title={editor?.id ? "编辑 Webhook" : "新建 Webhook"}
      >
        {editor ? (
          <form
            className="action-dialog-form webhook-editor-form"
            onSubmit={(event) => void save(event)}
          >
            <div className="webhook-editor-grid">
              <label className="field-stack">
                <span>名称</span>
                <Input
                  maxLength={120}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  required
                  value={editor.name}
                />
              </label>
              <label className="field-stack">
                <span>请求方式</span>
                <Select
                  aria-label="请求方式"
                  onChange={(event) =>
                    setEditor({ ...editor, method: event.target.value as WebhookRequestMethod })
                  }
                  value={editor.method}
                >
                  <option value="POST">POST · JSON 请求体</option>
                  <option value="GET">GET · 查询参数</option>
                </Select>
              </label>
              <label className="field-stack webhook-editor-wide">
                <span>目标地址</span>
                <Input
                  maxLength={2048}
                  onChange={(event) => setEditor({ ...editor, targetUrl: event.target.value })}
                  placeholder="https://internal.example/hooks/autoforge"
                  required
                  type="url"
                  value={editor.targetUrl}
                />
              </label>
              <label className="field-stack webhook-editor-wide">
                <span>说明</span>
                <Input
                  maxLength={500}
                  onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                  placeholder="例如：推送到质量告警群"
                  value={editor.description}
                />
              </label>
            </div>
            {editor.method === "POST" ? (
              <div className="webhook-template-editor">
                <div className="webhook-template-heading">
                  <span>
                    <Code2 size={15} /> JSON 请求体模板
                  </span>
                  <small>点击变量插入到光标位置</small>
                </div>
                <div className="webhook-variable-list">
                  {WEBHOOK_BODY_VARIABLES.map((variable) => (
                    <Button
                      className="webhook-variable-token"
                      key={variable}
                      onClick={() => insertVariable(variable)}
                      size="compact"
                      type="button"
                      variant="ghost"
                    >{`{{${variable}}}`}</Button>
                  ))}
                </div>
                <Textarea
                  ref={bodyRef}
                  aria-label="JSON 请求体模板"
                  onChange={(event) => setEditor({ ...editor, bodyTemplate: event.target.value })}
                  rows={12}
                  spellCheck={false}
                  value={editor.bodyTemplate}
                />
              </div>
            ) : (
              <div className="webhook-get-preview">
                <strong>GET 查询参数</strong>
                <p>系统会自动附加 event、batchId、suiteId、status 与 completedAt，不发送请求体。</p>
              </div>
            )}
            <label className="webhook-enabled-field">
              <Input
                checked={editor.enabled}
                onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })}
                type="checkbox"
              />
              <span>
                <strong>启用此端点</strong>
                <small>停用后不会为新完成批次创建通知。</small>
              </span>
            </label>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="webhook-editor-actions">
              <Button disabled={pending} onClick={() => setEditor(undefined)} type="button">
                取消
              </Button>
              <Button disabled={pending} type="submit" variant="primary">
                {pending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                {editor.id ? "保存修改" : "创建端点"}
              </Button>
            </div>
          </form>
        ) : null}
      </ActionDialog>

      <ActionDialog
        description="端点会从所有任务解绑，历史投递记录仍保留。"
        onClose={() => !pending && setDeleting(undefined)}
        open={Boolean(deleting)}
        title="删除 Webhook"
      >
        <div className="action-dialog-form">
          <p>确定删除「{deleting?.name}」？此操作不可恢复。</p>
          <div className="webhook-editor-actions">
            <Button disabled={pending} onClick={() => setDeleting(undefined)} type="button">
              取消
            </Button>
            <Button disabled={pending} onClick={() => void remove()} type="button" variant="danger">
              {pending ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}删除
            </Button>
          </div>
        </div>
      </ActionDialog>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <article className={`webhook-metric webhook-metric-${tone}`}>
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </article>
  );
}

function DeliveryRow({ delivery }: { delivery: WebhookDelivery }) {
  const labels = {
    pending: "等待重试",
    delivering: "发送中",
    succeeded: "已送达",
    failed: "投递失败",
  } as const;
  return (
    <tr>
      <td>
        <strong>{delivery.webhookName}</strong>
        <small title={delivery.suiteName}>{delivery.suiteName}</small>
      </td>
      <td>
        <span className={`webhook-delivery-status ${delivery.status}`}>
          {labels[delivery.status]}
        </span>
      </td>
      <td>
        {delivery.responseStatus ?? "—"}
        {delivery.errorMessage ? (
          <small title={delivery.errorMessage}>{delivery.errorMessage}</small>
        ) : null}
      </td>
      <td>{delivery.attempts} 次</td>
      <td>{formatPlatformDateTime(delivery.updatedAt)}</td>
    </tr>
  );
}

function toEditor(configuration: WebhookConfiguration): EditorState {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    targetUrl: configuration.targetUrl,
    method: configuration.method,
    bodyTemplate: configuration.bodyTemplate ?? DEFAULT_WEBHOOK_BODY_TEMPLATE,
    enabled: configuration.enabled,
    revision: configuration.revision,
  };
}

async function requestJson<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as T | { error?: { message?: string } };
  if (!response.ok)
    throw new Error(
      "error" in (payload as object)
        ? ((payload as { error?: { message?: string } }).error?.message ?? "请求失败。")
        : "请求失败。",
    );
  return payload as T;
}
