"use client";

import type { RunBatch } from "@autoforge/domain";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { formatBatchDuration } from "@/lib/run-batch-presentation";

/**
 * 执行记录页的行载荷。与 RunBatch 相比只携带展示所需字段，让表格组件
 * 与领域聚合解耦，同时避免把 ORM/领域类型直接渲染到客户端。
 */
export type ExecutionRecordRow = {
  id: string;
  suiteName: string;
  suiteVersion: number;
  status: RunBatch["status"];
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  timedOutRuns: number;
  retryMode: "immediate" | "round";
  currentRound: number;
  selectedRunnerCount: number;
  createdAt: string;
  updatedAt: string;
};

const ACTIVE_STATUSES: ReadonlySet<RunBatch["status"]> = new Set([
  "queued",
  "dispatching",
  "scheduled",
  "running",
]);

function isActiveStatus(status: RunBatch["status"]): boolean {
  return ACTIVE_STATUSES.has(status);
}

function statusLabel(status: RunBatch["status"]): string {
  const labels: Record<RunBatch["status"], string> = {
    queued: "等待资源",
    dispatching: "分配中",
    scheduled: "已生成分配",
    running: "执行中",
    succeeded: "已成功",
    failed: "已失败",
    cancelled: "已取消",
  };
  return labels[status];
}

function passRatePercent(row: Pick<ExecutionRecordRow, "totalRuns" | "succeededRuns">): number {
  if (row.totalRuns === 0) return 0;
  return Math.round((row.succeededRuns / row.totalRuns) * 100);
}

function durationMs(row: Pick<ExecutionRecordRow, "createdAt" | "updatedAt">): number {
  const start = Date.parse(row.createdAt);
  // 终态批次的 updatedAt 即结束时间；进行中的批次展示已消耗时长。
  const end = Date.parse(row.updatedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return end - start;
}

type ColumnDefinition = {
  key: string;
  label: string;
  defaultWidth: number;
  minWidth: number;
};

const COLUMNS: ColumnDefinition[] = [
  { key: "id", label: "批次 ID", defaultWidth: 120, minWidth: 80 },
  { key: "suite", label: "任务（Suite）", defaultWidth: 220, minWidth: 120 },
  { key: "status", label: "状态", defaultWidth: 100, minWidth: 80 },
  { key: "passRate", label: "通过率", defaultWidth: 90, minWidth: 70 },
  { key: "passed", label: "已通过", defaultWidth: 80, minWidth: 64 },
  { key: "failed", label: "已失败", defaultWidth: 80, minWidth: 64 },
  { key: "round", label: "当前轮次", defaultWidth: 110, minWidth: 80 },
  { key: "retryMode", label: "重跑方式", defaultWidth: 100, minWidth: 80 },
  { key: "runners", label: "执行机", defaultWidth: 80, minWidth: 64 },
  { key: "createdAt", label: "创建时间", defaultWidth: 150, minWidth: 110 },
  { key: "duration", label: "耗时", defaultWidth: 100, minWidth: 70 },
  { key: "actions", label: "操作", defaultWidth: 100, minWidth: 84 },
];

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
 * “详情”按钮，批次 ID 仅作为文本展示。
 */
export function ExecutionRecordsTable({ rows }: { rows: ExecutionRecordRow[] }) {
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

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const state = dragState.current;
      if (!state) return;
      const column = COLUMNS.find((item) => item.key === state.key);
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

  const startResize = useCallback((event: React.MouseEvent, column: ColumnDefinition) => {
    event.preventDefault();
    const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    dragState.current = {
      key: column.key,
      startX: event.clientX,
      startWidth: width,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const columnWidth = (column: ColumnDefinition): number =>
    widths[column.key] ?? column.defaultWidth;

  return (
    <div className="table-scroll resizable-table-scroll">
      <table className="data-table execution-records-table resizable-table">
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.key} style={{ width: columnWidth(column) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
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
                <span className="table-id-text" title={row.id}>
                  {row.id.slice(0, 8)}…
                </span>
              </td>
              <td>
                <strong>{row.suiteName}</strong>
                <small> v{row.suiteVersion}</small>
              </td>
              <td>
                <span className={`batch-status batch-status-${row.status}`}>
                  {statusLabel(row.status)}
                </span>
              </td>
              <td>{passRatePercent(row)}%</td>
              <td>{row.succeededRuns}</td>
              <td>{row.failedRuns + row.timedOutRuns}</td>
              <td>{row.retryMode === "round" ? `第 ${row.currentRound} 轮` : "-"}</td>
              <td>{row.retryMode === "round" ? "整轮轮次" : "立即重跑"}</td>
              <td>{row.selectedRunnerCount}</td>
              <td>
                <time dateTime={row.createdAt}>{formatRecordTime(row.createdAt)}</time>
              </td>
              <td>
                {isActiveStatus(row.status) ? "执行中" : formatBatchDuration(durationMs(row))}
              </td>
              <td>
                <Link
                  aria-label={`查看批次 ${row.id} 详情`}
                  className="button button-secondary compact-button"
                  href={`/run-batches/${encodeURIComponent(row.id)}`}
                >
                  <ExternalLink size={14} aria-hidden="true" /> 详情
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatRecordTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
