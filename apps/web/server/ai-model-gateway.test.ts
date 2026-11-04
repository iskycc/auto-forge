import { describe, it, expect, vi } from "vitest";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import { OpenAiCompatibleGateway, retryAfter } from "./ai-model-gateway";
import { AiEvidenceStore, redactAiText, redactAiJson, extractCompleteStacks } from "./ai-evidence";
import type {
  AiAnalysisRepository,
  AiWork,
  ExecutionControlRepository,
  JarObjectStorePort,
} from "@autoforge/application";
import { AiResourceDeferral } from "@autoforge/application";

describe("AI model boundary", () => {
  it("defers a busy log database instead of publishing an incomplete finding", async () => {
    const busy = new Error("log database is busy");
    const store = new AiEvidenceStore(
      { source: async () => null } as unknown as AiAnalysisRepository,
      {
        listLogChunks: async () => {
          throw busy;
        },
      } as unknown as ExecutionControlRepository,
      { putObject: vi.fn() } as unknown as JarObjectStorePort,
      "test-only-signature-key",
      () => true,
      (error) => error === busy,
    );
    await expect(
      store.collect(
        {
          id: "item",
          jobId: "job",
          projectId: "project",
          executionRunId: "run",
          attemptId: "attempt",
        } as AiWork,
        aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "test" }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ constructor: AiResourceDeferral, cause: busy });
  });
  it("stops all log pagination when the next fragment exceeds the remaining evidence budget", async () => {
    const listLogChunks = vi.fn(async (input: { afterSequence: number }) => {
      if (input.afterSequence >= 31) return { items: [] };
      return {
        items: Array.from({ length: 16 }, (_, index) => ({
          sequence: input.afterSequence + 1 + index,
          recordedAt: "2026-11-04T00:00:00.000Z",
          content: "x".repeat(128 * 1024),
        })),
        nextSequence: input.afterSequence + 17,
      };
    });
    const store = new AiEvidenceStore(
      { source: async () => null } as unknown as AiAnalysisRepository,
      { listLogChunks } as unknown as ExecutionControlRepository,
      { putObject: vi.fn().mockResolvedValue(undefined) } as unknown as JarObjectStorePort,
      "test-only-signature-key",
    );
    const result = await store.collect(
      {
        id: "item",
        jobId: "job",
        projectId: "project",
        executionRunId: "run",
        attemptId: "attempt",
      } as AiWork,
      aiModelConfigurationSchema.parse({
        baseUrl: "http://model/v1",
        modelId: "test",
        maximumEvidenceMiB: 1,
      }),
      new AbortController().signal,
    );
    expect(listLogChunks).toHaveBeenCalledTimes(1);
    expect(
      result.evidence.parts.reduce((sum, part) => sum + part.sizeBytes, 0),
    ).toBeLessThanOrEqual(1048576);
    expect(result.evidence.limitations).toContain(
      "用例证据超出配置的采集空间预算，剩余正文未分析。",
    );
  });
  it("preserves distinct complete stack frames and excludes an unterminated tail", () => {
    const stack = "java.lang.AssertionError: expected 1\n\tat example.Test.run(Test.java:20)\n";
    expect(extractCompleteStacks(stack)).toEqual([stack.trimEnd()]);
    expect(extractCompleteStacks(stack.trimEnd())).toEqual([]);
    expect(extractCompleteStacks(stack.replace(":20", ":21"))).not.toEqual(
      extractCompleteStacks(stack),
    );
  });
  it("redacts nested dynamic input secrets while preserving zero and false", () => {
    const value = JSON.parse(
      redactAiJson({
        credentials: { password: "secret with spaces", apiKey: "key" },
        count: 0,
        enabled: false,
      }),
    );
    expect(value).toEqual({
      credentials: { password: "[REDACTED]", apiKey: "[REDACTED]" },
      count: 0,
      enabled: false,
    });
  });
  it("honors valid server retry hints and ignores invalid values", () => {
    expect(retryAfter("120")).toBe(120000);
    expect(retryAfter("Wed, 04 Nov 2026 00:01:00 GMT", Date.parse("2026-11-04T00:00:00Z"))).toBe(
      60000,
    );
    expect(retryAfter("invalid")).toBeUndefined();
  });
  it("redacts credentials before evidence partitioning", () => {
    expect(
      redactAiText(
        'password=very-secret apiKey:"token" Authorization: Bearer abc123 https://user:pass@host/path',
      ),
    ).not.toMatch(/very-secret|"token"|abc123|user:pass/u);
  });
  it("does not retry billing failures or forward upstream bodies containing secrets", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"code":"insufficient_quota","secret":"token"}', {
        status: 429,
        headers: { "retry-after": "60" },
      }),
    );
    await expect(
      new OpenAiCompatibleGateway(transport).complete({
        configuration: aiModelConfigurationSchema.parse({
          baseUrl: "http://model/v1",
          modelId: "test",
        }),
        apiKey: "secret",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ retryable: false, message: "模型额度或计费不足，请联系管理员。" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
