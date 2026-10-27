"use client";

import { Alert, Card, Input, Tabs } from "antd";
import { ExternalLink, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyableText } from "./ui/copyable-text";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";
import { JenkinsTaskGuide } from "./jenkins-task-guide";
import { throwApiErrorResponse } from "@/lib/client-api";

export function TaskExecutionAccess({
  suiteId,
  baseUrl,
  canPublish,
}: {
  suiteId: string;
  baseUrl: string | undefined;
  canPublish: boolean;
}) {
  return (
    <Card title="执行接入">
      <div className="grid min-w-0 gap-5">
        {canPublish ? <PublicTaskLink suiteId={suiteId} /> : null}
        <JenkinsTaskGuide suiteId={suiteId} baseUrl={baseUrl} />
      </div>
    </Card>
  );
}

export function TaskExecutionAccessButton({
  suiteId,
  baseUrl,
  canPublish,
}: {
  suiteId: string;
  baseUrl: string | undefined;
  canPublish: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="执行接入"
        title="公开执行链接与 Jenkins 对接"
        onClick={() => setOpen(true)}
      >
        <Link2 size={15} />
      </Button>
      <ActionDialog
        open={open}
        title="任务执行接入"
        description="提供公开执行入口或通过 Jenkins 持续集成启动任务。"
        onClose={() => setOpen(false)}
        className="!w-[min(820px,calc(100vw-64px))]"
      >
        <Tabs
          items={[
            ...(canPublish
              ? [
                  {
                    key: "public",
                    label: "公开执行链接",
                    children: <PublicTaskLink suiteId={suiteId} />,
                  },
                ]
              : []),
            {
              key: "jenkins",
              label: "Jenkins 对接",
              children: <JenkinsTaskGuide suiteId={suiteId} baseUrl={baseUrl} />,
            },
          ]}
        />
      </ActionDialog>
    </>
  );
}

function PublicTaskLink({ suiteId }: { suiteId: string }) {
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revoked, setRevoked] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setPending(true);
      try {
        const response = await fetch(
          `/api/v1/case-suites/${encodeURIComponent(suiteId)}/execution-link`,
          {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          },
        );
        if (!response.ok) await throwApiErrorResponse(response, "读取公开执行链接失败。");
        const result = (await response.json()) as { url: string | null };
        if (!controller.signal.aborted) setUrl(result.url ?? "");
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取链接失败。");
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [suiteId]);
  async function change(method: "POST" | "DELETE") {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/case-suites/${encodeURIComponent(suiteId)}/execution-link`,
        { method },
      );
      if (!response.ok) await throwApiErrorResponse(response, "更新公开执行链接失败。");
      const payload = (await response.json()) as { url?: string };
      setUrl(payload.url ?? "");
      setRevoked(method === "DELETE");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="grid min-w-0 gap-4" aria-label="任务公开执行链接">
      <div>
        <h3 className="mb-2 mt-0 text-base">公开执行链接</h3>
        <p className="m-0 leading-6 text-muted-foreground">
          获得链接的任何已登录用户均可执行此任务，无需项目执行权限；可终止通过本任务公开入口创建的批次。页面只展示基本配置，不允许覆盖任务配置。
        </p>
      </div>
      <Alert
        type="info"
        showIcon
        title="链接会记录您的账号为分享人"
        description="每个分享人拥有独立链接，撤销只影响自己的链接。任务删除或分享人停用后链接失效；撤销不终止已启动的批次。重新生成会重新启用本账号的原链接。"
      />
      {url ? (
        <div className="grid min-w-0 gap-3">
          <Input aria-label="公开执行链接" readOnly value={url} />
          <div className="flex flex-wrap items-center gap-4">
            <CopyableText text={url}>复制链接</CopyableText>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary"
            >
              <ExternalLink size={15} />
              打开执行页
            </a>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void change("DELETE")}
            >
              撤销本人的链接
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          className="w-fit"
          variant="default"
          loading={pending}
          onClick={() => void change("POST")}
        >
          <Link2 size={16} />
          {revoked ? "重新生成公开执行链接" : "生成本人的公开执行链接"}
        </Button>
      )}
      {revoked ? <Alert type="success" title="本人的链接已撤销，已有执行记录仍保留。" /> : null}
      {error ? <Alert type="error" showIcon title={error} /> : null}
    </section>
  );
}
