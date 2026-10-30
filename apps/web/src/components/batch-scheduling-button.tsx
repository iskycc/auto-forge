"use client";

import { useState } from "react";
import { Pause, Play } from "lucide-react";
import type { RunBatch } from "@autoforge/domain";
import { Button } from "./ui";
import { useToast } from "./ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";

export function BatchSchedulingButton({
  batch,
  endpoint,
  onChanged,
  disabled = false,
  compact = false,
}: {
  batch: Pick<RunBatch, "id" | "pauseRequestedAt" | "terminationRequestedAt">;
  endpoint?: string;
  onChanged: () => void | Promise<void>;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const action = batch.pauseRequestedAt ? "resume" : "pause";
  async function change() {
    setPending(true);
    try {
      const response = await fetch(
        endpoint ?? `/api/v1/run-batches/${encodeURIComponent(batch.id)}/scheduling`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "调整任务调度失败。"))!);
      await onChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "调整任务调度失败。");
    } finally {
      setPending(false);
    }
  }
  return (
    <Button
      type="button"
      variant="secondary"
      {...(compact ? { size: "compact" as const } : {})}
      disabled={disabled || pending || Boolean(batch.terminationRequestedAt)}
      title={
        action === "pause"
          ? "停止新的调度，已下发的用例继续执行至完成。"
          : "从剩余用例及重试继续调度，不重跑已完成结果。"
      }
      onClick={() => void change()}
    >
      {action === "pause" ? (
        <Pause size={compact ? 14 : 16} aria-hidden="true" />
      ) : (
        <Play size={compact ? 14 : 16} aria-hidden="true" />
      )}
      {pending ? "正在提交…" : action === "pause" ? "暂停任务" : "继续调度"}
    </Button>
  );
}
