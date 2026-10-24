import { describe, expect, it } from "vitest";

import {
  EXECUTION_RECORD_COLUMNS,
  executionRecordColumnWidths,
  fitExecutionRecordColumns,
  executionRecordDurationMs,
  executionRecordStatusLabel,
  type ExecutionRecordRow,
} from "./execution-record-columns";

function row(index: number, suiteName = "日常回归任务"): ExecutionRecordRow {
  return {
    id: `batch-${index}`,
    sequenceNumber: index,
    suiteName,
    suiteVersion: 1,
    status: "succeeded",
    totalRuns: 10,
    succeededRuns: 9,
    failedRuns: 1,
    timedOutRuns: 0,
    retryMode: "immediate",
    currentRound: 1,
    selectedRunnerCount: 2,
    scheduledFor: "2026-08-20T08:00:00.000Z",
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:12.000Z",
    observedAt: "2026-08-20T08:01:00.000Z",
  };
}

describe("executionRecordColumnWidths", () => {
  it("shares spare desktop width evenly across data columns and keeps action buttons compact", () => {
    const widths = executionRecordColumnWidths([row(1)]);
    const total = EXECUTION_RECORD_COLUMNS.reduce((sum, column) => sum + widths[column.key], 0);
    const fitted = fitExecutionRecordColumns(widths, total + 800.75);
    const gains = EXECUTION_RECORD_COLUMNS.filter((column) => column.key !== "actions").map(
      (column) => fitted[column.key] - widths[column.key],
    );
    expect(Math.min(...gains)).toBeGreaterThan(0);
    expect(Math.max(...gains) - Math.min(...gains)).toBeLessThanOrEqual(1);
    expect(EXECUTION_RECORD_COLUMNS.reduce((sum, column) => sum + fitted[column.key], 0)).toBe(
      total + 800,
    );
    expect(fitted.actions).toBe(widths.actions);
    expect(fitExecutionRecordColumns(widths, 800)).toEqual(widths);
    expect(fitExecutionRecordColumns(widths, 0)).toEqual(widths);
  });

  it("keeps resized columns stable while other columns share the remaining space", () => {
    const widths = { ...executionRecordColumnWidths([row(1)]), suite: 300, total: 160 };
    const total = EXECUTION_RECORD_COLUMNS.reduce((sum, column) => sum + widths[column.key], 0);
    const fitted = fitExecutionRecordColumns(widths, total + 503, ["suite", "total"]);
    expect(fitted.suite).toBe(300);
    expect(fitted.total).toBe(160);
    expect(fitted.actions).toBe(widths.actions);
    const gains = EXECUTION_RECORD_COLUMNS.filter(
      (column) => !["actions", "suite", "total"].includes(column.key),
    ).map((column) => fitted[column.key] - widths[column.key]);
    expect(Math.min(...gains)).toBeGreaterThan(0);
    expect(Math.max(...gains) - Math.min(...gains)).toBeLessThanOrEqual(1);
    expect(gains.reduce((sum, gain) => sum + gain, 0)).toBe(503);
    expect(widths.suite).toBe(300);
    expect(
      fitExecutionRecordColumns(
        widths,
        total + 503,
        EXECUTION_RECORD_COLUMNS.map((column) => column.key),
      ),
    ).toEqual(widths);
  });

  it("shows the execution case total independently of result statistics and retry rounds", () => {
    const totalColumn = EXECUTION_RECORD_COLUMNS.find((column) => column.key === "total");
    expect(totalColumn?.label).toBe("用例总数");
    expect(totalColumn?.text({ ...row(1), totalRuns: 100_000, currentRound: 3 })).toBe("100000");
    expect(totalColumn?.text({ ...row(1), totalRuns: 7, statisticsPending: true })).toBe("7");
    expect(totalColumn?.text({ ...row(1), totalRuns: 0 })).toBe("0");
  });

  it("sizes a column for at least 70 percent of rows without following long outliers", () => {
    const ordinaryRows = Array.from({ length: 8 }, (_, index) => row(index + 1));
    const rowsWithOutliers = [
      ...ordinaryRows,
      row(9, "极长".repeat(120)),
      row(10, "另一个极端超长但不应撑开整张表的任务名称".repeat(30)),
    ];

    expect(executionRecordColumnWidths(rowsWithOutliers).suite).toBe(
      executionRecordColumnWidths(ordinaryRows).suite,
    );
  });

  it("still clamps every column to its desktop readability bounds", () => {
    const widths = executionRecordColumnWidths([row(1, "x".repeat(1_000))]);

    expect(widths.suite).toBeGreaterThanOrEqual(120);
    expect(widths.suite).toBeLessThanOrEqual(360);
  });

  it("distinguishes completed, exceptional, and terminated batches", () => {
    expect(executionRecordStatusLabel("failed")).toBe("执行异常");
    expect(executionRecordStatusLabel("cancelled")).toBe("已终止");
    expect(executionRecordStatusLabel("succeeded")).toBe("执行完成");
  });

  it("uses observation time only while a batch is active", () => {
    const active = { ...row(1), status: "running" as const };
    expect(executionRecordDurationMs(active)).toBe(60_000);
    expect(executionRecordDurationMs({ ...active, status: "failed" })).toBe(12_000);
  });

  it("shows a live countdown and does not count it as execution duration", () => {
    const delayed = {
      ...row(1),
      status: "queued" as const,
      scheduledFor: "2026-08-20T08:05:00.000Z",
      observedAt: "2026-08-20T08:04:01.000Z",
    };

    expect(executionRecordStatusLabel(delayed)).toBe("倒计时 00:59");
    expect(executionRecordDurationMs(delayed)).toBe(0);
  });
});
