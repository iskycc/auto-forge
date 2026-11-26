import { describe, expect, it } from "vitest";
import {
  aiExportResult,
  aiExportText,
  splitAiAnalysisConclusion,
} from "./ai-analysis-presentation";

it("removes review boilerplate in spreadsheet cells and preserves evidence wording", () => {
  expect(aiExportResult("可能重跑通过（分析中，待确认）")).toBe("重跑通过");
  expect(aiExportResult("可能业务问题需要提单（需人工确认）")).toBe("业务问题需要提单");
  expect(aiExportResult("AI 初步建议（已分析 2/2 证据片；待人工确认）\n可能用例问题需要修改")).toBe(
    "用例问题需要修改",
  );
  expect(
    aiExportText(
      "可能原因：等待连接池，需人工确认。\n依据：异常可能来自网络中断。\n需要人工确认。",
    ),
  ).toBe("原因：等待连接池。\n依据：异常可能来自网络中断。");
});

describe("AI analysis presentation", () => {
  it.each([
    ["可能重跑通过（待人工确认）", "\n"],
    ["可能用例问题需要修改（待人工确认）", "\r\n"],
  ])("separates the recommendation %s from its reason and evidence", (recommendation, newline) => {
    expect(
      splitAiAnalysisConclusion(
        [recommendation, "原因：依赖瞬时不可用。", "依据：连接被重置。"].join(newline),
      ),
    ).toEqual({
      result: recommendation,
      reason: "依赖瞬时不可用。\n依据：连接被重置。",
    });
  });

  it("does not present retained compact drafts as finished analysis or expose process-only statements", () => {
    expect(
      splitAiAnalysisConclusion(
        "可能重跑通过（分析中，待确认）\n原因：连接池耗尽。\n依据：等待 30 秒。",
      ),
    ).toEqual({ result: "", reason: "" });
    expect(
      splitAiAnalysisConclusion(
        "可能重跑通过（待人工确认）\n原因：本片最早的解释性异常。\n依据：请结合下一片检查。",
      ),
    ).toEqual({ result: "", reason: "" });
    expect(
      splitAiAnalysisConclusion(
        "可能重跑通过（待人工确认）\n原因：本片最早的解释性异常：连接池耗尽。\n依据：等待 30 秒。",
      ),
    ).toEqual({ result: "可能重跑通过（待人工确认）", reason: "连接池耗尽。\n依据：等待 30 秒。" });
  });

  it("keeps summaries and separates details from older multiline reports", () => {
    expect(
      splitAiAnalysisConclusion(
        "AI 初步建议（分析中 1/3）\n检查测试环境。\n仍需验证。\n可能原因：连接中止。\n建议检查：网络。\n模型自评置信度：low",
      ),
    ).toEqual({
      result: "AI 初步建议（分析中 1/3）\n检查测试环境。\n仍需验证。",
      reason: "可能原因：连接中止。\n建议检查：网络。\n模型自评置信度：low",
    });
  });

  it("recovers reasons in older reports with an inline recommendation", () => {
    expect(
      splitAiAnalysisConclusion("可能业务问题需要提单：服务返回错误；依据：响应异常。"),
    ).toEqual({
      result: "可能业务问题需要提单",
      reason: "服务返回错误；依据：响应异常。",
    });
  });

  it("retains the legacy summary when it starts with a reason label", () => {
    expect(
      splitAiAnalysisConclusion(
        "AI 初步建议（已分析 1/1 证据片）\n可能原因：需要复核。\n可能原因：连接中止。",
      ),
    ).toEqual({
      result: "AI 初步建议（已分析 1/1 证据片）\n可能原因：需要复核。",
      reason: "可能原因：连接中止。",
    });
  });

  it("retains free-form text and leaves missing results blank", () => {
    expect(splitAiAnalysisConclusion("一条历史建议\n人工确认后执行")).toEqual({
      result: "一条历史建议\n人工确认后执行",
      reason: "",
    });
    expect(splitAiAnalysisConclusion(null)).toEqual({ result: "", reason: "" });
  });
});
