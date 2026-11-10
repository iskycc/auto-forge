"use client";

import { Archive, ArchiveRestore } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CaseSuite } from "@autoforge/domain";

import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";
import { useToast } from "./ui-feedback";
import { useConcurrentModificationFeedback } from "./concurrent-modification-feedback";
import { isConcurrentModificationError, throwApiErrorResponse } from "@/lib/client-api";

export function CaseSuiteArchiveButton({
  suite,
  presentation = "label",
  onChanged,
}: {
  suite: Pick<CaseSuite, "id" | "name" | "revision" | "status">;
  presentation?: "icon" | "label";
  onChanged?: (suite: CaseSuite) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const archived = suite.status === "archived";
  const label = archived ? "恢复任务" : "归档任务";
  const Icon = archived ? ArchiveRestore : Archive;

  async function changeStatus(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: suite.revision, archived: !archived }),
      });
      if (!response.ok) await throwApiErrorResponse(response, `${label}失败。`);
      const updated = (await response.json()) as CaseSuite;
      setOpen(false);
      onChanged?.(updated);
      toast.success(
        archived ? "任务已恢复到活动任务列表。" : "任务已归档，用例和历史执行记录已保留。",
      );
      router.refresh();
    } catch (caught) {
      if (isConcurrentModificationError(caught)) {
        setOpen(false);
        await showConcurrentModification(caught);
        return;
      }
      const message = caught instanceof Error ? caught.message : `${label}失败。`;
      if (archived) toast.error(message);
      else setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={presentation === "icon" ? "icon" : "default"}
        aria-label={`${label} ${suite.name}`}
        title={presentation === "icon" ? label : undefined}
        aria-expanded={open}
        aria-haspopup={archived ? undefined : "dialog"}
        loading={pending}
        onClick={() => {
          setError(undefined);
          if (archived) void changeStatus();
          else setOpen(true);
        }}
      >
        <Icon size={16} />
        {presentation === "label" ? label : null}
      </Button>
      <ActionDialog
        open={open}
        title="归档任务"
        closeDisabled={pending}
        description="归档后任务将移到已归档列表，用例和配置只读，不能发起新的执行。"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="button" loading={pending} onClick={() => void changeStatus()}>
              确认归档
            </Button>
          </>
        }
      >
        <p className="m-0 font-semibold [overflow-wrap:anywhere]">{suite.name}</p>
        <p className="mt-3 mb-0 text-sm leading-6 text-muted-foreground">
          按当前已保存的配置归档，未保存的修改不会保留。保留全部用例、任务配置及历史执行记录，执行计划会停用。可随时恢复为活动任务，恢复后需自行重新启用执行计划。
          有待执行、倒计时或执行中批次时不能归档。
        </p>
        {error ? (
          <Notice tone="error" role="alert" className="mt-3">
            {error}
          </Notice>
        ) : null}
      </ActionDialog>
    </>
  );
}
