"use client";

import { Alert } from "antd";
import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui";
import { Dialog } from "./ui/dialog";
import { CopyableText } from "./ui/copyable-text";
import { useConfirm } from "./ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";

export function FailureAnalysisPublicationButton({ batchId }: { batchId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        <Link2 size={15} />
        公开分析
      </Button>
      {open ? <PublicationDialog batchId={batchId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
function PublicationDialog({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const confirm = useConfirm();
  const [path, setPath] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const endpoint = `/api/v1/failure-analysis/batches/${encodeURIComponent(batchId)}/publication`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error((await readApiErrorMessage(response, "读取公开分析链接失败。"))!);
        const result = (await response.json()) as { path: string | null };
        if (!controller.signal.aborted) setPath(result.path);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取公开分析链接失败。");
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [endpoint]);
  async function change(action: "publish" | "revoke") {
    if (pending) return;
    if (
      action === "revoke" &&
      !(await confirm({
        title: "撤销公开分析链接？",
        description: "撤销后，链接的读取、认领及提交入口立即失效。已有分析结论与证明材料保留。",
        confirmLabel: "确认撤销",
        tone: "danger",
      }))
    )
      return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: action === "publish" ? "POST" : "DELETE",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "更新公开分析链接失败。"))!);
      setPath(((await response.json()) as { path: string | null }).path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新公开分析链接失败。");
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      title="公开分析链接"
      onClose={onClose}
      closeDisabled={pending}
      className="w-[min(720px,calc(100vw-48px))]"
    >
      <section className="grid min-w-0 gap-4 p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-lg font-semibold">公开分析链接</h2>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            关闭
          </Button>
        </div>
        <Alert
          showIcon
          type="info"
          title="面向持有链接的协作人员"
          description="启用后，访客可只读查看本次任务的失败用例、人工分析结论、日志与证明。个人账号登录后，无需项目权限即可认领和分析自己认领的用例；不能修改他人的结论或管理任务。"
        />
        {error ? <Alert showIcon type="error" title={error} /> : null}
        {path ? (
          <div className="min-w-0 rounded-lg border border-solid border-border bg-muted/40 p-3">
            <CopyableText
              block
              className="!mb-0 break-all"
              text={new URL(path, window.location.origin).href}
            />
          </div>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">
            {pending ? "正在读取链接状态…" : "当前未启用公开分析。"}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {path ? (
            <>
              <a
                href={path}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-sm text-info"
              >
                新标签页查看
              </a>
              <Button
                type="button"
                variant="danger"
                disabled={pending}
                onClick={() => void change("revoke")}
              >
                撤销链接
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={pending}
              loading={pending}
              onClick={() => void change("publish")}
            >
              启用并生成链接
            </Button>
          )}
        </div>
      </section>
    </Dialog>
  );
}
