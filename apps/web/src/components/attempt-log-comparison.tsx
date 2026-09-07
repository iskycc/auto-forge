"use client";

import { ChevronLeft, ChevronRight, GitCompareArrows, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { AnalysisLogComparison } from "@/components/failure-analysis-execution-history";
import { Button, Select } from "@/components/ui";
import { compareAttemptLogs, type LogDiffRow } from "@/lib/attempt-log-diff";
import {
  loadComparisonLog,
  type ComparisonLog,
  type ComparisonLogStream,
} from "@/lib/load-comparison-log";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { sharedOutcomeLabel } from "@/lib/shared-attempt-log";

const ROWS_PER_PAGE = 200;
const EMPTY_DIFF_ROWS: LogDiffRow[] = [];
type LoadedLog = { log: ComparisonLog } | { error: string };

export function AttemptLogComparison({
  comparison,
  onClose,
}: {
  comparison: AnalysisLogComparison;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [stream, setStream] = useState<ComparisonLogStream>("stdout");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    closeRef.current?.focus();
    return () => {
      dialog?.close();
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="analysis-log-comparison"
      aria-label={`日志对比 · ${comparison.claim.caseName}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="analysis-log-comparison-header">
        <div>
          <GitCompareArrows size={20} />
          <span>
            <strong>日志对比</strong>
            <small title={comparison.claim.className}>
              {comparison.claim.caseName} · {comparison.claim.className}
            </small>
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
            <X size={16} /> 返回分析
          </Button>
        </div>
      </header>
      <LogComparisonContent key={`${stream}-${revision}`} comparison={comparison} stream={stream} />
    </dialog>
  );
}

function LogComparisonContent({
  comparison,
  stream,
}: {
  comparison: AnalysisLogComparison;
  stream: ComparisonLogStream;
}) {
  const [loaded, setLoaded] = useState<{ previous: LoadedLog; current: LoadedLog }>();
  const [page, setPage] = useState(0);
  const [difference, setDifference] = useState(-1);
  const previousRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const previousAttemptId = comparison.execution.attemptId;
  const currentAttemptId = comparison.claim.attemptId;
  useEffect(() => {
    const controller = new AbortController();
    async function readLog(attemptId: string | undefined): Promise<LoadedLog> {
      if (!attemptId) return { error: "该次执行没有可对比的日志。" };
      try {
        return { log: await loadComparisonLog(attemptId, stream, controller.signal) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "读取日志失败。" };
      }
    }
    void Promise.all([readLog(previousAttemptId), readLog(currentAttemptId)]).then(
      ([previous, current]) => {
        if (!controller.signal.aborted) setLoaded({ previous, current });
      },
    );
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
  const pages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const limited = diff?.limited || previousLog?.limited || currentLog?.limited;
  const incomplete = previousLog?.incomplete || currentLog?.incomplete;
  const pageRows = rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);
  const selectedRow = differenceStarts[difference];
  useEffect(() => {
    for (const viewport of [previousRef.current, currentRef.current]) {
      if (!viewport) continue;
      const row =
        selectedRow === undefined
          ? null
          : viewport.querySelector<HTMLElement>(`[data-diff-row="${selectedRow}"]`);
      viewport.scrollTop = row ? Math.max(0, row.offsetTop - row.offsetHeight * 2) : 0;
    }
  }, [page, selectedRow]);
  function moveDifference(next: number) {
    const row = differenceStarts[next];
    if (row === undefined) return;
    setDifference(next);
    setPage(Math.floor(row / ROWS_PER_PAGE));
  }
  return (
    <>
      <div className="analysis-log-diff-toolbar">
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
      {limited || incomplete ? (
        <p className="analysis-log-diff-notice" role="status">
          {limited
            ? "日志较长，本次仅对比各日志开头最多 2,000 行、约 13 万字符；未加载部分不纳入差异。"
            : null}
          {incomplete ? "日志存在缺失或截断，对比仅供已读取内容参考。" : null}
        </p>
      ) : null}
      <div className="analysis-log-windows">
        <ComparisonWindow
          title="历史日志"
          subtitle={`批次 #${comparison.execution.batchSequenceNumber} · ${sharedOutcomeLabel(comparison.execution.outcome)} · ${formatPlatformDateTime(comparison.execution.createdAt)}`}
          side="previous"
          loaded={loaded?.previous}
          rows={pageRows}
          offset={page * ROWS_PER_PAGE}
          selectedRow={selectedRow}
          viewportRef={previousRef}
          pairedRef={currentRef}
          comparisonReady={Boolean(diff)}
        />
        <ComparisonWindow
          title="本次分析日志"
          subtitle={`第 ${comparison.claim.attemptNumber} 次尝试 · 失败 · ${comparison.claim.caseName}`}
          side="current"
          loaded={loaded?.current}
          rows={pageRows}
          offset={page * ROWS_PER_PAGE}
          selectedRow={selectedRow}
          viewportRef={currentRef}
          pairedRef={previousRef}
          comparisonReady={Boolean(diff)}
        />
      </div>
      <footer className="analysis-log-diff-footer">
        <span>两侧同步滚动 · 按 Esc 返回分析</span>
        <div>
          <Button
            size="compact"
            type="button"
            disabled={page === 0}
            onClick={() => {
              setPage(page - 1);
              setDifference(-1);
            }}
          >
            上一页日志
          </Button>
          <span>
            第 {page + 1} / {pages} 页
          </span>
          <Button
            size="compact"
            type="button"
            disabled={page + 1 >= pages}
            onClick={() => {
              setPage(page + 1);
              setDifference(-1);
            }}
          >
            下一页日志
          </Button>
        </div>
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
  offset,
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
  offset: number;
  selectedRow: number | undefined;
  viewportRef: RefObject<HTMLDivElement | null>;
  pairedRef: RefObject<HTMLDivElement | null>;
  comparisonReady: boolean;
}) {
  return (
    <section className="analysis-log-window" aria-label={title}>
      <header>
        <strong>{title}</strong>
        <small title={subtitle}>{subtitle}</small>
      </header>
      <div
        className="analysis-log-lines"
        ref={viewportRef}
        tabIndex={0}
        aria-label={`${title}内容`}
        onScroll={(event) => {
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
          <div className="analysis-log-line-list">
            {rows.map((row, index) => {
              const line = row[side];
              const changed = row.kind !== "equal" && line !== undefined;
              return (
                <div
                  key={offset + index}
                  className="analysis-log-line"
                  data-diff-row={offset + index}
                  data-selected={selectedRow === offset + index || undefined}
                  data-change={changed ? (side === "previous" ? "removed" : "added") : undefined}
                >
                  <span className="analysis-log-line-number" aria-hidden="true">
                    {line?.number ?? ""}
                  </span>
                  <span
                    className="analysis-log-line-sign"
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
