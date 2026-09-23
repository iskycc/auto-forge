"use client";
import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { WebhookConfiguration } from "@autoforge/domain";
import { BellRing, Check, LoaderCircle, Webhook } from "lucide-react";
import { LinkButton } from "@/components/ui/link-button";
import { useState } from "react";

import { Button, Input } from "./ui";
import { useToast } from "./ui-feedback";

export function CaseSuiteWebhookBindings({
  suiteId,
  configurations,
  initialWebhookIds,
  canManage,
}: {
  suiteId: string;
  configurations: WebhookConfiguration[];
  initialWebhookIds: string[];
  canManage: boolean;
}) {
  const toast = useToast();
  const [selected, setSelected] = useState(new Set(initialWebhookIds));
  const [saved, setSaved] = useState(new Set(initialWebhookIds));
  const [pending, setPending] = useState(false);
  const changed = configurations.some((item) => selected.has(item.id) !== saved.has(item.id));

  async function save(): Promise<void> {
    setPending(true);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suiteId)}/webhooks`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webhookIds: [...selected] }),
      });
      const payload = (await response.json()) as {
        webhookIds?: string[];
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error?.message ?? "保存通知绑定失败。");
      const next = new Set(payload.webhookIds ?? []);
      setSelected(next);
      setSaved(next);
      toast.success("Webhook 绑定已保存。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存通知绑定失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card
      as="section"
      className={cn(
        "card case-suite-webhooks-card",
        uiPatterns["card"],
        caseSuiteWebhookBindingsStyles["case-suite-webhooks-card"],
      )}
    >
      <div className={cn("section-title-row", uiPatterns["section-title-row"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>NOTIFICATIONS</span>
          <h2>完成通知</h2>
          <p>任务进入终态后，向所选端点推送批次状态和用例结果统计。</p>
        </div>
        <LinkButton
          className={cn("button button-ghost", uiPatterns["button"])}
          href="/settings/webhooks"
        >
          <Webhook size={15} /> 管理端点
        </LinkButton>
      </div>
      {configurations.length === 0 ? (
        <div
          className={cn(
            "case-suite-webhooks-empty",
            caseSuiteWebhookBindingsStyles["case-suite-webhooks-empty"],
          )}
        >
          <BellRing size={22} />
          <span>
            <strong>暂无可绑定端点</strong>
            <small>先在“回调通知”页面创建 GET 或 POST Webhook。</small>
          </span>
        </div>
      ) : (
        <div
          className={cn(
            "case-suite-webhook-options",
            caseSuiteWebhookBindingsStyles["case-suite-webhook-options"],
          )}
        >
          {configurations.map((item) => (
            <label className={selected.has(item.id) ? "selected" : ""} key={item.id}>
              <Input
                checked={selected.has(item.id)}
                disabled={!canManage || (!item.enabled && !selected.has(item.id))}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(item.id);
                  else next.delete(item.id);
                  setSelected(next);
                }}
                type="checkbox"
              />
              <span
                className={cn(
                  caseSuiteWebhookBindingsStyles["webhook-method"],
                  `webhook-method webhook-method webhook-method-${item.method.toLowerCase()}`,
                )}
              >
                {item.method}
              </span>
              <span>
                <strong>{item.name}</strong>
                <small title={item.targetUrl}>{item.enabled ? item.targetUrl : "端点已停用"}</small>
              </span>
              {selected.has(item.id) ? <Check size={16} /> : null}
            </label>
          ))}
        </div>
      )}
      {canManage && configurations.length > 0 ? (
        <div
          className={cn(
            "case-suite-webhook-footer",
            caseSuiteWebhookBindingsStyles["case-suite-webhook-footer"],
          )}
        >
          <span className={cn("muted", uiPatterns["muted"])}>
            {changed ? "存在未保存变更" : "当前配置已保存"}
          </span>
          <Button
            disabled={!changed || pending}
            onClick={() => void save()}
            type="button"
            variant="primary"
          >
            {pending ? (
              <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />
            ) : (
              <BellRing size={16} />
            )}
            保存通知绑定
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const caseSuiteWebhookBindingsStyles = {
  "case-suite-webhook-footer": "flex items-center justify-between gap-2.5 min-h-9 mt-3.5",
  "case-suite-webhook-options":
    "[&_label_>_span:nth-of-type(2)]:grid [&_label_>_span:nth-of-type(2)]:min-w-0 [&_label_>_span:nth-of-type(2)]:gap-0.5 [&_small]:text-muted-foreground [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap grid grid-cols-2 gap-2.5 mt-4 [&_label]:grid [&_label]:min-w-0 [&_label]:grid-cols-[auto_auto_minmax(0,_1fr)_auto] [&_label]:items-center [&_label]:gap-2.5 [&_label]:border [&_label]:border-solid [&_label]:border-border [&_label]:rounded-lg [&_label]:p-3 [&_label]:cursor-pointer [&_label.selected]:border-muted [&_label.selected]:bg-muted max-[1181px]:grid-cols-[1fr]",
  "case-suite-webhooks-card": "p-5",
  "case-suite-webhooks-empty":
    "border border-solid border-border rounded-lg py-[13px] px-3.5 bg-info/10 flex items-center gap-[11px] mt-[15px] [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-0.5 [&_small]:text-muted-foreground",
  "webhook-method":
    "inline-flex w-fit items-center rounded-md py-1 px-[7px] font-mono text-xs font-semibold tracking-normal [&.webhook-method-post]:bg-info/10 [&.webhook-method-post]:text-info [&.webhook-method-get]:bg-success/10 [&.webhook-method-get]:text-success",
} as const;
