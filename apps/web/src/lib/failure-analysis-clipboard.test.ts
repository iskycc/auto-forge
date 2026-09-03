import { describe, expect, it } from "vitest";

import { formatFailureAnalysisClipboard } from "./failure-analysis-clipboard";

describe("formatFailureAnalysisClipboard", () => {
  it("formats single and batch case details as safe rich text plus plain text", () => {
    const formatted = formatFailureAnalysisClipboard(
      [claim("analysis-a", "登录 <失败>"), claim("analysis-b", "支付失败")],
      {
        category: "code_issue_filed",
        issueDescription: "空指针 & 超时",
        ticketReference: "BUG-1024",
      },
    );

    expect(formatted.text).toContain("AutoForge 用例分析（2 个）");
    expect(formatted.text).toContain("1. 登录 <失败>");
    expect(formatted.text).toContain("分析结论：代码问题已提单");
    expect(formatted.html).toContain("登录 &lt;失败&gt;");
    expect(formatted.html).toContain("空指针 &amp; 超时");
    expect(formatted.html).not.toContain("登录 <失败>");
  });
});

function claim(id: string, caseName: string) {
  return {
    id,
    projectId: "project-a",
    batchId: "batch-a",
    executionRunId: `run-${id}`,
    caseDefinitionId: `case-${id}`,
    attemptId: `attempt-${id}`,
    caseName,
    className: "example.FailedTest",
    attemptNumber: 2,
    failureSummary: "AssertionError",
    resultCode: "failed",
    status: "claimed" as const,
    claimantId: "user-a",
    claimantUsername: "u10001",
    claimantDisplayName: "分析员",
    claimedAt: "2026-09-03T01:00:00.000Z",
    updatedAt: "2026-09-03T01:00:00.000Z",
  };
}
