"use client";
import { Segmented } from "./ui/segmented";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { AttemptLogPage, LogChunk } from "@autoforge/contracts";
import type { RunAttempt } from "@autoforge/domain";
import { isTerminalAttemptStatus } from "@autoforge/domain";
import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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

function parseLiveLogMessage(value: unknown): { chunks: LogChunk[] } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as {
      schemaVersion?: unknown;
      type?: unknown;
      chunks?: unknown;
    };
    if (parsed.schemaVersion !== 1 || parsed.type !== "chunks" || !Array.isArray(parsed.chunks)) {
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
  canReadLogs,
  canCreateRuns,
  onClose,
}: {
  attemptId: string;
  attemptStatus: RunAttempt["status"];
  canReadLogs: boolean;
  canCreateRuns: boolean;
  onClose: () => void;
}) {
  const [stream, setStream] = useState<LogStream>("stdout");
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
  const [activeAttempt, setActiveAttempt] = useState<LiveLogAttempt>({
    id: attemptId,
    status: attemptStatus,
  });
  const viewingManualRerun = activeAttempt.id !== attemptId;
  const attemptTerminal = isTerminalAttemptStatus(activeAttempt.status);

  const loadLogs = useCallback(
    async (
      selectedStream: LogStream,
      search: string,
      timeRange: { after: string; before: string },
      afterSequence: number,
    ) => {
      await Promise.resolve();
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({
          stream: selectedStream,
          afterSequence: String(afterSequence),
          limit: "200",
        });
        if (search.trim()) parameters.set("query", search.trim());
        const afterTimestamp = toIsoFilter(timeRange.after);
        const beforeTimestamp = toIsoFilter(timeRange.before);
        if (afterTimestamp) parameters.set("recordedAfter", afterTimestamp);
        if (beforeTimestamp) parameters.set("recordedBefore", beforeTimestamp);
        const response = await fetch(
          `/api/v1/run-attempts/${encodeURIComponent(activeAttempt.id)}/logs?${parameters}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error((await readApiErrorMessage(response, "读取日志失败。"))!);
        }
        const logPage = (await response.json()) as AttemptLogPage;
        setLogs((current) => mergeLogChunks(current, logPage.items));
        setNextSequence(logPage.nextSequence);
        setLogsTruncated(logPage.truncated);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "读取日志失败。");
      } finally {
        setLoading(false);
      }
    },
    [activeAttempt.id],
  );

  useEffect(() => {
    if (!canReadLogs) return;
    const scheduledLoad = window.setTimeout(() => {
      setLogs([]);
      setNextSequence(undefined);
      setLogsTruncated(false);
      void loadLogs(stream, activeQuery, activeTimeRange, -1);
    }, 0);
    return () => window.clearTimeout(scheduledLoad);
  }, [activeQuery, activeTimeRange, canReadLogs, loadLogs, stream]);

  useEffect(() => {
    if (
      !canReadLogs ||
      attemptTerminal ||
      activeQuery ||
      activeTimeRange.after ||
      activeTimeRange.before
    ) {
      return;
    }
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    const connect = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/v1/run-attempts/${encodeURIComponent(activeAttempt.id)}/log-stream-ticket`,
          { method: "POST" },
        );
        if (!response.ok || disposed) return;
        const payload = (await response.json()) as { ticket?: string };
        if (!payload.ticket || disposed) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(
          `${protocol}//${window.location.host}/api/v1/log-stream`,
          `autoforge-log.${payload.ticket}`,
        );
        socket.onopen = () => {
          setLiveLogs(true);
          void loadLogs(stream, "", { after: "", before: "" }, -1);
        };
        socket.onmessage = (event) => {
          const message = parseLiveLogMessage(event.data);
          if (!message) return;
          const incoming = message.chunks.filter((chunk) => chunk.stream === stream);
          if (incoming.length === 0) return;
          setLogs((current) => mergeLogChunks(current, incoming));
        };
        socket.onclose = () => {
          setLiveLogs(false);
          if (!disposed) reconnectTimer = window.setTimeout(() => void connect(), 2_000);
        };
        socket.onerror = () => socket?.close();
      } catch {
        setLiveLogs(false);
        if (!disposed) reconnectTimer = window.setTimeout(() => void connect(), 5_000);
      }
    };
    void connect();
    return () => {
      disposed = true;
      setLiveLogs(false);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close(1000, "Log view changed");
    };
  }, [
    activeAttempt.id,
    activeQuery,
    activeTimeRange,
    attemptTerminal,
    canReadLogs,
    loadLogs,
    stream,
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
        {canCreateRuns && attemptTerminal && !viewingManualRerun ? (
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
        <p className={cn("status-warning", attemptLogViewerStyles["status-warning"])} role="status">
          日志已达到保留上限，后续内容被明确截断。
        </p>
      ) : null}
      {sequenceGaps.length > 0 ? (
        <p className={cn("status-warning", attemptLogViewerStyles["status-warning"])} role="status">
          检测到 {sequenceGaps.length} 个序号缺口；Agent 补传后刷新即可恢复连续内容。
        </p>
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
        <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
          当前账号没有读取执行日志的权限。
        </div>
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
    'flex [flex:1_1_620px] flex-wrap items-center gap-[7px] border border-solid border-border rounded-md bg-card gap-y-1.5 py-[7px] px-2.5 [&_input]:w-auto [&_input]:min-w-[150px] [&_input]:[flex:1_1_150px] [&_input]:min-h-8.5 [&_input]:border-0 [&_input]:p-0 [&_input]:[outline:0] [&_input]:bg-transparent [&_>_button[type="submit"]]:ml-auto [&_.log-time-filter]:min-w-0 [&_.ui-datetime]:w-auto [&_.ui-datetime]:min-w-0 [&_.ui-datetime-display]:min-w-0 [&_.ui-datetime-display]:max-w-full [&_.ui-datetime-display_>_span]:min-w-0',
  "log-time-filter":
    "flex items-center gap-[5px] text-muted-foreground text-xs [&_>_span]:[flex:0_0_auto]",
  "log-toolbar": "flex items-start justify-between gap-3 mb-2.5",

  "status-warning":
    "[margin:0_0_10px] border border-solid border-transparent rounded-lg py-2 px-2.5 text-warning bg-warning/10 text-xs",
} as const;
