"use client";

import {
  batchUpdateRunnerAgentsResultSchema,
  type BatchUpdateRunnerAgentsResult,
} from "@autoforge/contracts";
import { CheckCircle2, Download, ShieldAlert, X } from "lucide-react";
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
      <Button className="button button-primary" onClick={() => setOpen(true)} type="button">
        <Download size={16} /> 批量更新
      </Button>
      {open ? (
        <div
          className="runner-update-overlay"
          onMouseDown={() => !pending && setOpen(false)}
          role="presentation"
        >
          <section
            aria-label="批量更新执行机 Agent"
            aria-modal="true"
            className="runner-update-dialog batch-runner-update-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="runner-update-titlebar">
              <span>
                <Download size={16} />
                <strong>批量更新执行机 Agent</strong>
                <small>目标版本 {latestVersion} · 最多并行 4 台</small>
              </span>
              <Button aria-label="关闭" disabled={pending} onClick={() => setOpen(false)}>
                <X size={16} />
              </Button>
            </header>
            <div className="runner-update-body">
              <div className="batch-runner-update-list">
                <div className="inline-notice" role="status">
                  <CheckCircle2 size={18} />
                  <span>
                    本次只替换 Agent 与 Adapter 程序，远端配置、systemd
                    服务、身份和数据目录保持不变。
                  </span>
                </div>
                {targets.map((target) => (
                  <label className="batch-runner-update-row" key={target.runnerId}>
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
                <div className="inline-notice warning-notice">
                  <ShieldAlert size={18} />
                  <span>这些执行机都没有已保存连接信息，暂时不能批量更新。</span>
                </div>
              ) : null}
              {result ? (
                <div className="batch-runner-update-results" role="status">
                  {result.items.map((item) => (
                    <div key={item.runnerId} className={`batch-update-result ${item.status}`}>
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
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="runner-installer-actions">
                <Button
                  className="button-primary"
                  disabled={selectedIds.size === 0 || pending}
                  onClick={() => void updateSelected()}
                  type="button"
                >
                  <Download size={16} /> {pending ? "正在批量更新…" : `更新 ${selectedIds.size} 台`}
                </Button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
