"use client";
import { Checkbox } from "antd";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useClientReadiness } from "@/components/ui/use-client-readiness";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { WebhookConfiguration } from "@autoforge/domain";
import { BellRing, Check, Webhook } from "lucide-react";
import { LinkButton } from "@/components/ui/link-button";
import { useState } from "react";

import { Button } from "./ui";
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
  const clientReady = useClientReadiness();
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
        <EmptyState className="mt-4 grid justify-items-center gap-2 rounded-lg border border-dashed border-border p-4 text-muted-foreground">
          <BellRing size={22} aria-hidden="true" />
          <strong>暂无可绑定端点</strong>
          <p className="m-0 text-sm">先在“回调通知”页面创建 GET 或 POST Webhook。</p>
        </EmptyState>
      ) : (
        <div
          className={cn(
            "case-suite-webhook-options",
            caseSuiteWebhookBindingsStyles["case-suite-webhook-options"],
          )}
        >
          {configurations.map((item) => (
            <Checkbox
              key={item.id}
              aria-label={item.name}
              className={cn(
                "w-full min-w-0 rounded-lg border border-border p-3",
                selected.has(item.id) && "border-primary bg-accent",
              )}
              styles={{ label: { minWidth: 0, flex: 1 } }}
              checked={selected.has(item.id)}
              disabled={
                !clientReady || pending || !canManage || (!item.enabled && !selected.has(item.id))
              }
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(item.id);
                else next.delete(item.id);
                setSelected(next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Badge variant={item.method === "GET" ? "success" : "info"} className="font-mono">
                  {item.method}
                </Badge>
                <span className="grid min-w-0 flex-1 gap-1">
                  <strong className="[overflow-wrap:anywhere]">{item.name}</strong>
                  <small className="truncate text-xs text-muted-foreground" title={item.targetUrl}>
                    {item.enabled ? item.targetUrl : "端点已停用"}
                  </small>
                </span>
                {selected.has(item.id) ? (
                  <Check className="shrink-0 text-primary" size={16} aria-hidden="true" />
                ) : null}
              </span>
            </Checkbox>
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
            loading={pending}
            onClick={() => void save()}
            type="button"
            variant="primary"
          >
            {pending ? null : <BellRing size={16} />}
            保存通知绑定
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const caseSuiteWebhookBindingsStyles = {
  "case-suite-webhook-footer": "flex items-center justify-between gap-2.5 min-h-9 mt-3.5",
  "case-suite-webhook-options": "mt-4 grid min-w-0 grid-cols-2 gap-3 max-[1181px]:grid-cols-1",
  "case-suite-webhooks-card": "p-5",
} as const;
