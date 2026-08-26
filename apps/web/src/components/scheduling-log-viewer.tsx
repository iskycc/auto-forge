"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TerminalLogViewer } from "@/components/terminal-log-viewer";
import { readApiErrorMessage } from "@/lib/client-api";

type SchedulingEventType =
  | "batch_scheduled"
  | "run_assigned"
  | "attempt_claimed"
  | "attempt_completed"
  | "run_held_for_round"
  | "retry_concurrency_changed"
  | "runner_fault_rescheduled"
  | "round_recovery"
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
  nextBeforeId?: string;
};

type SchedulingEventCacheEntry = {
  events: SchedulingEvent[];
  nextBeforeId?: string;
  historyComplete: boolean;
};

const SCHEDULING_EVENT_PAGE_SIZE = 500;
const SCHEDULING_EVENT_ROW_HEIGHT_PX = 22;
const SCHEDULING_EVENT_OVERSCAN_ROWS = 24;
const MAXIMUM_SCHEDULING_EVENT_CACHE_ENTRIES = 6;
const schedulingEventCache = new Map<string, SchedulingEventCacheEntry>();

const SCHEDULING_EVENT_CLASS: Record<SchedulingEventType, string> = {
  batch_scheduled: "scheduling-event-blue",
  run_assigned: "scheduling-event-green",
  attempt_claimed: "scheduling-event-blue",
  attempt_completed: "",
  run_held_for_round: "scheduling-event-yellow",
  retry_concurrency_changed: "scheduling-event-yellow",
  runner_fault_rescheduled: "scheduling-event-red",
  round_recovery: "scheduling-event-blue",
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

function schedulingCacheKey(batchId: string, runnerId: string | undefined): string {
  return `${batchId}:${runnerId ?? "all"}`;
}

function readSchedulingEventCache(key: string): SchedulingEventCacheEntry | undefined {
  const cached = schedulingEventCache.get(key);
  if (!cached) return undefined;
  schedulingEventCache.delete(key);
  schedulingEventCache.set(key, cached);
  return cached;
}

function writeSchedulingEventCache(key: string, entry: SchedulingEventCacheEntry): void {
  schedulingEventCache.delete(key);
  schedulingEventCache.set(key, entry);
  while (schedulingEventCache.size > MAXIMUM_SCHEDULING_EVENT_CACHE_ENTRIES) {
    const oldestKey = schedulingEventCache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    schedulingEventCache.delete(oldestKey);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * 调度日志弹窗首先读取最新一页并定位末尾，随后自动反向补齐历史。事件数据可以完整保留，
 * 但视图只渲染当前可见窗口，避免大批次生成无界 DOM。
 */
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
  const cacheKey = schedulingCacheKey(batchId, runnerId);
  const [initialCache] = useState(() => readSchedulingEventCache(cacheKey));
  const [events, setEvents] = useState<SchedulingEvent[]>(initialCache?.events ?? []);
  const [loadingHistory, setLoadingHistory] = useState(initialCache?.historyComplete !== true);
  const [error, setError] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const logRef = useRef<HTMLDivElement | null>(null);
  const eventsRef = useRef(initialCache?.events ?? []);
  const knownEventIdsRef = useRef(new Set((initialCache?.events ?? []).map((event) => event.id)));
  const nextBeforeIdRef = useRef(initialCache?.nextBeforeId);
  const historyCompleteRef = useRef(initialCache?.historyComplete === true);
  const followTailRef = useRef(true);
  const prependedRowsRef = useRef(0);

  const persistCache = useCallback(() => {
    writeSchedulingEventCache(cacheKey, {
      events: eventsRef.current,
      ...(nextBeforeIdRef.current ? { nextBeforeId: nextBeforeIdRef.current } : {}),
      historyComplete: historyCompleteRef.current,
    });
  }, [cacheKey]);

  const applyPage = useCallback(
    (incoming: SchedulingEvent[], direction: "older" | "newer" | "replace") => {
      const additions = incoming.filter((event) => {
        if (knownEventIdsRef.current.has(event.id)) return false;
        knownEventIdsRef.current.add(event.id);
        return true;
      });
      if (additions.length === 0) return;
      const next =
        direction === "replace"
          ? additions
          : direction === "older"
            ? [...additions, ...eventsRef.current]
            : [...eventsRef.current, ...additions];
      if (direction === "older") prependedRowsRef.current += additions.length;
      eventsRef.current = next;
      setEvents(next);
      persistCache();
    },
    [persistCache],
  );

  const fetchPage = useCallback(
    async (
      cursor: { latest?: true; beforeId?: string; afterId?: string },
      signal: AbortSignal,
    ): Promise<SchedulingEventPage> => {
      const parameters = new URLSearchParams({ limit: String(SCHEDULING_EVENT_PAGE_SIZE) });
      if (runnerId) parameters.set("runnerId", runnerId);
      if (cursor.latest) parameters.set("latest", "true");
      if (cursor.beforeId) parameters.set("beforeId", cursor.beforeId);
      if (cursor.afterId) parameters.set("afterId", cursor.afterId);
      const response = await fetch(
        `/api/v1/run-batches/${encodeURIComponent(batchId)}/scheduling-events?${parameters}`,
        { cache: "no-store", signal },
      );
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "读取调度日志失败。"))!);
      }
      return (await response.json()) as SchedulingEventPage;
    },
    [batchId, runnerId],
  );

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const loadCompleteHistory = async () => {
      setLoadingHistory(!historyCompleteRef.current);
      setError("");
      try {
        if (eventsRef.current.length === 0) {
          const latest = await fetchPage({ latest: true }, controller.signal);
          if (disposed) return;
          applyPage(latest.items, "replace");
          nextBeforeIdRef.current = latest.nextBeforeId;
          historyCompleteRef.current = latest.nextBeforeId === undefined;
          persistCache();
        }
        while (!disposed && nextBeforeIdRef.current) {
          const previous = await fetchPage(
            { beforeId: nextBeforeIdRef.current },
            controller.signal,
          );
          if (disposed) return;
          applyPage(previous.items, "older");
          nextBeforeIdRef.current = previous.nextBeforeId;
          historyCompleteRef.current = previous.nextBeforeId === undefined;
          persistCache();
        }
      } catch (loadError) {
        if (!isAbortError(loadError)) {
          setError(loadError instanceof Error ? loadError.message : "读取调度日志失败。");
        }
      } finally {
        if (!disposed) setLoadingHistory(false);
      }
    };
    void loadCompleteHistory();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [applyPage, fetchPage, persistCache]);

  useEffect(() => {
    const controller = new AbortController();
    let requestRunning = false;
    const poll = async () => {
      if (requestRunning) return;
      requestRunning = true;
      try {
        const newest = eventsRef.current.at(-1);
        if (!newest) {
          const latest = await fetchPage({ latest: true }, controller.signal);
          applyPage(latest.items, "replace");
          return;
        }
        let afterId: string | undefined = newest.id;
        while (afterId) {
          const page = await fetchPage({ afterId }, controller.signal);
          applyPage(page.items, "newer");
          afterId = page.nextAfterId;
        }
      } catch (pollError) {
        if (!isAbortError(pollError)) {
          setError(pollError instanceof Error ? pollError.message : "刷新调度日志失败。");
        }
      } finally {
        requestRunning = false;
      }
    };
    // Cached rows render synchronously on reopen; refresh only the delta in the
    // background so the dialog never presents stale tail state for three seconds.
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [applyPage, fetchPage]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const updateHeight = () => setViewportHeight(log.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    if (followTailRef.current) {
      log.scrollTop = log.scrollHeight;
    } else if (prependedRowsRef.current > 0) {
      log.scrollTop += prependedRowsRef.current * SCHEDULING_EVENT_ROW_HEIGHT_PX;
    }
    prependedRowsRef.current = 0;
    setScrollTop(log.scrollTop);
  }, [events]);

  const visibleRange = useMemo(() => {
    const first = Math.max(
      0,
      Math.floor(scrollTop / SCHEDULING_EVENT_ROW_HEIGHT_PX) - SCHEDULING_EVENT_OVERSCAN_ROWS,
    );
    const count =
      Math.ceil(viewportHeight / SCHEDULING_EVENT_ROW_HEIGHT_PX) +
      SCHEDULING_EVENT_OVERSCAN_ROWS * 2;
    return { first, last: Math.min(events.length, first + count) };
  }, [events.length, scrollTop, viewportHeight]);
  const visibleEvents = events.slice(visibleRange.first, visibleRange.last);

  return (
    <TerminalLogViewer title={title} onClose={onClose}>
      {error ? <p className="form-error">{error}</p> : null}
      {loadingHistory ? (
        <p className="scheduling-log-status" role="status">
          正在自动同步历史调度日志，已加载 {events.length} 条…
        </p>
      ) : null}
      <div
        className="execution-log execution-log-dark scheduling-log"
        aria-live="polite"
        ref={logRef}
        role="log"
        onScroll={(event) => {
          const log = event.currentTarget;
          setScrollTop(log.scrollTop);
          followTailRef.current =
            log.scrollHeight - log.scrollTop - log.clientHeight <=
            SCHEDULING_EVENT_ROW_HEIGHT_PX * 2;
        }}
      >
        {events.length > 0 ? (
          <div
            className="scheduling-log-window"
            style={{ height: events.length * SCHEDULING_EVENT_ROW_HEIGHT_PX }}
          >
            <div
              className="scheduling-log-visible-rows"
              style={{
                transform: `translateY(${visibleRange.first * SCHEDULING_EVENT_ROW_HEIGHT_PX}px)`,
              }}
            >
              {visibleEvents.map((event) => (
                <div className={`scheduling-event ${schedulingEventClass(event)}`} key={event.id}>
                  <span className="ansi-bright-black">[{formatEventTime(event.recordedAt)}]</span>{" "}
                  {event.message}
                </div>
              ))}
            </div>
          </div>
        ) : loadingHistory ? (
          "正在读取调度日志..."
        ) : (
          "暂无调度日志"
        )}
      </div>
    </TerminalLogViewer>
  );
}
