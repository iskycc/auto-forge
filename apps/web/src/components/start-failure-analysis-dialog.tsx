"use client";

import {
  failureAnalysisBatchPageSchema,
  type FailureAnalysisBatchPage,
} from "@autoforge/contracts";
import { LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { StartFailureAnalysisButton } from "@/components/start-failure-analysis-button";
import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

export function StartFailureAnalysisDialog({
  projectId,
  projectVersionId,
}: {
  projectId: string;
  projectVersionId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<FailureAnalysisBatchPage>({ items: [] });
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  function close() {
    request.current?.abort();
    setOpen(false);
  }

  async function load(cursor?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({
        projectId,
        projectVersionId,
        view: "available",
        limit: "10",
      });
      if (cursor) parameters.set("cursor", cursor);
      const response = await fetch(`/api/v1/failure-analysis/batches?${parameters}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const message = await readApiErrorMessage(response, "读取最近执行失败。");
      if (message) throw new Error(message);
      const receivedPage = failureAnalysisBatchPageSchema.parse(await response.json());
      if (!controller.signal.aborted) setPage(receivedPage);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "读取最近执行失败。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
          setCursorHistory([]);
          void load();
        }}
        type="button"
        variant="primary"
      >
        <Plus size={16} /> 新建分析任务
      </Button>
      <ActionDialog
        open={open}
        onClose={close}
        title="选择执行任务开始分析"
        description="最近已结束且最后一轮仍有失败用例的任务；每次执行只创建一张共享分析卡片。"
        className="failure-analysis-start-dialog"
      >
        {loading ? (
          <p role="status">
            <LoaderCircle className="spin" size={16} /> 正在读取最近执行…
          </p>
        ) : error ? (
          <div role="alert">
            {error}
            <Button onClick={() => void load(cursorHistory.at(-1))}>重试</Button>
          </div>
        ) : page.items.length === 0 ? (
          <div className="empty-state">
            <strong>没有可新增的分析任务</strong>
            <p>全部已开始分析，或当前版本没有符合条件的执行。</p>
          </div>
        ) : (
          <div className="failure-analysis-start-list">
            {page.items.map((batch) => (
              <article className="failure-analysis-start-row" key={batch.id}>
                <div>
                  <strong>
                    #{batch.sequenceNumber} · {batch.suiteName}
                  </strong>
                  <span>
                    {formatPlatformDateTime(batch.createdAt)} · 第 {batch.currentRound} 轮 ·
                    最终失败 {batch.failedRuns}
                  </span>
                </div>
                <StartFailureAnalysisButton
                  scope={{ projectId, projectVersionId, batchId: batch.id }}
                  onStarted={() => {
                    close();
                    router.refresh();
                  }}
                />
              </article>
            ))}
          </div>
        )}
        <div className="button-row">
          <Button
            disabled={loading || cursorHistory.length === 0}
            onClick={() => {
              const history = cursorHistory.slice(0, -1);
              setCursorHistory(history);
              void load(history.at(-1));
            }}
          >
            上一页
          </Button>
          <Button
            disabled={loading || !page.nextCursor}
            onClick={() => {
              setCursorHistory((history) => [...history, page.nextCursor]);
              void load(page.nextCursor);
            }}
          >
            更早执行
          </Button>
        </div>
      </ActionDialog>
    </>
  );
}
