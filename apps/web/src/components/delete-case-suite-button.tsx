"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";
import { useToast } from "./ui-feedback";
import { useConcurrentModificationFeedback } from "./concurrent-modification-feedback";
import {
  ApiClientError,
  isConcurrentModificationError,
  throwApiErrorResponse,
} from "@/lib/client-api";

export function DeleteCaseSuiteButton({
  suiteId,
  suiteName,
  revision,
  presentation = "label",
  onDeleted,
}: {
  suiteId: string;
  suiteName: string;
  revision: number;
  presentation?: "icon" | "label";
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; refreshRequired: boolean } | null>(
    null,
  );

  async function deleteSuite(): Promise<void> {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suiteId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      if (!response.ok) await throwApiErrorResponse(response, "删除任务失败，请重试。");
      setOpen(false);
      toast.success("任务已删除，历史执行记录已保留。");
      if (onDeleted) onDeleted();
      else router.replace("/case-suites");
      router.refresh();
    } catch (error) {
      if (isConcurrentModificationError(error)) {
        setOpen(false);
        await showConcurrentModification(error);
        return;
      }
      setFailure({
        message: error instanceof Error ? error.message : "删除任务失败，请重试。",
        refreshRequired: error instanceof ApiClientError && error.code === "CASE_SUITE_NOT_FOUND",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size={presentation === "icon" ? "icon" : "default"}
        aria-label={`删除任务 ${suiteName}`}
        title={presentation === "icon" ? "删除任务" : undefined}
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        <Trash2 size={15} />
        {presentation === "label" ? "删除任务" : null}
      </Button>
      <ActionDialog
        open={open}
        title="删除任务"
        description="删除后无法恢复，请确认要删除的任务。"
        onClose={() => setOpen(false)}
        closeDisabled={pending}
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
            {failure?.refreshRequired ? (
              <Button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.refresh();
                }}
              >
                刷新任务
              </Button>
            ) : (
              <Button
                type="button"
                variant="destructive"
                loading={pending}
                disabled={pending}
                onClick={() => void deleteSuite()}
              >
                确认删除
              </Button>
            )}
          </>
        }
      >
        <p className="m-0 font-semibold [overflow-wrap:anywhere]">{suiteName}</p>
        <p className="mt-3 mb-0 text-sm leading-6 text-muted-foreground">
          仅删除任务及其执行计划。用例、历史执行记录、日志、产物和分析结果都会保留，
          正在执行的批次会继续运行。
        </p>
        {failure ? (
          <Notice tone="error" role="alert" className="mt-3">
            {failure.message}
          </Notice>
        ) : null}
      </ActionDialog>
    </>
  );
}
