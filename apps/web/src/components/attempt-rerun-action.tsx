"use client";

import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import type { RunAttempt } from "@autoforge/domain";

import { readApiErrorMessage } from "@/lib/client-api";
import { Button } from "./ui";
import { useToast } from "./ui-feedback";

export function AttemptRerunAction({
  attemptId,
  compact = false,
  onOpenLiveLogs,
  onRerunAttemptAvailable,
}: {
  attemptId: string;
  compact?: boolean;
  onOpenLiveLogs?: (attempt: LiveLogAttempt) => void;
  /** 新 attempt 持久化后通知宿主刷新其执行历史快照。 */
  onRerunAttemptAvailable?: (attempt: LiveLogAttempt) => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [trackingBatchId, setTrackingBatchId] = useState("");
  const [liveAttempt, setLiveAttempt] = useState<LiveLogAttempt | null>(null);

  useEffect(() => {
    if (!trackingBatchId || liveAttempt || (!onOpenLiveLogs && !onRerunAttemptAvailable)) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/v1/case-log-reruns/${encodeURIComponent(trackingBatchId)}/log-target`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error((await readApiErrorMessage(response, "查询手动执行状态失败。"))!);
        }
        const target = (await response.json()) as CaseLogRerunTargetResponse;
        if (disposed) return;
        if (target.attempt) {
          setLiveAttempt(target.attempt);
          onRerunAttemptAvailable?.(target.attempt);
          toast.success("手动执行已经调度，可以查看实时日志。");
          return;
        }
        if (["succeeded", "failed", "cancelled"].includes(target.batchStatus)) {
          toast.warning("手动执行已结束，但没有生成可查看的执行日志。");
          return;
        }
        timer = window.setTimeout(() => void poll(), 1_500);
      } catch (cause) {
        if (disposed) return;
        toast.error(cause instanceof Error ? cause.message : "查询手动执行状态失败。");
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [liveAttempt, onOpenLiveLogs, onRerunAttemptAvailable, toast, trackingBatchId]);

  async function rerunCase(): Promise<void> {
    setPending(true);
    try {
      const response = await fetch(`/api/v1/run-attempts/${encodeURIComponent(attemptId)}/rerun`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "执行此用例失败。"))!);
      }
      const target = (await response.json()) as CaseLogRerunTargetResponse;
      setTrackingBatchId(target.batchId);
      setLiveAttempt(target.attempt);
      if (target.attempt) onRerunAttemptAvailable?.(target.attempt);
      toast.info(
        target.attempt
          ? "手动执行已经调度，可以查看实时日志。"
          : "已提交手动执行，正在等待调度；实时日志入口会自动出现。",
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "执行此用例失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={`attempt-rerun-action${compact ? " compact" : ""}`}>
      <Button
        className={`button button-primary${compact ? " compact-button" : ""}`}
        disabled={pending}
        onClick={() => void rerunCase()}
        type="button"
      >
        <RotateCcw size={15} />
        {pending ? "正在提交…" : "执行此用例"}
      </Button>
      {liveAttempt && onOpenLiveLogs ? (
        <Button
          className="button button-primary compact-button"
          onClick={() => onOpenLiveLogs(liveAttempt)}
          type="button"
          variant="primary"
        >
          查看实时日志
        </Button>
      ) : null}
    </div>
  );
}

export type LiveLogAttempt = Pick<RunAttempt, "id" | "status">;

type CaseLogRerunTargetResponse = {
  batchId: string;
  batchStatus: string;
  attempt: LiveLogAttempt | null;
};
