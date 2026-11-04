import { describe, expect, it } from "vitest";
import { aiModelConfigurationSchema, aiConclusionSchema } from "../src/ai-analysis";

describe("AI analysis contracts", () => {
  it("accepts an intranet compatible endpoint and supplies bounded defaults", () => {
    expect(
      aiModelConfigurationSchema.parse({
        baseUrl: "http://10.0.0.2:8080/v1",
        modelId: "local-model",
      }),
    ).toMatchObject({ enabled: false, concurrency: 2, maximumRetries: 3 });
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
