"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ReadModelStatus } from "@autoforge/contracts";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { requestReadModelRefresh } from "@/lib/read-model-refresh";
import { Button } from "./ui";
import { Notice } from "./ui/notice";

const PREPARATION_NOTICE_DELAY_MS = 120_000;

export function ExecutionStatisticsStatus({
  statistics,
  canRefresh,
  onRefresh,
}: {
  statistics: ReadModelStatus;
  canRefresh: boolean;
  onRefresh: (signal: AbortSignal) => Promise<void>;
}) {
  const [delayedId, setDelayedId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  const waiting = statistics.generation === null;
  const failed = statistics.state === "failed";
  const delayed = delayedId === statistics.id;
  useEffect(() => {
    if (!waiting || failed) return;
    const timer = window.setTimeout(() => setDelayedId(statistics.id), PREPARATION_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [statistics.id, waiting, failed]);
  useEffect(() => () => controller.current?.abort(), []);

  async function refresh(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError("");
    const refreshController = new AbortController();
    controller.current = refreshController;
    const signal = AbortSignal.any([refreshController.signal, AbortSignal.timeout(15_000)]);
    try {
      await requestReadModelRefresh([statistics.id], signal);
      await onRefresh(signal);
    } catch (cause) {
      if (!refreshController.signal.aborted)
        setError(
          cause instanceof Error && cause.name === "TimeoutError"
            ? "请求统计更新超时，请检查连接后重试。"
            : cause instanceof Error
              ? cause.message
              : "重新生成统计失败，请稍后重试。",
        );
    } finally {
      if (!refreshController.signal.aborted) setPending(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p role="status" className="m-0 min-w-0">
          {failed
            ? "轮次统计生成失败"
            : waiting && delayed
              ? "轮次统计准备时间较长"
              : statistics.generatedAt
                ? `轮次统计更新于 ${formatLocalDateTime(statistics.generatedAt)}`
                : "正在准备轮次统计"}
          {failed || (waiting && delayed)
            ? canRefresh
              ? "，可重新生成；执行记录和控制仍可使用。"
              : "，请联系有权限的用户重新生成。"
            : statistics.state !== "ready"
              ? " · 后台更新中"
              : ""}
        </p>
        {canRefresh && (failed || (waiting && delayed)) ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            loading={pending}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} /> 重新生成统计
          </Button>
        ) : null}
      </div>
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
