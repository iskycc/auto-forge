"use client";

import { LockKeyhole, LockKeyholeOpen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CaseSuite } from "@autoforge/domain";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";
import { useToast } from "./ui-feedback";
import { useConcurrentModificationFeedback } from "./concurrent-modification-feedback";
import { isConcurrentModificationError, throwApiErrorResponse } from "@/lib/client-api";

export function CaseSuiteLockButton({
  suite,
  onChanged,
}: {
  suite: CaseSuite;
  onChanged?: (suite: CaseSuite) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = !!suite.lockedBy;
  const label = locked ? "解除锁定" : "锁定任务";
  const Icon = locked ? LockKeyholeOpen : LockKeyhole;
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/lock`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locked: !locked, expectedRevision: suite.revision }),
      });
      if (!response.ok) await throwApiErrorResponse(response, `${label}失败。`);
      const saved = (await response.json()) as CaseSuite;
      onChanged?.(saved);
      setOpen(false);
      toast.success(locked ? "任务已解除锁定。" : "任务已锁定，仅您可以修改任务。");
      router.refresh();
    } catch (cause) {
      if (isConcurrentModificationError(cause)) {
        setOpen(false);
        await showConcurrentModification(cause);
        return;
      }
      setError(cause instanceof Error ? cause.message : `${label}失败。`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`${label} ${suite.name}`}
        title={label}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        <Icon size={16} />
      </Button>
      <ActionDialog
        open={open}
        title={label}
        onClose={() => setOpen(false)}
        closeDisabled={busy}
        description={
          locked
            ? "解除后，其他具有任务管理权限的用户可继续修改任务。"
            : "锁定后，仅您可以编辑配置、增删成员、删除、归档和解除锁定。"
        }
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="button" loading={busy} onClick={() => void save()}>
              确认{label}
            </Button>
          </>
        }
      >
        <p className="m-0 font-semibold [overflow-wrap:anywhere]">{suite.name}</p>
        <p className="mt-3 mb-0 text-sm text-muted-foreground">
          锁定状态会持久保存，刷新或平台重启后仍然有效。
        </p>
        {error ? (
          <Notice tone="error" className="mt-3" role="alert">
            {error}
          </Notice>
        ) : null}
      </ActionDialog>
    </>
  );
}
