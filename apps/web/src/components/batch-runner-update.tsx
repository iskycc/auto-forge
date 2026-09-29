"use client";
import { Notice } from "@/components/ui/notice";

import { ActionDialog } from "@/components/action-dialog";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import {
  batchUpdateRunnerAgentsResultSchema,
  type BatchUpdateRunnerAgentsResult,
} from "@autoforge/contracts";
import { CheckCircle2, Download, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button, Input } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

export type BatchRunnerUpdateTarget = {
  runnerId: string;
  runnerName: string;
  hasStoredProfile: boolean;
};

export function BatchRunnerUpdate({
  targets,
  latestVersion,
}: {
  targets: readonly BatchRunnerUpdateTarget[];
  latestVersion: string;
}) {
  const router = useRouter();
  const availableIds = useMemo(
    () => targets.filter((target) => target.hasStoredProfile).map((target) => target.runnerId),
    [targets],
  );
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set(availableIds));
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<BatchUpdateRunnerAgentsResult>();
  const [error, setError] = useState("");

  function toggle(runnerId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(runnerId)) next.delete(runnerId);
      else next.add(runnerId);
      return next;
    });
  }

  async function updateSelected(): Promise<void> {
    if (selectedIds.size === 0) return;
    setPending(true);
    setError("");
    setResult(undefined);
    try {
      const response = await fetch("/api/v1/runners/updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerIds: [...selectedIds] }),
      });
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "批量更新执行机失败。"))!);
      }
      setResult(batchUpdateRunnerAgentsResultSchema.parse(await response.json()));
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "批量更新执行机失败。");
    } finally {
      setPending(false);
    }
  }

  if (targets.length === 0) return null;
  return (
    <>
      <Button
        className={cn("button button-primary", uiPatterns["button"], uiPatterns["button-primary"])}
        onClick={() => setOpen(true)}
        type="button"
      >
        <Download size={16} /> 批量更新
      </Button>
      {open ? (
        <ActionDialog
          open
          title={"批量更新执行机 Agent"}
          description={`目标版本 ${latestVersion} · 最多并行 4 台`}
          onClose={() => !pending && setOpen(false)}
          closeDisabled={pending}
          className="batch-runner-update-dialog w-[min(760px,calc(100vw-3rem))]"
          backdropClassName="runner-update-overlay"
          footer={
            <Button
              variant="primary"
              disabled={selectedIds.size === 0 || pending}
              onClick={() => void updateSelected()}
              type="button"
            >
              <Download size={16} /> {pending ? "正在批量更新…" : `更新 ${selectedIds.size} 台`}
            </Button>
          }
        >
          <div className={cn("runner-update-body", batchRunnerUpdateStyles["runner-update-body"])}>
            <div
              className={cn(
                "batch-runner-update-list",
                batchRunnerUpdateStyles["batch-runner-update-list"],
              )}
            >
              <Notice
                tone="info"
                className={cn("inline-notice", uiPatterns["inline-notice"])}
                role="status"
              >
                <CheckCircle2 size={18} />
                <span>
                  本次只替换 Agent 与 Adapter 程序，远端配置、systemd 服务、身份和数据目录保持不变。
                </span>
              </Notice>
              {targets.map((target) => (
                <label
                  className={cn(
                    "batch-runner-update-row",
                    batchRunnerUpdateStyles["batch-runner-update-row"],
                  )}
                  key={target.runnerId}
                >
                  <Input
                    checked={selectedIds.has(target.runnerId)}
                    disabled={!target.hasStoredProfile || pending}
                    onChange={() => toggle(target.runnerId)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{target.runnerName}</strong>
                    <small>
                      {target.hasStoredProfile
                        ? "使用 AES-GCM 加密保存的 SSH 连接信息"
                        : "尚无连接信息，请先单独核验并更新一次"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            {availableIds.length === 0 ? (
              <Notice
                tone="warning"
                className={cn(
                  "inline-notice warning-notice",
                  uiPatterns["inline-notice"],
                  uiPatterns["warning-notice"],
                )}
              >
                <ShieldAlert size={18} />
                <span>这些执行机都没有已保存连接信息，暂时不能批量更新。</span>
              </Notice>
            ) : null}
            {result ? (
              <div
                className={cn(
                  "batch-runner-update-results",
                  batchRunnerUpdateStyles["batch-runner-update-results"],
                )}
                role="status"
              >
                {result.items.map((item) => (
                  <div
                    key={item.runnerId}
                    className={cn(
                      batchRunnerUpdateStyles["batch-update-result"],
                      `batch-update-result ${item.status}`,
                    )}
                  >
                    {item.status === "updated" ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <ShieldAlert size={16} />
                    )}
                    <span>
                      <strong>{item.runnerName}</strong>
                      <small>{item.message}</small>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {error ? (
              <Notice
                tone="error"
                className={cn("form-error", uiPatterns["form-error"])}
                role="alert"
              >
                {error}
              </Notice>
            ) : null}
          </div>
        </ActionDialog>
      ) : null}
    </>
  );
}

const batchRunnerUpdateStyles = {
  "batch-runner-update-list": "grid min-w-0 grid-cols-1 gap-2",
  "batch-runner-update-results": "grid min-w-0 grid-cols-1 gap-2",
  "batch-runner-update-row":
    "flex min-w-0 items-center gap-3 py-3 px-3.5 border border-solid border-border rounded-lg bg-muted [&_>_span]:grid [&_>_span]:gap-[3px] [&_>_span]:min-w-0 [&_small]:text-muted-foreground [overflow-wrap:anywhere]",
  "batch-update-result":
    "flex min-w-0 items-center gap-3 py-3 px-3.5 border border-solid border-border rounded-lg bg-muted [&_>_span]:grid [&_>_span]:gap-[3px] [&_>_span]:min-w-0 [&_small]:text-muted-foreground [&>svg]:shrink-0 [overflow-wrap:anywhere] [&.updated_svg]:text-success [&.failed_svg]:text-warning [&.missing\\_profile_svg]:text-warning",
  "runner-update-body": "grid min-w-0 grid-cols-1 gap-4",
} as const;
