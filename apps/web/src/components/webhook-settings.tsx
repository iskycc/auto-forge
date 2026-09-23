"use client";
import { EmptyState } from "@/components/ui/empty-state";

import { Notice } from "@/components/ui/notice";

import { Disclosure } from "@/components/ui/disclosure";

import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

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
import { useConcurrentModificationFeedback } from "./concurrent-modification-feedback";
import { Button, Input, Select, Textarea } from "./ui";
import { useToast } from "./ui-feedback";
import { throwApiErrorResponse } from "@/lib/client-api";

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
  deliveryFilter,
}: {
  projectId: string;
  initialConfigurations: WebhookConfiguration[];
  initialDeliveries: WebhookDelivery[];
  canManage: boolean;
  deliveryFilter?: { status: string; webhookId: string };
}) {
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [configurations, setConfigurations] = useState(initialConfigurations);
  const [deliveries] = useState(initialDeliveries);
  const [templatePreview, setTemplatePreview] = useState("");
  const [editor, setEditor] = useState<EditorState>();
  const [deleting, setDeleting] = useState<WebhookConfiguration>();
  const [pending, setPending] = useState(false);
  const [testingId, setTestingId] = useState("");
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
      toast.success(editor.id ? "Webhook 配置已保存。" : "Webhook 已创建。");
    } catch (problem) {
      if (await showConcurrentModification(problem)) return;
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
      toast.success("Webhook 已删除。");
    } catch (problem) {
      if (await showConcurrentModification(problem)) return;
      setError(problem instanceof Error ? problem.message : "删除 Webhook 失败。");
    } finally {
      setPending(false);
    }
  }

  async function test(configuration: WebhookConfiguration): Promise<void> {
    setTestingId(configuration.id);
    setError("");
    try {
      const result = await requestJson<{
        statusCode: number;
        method: WebhookRequestMethod;
        presetPassRate: number;
      }>(`/api/v1/webhooks/${encodeURIComponent(configuration.id)}/test`, { method: "POST" });
      toast.success(
        `「${configuration.name}」测试成功：${result.method} · HTTP ${result.statusCode} · 预置通过率 ${result.presetPassRate}%。`,
        { title: "Webhook 连通性正常" },
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
    <div className={cn("webhook-settings-stack", webhookSettingsStyles["webhook-settings-stack"])}>
      <section
        className={cn("webhook-metric-grid", webhookSettingsStyles["webhook-metric-grid"])}
        aria-label="Webhook 概览"
      >
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

      <Card
        as="section"
        className={cn(
          "card webhook-configurations-card",
          uiPatterns["card"],
          webhookSettingsStyles["webhook-configurations-card"],
        )}
      >
        <div
          className={cn(
            "section-title-row webhook-section-title",
            uiPatterns["section-title-row"],
            webhookSettingsStyles["webhook-section-title"],
          )}
        >
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>ENDPOINTS</span>
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
          <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
            {error}
          </Notice>
        ) : null}
        {configurations.length === 0 ? (
          <EmptyState
            className={cn(
              "empty-state table-empty webhook-empty-state",
              uiPatterns["empty-state"],
              uiPatterns["table-empty"],
              webhookSettingsStyles["webhook-empty-state"],
            )}
          >
            <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
              <Webhook size={25} />
            </span>
            <strong>尚未配置通知端点</strong>
            <p>创建 GET 或 POST Webhook，然后前往任务详情绑定。</p>
            {canManage ? (
              <Button
                type="button"
                variant="primary"
                onClick={() => setEditor({ ...EMPTY_EDITOR })}
              >
                创建第一个 Webhook
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <div className={cn("webhook-card-grid", webhookSettingsStyles["webhook-card-grid"])}>
            {configurations.map((configuration) => (
              <article
                className={cn(
                  "webhook-endpoint-card",
                  webhookSettingsStyles["webhook-endpoint-card"],
                )}
                key={configuration.id}
              >
                <div
                  className={cn(
                    "webhook-endpoint-heading",
                    webhookSettingsStyles["webhook-endpoint-heading"],
                  )}
                >
                  <span
                    className={cn(
                      webhookSettingsStyles["webhook-method"],
                      `webhook-method webhook-method webhook-method-${configuration.method.toLowerCase()}`,
                    )}
                  >
                    {configuration.method}
                  </span>
                  <span
                    className={cn(
                      webhookSettingsStyles["webhook-state"],
                      `webhook-state ${configuration.enabled ? "enabled" : "disabled"}`,
                    )}
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
                  <div
                    className={cn(
                      "webhook-card-actions",
                      webhookSettingsStyles["webhook-card-actions"],
                    )}
                  >
                    <Button
                      disabled={Boolean(testingId)}
                      onClick={() => void test(configuration)}
                      size="compact"
                      type="button"
                      variant="secondary"
                    >
                      {testingId === configuration.id ? (
                        <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={14} />
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
      </Card>

      <Card
        as="section"
        className={cn(
          "card webhook-deliveries-card",
          uiPatterns["card"],
          webhookSettingsStyles["webhook-deliveries-card"],
        )}
      >
        <div
          className={cn(
            "section-title-row webhook-section-title",
            uiPatterns["section-title-row"],
            webhookSettingsStyles["webhook-section-title"],
          )}
        >
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>DELIVERIES</span>
            <h2>最近投递</h2>
            <p>保留响应码、尝试次数和最后错误，便于快速定位接收端问题。</p>
          </div>
          <span className={cn("table-count", webhookSettingsStyles["table-count"])}>
            本页 {deliveries.length} 条
          </span>
        </div>
        <form className={cn("management-toolbar", uiPatterns["management-toolbar"])} method="get">
          <Select
            name="webhookId"
            aria-label="投递端点"
            defaultValue={deliveryFilter?.webhookId ?? ""}
          >
            <option value="">全部端点</option>
            {configurations.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          <Select name="status" aria-label="投递状态" defaultValue={deliveryFilter?.status ?? ""}>
            <option value="">全部状态</option>
            <option value="pending">等待投递</option>
            <option value="delivering">投递中</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
          </Select>
          <Button type="submit">筛选投递</Button>
        </form>
        {deliveries.length === 0 ? (
          <EmptyState
            className={cn(
              "empty-state table-empty webhook-delivery-empty",
              uiPatterns["empty-state"],
              uiPatterns["table-empty"],
              webhookSettingsStyles["webhook-delivery-empty"],
            )}
          >
            <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
              <Send size={24} />
            </span>
            <strong>暂无投递记录</strong>
            <p>任务绑定 Webhook 并执行完成后，投递结果会显示在这里。</p>
          </EmptyState>
        ) : (
          <div
            className={cn(
              "webhook-delivery-table-wrap",
              webhookSettingsStyles["webhook-delivery-table-wrap"],
            )}
          >
            <Table
              className={cn(
                "data-table webhook-delivery-table",
                uiPatterns["data-table"],
                webhookSettingsStyles["webhook-delivery-table"],
              )}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>端点 / 任务</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>响应</TableHead>
                  <TableHead>尝试</TableHead>
                  <TableHead>更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((delivery) => (
                  <DeliveryRow delivery={delivery} key={delivery.id} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <ActionDialog
        protectUnsavedChanges
        className={cn("webhook-editor-dialog", webhookSettingsStyles["webhook-editor-dialog"])}
        description="通知失败不影响任务执行结果；系统会自动进行有限重试。"
        onClose={() => !pending && setEditor(undefined)}
        open={Boolean(editor)}
        title={editor?.id ? "编辑 Webhook" : "新建 Webhook"}
      >
        {editor ? (
          <form
            className={cn(
              "action-dialog-form webhook-editor-form",
              webhookSettingsStyles["action-dialog-form"],
              webhookSettingsStyles["webhook-editor-form"],
            )}
            onSubmit={(event) => void save(event)}
          >
            <div
              className={cn("webhook-editor-grid", webhookSettingsStyles["webhook-editor-grid"])}
            >
              <label className={cn("field-stack", uiPatterns["field-stack"])}>
                <span>名称</span>
                <Input
                  maxLength={120}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  required
                  value={editor.name}
                />
              </label>
              <label className={cn("field-stack", uiPatterns["field-stack"])}>
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
              <label
                className={cn(
                  "field-stack webhook-editor-wide",
                  uiPatterns["field-stack"],
                  webhookSettingsStyles["webhook-editor-wide"],
                )}
              >
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
              <label
                className={cn(
                  "field-stack webhook-editor-wide",
                  uiPatterns["field-stack"],
                  webhookSettingsStyles["webhook-editor-wide"],
                )}
              >
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
              <div
                className={cn(
                  "webhook-template-editor",
                  webhookSettingsStyles["webhook-template-editor"],
                )}
              >
                <div
                  className={cn(
                    "webhook-template-heading",
                    webhookSettingsStyles["webhook-template-heading"],
                  )}
                >
                  <span>
                    <Code2 size={15} /> JSON 请求体模板
                  </span>
                  <small>点击变量插入到光标位置</small>
                </div>
                <Disclosure header={<>插入模板变量</>}>
                  <div
                    className={cn(
                      "webhook-variable-list",
                      webhookSettingsStyles["webhook-variable-list"],
                    )}
                  >
                    {WEBHOOK_BODY_VARIABLES.map((variable) => (
                      <Button
                        className={"webhook-variable-token"}
                        key={variable}
                        onClick={() => insertVariable(variable)}
                        size="compact"
                        type="button"
                        variant="ghost"
                      >{`{{${variable}}}`}</Button>
                    ))}
                  </div>
                </Disclosure>
                <Textarea
                  ref={bodyRef}
                  aria-label="JSON 请求体模板"
                  onChange={(event) => {
                    setTemplatePreview("");
                    setEditor({ ...editor, bodyTemplate: event.target.value });
                  }}
                  rows={12}
                  spellCheck={false}
                  value={editor.bodyTemplate}
                />
                <Button
                  type="button"
                  onClick={() => {
                    try {
                      setTemplatePreview(
                        JSON.stringify(
                          JSON.parse(
                            editor.bodyTemplate.replace(
                              /\{\{([^{}]+)\}\}/gu,
                              (_, variable: string) => {
                                if (
                                  !(WEBHOOK_BODY_VARIABLES as readonly string[]).includes(variable)
                                )
                                  throw new Error(`不支持的变量：${variable}`);
                                return variable === "batch.suiteName"
                                  ? "示例回归任务"
                                  : variable === "batch.status"
                                    ? "succeeded"
                                    : variable.startsWith("summary.")
                                      ? "1"
                                      : `示例 ${variable}`;
                              },
                            ),
                          ),
                          null,
                          2,
                        ),
                      );
                    } catch (cause) {
                      setTemplatePreview(
                        `模板格式错误：${cause instanceof Error ? cause.message : "请检查 JSON"}`,
                      );
                    }
                  }}
                >
                  预览模板（不发送）
                </Button>
                {templatePreview ? (
                  <pre
                    className={cn(
                      "webhook-template-preview",
                      webhookSettingsStyles["webhook-template-preview"],
                    )}
                  >
                    {templatePreview}
                  </pre>
                ) : null}
              </div>
            ) : (
              <div
                className={cn("webhook-get-preview", webhookSettingsStyles["webhook-get-preview"])}
              >
                <strong>GET 查询参数</strong>
                <p>系统会自动附加 event、batchId、suiteId、status 与 completedAt，不发送请求体。</p>
              </div>
            )}
            <label
              className={cn(
                "webhook-enabled-field",
                webhookSettingsStyles["webhook-enabled-field"],
              )}
            >
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
              <Notice
                tone="error"
                className={cn("form-error", uiPatterns["form-error"])}
                role="alert"
              >
                {error}
              </Notice>
            ) : null}
            <div
              className={cn(
                "webhook-editor-actions management-sticky-actions",
                webhookSettingsStyles["webhook-editor-actions"],
                webhookSettingsStyles["management-sticky-actions"],
              )}
            >
              <Button
                data-dialog-dismiss
                disabled={pending}
                onClick={() => setEditor(undefined)}
                type="button"
              >
                取消
              </Button>
              <Button disabled={pending} type="submit" variant="primary">
                {pending ? (
                  <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />
                ) : (
                  <Send size={16} />
                )}
                {editor.id ? "保存修改" : "创建端点"}
              </Button>
            </div>
          </form>
        ) : null}
      </ActionDialog>

      <ActionDialog
        protectUnsavedChanges
        description="端点会从所有任务解绑，历史投递记录仍保留。"
        onClose={() => !pending && setDeleting(undefined)}
        open={Boolean(deleting)}
        title="删除 Webhook"
      >
        <div className={cn("action-dialog-form", webhookSettingsStyles["action-dialog-form"])}>
          <p>确定删除「{deleting?.name}」？此操作不可恢复。</p>
          <div
            className={cn(
              "webhook-editor-actions management-sticky-actions",
              webhookSettingsStyles["webhook-editor-actions"],
              webhookSettingsStyles["management-sticky-actions"],
            )}
          >
            <Button disabled={pending} onClick={() => setDeleting(undefined)} type="button">
              取消
            </Button>
            <Button disabled={pending} onClick={() => void remove()} type="button" variant="danger">
              {pending ? (
                <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />
              ) : (
                <Trash2 size={16} />
              )}
              删除
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
    <article
      className={cn(
        webhookSettingsStyles["webhook-metric"],
        `webhook-metric webhook-metric webhook-metric-${tone}`,
      )}
    >
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
    <TableRow>
      <TableCell>
        <strong>{delivery.webhookName}</strong>
        <small title={delivery.suiteName}>{delivery.suiteName}</small>
      </TableCell>
      <TableCell>
        <span
          className={cn(
            webhookSettingsStyles["webhook-delivery-status"],
            `webhook-delivery-status ${delivery.status}`,
          )}
        >
          {labels[delivery.status]}
        </span>
      </TableCell>
      <TableCell>
        {delivery.responseStatus ?? "—"}
        {delivery.errorMessage ? (
          <small title={delivery.errorMessage}>{delivery.errorMessage}</small>
        ) : null}
      </TableCell>
      <TableCell>{delivery.attempts} 次</TableCell>
      <TableCell>{formatPlatformDateTime(delivery.updatedAt)}</TableCell>
    </TableRow>
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
  if (!response.ok) await throwApiErrorResponse(response, "请求失败。");
  return (await response.json()) as T;
}

const webhookSettingsStyles = {
  "action-dialog-form": "mt-0",
  "management-sticky-actions":
    "sticky bottom-0 z-3 flex items-center justify-end gap-3 p-3 bg-card border-t border-solid border-border [&_>_span]:mr-auto",
  "table-count": "text-muted-foreground text-xs whitespace-nowrap",
  "webhook-card-actions": "flex items-center justify-end gap-2.5",
  "webhook-card-grid": "grid grid-cols-2 gap-3 mt-[17px] max-[1181px]:grid-cols-[1fr]",
  "webhook-configurations-card": "p-5",
  "webhook-deliveries-card": "p-5",
  "webhook-delivery-empty": "min-h-0 p-5 gap-2 [&_.empty-icon]:hidden",
  "webhook-delivery-status":
    "text-xs font-semibold [&.succeeded]:text-success [&.failed]:text-destructive [&.pending]:text-warning [&.delivering]:text-info",
  "webhook-delivery-table":
    "w-full [table-layout:fixed] [&_td:first-child]:overflow-hidden [&_td:first-child]:text-ellipsis [&_td:nth-child(3)]:overflow-hidden [&_td:nth-child(3)]:text-ellipsis [&_td:first-child_small]:block [&_td:first-child_small]:overflow-hidden [&_td:first-child_small]:mt-[3px] [&_td:first-child_small]:text-muted-foreground [&_td:first-child_small]:text-xs [&_td:first-child_small]:text-ellipsis [&_td:first-child_small]:whitespace-nowrap [&_td:nth-child(3)_small]:block [&_td:nth-child(3)_small]:overflow-hidden [&_td:nth-child(3)_small]:mt-[3px] [&_td:nth-child(3)_small]:text-muted-foreground [&_td:nth-child(3)_small]:text-xs [&_td:nth-child(3)_small]:text-ellipsis [&_td:nth-child(3)_small]:whitespace-nowrap",
  "webhook-delivery-table-wrap":
    "overflow-hidden mt-4 border border-solid border-border rounded-xl",
  "webhook-editor-actions": "flex items-center justify-end gap-2.5",
  "webhook-editor-dialog":
    "w-[min(860px,_calc(100dvw_-_32px))] max-h-[min(880px,_calc(100dvh_-_24px))]",
  "webhook-editor-form": "grid gap-3.5",
  "webhook-editor-grid":
    "grid grid-cols-[1.5fr_1fr] gap-[13px] [&_.ui-select]:w-full [&_.ui-input]:w-full",
  "webhook-editor-wide": "col-span-full",
  "webhook-empty-state": "min-h-0 p-5 gap-2",
  "webhook-enabled-field":
    "flex items-center gap-2.5 [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-0.5 [&_small]:text-muted-foreground",
  "webhook-endpoint-card":
    "grid min-w-0 gap-3.5 border border-solid border-border rounded-lg p-[17px] bg-card [&_h3]:m-0 [&_h3]:text-lg [&_p]:m-0 [&_p]:mt-[5px] [&_p]:text-muted-foreground [&_p]:text-sm [&_p]:leading-[1.5] [&_code]:overflow-hidden [&_code]:rounded-lg [&_code]:py-[9px] [&_code]:px-2.5 [&_code]:bg-muted [&_code]:text-info [&_code]:text-xs [&_code]:text-ellipsis [&_code]:whitespace-nowrap",
  "webhook-endpoint-heading": "flex items-center justify-between gap-2.5",
  "webhook-get-preview":
    "border border-solid border-border rounded-lg py-[13px] px-3.5 bg-info/10 [&_p]:[margin:4px_0_0] [&_p]:text-muted-foreground [&_p]:text-sm",
  "webhook-method":
    "inline-flex w-fit items-center rounded-md py-1 px-[7px] font-mono text-xs font-semibold tracking-normal [&.webhook-method-post]:bg-info/10 [&.webhook-method-post]:text-info [&.webhook-method-get]:bg-success/10 [&.webhook-method-get]:text-success",
  "webhook-metric":
    "flex min-w-0 items-center gap-[13px] border border-solid border-border rounded-xl py-[17px] px-4.5 bg-card shadow-xs [&_>_span]:grid [&_>_span]:w-9.5 [&_>_span]:h-9.5 [&_>_span]:[flex:0_0_auto] [&_>_span]:place-items-center [&_>_span]:rounded-lg [&_>_span]:bg-muted [&_>_span]:text-muted-foreground [&_>_div]:grid [&_>_div]:gap-px [&_strong]:text-2xl [&_strong]:leading-[1] [&_strong]:tabular-nums [&_small]:text-muted-foreground [&.webhook-metric-grid]:grid [&.webhook-metric-grid]:grid-cols-4 [&.webhook-metric-grid]:gap-3.5 [&.webhook-metric-grid]:max-[1181px]:grid-cols-2 [&.webhook-metric-blue]:[&_>_span]:bg-info/10 [&.webhook-metric-blue]:[&_>_span]:text-info [&.webhook-metric-green]:[&_>_span]:bg-success/10 [&.webhook-metric-green]:[&_>_span]:text-success [&.webhook-metric-orange]:[&_>_span]:bg-warning/10 [&.webhook-metric-orange]:[&_>_span]:text-warning",
  "webhook-metric-grid": "grid grid-cols-4 gap-3.5 max-[1181px]:grid-cols-2",
  "webhook-section-title":
    "[&_p]:text-muted-foreground [&_p]:m-0 [&_p]:mt-[5px] [&_p]:text-sm items-start [&_h2]:m-0",
  "webhook-settings-stack": "grid gap-4.5",
  "webhook-state":
    "flex items-center gap-1.5 text-muted-foreground text-xs [&_i]:w-[7px] [&_i]:h-[7px] [&_i]:rounded-full [&_i]:bg-muted-foreground [&.enabled_i]:bg-success [&.enabled_i]:shadow-xs",
  "webhook-template-editor":
    "grid gap-3.5 [&_textarea]:w-full [&_textarea]:[resize:vertical] [&_textarea]:font-mono [&_textarea]:text-xs [&_textarea]:leading-[1.55]",
  "webhook-template-heading":
    "flex items-center justify-between gap-2.5 [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-[7px] [&_>_span]:font-semibold [&_small]:text-muted-foreground",
  "webhook-template-preview":
    "max-h-[240px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] p-3 bg-muted rounded-lg",
  "webhook-variable-list":
    "flex flex-wrap gap-1.5 [&_.webhook-variable-token]:border [&_.webhook-variable-token]:border-solid [&_.webhook-variable-token]:border-border [&_.webhook-variable-token]:rounded-md [&_.webhook-variable-token]:py-1 [&_.webhook-variable-token]:px-[7px] [&_.webhook-variable-token]:bg-muted [&_.webhook-variable-token]:text-info [&_.webhook-variable-token]:font-mono [&_.webhook-variable-token]:text-xs [&_.webhook-variable-token]:cursor-pointer",
} as const;
