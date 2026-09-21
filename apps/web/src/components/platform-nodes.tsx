"use client";

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
    <div className="settings-stack">
      <p className="settings-note">
        节点启动后自动登记。填写各节点之间可直接访问的 IP（或域名）和端口，例如
        http://10.20.0.11:3000。请使用节点自身地址；日志归属由节点 ID 标识，修改地址不会搬移日志。
      </p>
      {nodes.length === 0 ? (
        <div className="content-card">尚无平台节点，请先启动 Full 分布式节点。</div>
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
      className="content-card settings-section"
      onSubmit={submit}
      aria-label={`平台节点 ${node.name}`}
    >
      <div className="management-toolbar">
        <h2>{node.name === node.id ? `平台节点 · ${node.id.slice(-8)}` : node.name}</h2>
        {current ? <span className="permission-chip">当前节点</span> : null}
        <span className="permission-chip">
          {node.internalBaseUrl ? "地址已配置" : "待配置地址"}
        </span>
      </div>
      <details className="management-disclosure">
        <summary>节点标识与配置时间</summary>
        <p className="settings-note">节点 ID：{node.id}</p>
        <p className="settings-note">
          连通检查通过已保存地址访问目标，校验共享密钥与节点身份。检查结果仅代表检查时刻，不自动轮询。
        </p>
      </details>
      {!node.internalBaseUrl ? (
        <p role="status">尚未配置内部地址，其他节点暂时无法读取本节点日志。</p>
      ) : null}
      {check ? (
        <p className="settings-note" role="status">
          {check.message} · {formatPlatformDateTime(check.checkedAt)}
        </p>
      ) : null}
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}
      <fieldset className="settings-form-fieldset" disabled={!canManage || pending}>
        <div className="settings-grid-form">
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
        <div className="settings-form-actions">
          <Button
            type="button"
            disabled={checking || !node.internalBaseUrl}
            onClick={() => void checkConnectivity()}
          >
            {checking ? "检查中…" : "检查连通性"}
          </Button>
          <Button className="primary-button" type="submit">
            {pending ? "正在保存…" : "保存节点地址"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
