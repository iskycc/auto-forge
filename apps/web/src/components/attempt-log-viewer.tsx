"use client";
import { EmptyState } from "@/components/ui/empty-state";

import { Segmented } from "./ui/segmented";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { AttemptLogPage, LogChunk } from "@autoforge/contracts";
import type { RunAttempt } from "@autoforge/domain";
import { isTerminalAttemptStatus } from "@autoforge/domain";
import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TerminalLogViewer } from "@/components/terminal-log-viewer";
import { AttemptRerunAction, type LiveLogAttempt } from "@/components/attempt-rerun-action";
import { Button, DatetimeInput, Input } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { visibleAttemptLogText } from "@/lib/log-presentation";
import { highlightLogLevels } from "@/lib/log-levels";
import { parseSafeAnsi } from "@/lib/safe-ansi";
import { platformDateTimeInputToIso } from "@/lib/platform-date-time";
import { useColorMode } from "./ant-design-provider";
import type { ColorMode } from "@/lib/color-mode";
import { lightLogVariables } from "@/lib/ant-design-theme";

type LogStream = "stdout" | "stderr" | "agent";

function streamLabel(stream: LogStream): string {
  return { stdout: "标准输出", stderr: "错误输出", agent: "Agent 诊断" }[stream];
}

function parseLiveLogMessage(value: unknown, attemptId: string): { chunks: LogChunk[] } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: unknown;
      type?: unknown;
      chunks?: unknown;
      attemptId?: unknown;
    };
    if (
      parsed.schemaVersion !== 1 ||
      parsed.type !== "chunks" ||
      parsed.attemptId !== attemptId ||
      !Array.isArray(parsed.chunks)
    ) {
      return null;
    }
    const chunks = parsed.chunks.filter(
      (chunk): chunk is LogChunk =>
        typeof chunk === "object" &&
        chunk !== null &&
        ["stdout", "stderr", "agent"].includes(String((chunk as LogChunk).stream)) &&
        Number.isInteger((chunk as LogChunk).sequence) &&
        typeof (chunk as LogChunk).content === "string" &&
        typeof (chunk as LogChunk).recordedAt === "string",
    );
    return { chunks };
  } catch {
    return null;
  }
}

function mergeLogChunks(current: LogChunk[], incoming: LogChunk[]): LogChunk[] {
  const bySequence = new Map(current.map((chunk) => [chunk.sequence, chunk]));
  for (const chunk of incoming) bySequence.set(chunk.sequence, chunk);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function toIsoFilter(value: string): string | undefined {
  return value ? platformDateTimeInputToIso(value) : undefined;
}

/**
 * 单个执行尝试的日志终端弹窗。仅持有日志相关状态：流切换、搜索与时间筛选、
 * 深浅色、分页加载；attempt 非终态时通过 WebSocket 接收实时日志块。
 */
export function AttemptLogViewer({
  attemptId,
  attemptStatus,
  batchTerminal = false,
  canReadLogs,
  canRetryRuns,
  onClose,
  logEndpoint,
  shareQuery = "",
  initialStream = "stdout",
}: {
  attemptId: string;
  attemptStatus: RunAttempt["status"];
  batchTerminal?: boolean;
  canReadLogs: boolean;
  canRetryRuns: boolean;
  onClose: () => void;
  /** A scoped, read-only log source; execution and live-stream endpoints stay unchanged. */
  logEndpoint?: string;
  shareQuery?: string;
  initialStream?: LogStream;
}) {
  const [stream, setStream] = useState<LogStream>(initialStream);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [recordedAfter, setRecordedAfter] = useState("");
  const [recordedBefore, setRecordedBefore] = useState("");
  const [activeTimeRange, setActiveTimeRange] = useState({ after: "", before: "" });
  const { colorMode } = useColorMode();
  const [logColorMode, setLogColorMode] = useState<ColorMode>();
  const darkLogs = (logColorMode ?? colorMode) === "dark";
  const [logs, setLogs] = useState<AttemptLogPage["items"]>([]);
  const [nextSequence, setNextSequence] = useState<number | undefined>();
  const [logsTruncated, setLogsTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [liveLogs, setLiveLogs] = useState(false);
  const [error, setError] = useState("");
  const pendingLogReads = useRef(new Set<AbortController>());
  const [activeAttempt, setActiveAttempt] = useState<LiveLogAttempt>({
    id: attemptId,
    status: attemptStatus,
  });
  const viewingManualRerun = activeAttempt.id !== attemptId;
  const attemptTerminal = isTerminalAttemptStatus(
    viewingManualRerun ? activeAttempt.status : attemptStatus,
  );

  const loadLogs = useCallback(
    async (
      selectedStream: LogStream,
      search: string,
      timeRange: { after: string; before: string },
      afterSequence: number,
    ) => {
      const controller = new AbortController();
      const pending = pendingLogReads.current;
      pending.add(controller);
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams(shareQuery);
        parameters.set("stream", selectedStream);
        parameters.set("afterSequence", String(afterSequence));
        parameters.set("limit", "200");
        if (search.trim()) parameters.set("query", search.trim());
        const afterTimestamp = toIsoFilter(timeRange.after);
        const beforeTimestamp = toIsoFilter(timeRange.before);
        if (afterTimestamp) parameters.set("recordedAfter", afterTimestamp);
        if (beforeTimestamp) parameters.set("recordedBefore", beforeTimestamp);
        const response = await fetch(
          logEndpoint
            ? `${logEndpoint}${logEndpoint.includes("?") ? "&" : "?"}${parameters}`
            : `/api/v1/run-attempts/${encodeURIComponent(activeAttempt.id)}/logs?${parameters}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error((await readApiErrorMessage(response, "读取日志失败。"))!);
        }
        const logPage = (await response.json()) as AttemptLogPage;
        if (controller.signal.aborted) return;
        setLogs((current) => mergeLogChunks(current, logPage.items));
        setNextSequence(logPage.nextSequence);
        setLogsTruncated(logPage.truncated);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "读取日志失败。");
      } finally {
        pending.delete(controller);
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [activeAttempt.id, logEndpoint, shareQuery],
  );

  useEffect(() => {
    if (!canReadLogs) return;
    const pending = pendingLogReads.current;
    const scheduledLoad = window.setTimeout(() => {
      setLogs([]);
      setNextSequence(undefined);
      setLogsTruncated(false);
      void loadLogs(stream, activeQuery, activeTimeRange, -1);
    }, 0);
    return () => {
      window.clearTimeout(scheduledLoad);
      // Requests from the previous stream, filters or attempt must not update this view.
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, [activeQuery, activeTimeRange, canReadLogs, loadLogs, stream]);

  useEffect(() => {
    if (
      !canReadLogs ||
      attemptTerminal ||
      (batchTerminal && !viewingManualRerun) ||
      activeQuery ||
      activeTimeRange.after ||
      activeTimeRange.before
    ) {
      return;
    }
    if (logEndpoint) return;
    const controller = new AbortController();
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let reconnects = 0;
    let connecting = false;
    const stop = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      socket?.close(1000, "Log view changed");
      socket = undefined;
    };
    const scheduleReconnect = (delay: number) => {
      if (controller.signal.aborted || document.hidden || reconnects >= 8) return;
      reconnects += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };
    const connect = async (): Promise<void> => {
      if (controller.signal.aborted || document.hidden || connecting || socket) return;
      connecting = true;
      try {
        const response = await fetch(
          `/api/v1/run-attempts/${encodeURIComponent(activeAttempt.id)}/log-stream-ticket${shareQuery ? `?${shareQuery}` : ""}`,
          {
            method: "POST",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          },
        );
        if (controller.signal.aborted || document.hidden) return;
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) scheduleReconnect(5_000);
          return;
        }
        const payload = (await response.json()) as { ticket?: string };
        if (!payload.ticket || controller.signal.aborted || document.hidden) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const connection = new WebSocket(
          `${protocol}//${window.location.host}/api/v1/log-stream`,
          `autoforge-log.${payload.ticket}`,
        );
        socket = connection;
        connection.onopen = () => {
          if (controller.signal.aborted || socket !== connection) return;
          setLiveLogs(true);
          void loadLogs(stream, "", { after: "", before: "" }, -1);
        };
        connection.onmessage = (event) => {
          if (controller.signal.aborted || socket !== connection) return;
          const message = parseLiveLogMessage(event.data, activeAttempt.id);
          if (!message) return;
          const incoming = message.chunks.filter((chunk) => chunk.stream === stream);
          if (incoming.length === 0) return;
          setLogs((current) => mergeLogChunks(current, incoming));
        };
        connection.onclose = () => {
          if (controller.signal.aborted || socket !== connection) return;
          socket = undefined;
          setLiveLogs(false);
          scheduleReconnect(2_000);
        };
        connection.onerror = () => connection.close();
      } catch {
        scheduleReconnect(5_000);
      } finally {
        connecting = false;
      }
    };
    const syncVisibility = () => {
      if (document.hidden) {
        stop();
        setLiveLogs(false);
      } else {
        reconnects = 0;
        void connect();
      }
    };
    document.addEventListener("visibilitychange", syncVisibility);
    void connect();
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", syncVisibility);
      stop();
      setLiveLogs(false);
    };
  }, [
    activeAttempt.id,
    activeQuery,
    activeTimeRange,
    attemptTerminal,
    batchTerminal,
    canReadLogs,
    loadLogs,
    logEndpoint,
    shareQuery,
    stream,
    viewingManualRerun,
  ]);

  const sequenceGaps = useMemo(() => {
    const gaps: Array<{ after: number; before: number }> = [];
    for (let index = 1; index < logs.length; index += 1) {
      const previous = logs[index - 1];
      const current = logs[index];
      if (previous && current && current.sequence > previous.sequence + 1) {
        gaps.push({ after: previous.sequence, before: current.sequence });
      }
    }
    return gaps;
  }, [logs]);
  const visibleLogText = useMemo(
    () => visibleAttemptLogText(logs.map((chunk) => chunk.content).join("")),
    [logs],
  );
  const renderedLogs = useMemo(
    () => highlightLogLevels(parseSafeAnsi(visibleLogText)),
    [visibleLogText],
  );

  return (
    <TerminalLogViewer
      title={`执行日志 · ${activeAttempt.id.slice(0, 8)} · ${streamLabel(stream)}${liveLogs ? " · 实时" : ""}`}
      onClose={onClose}
    >
      <div className={cn("log-toolbar", attemptLogViewerStyles["log-toolbar"])}>
        <Segmented
          label="日志流"
          value={stream}
          onChange={setStream}
          options={(["stdout", "stderr", "agent"] as const).map((value) => ({
            value,
            label: value,
          }))}
        />
        <form
          className={cn("log-search", attemptLogViewerStyles["log-search"])}
          onSubmit={(event) => {
            event.preventDefault();
            if (query === activeQuery) {
              void loadLogs(stream, activeQuery, activeTimeRange, -1);
            } else {
              setActiveQuery(query);
            }
            setActiveTimeRange({ after: recordedAfter, before: recordedBefore });
          }}
        >
          <Search size={15} />
          <Input
            aria-label="搜索日志"
            placeholder="搜索当前日志流"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className={cn("log-time-filter", attemptLogViewerStyles["log-time-filter"])}>
            <span>开始</span>
            <DatetimeInput
              aria-label="日志开始时间"
              value={recordedAfter}
              onChange={(event) => setRecordedAfter(event.target.value)}
            />
          </label>
          <label className={cn("log-time-filter", attemptLogViewerStyles["log-time-filter"])}>
            <span>结束</span>
            <DatetimeInput
              aria-label="日志结束时间"
              value={recordedBefore}
              onChange={(event) => setRecordedBefore(event.target.value)}
            />
          </label>
          <Button
            className={cn(
              "button button-secondary compact-button",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
              uiPatterns["compact-button"],
            )}
            type="submit"
          >
            筛选
          </Button>
        </form>
        <Button
          aria-pressed={darkLogs}
          className={cn(
            "button button-secondary compact-button",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
            uiPatterns["compact-button"],
          )}
          onClick={() => setLogColorMode(darkLogs ? "light" : "dark")}
          type="button"
        >
          {darkLogs ? "浅色日志" : "深色日志"}
        </Button>
        {viewingManualRerun ? (
          <Button
            className={cn(
              "button button-secondary compact-button",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
              uiPatterns["compact-button"],
            )}
            onClick={() => setActiveAttempt({ id: attemptId, status: attemptStatus })}
            type="button"
          >
            返回原日志
          </Button>
        ) : null}
        {canRetryRuns && attemptTerminal && !viewingManualRerun ? (
          <AttemptRerunAction attemptId={attemptId} compact onOpenLiveLogs={setActiveAttempt} />
        ) : null}
      </div>
      {error ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
          {error}
        </Notice>
      ) : null}
      <p
        className={cn("log-output-policy-note", attemptLogViewerStyles["log-output-policy-note"])}
        role="note"
      >
        测试日志不限制类名、包名或普通关键字；仅明确的 Bearer、密码、Token 与 API Key
        凭据格式执行安全保护。
      </p>
      {logsTruncated ? (
        <Notice
          tone="warning"
          className={cn("status-warning", attemptLogViewerStyles["status-warning"])}
          role="status"
        >
          日志已达到保留上限，后续内容被明确截断。
        </Notice>
      ) : null}
      {sequenceGaps.length > 0 ? (
        <Notice
          tone="warning"
          className={cn("status-warning", attemptLogViewerStyles["status-warning"])}
          role="status"
        >
          检测到 {sequenceGaps.length} 个序号缺口；Agent 补传后刷新即可恢复连续内容。
        </Notice>
      ) : null}
      {canReadLogs ? (
        <pre
          style={logColorMode === "light" ? lightLogVariables : undefined}
          className={cn(
            attemptLogViewerStyles["execution-log"],
            `execution-log ${darkLogs ? cn("execution-log-dark", attemptLogViewerStyles["execution-log-dark"]) : ""}`,
          )}
          aria-live="polite"
        >
          {visibleLogText
            ? renderedLogs.map((segment, index) => (
                <span className={segment.classes.join(" ")} key={index}>
                  {segment.text}
                </span>
              ))
            : loading
              ? "正在读取日志..."
              : "当前日志流暂无内容。"}
        </pre>
      ) : (
        <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
          当前账号没有读取执行日志的权限。
        </EmptyState>
      )}
      {nextSequence !== undefined ? (
        <Button
          className={cn(
            "button button-secondary compact-button",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
            uiPatterns["compact-button"],
          )}
          disabled={loading}
          onClick={() => void loadLogs(stream, activeQuery, activeTimeRange, nextSequence)}
          type="button"
        >
          <RefreshCw size={15} /> 加载更多
        </Button>
      ) : null}
    </TerminalLogViewer>
  );
}

const attemptLogViewerStyles = {
  "execution-log": uiPatterns["execution-log"],
  "execution-log-dark": uiPatterns["execution-log-dark"],
  "log-output-policy-note": "[margin:0_16px_10px] text-muted-foreground text-xs",
  "log-search":
    'flex min-w-0 [flex:1_1_620px] flex-wrap items-center gap-[7px] border border-solid border-border rounded-md bg-card gap-y-1.5 py-[7px] px-2.5 [&>_.ui-field-feedback]:[flex:1_1_150px] [&>_.ui-field-feedback]:min-w-[150px] [&>_.ui-field-feedback_.ui-input]:min-h-8.5 [&>_.ui-field-feedback_.ui-input]:border-0 [&>_.ui-field-feedback_.ui-input]:p-0 [&>_.ui-field-feedback_.ui-input]:bg-transparent [&_>_button[type="submit"]]:ml-auto',
  "log-time-filter":
    "flex min-w-0 basis-[240px] items-center gap-[5px] text-muted-foreground text-xs [&>span:first-child]:shrink-0 [&>_.ui-field-feedback]:flex-1",
  "log-toolbar": "flex items-start justify-between gap-3 mb-2.5",

  "status-warning":
    "[margin:0_0_10px] border border-solid border-transparent rounded-lg py-2 px-2.5 text-warning bg-warning/10 text-xs",
} as const;
