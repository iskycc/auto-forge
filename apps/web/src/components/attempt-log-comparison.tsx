"use client";
import { Progress } from "@/components/ui/progress";

import { cn } from "@/lib/utils";

import { ChevronLeft, ChevronRight, GitCompareArrows, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { compareAttemptLogs, type LogDiffRow } from "../lib/attempt-log-diff";
import {
  loadComparisonLog,
  type ComparisonLog,
  type ComparisonLogProgress,
  type ComparisonLogStream,
} from "../lib/load-comparison-log";
import { Button, Select } from "./ui";
import { Dialog } from "./ui/dialog";

const LOG_ROW_HEIGHT_PX = 24;
const LOG_ROW_OVERSCAN = 16;
const EMPTY_DIFF_ROWS: LogDiffRow[] = [];
type LoadedLog = { log: ComparisonLog } | { error: string };
type VisibleLogRows = { start: number; end: number };

const EMPTY_LOAD_PROGRESS: ComparisonLogProgress = {
  loadedCharacters: 0,
  loadedChunks: 0,
};

export type AttemptLogComparisonSelection = {
  name: string;
  context: string;
  left: {
    attemptId?: string | undefined;
    title: string;
    subtitle: string;
  };
  right: {
    attemptId?: string | undefined;
    title: string;
    subtitle: string;
  };
};

export function AttemptLogComparison({
  comparison,
  onClose,
}: {
  comparison: AttemptLogComparisonSelection;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [stream, setStream] = useState<ComparisonLogStream>("stdout");
  const [revision, setRevision] = useState(0);
  return (
    <Dialog
      open
      title={`日志对比 · ${comparison.name}`}
      onClose={onClose}
      className={attemptLogComparisonStyles["analysis-log-comparison"]}
      zIndex={1100}
      initialFocusRef={closeRef}
    >
      <section className="analysis-log-comparison" aria-label={`日志对比 · ${comparison.name}`}>
        <header
          className={cn(
            "analysis-log-comparison-header",
            attemptLogComparisonStyles["analysis-log-comparison-header"],
          )}
        >
          <div>
            <GitCompareArrows size={20} />
            <span>
              <strong>日志对比</strong>

              <small title={comparison.context}>{comparison.context}</small>
            </span>
          </div>
          <div>
            <Select
              aria-label="对比日志流"
              value={stream}
              onChange={(event) => setStream(event.target.value as ComparisonLogStream)}
            >
              <option value="stdout">标准输出</option>
              <option value="stderr">错误输出</option>
              <option value="agent">执行机诊断</option>
            </Select>
            <Button
              size="compact"
              type="button"
              onClick={() => setRevision((value) => value + 1)}
              aria-label="重新加载对比日志"
            >
              <RefreshCw size={15} />
            </Button>
            <Button
              ref={closeRef}
              size="compact"
              type="button"
              onClick={onClose}
              aria-label="关闭日志对比"
            >
              <X size={16} /> 关闭对比
            </Button>
          </div>
        </header>
        <LogComparisonContent
          key={`${stream}-${revision}`}
          comparison={comparison}
          stream={stream}
        />
      </section>
    </Dialog>
  );
}

function LogComparisonContent({
  comparison,
  stream,
}: {
  comparison: AttemptLogComparisonSelection;
  stream: ComparisonLogStream;
}) {
  const [loaded, setLoaded] = useState<{ previous: LoadedLog; current: LoadedLog }>();
  const [loadProgress, setLoadProgress] = useState({
    previous: EMPTY_LOAD_PROGRESS,
    current: EMPTY_LOAD_PROGRESS,
  });
  const [difference, setDifference] = useState(-1);
  const previousRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const previousAttemptId = comparison.left.attemptId;
  const currentAttemptId = comparison.right.attemptId;
  useEffect(() => {
    const controller = new AbortController();
    async function readLog(
      side: "previous" | "current",
      attemptId: string | undefined,
    ): Promise<LoadedLog> {
      if (!attemptId) return { error: "该次执行没有可对比的日志。" };
      try {
        return {
          log: await loadComparisonLog(attemptId, stream, controller.signal, (progress) => {
            if (controller.signal.aborted) return;
            setLoadProgress((current) => ({ ...current, [side]: progress }));
          }),
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "读取日志失败。" };
      }
    }
    void Promise.all([
      readLog("previous", previousAttemptId),
      readLog("current", currentAttemptId),
    ]).then(([previous, current]) => {
      if (!controller.signal.aborted) setLoaded({ previous, current });
    });
    return () => controller.abort();
  }, [previousAttemptId, currentAttemptId, stream]);
  const previousLog =
    loaded?.previous && "log" in loaded.previous ? loaded.previous.log : undefined;
  const currentLog = loaded?.current && "log" in loaded.current ? loaded.current.log : undefined;
  const diff = useMemo(
    () =>
      previousLog && currentLog ? compareAttemptLogs(previousLog.text, currentLog.text) : undefined,
    [previousLog, currentLog],
  );
  const rows = diff?.rows ?? EMPTY_DIFF_ROWS;
  const differenceStarts = useMemo(
    () =>
      rows.flatMap((row, index) =>
        row.kind !== "equal" && (index === 0 || rows[index - 1]?.kind === "equal") ? [index] : [],
      ),
    [rows],
  );
  const limited = diff?.limited || previousLog?.limited || currentLog?.limited;
  const incomplete = previousLog?.incomplete || currentLog?.incomplete;
  const selectedRow = differenceStarts[difference];
  useEffect(() => {
    for (const viewport of [previousRef.current, currentRef.current]) {
      if (!viewport) continue;
      viewport.scrollTop =
        selectedRow === undefined ? 0 : Math.max(0, (selectedRow - 2) * LOG_ROW_HEIGHT_PX);
    }
  }, [selectedRow]);
  function moveDifference(next: number) {
    if (differenceStarts[next] === undefined) return;
    setDifference(next);
  }
  const loadedChunks = loadProgress.previous.loadedChunks + loadProgress.current.loadedChunks;
  const loadedCharacters =
    loadProgress.previous.loadedCharacters + loadProgress.current.loadedCharacters;
  return (
    <>
      <div
        className={cn(
          "analysis-log-diff-toolbar",
          attemptLogComparisonStyles["analysis-log-diff-toolbar"],
        )}
      >
        <span role="status">
          {!loaded
            ? "正在读取两侧日志…"
            : !diff
              ? "日志读取失败，可点击右上角重新加载。"
              : !rows.length
                ? "两侧均暂无日志"
                : differenceStarts.length
                  ? `${differenceStarts.length} 处差异 · 左侧 − 历史内容，右侧 + 本次内容`
                  : "当前范围内的日志内容一致"}
        </span>
        <div>
          <Button
            size="compact"
            type="button"
            disabled={difference <= 0}
            onClick={() => moveDifference(difference - 1)}
          >
            <ChevronLeft size={14} /> 上一处差异
          </Button>
          <Button
            size="compact"
            type="button"
            disabled={difference + 1 >= differenceStarts.length}
            onClick={() => moveDifference(difference + 1)}
          >
            下一处差异 <ChevronRight size={14} />
          </Button>
        </div>
      </div>
      {!loaded ? (
        <div
          className={cn(
            "analysis-log-load-progress",
            attemptLogComparisonStyles["analysis-log-load-progress"],
          )}
          role="status"
        >
          <div>
            <strong>正在连续加载两侧日志</strong>
            <span>
              {loadedChunks > 0
                ? `已读取 ${loadedChunks.toLocaleString("zh-CN")} 个日志块 · ${loadedCharacters.toLocaleString("zh-CN")} 个字符`
                : "正在请求首批日志…"}
            </span>
          </div>
          <Progress aria-label="日志加载进度" />
        </div>
      ) : null}
      {limited || incomplete ? (
        <p
          className={cn(
            "analysis-log-diff-notice",
            attemptLogComparisonStyles["analysis-log-diff-notice"],
          )}
          role="status"
        >
          {limited
            ? "日志较长，本次仅对比各日志开头最多 2,000 行、约 13 万字符；未加载部分不纳入差异。"
            : null}
          {incomplete ? "日志存在缺失或截断，对比仅供已读取内容参考。" : null}
        </p>
      ) : null}
      <div
        className={cn("analysis-log-windows", attemptLogComparisonStyles["analysis-log-windows"])}
      >
        <ComparisonWindow
          title={comparison.left.title}
          subtitle={comparison.left.subtitle}
          side="previous"
          loaded={loaded?.previous}
          rows={rows}
          selectedRow={selectedRow}
          viewportRef={previousRef}
          pairedRef={currentRef}
          comparisonReady={Boolean(diff)}
        />
        <ComparisonWindow
          title={comparison.right.title}
          subtitle={comparison.right.subtitle}
          side="current"
          loaded={loaded?.current}
          rows={rows}
          selectedRow={selectedRow}
          viewportRef={currentRef}
          pairedRef={previousRef}
          comparisonReady={Boolean(diff)}
        />
      </div>
      <footer
        className={cn(
          "analysis-log-diff-footer",
          attemptLogComparisonStyles["analysis-log-diff-footer"],
        )}
      >
        <span>
          {loaded
            ? diff
              ? `单页连续对比 ${rows.length.toLocaleString("zh-CN")} 行 · 两侧同步滚动 · 按 Esc 关闭对比`
              : "日志读取成功后将在同一页面连续展示 · 按 Esc 关闭对比"
            : "加载完成后将在同一页面连续展示 · 两侧同步滚动 · 按 Esc 关闭对比"}
        </span>
      </footer>
    </>
  );
}

function ComparisonWindow({
  title,
  subtitle,
  side,
  loaded,
  rows,
  selectedRow,
  viewportRef,
  pairedRef,
  comparisonReady,
}: {
  title: string;
  subtitle: string;
  side: "previous" | "current";
  loaded: LoadedLog | undefined;
  rows: LogDiffRow[];
  selectedRow: number | undefined;
  viewportRef: RefObject<HTMLDivElement | null>;
  pairedRef: RefObject<HTMLDivElement | null>;
  comparisonReady: boolean;
}) {
  const [visibleRows, setVisibleRows] = useState<VisibleLogRows>({ start: 0, end: 0 });
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateVisibleRows = () => {
      const next = visibleLogRows(rows.length, viewport.scrollTop, viewport.clientHeight);
      setVisibleRows((current) =>
        current.start === next.start && current.end === next.end ? current : next,
      );
    };
    updateVisibleRows();
    const observer = new ResizeObserver(updateVisibleRows);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [rows.length, viewportRef]);
  const renderedRows = rows.slice(visibleRows.start, visibleRows.end);
  return (
    <section
      className={cn("analysis-log-window", attemptLogComparisonStyles["analysis-log-window"])}
      aria-label={title}
    >
      <header>
        <strong>{title}</strong>
        <small title={subtitle}>{subtitle}</small>
      </header>
      <div
        className={cn("analysis-log-lines", attemptLogComparisonStyles["analysis-log-lines"])}
        ref={viewportRef}
        tabIndex={0}
        aria-label={`${title}内容`}
        onScroll={(event) => {
          const next = visibleLogRows(
            rows.length,
            event.currentTarget.scrollTop,
            event.currentTarget.clientHeight,
          );
          setVisibleRows((current) =>
            current.start === next.start && current.end === next.end ? current : next,
          );
          const paired = pairedRef.current;
          if (paired && Math.abs(paired.scrollTop - event.currentTarget.scrollTop) > 1)
            paired.scrollTop = event.currentTarget.scrollTop;
        }}
      >
        {!loaded ? (
          <p role="status">正在读取日志…</p>
        ) : "error" in loaded ? (
          <p role="alert">{loaded.error}</p>
        ) : !comparisonReady ? (
          <p>另一侧日志读取失败，请重新加载后对比。</p>
        ) : !rows.length ? (
          <p>当前日志流暂无内容。</p>
        ) : (
          <div
            className={cn(
              "analysis-log-line-list",
              attemptLogComparisonStyles["analysis-log-line-list"],
            )}
            style={{
              paddingBlockStart: visibleRows.start * LOG_ROW_HEIGHT_PX,
              paddingBlockEnd: (rows.length - visibleRows.end) * LOG_ROW_HEIGHT_PX,
            }}
          >
            {renderedRows.map((row, index) => {
              const rowIndex = visibleRows.start + index;
              const line = row[side];
              const changed = row.kind !== "equal" && line !== undefined;
              return (
                <div
                  key={rowIndex}
                  className={cn(
                    "analysis-log-line",
                    attemptLogComparisonStyles["analysis-log-line"],
                  )}
                  data-diff-row={rowIndex}
                  data-selected={selectedRow === rowIndex || undefined}
                  data-change={changed ? (side === "previous" ? "removed" : "added") : undefined}
                >
                  <span
                    className={cn(
                      "analysis-log-line-number",
                      attemptLogComparisonStyles["analysis-log-line-number"],
                    )}
                    aria-hidden="true"
                  >
                    {line?.number ?? ""}
                  </span>
                  <span
                    className={cn(
                      "analysis-log-line-sign",
                      attemptLogComparisonStyles["analysis-log-line-sign"],
                    )}
                    aria-label={
                      changed ? (side === "previous" ? "历史差异行" : "本次差异行") : undefined
                    }
                  >
                    {changed ? (side === "previous" ? "−" : "+") : " "}
                  </span>
                  <code>{line?.text || " "}</code>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function visibleLogRows(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
): VisibleLogRows {
  const firstVisible = Math.floor(scrollTop / LOG_ROW_HEIGHT_PX);
  const visibleCount = Math.ceil(viewportHeight / LOG_ROW_HEIGHT_PX);
  const start = Math.max(0, firstVisible - LOG_ROW_OVERSCAN);
  return {
    start,
    end: Math.min(rowCount, firstVisible + visibleCount + LOG_ROW_OVERSCAN),
  };
}

const attemptLogComparisonStyles = {
  "analysis-log-comparison":
    "w-[calc(100vw-3rem)] max-w-[1920px] h-[calc(100dvh-3rem)] p-0 bg-background",
  "analysis-log-comparison-header":
    "flex items-center gap-2 shrink-0 justify-between py-3 px-4 border-b border-solid border-border bg-card [&_>_div]:flex [&_>_div]:items-center [&_>_div]:gap-2 [&_>_div:first-child]:min-w-0 [&_>_div_>_span]:min-w-0 [&_>_div:last-child]:shrink-0 [&_strong]:block [&_small]:block [&_small]:mt-2 [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-xs [&_small]:text-muted-foreground [&_svg]:shrink-0 [&_.ui-select]:min-w-[130px]",
  "analysis-log-diff-footer":
    "flex items-center gap-2 shrink-0 justify-between py-3 px-4 text-xs text-muted-foreground [&_>_div]:flex [&_>_div]:items-center [&_>_div]:gap-2 [&_>_div]:shrink-0",
  "analysis-log-diff-notice":
    "[margin:0_16px_12px] py-2 px-3 rounded-lg bg-warning/10 text-warning text-xs",
  "analysis-log-diff-toolbar":
    "flex items-center gap-2 shrink-0 justify-between py-3 px-4 text-xs text-muted-foreground [&_>_div]:flex [&_>_div]:items-center [&_>_div]:gap-2 [&_>_div]:shrink-0",
  "analysis-log-line":
    'flex h-6 leading-[24px] font-mono text-xs whitespace-pre [&_code]:pr-4 [&_code]:[font:inherit] [&[data-change="removed"]]:bg-destructive/10 [&[data-change="removed"]]:text-destructive [&[data-change="added"]]:bg-success/10 [&[data-change="added"]]:text-success [&[data-selected="true"]]:shadow-xs',
  "analysis-log-line-list": "min-w-full w-max [box-sizing:border-box] [overflow-anchor:none]",
  "analysis-log-line-number":
    "sticky left-0 w-11 shrink-0 pr-2 bg-muted text-muted-foreground text-right select-none",
  "analysis-log-line-sign": "w-5 shrink-0 text-center select-none",
  "analysis-log-lines":
    'relative flex-1 min-h-0 overflow-auto [overscroll-behavior:contain] [&_>_p]:m-4 [&_>_p]:text-muted-foreground [&_>_p]:text-sm [&_[role="alert"]]:text-destructive',
  "analysis-log-load-progress":
    "grid shrink-0 gap-2 [margin:0_16px_12px] p-3 border border-solid border-transparent rounded-lg bg-info/10 [&_>_div]:flex [&_>_div]:items-center [&_>_div]:justify-between [&_>_div]:gap-3 [&_strong]:text-xs [&_span]:text-xs [&_span]:text-muted-foreground [&_.ui-progress]:w-full [&_.ui-progress]:h-1.5 [&_.ui-progress]:[accent-color:var(--info)]",
  "analysis-log-window":
    "flex flex-col min-w-0 min-h-0 overflow-hidden border border-solid border-border rounded-lg bg-card shadow-xs [&_>_header]:grid [&_>_header]:gap-2 [&_>_header]:py-3 [&_>_header]:px-4 [&_>_header]:border-b [&_>_header]:border-solid [&_>_header]:border-border [&_>_header]:bg-muted [&_>_header_strong]:text-sm [&_>_header_small]:overflow-hidden [&_>_header_small]:text-ellipsis [&_>_header_small]:whitespace-nowrap [&_>_header_small]:text-muted-foreground [&_>_header_small]:text-xs",
  "analysis-log-windows":
    "grid grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)] gap-3 flex-1 min-h-0 py-0 px-4",
} as const;
