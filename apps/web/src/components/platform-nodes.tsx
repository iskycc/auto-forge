"use client";
import { Notice } from "@/components/ui/notice";

import { Badge } from "@/components/ui/badge";

import { Disclosure } from "@/components/ui/disclosure";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { PlatformNode } from "@autoforge/contracts";
import { Button, Input } from "@/components/ui";
import { readApiError } from "@/lib/client-api";
import { useToast } from "@/components/ui-feedback";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";

export function PlatformNodes({
  nodes,
  canManage,
  currentNodeId,
}: {
  currentNodeId?: string | undefined;
  nodes: PlatformNode[];
  canManage: boolean;
}) {
  return (
    <div className={cn("settings-stack", uiPatterns["settings-stack"])}>
      <p className={cn("settings-note", uiPatterns["settings-note"])}>
        节点启动后自动登记。填写各节点之间可直接访问的 IP（或域名）和端口，例如
        http://10.20.0.11:3000。请使用节点自身地址；日志归属由节点 ID 标识，修改地址不会搬移日志。
      </p>
      {nodes.length === 0 ? (
        <Card as="div" className={cn("content-card", uiPatterns["content-card"])}>
          尚无平台节点，请先启动 Full 分布式节点。
        </Card>
      ) : null}
      {nodes.map((node) => (
        <PlatformNodeForm
          key={`${node.id}:${node.revision}`}
          node={node}
          current={node.id === currentNodeId}
          canManage={canManage}
        />
      ))}
    </div>
  );
}

function PlatformNodeForm({
  node,
  canManage,
  current,
}: {
  node: PlatformNode;
  canManage: boolean;
  current: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ checkedAt: string; message: string }>();
  async function checkConnectivity() {
    setChecking(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/settings/platform-nodes/${encodeURIComponent(node.id)}/check`,
        { method: "POST" },
      );
      if (!response.ok)
        throw await readApiError(response, "节点连通检查失败。请检查地址、共享密钥与节点版本。");
      const result = (await response.json()) as { checkedAt: string };
      setCheck({ checkedAt: result.checkedAt, message: "连接与节点身份验证通过" });
      toast.success("节点连通检查通过。");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "节点检查失败。";
      setCheck(undefined);
      setError(message);
    } finally {
      setChecking(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/settings/platform-nodes/${encodeURIComponent(node.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: String(form.get("name")).trim(),
            internalBaseUrl: String(form.get("internalBaseUrl")).trim() || null,
            revision: node.revision,
          }),
        },
      );
      if (!response.ok) throw await readApiError(response, "节点配置保存失败。");
      toast.success("节点地址已保存，后续节点间请求使用新地址。");
      router.refresh();
    } catch (cause) {
      if (await showConcurrentModification(cause)) return;
      setError(cause instanceof Error ? cause.message : "节点配置保存失败。");
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className={cn(
        "content-card settings-section",
        uiPatterns["content-card"],
        uiPatterns["settings-section"],
      )}
      onSubmit={submit}
      aria-label={`平台节点 ${node.name}`}
    >
      <div className={cn("management-toolbar", uiPatterns["management-toolbar"])}>
        <h2>{node.name === node.id ? `平台节点 · ${node.id.slice(-8)}` : node.name}</h2>
        {current ? (
          <Badge className={cn("permission-chip", uiPatterns["permission-chip"])}>当前节点</Badge>
        ) : null}
        <Badge className={cn("permission-chip", uiPatterns["permission-chip"])}>
          {node.internalBaseUrl ? "地址已配置" : "待配置地址"}
        </Badge>
      </div>
      <Disclosure
        header={<>节点标识与配置时间</>}
        className={cn("management-disclosure", platformNodesStyles["management-disclosure"])}
      >
        <p className={cn("settings-note", uiPatterns["settings-note"])}>节点 ID：{node.id}</p>
        <p className={cn("settings-note", uiPatterns["settings-note"])}>
          连通检查通过已保存地址访问目标，校验共享密钥与节点身份。检查结果仅代表检查时刻，不自动轮询。
        </p>
      </Disclosure>
      {!node.internalBaseUrl ? (
        <Notice tone="warning" role="status">
          尚未配置内部地址，其他节点暂时无法读取本节点日志。
        </Notice>
      ) : null}
      {check ? (
        <p className={cn("settings-note", uiPatterns["settings-note"])} role="status">
          {check.message} · {formatPlatformDateTime(check.checkedAt)}
        </p>
      ) : null}
      {error ? (
        <Notice tone="error" className={cn("auth-error", uiPatterns["auth-error"])} role="alert">
          {error}
        </Notice>
      ) : null}
      <fieldset
        className={cn("settings-form-fieldset", platformNodesStyles["settings-form-fieldset"])}
        disabled={!canManage || pending}
      >
        <div className={cn("settings-grid-form", uiPatterns["settings-grid-form"])}>
          <label>
            节点名称
            <Input name="name" defaultValue={node.name} maxLength={120} required />
          </label>
          <label>
            节点 IP 和端口
            <Input
              name="internalBaseUrl"
              type="url"
              defaultValue={node.internalBaseUrl ?? ""}
              placeholder="http://10.20.0.11:3000"
            />
          </label>
        </div>
        <div className={cn("settings-form-actions", platformNodesStyles["settings-form-actions"])}>
          <Button
            type="button"
            disabled={checking || !node.internalBaseUrl}
            onClick={() => void checkConnectivity()}
          >
            {checking ? "检查中…" : "检查连通性"}
          </Button>
          <Button className={cn("primary-button", uiPatterns["primary-button"])} type="submit">
            {pending ? "正在保存…" : "保存节点地址"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

const platformNodesStyles = {
  "management-disclosure":
    "min-w-0 p-3 border border-solid border-border rounded-lg [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:font-semibold [&[data-open=true]_.ui-disclosure-label]:mb-3",
  "settings-form-actions":
    "flex justify-end gap-2.5 [&.management-sticky-actions]:bottom-3 [&.management-sticky-actions]:border [&.management-sticky-actions]:border-solid [&.management-sticky-actions]:border-border [&.management-sticky-actions]:rounded-xl [&.management-sticky-actions]:shadow-xs",
  "settings-form-fieldset":
    "contents min-w-0 m-0 border-0 p-0 [&:disabled]:opacity-78 [&[hidden]]:hidden",
} as const;
