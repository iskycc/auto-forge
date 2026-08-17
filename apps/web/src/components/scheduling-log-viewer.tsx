"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { TerminalLogViewer } from "@/components/terminal-log-viewer";
import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

type SchedulingEventType =
  | "batch_scheduled"
  | "run_assigned"
  | "attempt_claimed"
  | "attempt_completed"
  | "run_held_for_round"
  | "runner_metrics";

type SchedulingEvent = {
  id: string;
  batchId: string;
  runnerId?: string;
  executionRunId?: string;
  attemptId?: string;
  eventType: SchedulingEventType;
  message: string;
  payload?: Record<string, unknown>;
  recordedAt: string;
};

type SchedulingEventPage = {
  items: SchedulingEvent[];
  nextAfterId?: string;
};

const SCHEDULING_EVENT_CLASS: Record<SchedulingEventType, string> = {
  batch_scheduled: "scheduling-event-blue",
  run_assigned: "scheduling-event-green",
  attempt_claimed: "scheduling-event-blue",
  attempt_completed: "",
  run_held_for_round: "scheduling-event-yellow",
  runner_metrics: "scheduling-event-blue",
};

function schedulingEventClass(event: SchedulingEvent): string {
  if (event.eventType === "attempt_completed") {
    const outcome = event.payload?.outcome;
    return outcome === "succeeded" ? "scheduling-event-green" : "scheduling-event-red";
  }
  return SCHEDULING_EVENT_CLASS[event.eventType];
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 调度日志弹窗：批次级或单 Runner 级调度事件流，支持游标翻页与打开期间轮询。 */
export function SchedulingLogViewer({
  batchId,
  runnerId,
  title,
  onClose,
}: {
  batchId: string;
  runnerId: string | undefined;
  title: string;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<SchedulingEvent[]>([]);
  const [nextAfterId, setNextAfterId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement | null>(null);
  const lastEventIdRef = useRef<string | undefined>(undefined);

  const fetchPage = useCallback(
    async (afterId: string | undefined) => {
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({ limit: "200" });
        if (runnerId) parameters.set("runnerId", runnerId);
        if (afterId) parameters.set("afterId", afterId);
        const response = await fetch(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}/scheduling-events?${parameters}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          // readApiErrorMessage 仅在响应成功时返回 undefined，这里已排除该分支。
          throw new Error((await readApiErrorMessage(response, "读取调度日志失败。"))!);
        }
        const page = (await response.json()) as SchedulingEventPage;
        setEvents((current) => {
          const knownIds = new Set(current.map((event) => event.id));
          const additions = page.items.filter((event) => !knownIds.has(event.id));
          return additions.length > 0 ? [...current, ...additions] : current;
        });
        const newest = page.items.at(-1);
        if (newest) lastEventIdRef.current = newest.id;
        setNextAfterId(page.nextAfterId);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "读取调度日志失败。");
      } finally {
        setLoading(false);
      }
    },
    [batchId, runnerId],
  );

  // 首次加载与打开期间的增量轮询合并为一个 effect：
  // 通过 setTimeout/setInterval 回调触发异步拉取，避免在 effect 体内同步 setState。
  useEffect(() => {
    const kick = window.setTimeout(() => void fetchPage(undefined), 0);
    const timer = window.setInterval(() => void fetchPage(lastEventIdRef.current), 3_000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [fetchPage]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [events]);

  return (
    <TerminalLogViewer title={title} onClose={onClose}>
      {error ? <p className="form-error">{error}</p> : null}
      <pre
        className="execution-log execution-log-dark scheduling-log"
        aria-live="polite"
        ref={logRef}
      >
        {events.length > 0
          ? events.map((event) => (
              <span className={`scheduling-event ${schedulingEventClass(event)}`} key={event.id}>
                <span className="ansi-bright-black">[{formatEventTime(event.recordedAt)}]</span>{" "}
                {event.message}
                {"\n"}
              </span>
            ))
          : loading
            ? "正在读取调度日志..."
            : "暂无调度日志"}
      </pre>
      {nextAfterId !== undefined ? (
        <Button
          className="button button-secondary compact-button"
          disabled={loading}
          onClick={() => void fetchPage(nextAfterId)}
          type="button"
        >
          <RefreshCw size={15} /> 加载更多
        </Button>
      ) : null}
    </TerminalLogViewer>
  );
}
