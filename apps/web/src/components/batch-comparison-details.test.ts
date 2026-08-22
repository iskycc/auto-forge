import type { AnalyticsBatchComparison } from "@autoforge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BatchComparisonDetails } from "./batch-comparison-details";

describe("BatchComparisonDetails", () => {
  it("renders only a comfortable first window and localizes outcomes", () => {
    const cases: AnalyticsBatchComparison["cases"] = Array.from({ length: 120 }, (_, index) => ({
      caseDefinitionId: `case-${index + 1}`,
      displayName: `用例 ${index + 1}`,
      leftVersion: 1,
      rightVersion: 2,
      leftOutcome: "succeeded",
      rightOutcome: "failed",
      leftDurationMs: 100,
      rightDurationMs: 120,
      durationDeltaMs: 20,
    }));

    const html = renderToStaticMarkup(createElement(BatchComparisonDetails, { cases }));

    expect(html.match(/<tbody>[\s\S]*<\/tbody>/u)?.[0].match(/<tr>/gu)).toHaveLength(50);
    expect(html).toContain("第 1–50 项，共 120 项");
    expect(html).toContain("用例 50");
    expect(html).not.toContain("用例 51");
    expect(html).toContain("成功");
    expect(html).toContain("失败");
    expect(html).not.toContain("succeeded");
  });
});
