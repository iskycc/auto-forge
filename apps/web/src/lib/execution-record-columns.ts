import type { RunBatch } from "@autoforge/domain";

import { formatBatchDuration } from "./run-batch-presentation";
import { columnCharacterWidthAtCoverage } from "./table-column-width";

export type ExecutionRecordRow = {
  id: string;
  sequenceNumber: number;
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

export type ExecutionRecordColumnKey =
  | "id"
  | "suite"
  | "status"
  | "passRate"
  | "passed"
  | "failed"
  | "round"
  | "retryMode"
  | "runners"
  | "createdAt"
  | "duration"
  | "actions";

export type ExecutionRecordColumnDefinition = {
  key: ExecutionRecordColumnKey;
  label: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  text: (row: ExecutionRecordRow) => string;
};

export const EXECUTION_RECORD_COLUMNS: readonly ExecutionRecordColumnDefinition[] = [
  {
    key: "id",
    label: "批次编号",
    defaultWidth: 96,
    minWidth: 72,
    maxWidth: 140,
    text: (row) => `#${row.sequenceNumber}`,
  },
  {
    key: "suite",
    label: "任务（Suite）",
    defaultWidth: 220,
    minWidth: 120,
    maxWidth: 360,
    text: (row) => `${row.suiteName} v${row.suiteVersion}`,
  },
  {
    key: "status",
    label: "状态",
    defaultWidth: 100,
    minWidth: 80,
    maxWidth: 140,
    text: (row) => executionRecordStatusLabel(row.status),
  },
  {
    key: "passRate",
    label: "通过率",
    defaultWidth: 90,
    minWidth: 70,
    maxWidth: 110,
    text: (row) => `${executionRecordPassRate(row)}%`,
  },
  {
    key: "passed",
    label: "已通过",
    defaultWidth: 80,
    minWidth: 64,
    maxWidth: 100,
    text: (row) => String(row.succeededRuns),
  },
  {
    key: "failed",
    label: "已失败",
    defaultWidth: 80,
    minWidth: 64,
    maxWidth: 100,
    text: (row) => String(row.failedRuns + row.timedOutRuns),
  },
  {
    key: "round",
    label: "当前轮次",
    defaultWidth: 110,
    minWidth: 80,
    maxWidth: 130,
    text: (row) => (row.retryMode === "round" ? `第 ${row.currentRound} 轮` : "-"),
  },
  {
    key: "retryMode",
    label: "重跑方式",
    defaultWidth: 100,
    minWidth: 80,
    maxWidth: 120,
    text: (row) => (row.retryMode === "round" ? "整轮轮次" : "立即重跑"),
  },
  {
    key: "runners",
    label: "执行机",
    defaultWidth: 80,
    minWidth: 64,
    maxWidth: 100,
    text: (row) => String(row.selectedRunnerCount),
  },
  {
    key: "createdAt",
    label: "创建时间",
    defaultWidth: 150,
    minWidth: 110,
    maxWidth: 190,
    text: (row) => formatExecutionRecordTime(row.createdAt),
  },
  {
    key: "duration",
    label: "耗时",
    defaultWidth: 100,
    minWidth: 70,
    maxWidth: 130,
    text: (row) =>
      executionRecordIsActive(row.status)
        ? "执行中"
        : formatBatchDuration(executionRecordDurationMs(row)),
  },
  {
    key: "actions",
    label: "操作",
    defaultWidth: 100,
    minWidth: 84,
    maxWidth: 110,
    text: () => "详情",
  },
];

const CHARACTER_PIXEL_WIDTH = 8;
const CELL_HORIZONTAL_PADDING = 32;

export function executionRecordColumnWidths(
  rows: readonly ExecutionRecordRow[],
): Record<ExecutionRecordColumnKey, number> {
  const widths = {} as Record<ExecutionRecordColumnKey, number>;
  for (const column of EXECUTION_RECORD_COLUMNS) {
    if (rows.length === 0) {
      widths[column.key] = column.defaultWidth;
      continue;
    }
    const characterWidth = columnCharacterWidthAtCoverage(rows.map(column.text), {
      coverage: 0.7,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    const measuredWidth = Math.ceil(
      characterWidth * CHARACTER_PIXEL_WIDTH + CELL_HORIZONTAL_PADDING,
    );
    widths[column.key] = Math.min(column.maxWidth, Math.max(column.minWidth, measuredWidth));
  }
  return widths;
}

export function executionRecordIsActive(status: RunBatch["status"]): boolean {
  return ["queued", "dispatching", "scheduled", "running"].includes(status);
}

export function executionRecordStatusLabel(status: RunBatch["status"]): string {
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

export function executionRecordPassRate(
  row: Pick<ExecutionRecordRow, "totalRuns" | "succeededRuns">,
): number {
  return row.totalRuns === 0 ? 0 : Math.round((row.succeededRuns / row.totalRuns) * 100);
}

export function executionRecordDurationMs(
  row: Pick<ExecutionRecordRow, "createdAt" | "updatedAt">,
): number {
  const start = Date.parse(row.createdAt);
  const end = Date.parse(row.updatedAt);
  return Number.isNaN(start) || Number.isNaN(end) || end <= start ? 0 : end - start;
}

export function formatExecutionRecordTime(value: string): string {
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
