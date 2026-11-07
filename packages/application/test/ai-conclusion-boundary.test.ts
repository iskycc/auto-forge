import { describe, expect, it } from "vitest";
import { aiPreliminaryConclusionSchema } from "@autoforge/contracts";
import { readPreliminaryConclusion, renderPreliminaryConclusion } from "../src/ai-analysis-prompts";
import type { AiModelMessage } from "../src/ai-analysis-ports";

const draft = {
  recommendation: "business_issue_likely",
  reason: "业务状态与断言要求不符。",
  evidence: "响应中的订单状态为 FAILED。",
  evidenceReferences: ["stdout-1"],
};
function reply(value: unknown): AiModelMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "submit_ai_conclusion", arguments: JSON.stringify(value) },
      },
    ],
  };
}
describe("AI conclusion text boundary", () => {
  it("accepts and visibly shortens overlong reason/evidence while keeping the persisted compact contract", () => {
    const result = readPreliminaryConclusion(
      reply({
        ...draft,
        reason: "业务响应状态不匹配。".repeat(30),
        evidence: "java.lang.AssertionError: Wallet 状态不符合业务要求；".repeat(30),
      }),
      ["stdout-1"],
    );
    expect(result.reason.length).toBeLessThanOrEqual(160);
    expect(result.evidence.length).toBeLessThanOrEqual(200);
    expect(result.reason.endsWith("…")).toBe(true);
    expect(result.evidence.endsWith("…")).toBe(true);
    expect(result.evidenceReferences).toEqual(["stdout-1"]);
    expect(aiPreliminaryConclusionSchema.safeParse(result).success).toBe(true);
    expect(renderPreliminaryConclusion(result).split("\n")).toHaveLength(3);
  });
  it("normalizes display whitespace before judging length and keeps exact-limit text intact", () => {
    const result = readPreliminaryConclusion(
      reply({ ...draft, reason: "  业务\n\t 状态不符。  ", evidence: "证".repeat(200) }),
      ["stdout-1"],
    );
    expect(result.reason).toBe("业务 状态不符。");
    expect(result.evidence).toBe("证".repeat(200));
    const short = readPreliminaryConclusion(
      reply({ ...draft, evidence: "日志" + " ".repeat(300) + "显示失败" }),
      ["stdout-1"],
    );
    expect(short.evidence).toBe("日志 显示失败");
  });
  it("never splits a supplementary Unicode character at the shortening boundary", () => {
    const result = readPreliminaryConclusion(
      reply({ ...draft, evidence: "证".repeat(198) + "🧪".repeat(10) }),
      ["stdout-1"],
    );
    expect(result.evidence).toBe("证".repeat(198) + "…");
  });
  it.each([
    { ...draft, evidence: "  \n\t " },
    { ...draft, evidence: 123 },
    { ...draft, reason: { text: "原因" } },
    { ...draft, recommendation: "fixed" },
    { ...draft, command: "run-command" },
    { ...draft, evidenceReferences: [] },
  ])("keeps invalid structure/types/categories rejected with a readable error", (value) => {
    expect(() => readPreliminaryConclusion(reply(value), ["stdout-1"])).toThrow(
      /模型初步建议格式无效/,
    );
  });
  it("does not allow a long answer to bypass reference authorization", () => {
    expect(() =>
      readPreliminaryConclusion(
        reply({ ...draft, evidence: "长依据".repeat(300), evidenceReferences: ["other-attempt"] }),
        ["stdout-1"],
      ),
    ).toThrow("未读取");
  });
  it("reports malformed JSON without exposing low-level parser or validation output", () => {
    const invalid = reply(draft);
    invalid.tool_calls![0]!.function.arguments = "{broken";
    expect(() => readPreliminaryConclusion(invalid, ["stdout-1"])).toThrow(
      "模型初步建议不是有效的 JSON",
    );
  });
});
