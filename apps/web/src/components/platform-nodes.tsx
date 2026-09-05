"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { PlatformNode } from "@autoforge/contracts";
import { Button, Input } from "@/components/ui";
import { readApiError } from "@/lib/client-api";
import { useToast } from "@/components/ui-feedback";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";

export function PlatformNodes({ nodes, canManage }: { nodes: PlatformNode[]; canManage: boolean }) {
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
        <PlatformNodeForm key={`${node.id}:${node.revision}`} node={node} canManage={canManage} />
      ))}
    </div>
  );
}

function PlatformNodeForm({ node, canManage }: { node: PlatformNode; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
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
      <h2>{node.name}</h2>
      <p className="settings-note">节点 ID：{node.id}</p>
      {!node.internalBaseUrl ? (
        <p role="status">尚未配置内部地址，其他节点暂时无法读取本节点日志。</p>
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
          <Button className="primary-button" type="submit">
            {pending ? "正在保存…" : "保存节点地址"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
