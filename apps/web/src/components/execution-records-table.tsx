"use client";

import { ExternalLink, LoaderCircle, OctagonX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
  const [terminatingBatchId, setTerminatingBatchId] = useState<string>();
  const [actionError, setActionError] = useState("");
  const [observedAt, setObservedAt] = useState(rows[0]?.observedAt ?? "1970-01-01T00:00:00.000Z");
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

  useEffect(() => {
    if (!rows.some((row) => executionRecordIsActive(row.status))) return;
    const intervalId = window.setInterval(() => setObservedAt(new Date().toISOString()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [rows]);

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
    widths[column.key] ?? automaticWidths[column.key];
  // table-layout: fixed 只有在表格拥有确定宽度时才会完全忽略单元格的内在宽度。
  // 直接使用各列宽度之和，避免某个超长且不可换行的任务名通过 max-content 撑宽整列。
  const tableWidth = EXECUTION_RECORD_COLUMNS.reduce(
    (total, column) => total + columnWidth(column),
    0,
  );

  async function terminateBatch(row: ExecutionRecordRow): Promise<void> {
    if (
      !window.confirm(
        `终止批次 #${row.sequenceNumber}？平台会立即停止后续调度，正在执行的用例完成后任务正式终止。`,
      )
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
    <div className="execution-record-table-stack">
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="table-scroll resizable-table-scroll">
        <table
          className="data-table execution-records-table resizable-table"
          style={{ width: tableWidth }}
        >
          <colgroup>
            {EXECUTION_RECORD_COLUMNS.map((column) => (
              <col key={column.key} style={{ width: columnWidth(column) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {EXECUTION_RECORD_COLUMNS.map((column) => (
                <th key={column.key} scope="col">
                  <span className="resizable-th-content">
                    {column.label}
                    <span
                      aria-hidden="true"
                      className="column-resize-handle"
                      onMouseDown={(event) => startResize(event, column)}
                      role="separator"
                      aria-label={`调整“${column.label}”列宽`}
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {/* 自然递增编号完整展示；UUID 通过 title 悬浮查看。 */}
                  <span className="table-id-text" title={row.id}>
                    #{row.sequenceNumber}
                  </span>
                </td>
                <td>
                  <strong>{row.suiteName}</strong>
                  <small> v{row.suiteVersion}</small>
                </td>
                <td>
                  <span className={`batch-status batch-status-${row.status}`}>
                    {executionRecordStatusLabel({ ...row, observedAt })}
                  </span>
                </td>
                <td>{executionRecordPassRate(row)}%</td>
                <td>{row.succeededRuns}</td>
                <td>{row.failedRuns + row.timedOutRuns}</td>
                <td>{row.retryMode === "round" ? `第 ${row.currentRound} 轮` : "-"}</td>
                <td>{row.retryMode === "round" ? "整轮轮次" : "立即重跑"}</td>
                <td>{row.selectedRunnerCount}</td>
                <td>
                  <time dateTime={row.scheduledFor}>
                    {formatExecutionRecordTime(row.scheduledFor)}
                  </time>
                </td>
                <td>{formatBatchDuration(executionRecordDurationMs({ ...row, observedAt }))}</td>
                <td>
                  <span className="execution-record-row-actions">
                    <Link
                      aria-label={`查看批次 #${row.sequenceNumber} 详情`}
                      className="button button-secondary compact-button"
                      href={`/run-batches/${encodeURIComponent(row.id)}`}
                    >
                      <ExternalLink size={14} aria-hidden="true" /> 详情
                    </Link>
                    {canTerminate && executionRecordIsActive(row.status) ? (
                      <Button
                        className="button button-danger-quiet compact-button"
                        disabled={
                          Boolean(row.terminationRequestedAt) || terminatingBatchId === row.id
                        }
                        onClick={() => void terminateBatch(row)}
                        size="compact"
                        type="button"
                        variant="danger"
                      >
                        {terminatingBatchId === row.id ? (
                          <LoaderCircle className="spin" size={14} aria-hidden="true" />
                        ) : (
                          <OctagonX size={14} aria-hidden="true" />
                        )}
                        {row.terminationRequestedAt ? "终止中" : "终止任务"}
                      </Button>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
