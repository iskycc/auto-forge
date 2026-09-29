"use client";

import { Flex, Progress, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { DdtScope } from "@autoforge/domain";
import { Button } from "./ui";
import { Notice } from "./ui/notice";
import { debugRequest } from "@/lib/case-debug-client";

type ImportProgress = {
  status: string;
  progressPercent: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorSummary?: string;
  files?: Array<{ id: string; fileName: string; errorSummary?: string }>;
};
const terminalStates = new Set(["succeeded", "failed", "cancelled", "partially_succeeded"]);

export function CaseDebugImportProgress({
  jobId,
  scope,
  active,
  onComplete,
}: {
  jobId: string;
  scope: DdtScope;
  active: boolean;
  onComplete(): void;
}) {
  const [job, setJob] = useState<ImportProgress>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const completed = useRef(false);
  const url = `/api/v1/case-debug/ddt/imports/${encodeURIComponent(jobId)}?${new URLSearchParams(scope)}`;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    let terminal = false;
    async function poll() {
      if (inFlight || document.hidden || controller.signal.aborted) return;
      inFlight = true;
      try {
        const current = await debugRequest<ImportProgress>(url, { signal: controller.signal });
        setJob(current);
        setError("");
        terminal = terminalStates.has(current.status);
        if (terminal && !completed.current) {
          completed.current = true;
          if (current.status === "succeeded") onComplete();
        }
      } catch (problem) {
        if (!controller.signal.aborted)
          setError(problem instanceof Error ? problem.message : "导入进度读取失败。");
      } finally {
        inFlight = false;
        if (!terminal && !controller.signal.aborted) timer = setTimeout(() => void poll(), 2_000);
      }
    }
    function resume() {
      if (!document.hidden && !terminal) {
        clearTimeout(timer);
        void poll();
      }
    }
    void poll();
    document.addEventListener("visibilitychange", resume);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [url, active, onComplete, refresh]);
  async function cancel() {
    setCancelling(true);
    try {
      const target = new URL(url, window.location.origin);
      target.pathname += "/cancel";
      await debugRequest(target.toString(), { method: "POST" });
      setRefresh((value) => value + 1);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "取消导入失败。");
    } finally {
      setCancelling(false);
    }
  }
  const terminal = job && terminalStates.has(job.status);
  return (
    <div className="grid gap-2" aria-label="调试表格导入进度">
      <Flex gap="small" justify="space-between" align="center">
        <Typography.Text>
          {job?.status === "succeeded"
            ? `导入完成：新增 ${job.insertedCount}，更新 ${job.updatedCount}，跳过 ${job.skippedCount}`
            : job?.status === "cancelled"
              ? "导入已取消"
              : terminal
                ? "导入未完成，请检查导入任务"
                : "正在后台导入个人调试库…"}
        </Typography.Text>
        {!terminal ? (
          <Button
            disabled={cancelling || job?.status === "cancel_requested"}
            onClick={() => void cancel()}
          >
            取消导入
          </Button>
        ) : null}
      </Flex>
      {!terminal ? <Progress percent={job?.progressPercent ?? 0} size="small" /> : null}
      {job?.files
        ?.filter((file) => file.errorSummary)
        .map((file) => (
          <Notice key={file.id} tone="error">
            {file.fileName}：{file.errorSummary}
          </Notice>
        ))}
      {job?.errorSummary || error ? (
        <Notice tone="error">
          {job?.errorSummary ?? error}
          <Button onClick={() => setRefresh((value) => value + 1)}>重试读取</Button>
        </Notice>
      ) : null}
    </div>
  );
}
