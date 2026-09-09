import type { AnalyticsBatchComparison } from "@autoforge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BatchComparisonDetails, filterBatchComparisonCases } from "./batch-comparison-details";

describe("BatchComparisonDetails", () => {
  it("renders only a comfortable first window and localizes outcomes", () => {
    const cases: AnalyticsBatchComparison["cases"] = Array.from({ length: 120 }, (_, index) => ({
      caseDefinitionId: `case-${index + 1}`,
      displayName: `用例 ${index + 1}`,
      className: `example.Case${index + 1}`,
      leftVersion: 1,
      rightVersion: 2,
      leftOutcome: "succeeded",
      rightOutcome: "failed",
      leftAttemptId: `left-attempt-${index + 1}`,
      rightAttemptId: `right-attempt-${index + 1}`,
      leftAttemptNumber: 1,
      rightAttemptNumber: 2,
      leftDurationMs: 100,
      rightDurationMs: 120,
      durationDeltaMs: 20,
    }));

    const html = renderToStaticMarkup(
      createElement(BatchComparisonDetails, {
        cases,
        left: batchSnapshot("left", 12),
        right: batchSnapshot("right", 15),
      }),
    );

    expect(html.match(/<tbody>[\s\S]*<\/tbody>/u)?.[0].match(/<tr>/gu)).toHaveLength(50);
    expect(html).toContain("第 1–50 项，共 120 项");
    expect(html).toContain("用例 50");
    expect(html).not.toContain("用例 51");
    expect(html).toContain("成功");
    expect(html).toContain("失败");
    expect(html).toContain("日志对比");
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/u)?.[0]).not.toContain("succeeded");
  });

  it("filters result differences and explicit left-to-right transitions", () => {
    const cases: AnalyticsBatchComparison["cases"] = [
      comparisonCase("unchanged", "succeeded", "succeeded"),
      comparisonCase("regression", "succeeded", "failed"),
      comparisonCase("recovered", "failed", "succeeded"),
      comparisonCase("new-failure", undefined, "failed"),
    ];

    expect(
      filterBatchComparisonCases(cases, {
        difference: "different",
        leftOutcome: "all",
        rightOutcome: "all",
      }).map((item) => item.caseDefinitionId),
    ).toEqual(["regression", "recovered", "new-failure"]);
    expect(
      filterBatchComparisonCases(cases, {
        difference: "different",
        leftOutcome: "succeeded",
        rightOutcome: "failed",
      }).map((item) => item.caseDefinitionId),
    ).toEqual(["regression"]);
  });
});

function comparisonCase(
  caseDefinitionId: string,
  leftOutcome: "succeeded" | "failed" | undefined,
  rightOutcome: "succeeded" | "failed" | undefined,
): AnalyticsBatchComparison["cases"][number] {
  return {
    caseDefinitionId,
    displayName: caseDefinitionId,
    className: `example.${caseDefinitionId}`,
    leftVersion: 1,
    rightVersion: 2,
    leftOutcome,
    rightOutcome,
  };
}

function batchSnapshot(batchId: string, sequenceNumber: number): AnalyticsBatchComparison["left"] {
  return {
    batchId,
    sequenceNumber,
    projectId: "project-1",
    suiteId: "suite-1",
    suiteVersion: 1,
    selectedRunnerIds: [],
    caseCount: 120,
  };
}
