"use client";

import { Alert, Tag } from "antd";
import { useState } from "react";
import {
  runnerRejectedContactsPageSchema,
  type RunnerRejectedContactsPage,
  type RunnerInstallationProfile,
} from "@autoforge/contracts";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { RunnerUninstallDialog } from "./runner-uninstall-dialog";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { readApiErrorMessage } from "@/lib/client-api";

export function DeletedRunnerContacts({
  initialPage,
  profiles,
}: {
  initialPage: RunnerRejectedContactsPage;
  profiles: RunnerInstallationProfile[];
}) {
  const [page, setPage] = useState(initialPage);
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function load(nextCursor: string | undefined, direction: "next" | "previous" | "refresh") {
    setPending(true);
    setError("");
    try {
      const query = new URLSearchParams({
        limit: "10",
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      const response = await fetch(`/api/v1/runners/rejected-contacts?${query}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "读取已删除节点连接记录失败。"))!);
      const result = runnerRejectedContactsPageSchema.parse(await response.json());
      setPage(result);
      if (direction === "next") setHistory((values) => [...values, cursor]);
      if (direction === "previous") setHistory((values) => values.slice(0, -1));
      setCursor(nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取失败，请重试。");
    } finally {
      setPending(false);
    }
  }
  if (page.items.length === 0 && history.length === 0 && !error) return null;

  return (
    <Card
      as="section"
      className="grid min-w-0 gap-4 border border-border p-4"
      aria-label="已删除 Agent 连接提醒"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-base font-semibold">已删除 Agent 连接提醒</h2>
          {page.items.length ? <Tag color="warning">仍有连接被拒绝</Tag> : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => void load(cursor, "refresh")}
        >
          {pending ? "正在刷新…" : "刷新连接记录"}
        </Button>
      </div>
      <p className="m-0 text-sm leading-6 text-muted-foreground">
        这些节点已注销并删除，旧 Agent
        仍尝试连接且鉴权失败，不会获得执行任务。记录依据请求携带的旧节点
        ID，不能作为已核验的上线身份；卸载前仍须核验远端主机。最近时间每分钟最多更新一次。
      </p>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {page.items.length ? (
        <div className="grid min-w-0 gap-3">
          {page.items.map((contact) => {
            const profile = profiles.find((value) => value.runnerId === contact.runnerId);
            return (
              <article
                key={contact.runnerId}
                className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 p-3"
                aria-label={`已删除节点 ${contact.name}`}
              >
                <div className="grid min-w-0 gap-1">
                  <strong className="[overflow-wrap:anywhere]">{contact.name}</strong>
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {contact.runnerId}
                  </span>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                    <span>首次拒绝 {formatPlatformDateTime(contact.firstRejectedAt)}</span>
                    <span>最近拒绝 {formatPlatformDateTime(contact.lastRejectedAt)}</span>
                    <span>旧版本 {contact.agentVersion}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {profile
                      ? "可使用已保存 SSH 连接；失效时可重新填写。"
                      : "未保存 SSH 凭据，卸载时请填写主机、用户名和密码。"}
                  </span>
                </div>
                <RunnerUninstallDialog
                  runnerId={contact.runnerId}
                  runnerName={contact.name}
                  {...(profile ? { profile } : {})}
                />
              </article>
            );
          })}
        </div>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">暂无已删除节点的连接记录。</p>
      )}
      {history.length || page.nextCursor ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={pending || !history.length}
            onClick={() => void load(history.at(-1), "previous")}
          >
            上一页
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || !page.nextCursor}
            onClick={() => void load(page.nextCursor, "next")}
          >
            下一页
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
