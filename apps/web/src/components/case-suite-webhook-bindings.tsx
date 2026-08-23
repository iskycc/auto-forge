"use client";

import type { WebhookConfiguration } from "@autoforge/domain";
import { BellRing, Check, LoaderCircle, Webhook } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, Input } from "./ui";

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
  const [selected, setSelected] = useState(new Set(initialWebhookIds));
  const [saved, setSaved] = useState(new Set(initialWebhookIds));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const changed = configurations.some((item) => selected.has(item.id) !== saved.has(item.id));

  async function save(): Promise<void> {
    setPending(true);
    setMessage("");
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
      setMessage("Webhook 绑定已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存通知绑定失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card case-suite-webhooks-card">
      <div className="section-title-row">
        <div>
          <span className="eyebrow">NOTIFICATIONS</span>
          <h2>完成通知</h2>
          <p>任务进入终态后，向所选端点推送批次状态和用例结果统计。</p>
        </div>
        <Link className="button button-ghost" href="/settings/webhooks">
          <Webhook size={15} /> 管理端点
        </Link>
      </div>
      {configurations.length === 0 ? (
        <div className="case-suite-webhooks-empty">
          <BellRing size={22} />
          <span>
            <strong>暂无可绑定端点</strong>
            <small>先在“回调通知”页面创建 GET 或 POST Webhook。</small>
          </span>
        </div>
      ) : (
        <div className="case-suite-webhook-options">
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
                  setMessage("");
                }}
                type="checkbox"
              />
              <span className={`webhook-method webhook-method-${item.method.toLowerCase()}`}>
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
        <div className="case-suite-webhook-footer">
          <span className={message.includes("失败") ? "form-error" : "form-success"}>
            {message}
          </span>
          <Button
            disabled={!changed || pending}
            onClick={() => void save()}
            type="button"
            variant="primary"
          >
            {pending ? <LoaderCircle className="spin" size={16} /> : <BellRing size={16} />}
            保存通知绑定
          </Button>
        </div>
      ) : null}
    </section>
  );
}
