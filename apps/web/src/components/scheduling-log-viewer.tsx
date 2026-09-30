"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Input } from "antd";
import type { SchedulingEvent, SchedulingEventType } from "@autoforge/domain";
import { TerminalLogViewer } from "@/components/terminal-log-viewer";
import { Button } from "@/components/ui";
import { Notice } from "@/components/ui/notice";
import { uiPatterns } from "@/components/ui/patterns";
import { cn } from "@/lib/utils";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformTime } from "@/lib/platform-date-time";
import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";

const PAGE_SIZE = 500;
const ROW_HEIGHT_PX = 22;
const OVERSCAN_ROWS = 24;
const REFRESH_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;

type EventPage = { items: SchedulingEvent[]; nextBeforeId?: string; nextAfterId?: string };
type Cursor = { latest: true } | { beforeId: string } | { afterId: string };

const EVENT_CLASS: Record<SchedulingEventType, string> = {
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
    return event.payload?.outcome === "succeeded"
      ? "scheduling-event-green"
      : "scheduling-event-red";
  }
  return EVENT_CLASS[event.eventType];
}

function formatEventTime(value: string): string {
  return Number.isNaN(Date.parse(value)) ? "--:--:--" : formatPlatformTime(value);
}

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
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState({ query: "", revision: 0 });
  const { query } = search;
  return (
    <TerminalLogViewer title={title} onClose={onClose}>
      <form
        className="flex min-w-0 shrink-0 items-center gap-2 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch((previous) => ({ query: draft.trim(), revision: previous.revision + 1 }));
        }}
      >
        <Input
          aria-label="搜索调度日志"
          placeholder="输入日志任意片段，点击搜索（不区分英文大小写）"
          maxLength={256}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit">搜索</Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!draft && !query}
          onClick={() => {
            setDraft("");
            setSearch((previous) => ({ query: "", revision: previous.revision + 1 }));
          }}
        >
          清空搜索
        </Button>
      </form>
      <SchedulingLogWindow
        key={JSON.stringify([batchId, runnerId, query, search.revision])}
        batchId={batchId}
        runnerId={runnerId}
        query={query}
      />
    </TerminalLogViewer>
  );
}

/** Keep one cursor page in memory. Opening a dialog must never drain its full history. */
function SchedulingLogWindow({
  batchId,
  runnerId,
  query,
}: {
  batchId: string;
  runnerId: string | undefined;
  query: string;
}) {
  const cacheKey = `scheduling-events:v2:${JSON.stringify([batchId, runnerId, query])}`;
  const [cacheEpoch] = useState(browserCacheEpoch);
  const [page, setPage] = useState<EventPage>(
    () => (readBrowserSnapshot(cacheKey) as EventPage | undefined) ?? { items: [] },
  );
  const [cursor, setCursor] = useState<Cursor>({ latest: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const logRef = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const live = "latest" in cursor;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(initial: boolean) {
      // Historical pages and a scrolled-up live view remain stable while being read.
      if (!initial && (document.hidden || !followTail.current)) {
        timer = setTimeout(() => void load(false), REFRESH_INTERVAL_MS);
        return;
      }
      if (initial) setLoading(true);
      try {
        const parameters = new URLSearchParams({
          limit: String(PAGE_SIZE),
          ...Object.fromEntries(
            Object.entries(cursor).map(([name, value]) => [name, String(value)]),
          ),
        });
        if (runnerId) parameters.set("runnerId", runnerId);
        if (query) parameters.set("query", query);
        const response = await fetch(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}/scheduling-events?${parameters}`,
          {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          },
        );
        if (!response.ok)
          throw new Error((await readApiErrorMessage(response, "读取调度日志失败。"))!);
        const result = (await response.json()) as EventPage;
        if (controller.signal.aborted) return;
        // Only the completion outcome is used for presentation; resource snapshots are not cached twice.
        const next = {
          ...result,
          items: result.items.map(({ payload, ...event }) => ({
            ...event,
            ...(event.eventType === "attempt_completed"
              ? { payload: { outcome: payload?.outcome } }
              : {}),
          })),
        };
        setPage((previous) =>
          previous.items.length === next.items.length &&
          previous.items[0]?.id === next.items[0]?.id &&
          previous.items.at(-1)?.id === next.items.at(-1)?.id
            ? previous
            : next,
        );
        if (live) writeBrowserSnapshot(cacheKey, next, cacheEpoch);
        setError("");
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof DOMException && failure.name === "TimeoutError"
              ? "读取调度日志超时，请重试；可关闭弹窗查看其他执行机。"
              : failure instanceof Error
                ? failure.message
                : "读取调度日志失败，请重试。",
          );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (live && !query) timer = setTimeout(() => void load(false), REFRESH_INTERVAL_MS);
        }
      }
    }
    void load(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [batchId, runnerId, query, cacheKey, cacheEpoch, cursor, live, revision]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const observer = new ResizeObserver(() => setViewportHeight(log.clientHeight));
    setViewportHeight(log.clientHeight);
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTop = live && followTail.current ? log.scrollHeight : 0;
    setScrollTop(log.scrollTop);
  }, [page, live]);

  const visibleRange = useMemo(() => {
    const first = Math.max(
      0,
      Math.min(page.items.length - 1, Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS),
    );
    return {
      first,
      last: Math.min(
        page.items.length,
        first + Math.ceil(viewportHeight / ROW_HEIGHT_PX) + OVERSCAN_ROWS * 2,
      ),
    };
  }, [page.items.length, scrollTop, viewportHeight]);
  const first = page.items[0];
  const last = page.items.at(-1);
  const hasOlder = "afterId" in cursor ? Boolean(first) : Boolean(page.nextBeforeId);
  function navigate(next: Cursor) {
    followTail.current = "latest" in next;
    // Returning to an unchanged latest page must still resume tail-following.
    if (followTail.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
      setScrollTop(logRef.current.scrollTop);
    }
    setCursor(next);
  }

  return (
    <>
      <div
        className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pb-3 text-xs text-muted-foreground"
        role="status"
      >
        <span>
          {loading
            ? "正在读取调度日志…"
            : `${query ? "搜索结果" : live ? "最新日志" : "历史浏览"} · 当前 ${page.items.length} 条`}{" "}
          · 每次最多 {PAGE_SIZE} 条
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="compact"
            variant="secondary"
            disabled={loading || !hasOlder || !first}
            onClick={() => first && navigate({ beforeId: first.id })}
          >
            更早日志
          </Button>
          <Button
            type="button"
            size="compact"
            variant="secondary"
            disabled={loading || live || !last || ("afterId" in cursor && !page.nextAfterId)}
            onClick={() => last && navigate({ afterId: last.id })}
          >
            更新日志
          </Button>
          <Button
            type="button"
            size="compact"
            variant="secondary"
            disabled={loading}
            onClick={() => navigate({ latest: true })}
          >
            返回最新
          </Button>
        </div>
      </div>
      {error ? (
        <Notice tone="error" className="mx-4 mb-3">
          <span>{error}</span>
          <Button
            type="button"
            size="compact"
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </Button>
        </Notice>
      ) : null}
      <div
        className={cn(
          "execution-log scheduling-log",
          uiPatterns["execution-log"],
          "[&_.scheduling-event]:block [&_.scheduling-event]:h-5.5 [&_.scheduling-event]:leading-[22px] [&_.scheduling-event-green]:text-success [&_.scheduling-event-red]:text-destructive [&_.scheduling-event-yellow]:text-warning [&_.scheduling-event-blue]:text-info",
        )}
        ref={logRef}
        role="log"
        aria-live="off"
        aria-busy={loading}
        tabIndex={0}
        onScroll={(event) => {
          const log = event.currentTarget;
          setScrollTop(log.scrollTop);
          followTail.current =
            log.scrollHeight - log.scrollTop - log.clientHeight <= ROW_HEIGHT_PX * 2;
        }}
      >
        {page.items.length ? (
          <div
            className="relative min-w-full"
            style={{ height: page.items.length * ROW_HEIGHT_PX }}
          >
            <div
              className="absolute top-0 left-0 w-max min-w-full"
              style={{ transform: `translateY(${visibleRange.first * ROW_HEIGHT_PX}px)` }}
            >
              {page.items.slice(visibleRange.first, visibleRange.last).map((event) => (
                <div className={`scheduling-event ${schedulingEventClass(event)}`} key={event.id}>
                  <span className="text-muted-foreground">
                    [{formatEventTime(event.recordedAt)}]
                  </span>{" "}
                  {event.message}
                </div>
              ))}
            </div>
          </div>
        ) : loading ? (
          "正在读取调度日志..."
        ) : error ? (
          "调度日志暂不可用，请重试。"
        ) : query ? (
          "未找到匹配的调度日志"
        ) : (
          "暂无调度日志"
        )}
      </div>
    </>
  );
}
