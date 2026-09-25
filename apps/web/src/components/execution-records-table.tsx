"use client";
import { LoadingIcon } from "@/components/ui/loading-icon";

import { Badge } from "@/components/ui/badge";

import { Notice } from "@/components/ui/notice";

import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { StartFailureAnalysisButton } from "./start-failure-analysis-button";
import { usePlatformNow } from "./platform-time";

import { ExternalLink, OctagonX } from "lucide-react";
import { LinkButton } from "@/components/ui/link-button";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import {
  EXECUTION_RECORD_COLUMNS,
  executionRecordColumnWidths,
  executionRecordDurationMs,
  executionRecordIsActive,
  executionRecordPassRate,
  executionRecordStatusLabel,
  formatExecutionRecordTime,
  type ExecutionRecordColumnDefinition,
  type ExecutionRecordRow,
} from "@/lib/execution-record-columns";
import { formatBatchDuration } from "@/lib/run-batch-presentation";
import { Button } from "@/components/ui";
import { RunBatchPermanentShare } from "@/components/run-batch-permanent-share";
import { useConfirm } from "@/components/ui-feedback";

export type { ExecutionRecordRow } from "@/lib/execution-record-columns";

const STORAGE_KEY = "autoforge.execution-records.column-widths.v1";
// localStorage 变更事件名：拖拽结束后写入列宽时派发，让 useSyncExternalStore 快照刷新。
const COLUMN_WIDTHS_CHANGED = "autoforge.execution-records.column-widths-changed";
const EMPTY_WIDTHS: Record<string, number> = {};

function parseStoredWidths(raw: string): Record<string, number> {
  if (!raw) return EMPTY_WIDTHS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_WIDTHS;
    const widths: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) widths[key] = value;
    }
    return widths;
  } catch {
    return EMPTY_WIDTHS;
  }
}

// 快照按原始字符串缓存，保证 useSyncExternalStore 在无变化时返回同一引用。
let widthSnapshotCache: { raw: string; parsed: Record<string, number> } | undefined;

function readColumnWidthSnapshot(): Record<string, number> {
  if (typeof window === "undefined") return EMPTY_WIDTHS;
  let raw = "";
  try {
    raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return EMPTY_WIDTHS;
  }
  if (!widthSnapshotCache || widthSnapshotCache.raw !== raw) {
    widthSnapshotCache = { raw, parsed: parseStoredWidths(raw) };
  }
  return widthSnapshotCache.parsed;
}

function subscribeColumnWidths(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(COLUMN_WIDTHS_CHANGED, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(COLUMN_WIDTHS_CHANGED, callback);
  };
}

function persistColumnWidths(widths: Record<string, number>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // 存储不可用（隐私模式等）时列宽仅在本次会话内生效。
  }
  window.dispatchEvent(new Event(COLUMN_WIDTHS_CHANGED));
}

/**
 * 执行记录表格：列宽可拖拽调整并持久化到 localStorage；进入详情通过独立的
 * “详情”按钮，批次编号（自然递增）仅作为文本展示，UUID 在 title 中查看。
 */
export function ExecutionRecordsTable({
  rows,
  canTerminate,
}: {
  rows: ExecutionRecordRow[];
  canTerminate: boolean;
}) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const [terminatingBatchId, setTerminatingBatchId] = useState<string>();
  const [actionError, setActionError] = useState("");
  const nowMs = usePlatformNow(rows.some((row) => executionRecordIsActive(row.status)));
  const observedAt = new Date(nowMs).toISOString();
  // 持久化列宽通过外部 store 读取，服务端快照恒为空，避免首屏水合不一致。
  const storedWidths = useSyncExternalStore(
    subscribeColumnWidths,
    readColumnWidthSnapshot,
    () => EMPTY_WIDTHS,
  );
  // 拖拽中的宽度先放在临时状态里，松手后统一持久化。
  const [dragWidths, setDragWidths] = useState<Record<string, number>>({});
  // 拖拽镜像只在事件处理器里维护，供松手时合并持久化使用，避免渲染期写 ref。
  const dragWidthsRef = useRef<Record<string, number>>({});
  const dragState = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const widths: Record<string, number> = { ...storedWidths, ...dragWidths };
  const automaticWidths = useMemo(() => executionRecordColumnWidths(rows), [rows]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const state = dragState.current;
      if (!state) return;
      const column = EXECUTION_RECORD_COLUMNS.find((item) => item.key === state.key);
      if (!column) return;
      const nextWidth = Math.max(column.minWidth, state.startWidth + event.clientX - state.startX);
      const nextDragWidths = { ...dragWidthsRef.current, [state.key]: nextWidth };
      dragWidthsRef.current = nextDragWidths;
      setDragWidths(nextDragWidths);
    };
    const onUp = () => {
      if (!dragState.current) return;
      dragState.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistColumnWidths({ ...readColumnWidthSnapshot(), ...dragWidthsRef.current });
      dragWidthsRef.current = {};
      setDragWidths({});
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startResize = useCallback(
    (event: React.MouseEvent, column: ExecutionRecordColumnDefinition) => {
      event.preventDefault();
      const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
      dragState.current = {
        key: column.key,
        startX: event.clientX,
        startWidth: width,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  const columnWidth = (column: ExecutionRecordColumnDefinition): number =>
    // 已持久化的列宽可能来自旧版约束；读取时重新执行当前下限，防止升级后
    // localStorage 中的过窄数值继续截断状态、百分比和操作按钮。
    Math.max(column.minWidth, widths[column.key] ?? automaticWidths[column.key]);
  // table-layout: fixed 只有在表格拥有确定宽度时才会完全忽略单元格的内在宽度。
  // 直接使用各列宽度之和，避免某个超长且不可换行的任务名通过 max-content 撑宽整列。
  const tableWidth = EXECUTION_RECORD_COLUMNS.reduce(
    (total, column) => total + columnWidth(column),
    0,
  );

  async function terminateBatch(row: ExecutionRecordRow): Promise<void> {
    if (
      !(await confirmAction({
        title: `终止批次 #${row.sequenceNumber}`,
        description: "平台会立即停止后续调度，正在执行的用例完成后任务正式终止。",
        confirmLabel: "确认终止",
        tone: "danger",
      }))
    ) {
      return;
    }
    setTerminatingBatchId(row.id);
    setActionError("");
    try {
      const response = await fetch(`/api/v1/run-batches/${encodeURIComponent(row.id)}/terminate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Terminated from execution records." }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? `终止任务失败（HTTP ${response.status}）。`);
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "终止任务失败。");
    } finally {
      setTerminatingBatchId(undefined);
    }
  }

  return (
    <div
      className={cn(
        "execution-record-table-stack",
        executionRecordsTableStyles["execution-record-table-stack"],
      )}
    >
      {actionError ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
          {actionError}
        </Notice>
      ) : null}
      <div
        className={cn("table-display-tools", executionRecordsTableStyles["table-display-tools"])}
      >
        <span>可横向滚动查看所有列，任务与操作列固定</span>
        <Button
          type="button"
          size="compact"
          onClick={() => {
            persistColumnWidths({});
            setDragWidths({});
          }}
        >
          重置列宽
        </Button>
      </div>
      <div
        className={cn(
          "table-scroll resizable-table-scroll",
          uiPatterns["table-scroll"],
          executionRecordsTableStyles["resizable-table-scroll"],
        )}
        tabIndex={0}
        aria-label="执行记录表格，可横向滚动"
      >
        <Table
          className={cn(
            "data-table execution-records-table resizable-table",
            uiPatterns["data-table"],
            executionRecordsTableStyles["execution-records-table"],
            executionRecordsTableStyles["resizable-table"],
          )}
          style={
            {
              width: tableWidth,
              "--record-id-width": `${columnWidth(EXECUTION_RECORD_COLUMNS[0]!)}px`,
            } as CSSProperties
          }
        >
          <colgroup>
            {EXECUTION_RECORD_COLUMNS.map((column) => (
              <col key={column.key} style={{ width: columnWidth(column) }} />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow>
              {EXECUTION_RECORD_COLUMNS.map((column) => (
                <TableHead key={column.key} scope="col">
                  <span
                    className={cn(
                      "resizable-th-content",
                      executionRecordsTableStyles["resizable-th-content"],
                    )}
                  >
                    {column.label}
                    <span
                      tabIndex={0}
                      aria-orientation="vertical"
                      aria-valuemin={column.minWidth}
                      aria-valuenow={columnWidth(column)}
                      onKeyDown={(event) => {
                        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
                        event.preventDefault();
                        const width =
                          event.key === "Home"
                            ? automaticWidths[column.key]!
                            : Math.max(
                                column.minWidth,
                                columnWidth(column) + (event.key === "ArrowRight" ? 20 : -20),
                              );
                        persistColumnWidths({ ...storedWidths, [column.key]: width });
                      }}
                      className={cn(
                        "column-resize-handle",
                        executionRecordsTableStyles["column-resize-handle"],
                      )}
                      onMouseDown={(event) => startResize(event, column)}
                      role="separator"
                      aria-label={`调整“${column.label}”列宽`}
                    />
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  {/* 自然递增编号完整展示；UUID 通过 title 悬浮查看。 */}
                  <span
                    className={cn("table-id-text", executionRecordsTableStyles["table-id-text"])}
                    title={row.id}
                  >
                    #{row.sequenceNumber}
                  </span>
                </TableCell>
                <TableCell>
                  <strong>{row.suiteName}</strong>
                  <small> v{row.suiteVersion}</small>
                </TableCell>
                <TableCell>
                  <Badge
                    className={cn(
                      executionRecordsTableStyles["batch-status"],
                      `batch-status batch-status batch-status-${row.status}`,
                    )}
                  >
                    {executionRecordStatusLabel({ ...row, observedAt })}
                  </Badge>
                </TableCell>
                <TableCell title={row.statisticsPending ? "统计准备中" : undefined}>
                  {row.statisticsPending ? "—" : `${executionRecordPassRate(row)}%`}
                </TableCell>
                <TableCell>{row.statisticsPending ? "—" : row.succeededRuns}</TableCell>
                <TableCell>
                  {row.statisticsPending ? "—" : row.failedRuns + row.timedOutRuns}
                </TableCell>
                <TableCell>
                  {row.retryMode === "round" ? `第 ${row.currentRound} 轮` : "-"}
                </TableCell>
                <TableCell>{row.retryMode === "round" ? "整轮轮次" : "立即重跑"}</TableCell>
                <TableCell>{row.selectedRunnerCount}</TableCell>
                <TableCell>
                  <time dateTime={row.scheduledFor}>
                    {formatExecutionRecordTime(row.scheduledFor)}
                  </time>
                </TableCell>
                <TableCell>
                  {formatBatchDuration(executionRecordDurationMs({ ...row, observedAt }))}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "execution-record-row-actions",
                      executionRecordsTableStyles["execution-record-row-actions"],
                    )}
                  >
                    <LinkButton
                      aria-label={`查看批次 #${row.sequenceNumber} 详情`}
                      className={cn(
                        "button button-secondary compact-button",
                        uiPatterns["button"],
                        uiPatterns["button-secondary"],
                        uiPatterns["compact-button"],
                      )}
                      href={`/run-batches/${encodeURIComponent(row.id)}`}
                    >
                      <ExternalLink size={14} aria-hidden="true" /> 详情
                    </LinkButton>
                    <RunBatchPermanentShare batchId={row.id} sequenceNumber={row.sequenceNumber} />
                    {row.analysisScope &&
                    !executionRecordIsActive(row.status) &&
                    row.failedRuns > 0 ? (
                      <StartFailureAnalysisButton scope={row.analysisScope} />
                    ) : null}
                    {canTerminate && executionRecordIsActive(row.status) ? (
                      <Button
                        className={cn(
                          "button button-danger-quiet compact-button",
                          uiPatterns["button"],
                          uiPatterns["button-danger-quiet"],
                          uiPatterns["compact-button"],
                        )}
                        disabled={
                          Boolean(row.terminationRequestedAt) || terminatingBatchId === row.id
                        }
                        onClick={() => void terminateBatch(row)}
                        size="compact"
                        type="button"
                        variant="danger"
                      >
                        {terminatingBatchId === row.id ? (
                          <LoadingIcon size={14} aria-hidden="true" />
                        ) : (
                          <OctagonX size={14} aria-hidden="true" />
                        )}
                        {row.terminationRequestedAt ? "终止中" : "终止任务"}
                      </Button>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

const executionRecordsTableStyles = {
  "batch-status": uiPatterns["batch-status"],
  "column-resize-handle":
    "absolute top-0 right-0 z-2 w-1.5 h-full cursor-col-resize bg-transparent transition-colors duration-150 motion-reduce:transition-none [&:hover]:bg-info [&:hover]:opacity-45 [&:active]:bg-info [&:active]:opacity-45 [&:focus-visible]:[outline:2px_solid_var(--info)]",
  "execution-record-row-actions": "inline-flex items-center gap-2 flex-wrap whitespace-normal",
  "execution-record-table-stack": "grid gap-3",
  "execution-records-table":
    "[&_td_small]:text-muted-foreground [&_:is(th,_td):first-child]:sticky [&_:is(th,_td):first-child]:z-1 [&_:is(th,_td):first-child]:bg-card [&_:is(th,_td):first-child]:left-0 [&_:is(th,_td):nth-child(2)]:sticky [&_:is(th,_td):nth-child(2)]:z-1 [&_:is(th,_td):nth-child(2)]:bg-card [&_:is(th,_td):nth-child(2)]:left-[var(--record-id-width)] [&_:is(th,_td):nth-child(2)]:border-r [&_:is(th,_td):nth-child(2)]:border-solid [&_:is(th,_td):nth-child(2)]:border-border [&_:is(th,_td):last-child]:sticky [&_:is(th,_td):last-child]:z-1 [&_:is(th,_td):last-child]:bg-card [&_:is(th,_td):last-child]:right-0 [&_:is(th,_td):last-child]:border-l [&_:is(th,_td):last-child]:border-solid [&_:is(th,_td):last-child]:border-border [&_th:is(:first-child,_:nth-child(2),_:last-child)]:bg-muted",
  "resizable-table":
    "min-w-full [table-layout:fixed] [&_th]:relative [&_th]:overflow-visible [&_th]:whitespace-nowrap [&_td]:[overflow-wrap:anywhere] [&_td]:whitespace-normal",
  "resizable-table-scroll": "overflow-x-auto",
  "resizable-th-content": "flex items-center gap-1.5 min-w-0 overflow-hidden text-ellipsis",
  "table-display-tools":
    "flex items-center justify-between flex-wrap gap-3 text-muted-foreground text-sm",
  "table-id-text": "text-muted-foreground tabular-nums",
} as const;
