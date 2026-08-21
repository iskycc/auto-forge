import { describe, expect, it } from "vitest";

import {
  executionRecordColumnWidths,
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
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:12.000Z",
  };
}

describe("executionRecordColumnWidths", () => {
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
});
