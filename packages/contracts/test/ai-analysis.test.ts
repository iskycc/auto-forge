import { describe, expect, it } from "vitest";
import {
  aiModelConfigurationSchema,
  aiConclusionSchema,
  aiPreliminaryConclusionSchema,
} from "../src/ai-analysis";

describe("AI analysis contracts", () => {
  it("bounds new conclusions to one preliminary category and short reason/evidence", () => {
    const draft = {
      recommendation: "case_change_likely",
      reason: "断言已过时。",
      evidence: "接口字段已变更。",
      evidenceReferences: ["stack"],
    };
    expect(aiPreliminaryConclusionSchema.safeParse(draft).success).toBe(true);
    expect(
      aiPreliminaryConclusionSchema.safeParse({ ...draft, reason: "长".repeat(161) }).success,
    ).toBe(false);
    expect(
      aiPreliminaryConclusionSchema.safeParse({ ...draft, recommendation: "confirmed_bug" })
        .success,
    ).toBe(false);
    expect(
      aiPreliminaryConclusionSchema.safeParse({ ...draft, checks: ["长篇步骤"] }).success,
    ).toBe(false);
  });
  it("accepts an intranet compatible endpoint and supplies bounded defaults", () => {
    expect(
      aiModelConfigurationSchema.parse({
        baseUrl: "http://10.0.0.2:8080/v1",
        modelId: "local-model",
      }),
    ).toMatchObject({ enabled: false, concurrency: 2, maximumRetries: 3 });
  });
  it("preserves multiple bounded reference prompts and defaults older configurations to none", () => {
    const input = { baseUrl: "http://model/v1", modelId: "model" };
    expect(aiModelConfigurationSchema.parse(input)).toHaveProperty("referencePrompts", []);
    const referencePrompts = [
      { title: "环境波动", content: "连接重置时先考虑瞬时环境问题。" },
      { title: "业务规则", content: "支付状态不符合协议时建议人工核对业务。" },
    ];
    expect(aiModelConfigurationSchema.parse({ ...input, referencePrompts })).toHaveProperty(
      "referencePrompts",
      referencePrompts,
    );
    expect(
      aiModelConfigurationSchema.safeParse({
        ...input,
        referencePrompts: [{ title: "空提示", content: " " }],
      }).success,
    ).toBe(false);
  });
  it.each([
    "file:///etc/passwd",
    "https://secret@example.com/v1",
    "https://example.com/v1?key=secret",
  ])("rejects a credential-bearing or unsupported endpoint %s", (baseUrl) => {
    expect(aiModelConfigurationSchema.safeParse({ baseUrl, modelId: "model" }).success).toBe(false);
  });
  it("rejects output budgets that leave no evidence context", () => {
    expect(
      aiModelConfigurationSchema.safeParse({
        baseUrl: "http://model/v1",
        modelId: "model",
        contextTokens: 4096,
        outputTokens: 4096,
      }).success,
    ).toBe(false);
  });
  it("does not allow a model to submit execution status or an unreferenced conclusion", () => {
    const conclusion = {
      summary: "Need evidence",
      possibleCauses: [],
      checks: [],
      evidenceReferences: ["part-1"],
      limitations: [],
      confidence: "low",
    };
    expect(aiConclusionSchema.safeParse({ ...conclusion, outcome: "succeeded" }).success).toBe(
      false,
    );
    expect(aiConclusionSchema.safeParse({ ...conclusion, evidenceReferences: [] }).success).toBe(
      false,
    );
  });
});
