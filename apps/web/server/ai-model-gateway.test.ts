import { describe, it, expect, vi } from "vitest";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import { OpenAiCompatibleGateway, retryAfter } from "./ai-model-gateway";
import {
  AiEvidenceStore,
  prepareAiText,
  prepareAiJson,
  extractCompleteStacks,
} from "./ai-evidence";
import type {
  AiAnalysisRepository,
  AiWork,
  ExecutionControlRepository,
  JarObjectStorePort,
} from "@autoforge/application";
import { AiResourceDeferral } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";

describe("AI model boundary", () => {
  it("sends the stdout tail and business input without generic result codes, stderr or Agent diagnostics", async () => {
    const objects = new Map<string, Uint8Array>();
    const store = new AiEvidenceStore(
      {
        source: async () => ({
          outcome: "failed",
          class_name: "example.Test",
          result_code: "TESTNG_ASSERTIONS_FAILED",
          result_summary: "TESTNG_RESULT",
          runner_id: "unhelpful-node",
          class_data_json: '{"amount":0,"enabled":false}',
        }),
      } as unknown as AiAnalysisRepository,
      {
        listLogChunks: async ({ stream }: { stream: string }) => ({
          items: [
            {
              sequence: 0,
              recordedAt: "now",
              content:
                stream === "stdout"
                  ? "日志开头\n" +
                    "x".repeat(40001) +
                    "\n" +
                    "🧪".repeat(30000) +
                    "\n日志结尾\n" +
                    "java.lang.AssertionError: mismatch\n\tat example.Test.run(Test.java:20)\n\n".repeat(
                      2,
                    )
                  : stream === "stderr"
                    ? "java.lang.AssertionError: mismatch\n\tat example.Test.run(Test.java:20)\n\n".repeat(
                        2,
                      )
                    : "执行诊断末尾\n",
            },
          ],
        }),
      } as unknown as ExecutionControlRepository,
      {
        putObject: async ({
          objectKey,
          content,
        }: {
          objectKey: string;
          content: AsyncIterable<Uint8Array>;
        }) => {
          for await (const bytes of content) objects.set(objectKey, bytes);
        },
        read: async (key: string) => objects.get(key)!,
      } as unknown as JarObjectStorePort,
      "test-key",
    );
    const result = await store.collect(
      {
        id: "single",
        projectId: "p",
        jobId: "j",
        executionRunId: "r",
        attemptId: "a",
        strategy: "single_full_v2",
      } as AiWork,
      aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "model" }),
      new AbortController().signal,
    );
    expect(result.evidence.signature).toMatch(/^exact-stack-bundle-v2:/);
    expect(result.evidence.stackParts).toHaveLength(1);
    const stack = await store.part(result.evidence.stackParts![0]!);
    expect(stack.match(/AssertionError/gu)).toHaveLength(1);
    const fullText = (
      await Promise.all(result.evidence.parts.map((part) => store.part(part)))
    ).join("");
    expect(fullText).not.toContain("日志开头");
    expect(fullText).toContain("日志结尾");
    expect(fullText).toContain("🧪".repeat(30000));
    expect(fullText).not.toContain("🧪".repeat(30001));
    expect(fullText).not.toContain("\ufffd");
    expect(fullText).not.toContain("执行诊断末尾");
    expect(fullText).not.toMatch(
      /TESTNG_ASSERTIONS_FAILED|TESTNG_RESULT|unhelpful-node|\[stdout sequence/,
    );
    expect(fullText).toContain('"amount":0');
    expect(fullText).toContain('"enabled":false');
    const stdout = result.evidence.parts.filter((part) => part.id.startsWith("stdout-"));
    const stdoutText = (await Promise.all(stdout.map((part) => store.part(part)))).join("");
    expect(stdoutText).toBe(
      "🧪".repeat(30000) +
        "\n日志结尾\n" +
        "java.lang.AssertionError: mismatch\n\tat example.Test.run(Test.java:20)\n\n".repeat(2),
    );
    expect(result.evidence.stdoutComplete).toBe(true);
    expect(result.evidence.inputTransformations).toContainEqual(
      expect.stringContaining("末尾 25000"),
    );
  });
  it("ignores failures in excluded streams and rejects old broad evidence for new model requests", async () => {
    const listLogChunks = vi.fn(async ({ stream }: { stream: string }) => {
      if (stream !== "stdout") throw new Error("excluded stream must never be read");
      return { items: [{ sequence: 0, recordedAt: "now", content: "完整业务日志\n" }] };
    });
    const store = new AiEvidenceStore(
      { source: async () => null } as unknown as AiAnalysisRepository,
      { listLogChunks } as unknown as ExecutionControlRepository,
      {
        putObject: vi.fn(),
        read: async () => Buffer.from(JSON.stringify({ version: 1, parts: [{ id: "agent-1" }] })),
      } as unknown as JarObjectStorePort,
      "test-key",
    );
    const result = await store.collect(
      { id: "i", strategy: "single_full_v2" } as AiWork,
      aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "m" }),
      new AbortController().signal,
    );
    expect(listLogChunks.mock.calls.map(([query]) => query.stream)).toEqual(["stdout"]);
    expect(result.evidence.stdoutComplete).toBe(true);
    await expect(store.read("old-manifest")).rejects.toThrow("重新分析");
  });
  it("refuses a single-case full-log analysis when the evidence budget would omit log text", async () => {
    const store = new AiEvidenceStore(
      { source: async () => ({ outcome: "failed" }) } as unknown as AiAnalysisRepository,
      {
        listLogChunks: async () => ({
          items: [{ sequence: 0, recordedAt: "now", content: "x".repeat(2 * 1048576) }],
        }),
      } as unknown as ExecutionControlRepository,
      { putObject: vi.fn().mockResolvedValue(undefined) } as unknown as JarObjectStorePort,
      "test-key",
    );
    await expect(
      store.collect(
        { id: "i", strategy: "single_full_v2" } as AiWork,
        aiModelConfigurationSchema.parse({
          baseUrl: "http://model/v1",
          modelId: "m",
          maximumEvidenceMiB: 1,
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("无法完成全文日志分析");
  });
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
  it.each([
    {
      code: "LOG_DATABASE_IDENTITY_CONFLICT",
      message: "日志数据库身份不匹配，请恢复原日志数据库。",
      retryable: false,
    },
    {
      code: "PLATFORM_LOG_DATABASE_UNAVAILABLE",
      message: "日志数据库暂不可用，请检查连接及服务状态。",
      retryable: true,
    },
  ])(
    "reports the actual $code instead of saving a misleading incomplete manifest",
    async ({ code, message, retryable }) => {
      const cause = new DomainError(code, message);
      const putObject = vi.fn();
      const store = new AiEvidenceStore(
        { source: async () => null } as unknown as AiAnalysisRepository,
        {
          listLogChunks: async () => {
            throw cause;
          },
        } as unknown as ExecutionControlRepository,
        { putObject } as unknown as JarObjectStorePort,
        "test-key",
      );
      await expect(
        store.collect(
          { id: "item", strategy: "stack_groups_v2" } as AiWork,
          aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "m" }),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        name: "AiModelRequestError",
        message: expect.stringContaining(`${code}：${message}`),
        retryable,
        cause,
      });
      expect(putObject).not.toHaveBeenCalled();
    },
  );
  it("does not expose raw driver credentials in a log-read failure", async () => {
    const cause = new Error("connect postgresql://admin:private-password@db/logs failed");
    const store = new AiEvidenceStore(
      { source: async () => null } as unknown as AiAnalysisRepository,
      {
        listLogChunks: async () => {
          throw cause;
        },
      } as unknown as ExecutionControlRepository,
      { putObject: vi.fn() } as unknown as JarObjectStorePort,
      "test-key",
    );
    await expect(
      store.collect(
        { id: "item" } as AiWork,
        aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "m" }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "AiModelRequestError",
      message: expect.not.stringContaining("private-password"),
      retryable: true,
      cause,
    });
  });
  it("defers a busy log-storage pool even when the business-database classifier does not recognize it", async () => {
    const cause = new DomainError("PLATFORM_LOG_BUSY", "日志数据库繁忙。");
    const store = new AiEvidenceStore(
      { source: async () => null } as unknown as AiAnalysisRepository,
      {
        listLogChunks: async () => {
          throw cause;
        },
      } as unknown as ExecutionControlRepository,
      { putObject: vi.fn() } as unknown as JarObjectStorePort,
      "test-key",
    );
    await expect(
      store.collect(
        { id: "item" } as AiWork,
        aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "m" }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ constructor: AiResourceDeferral, cause });
  });
  it("keeps an evidence-object write failure distinct from a log-read failure", async () => {
    const cause = new Error("MinIO evidence write failed");
    const store = new AiEvidenceStore(
      { source: async () => null } as unknown as AiAnalysisRepository,
      {
        listLogChunks: async () => ({
          items: [{ sequence: 0, recordedAt: "now", content: "业务日志" }],
        }),
      } as unknown as ExecutionControlRepository,
      {
        putObject: async () => {
          throw cause;
        },
      } as unknown as JarObjectStorePort,
      "test-key",
    );
    await expect(
      store.collect(
        { id: "item" } as AiWork,
        aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "m" }),
        new AbortController().signal,
      ),
    ).rejects.toBe(cause);
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
    expect(result.evidence.stdoutComplete).toBe(false);
    expect(result.evidence.limitations.some((message) => message.includes("采集空间预算"))).toBe(
      true,
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
  it("groups identical complete stacks despite log prefixes, indentation and a final EOF", () => {
    const stack =
      "java.lang.AssertionError: expected 1\n\tat example.Test.run(Test.java:20)\nCaused by: java.io.IOException: connection reset\n\tat example.Client.read(Client.java:3)";
    const prefixed = stack
      .split("\n")
      .map((line) => `2026-11-05 18:00:00 [thread-4] ERROR ${line.replace(/^\t/u, "    ")}`)
      .join("\r\n");
    expect(extractCompleteStacks(prefixed, true)).toEqual(extractCompleteStacks(stack, true));
    expect(extractCompleteStacks(prefixed, true)[0]).toContain("Caused by:");
    expect(extractCompleteStacks(stack, false)).toEqual([]);
    expect(extractCompleteStacks(stack.replace(":20", ":21"), true)).not.toEqual(
      extractCompleteStacks(stack, true),
    );
  });
  it("keeps the same stack signature when only unrelated execution-input metadata is incomplete", async () => {
    let partialInput = false;
    const objects = new Map<string, Uint8Array>();
    const store = new AiEvidenceStore(
      {
        source: async () => ({ class_name: "Example", input_truncated: partialInput }),
      } as unknown as AiAnalysisRepository,
      {
        listLogChunks: async () => ({
          items: [
            {
              sequence: 0,
              recordedAt: "now",
              content: "java.lang.AssertionError: mismatch\n at example.Test.run(Test.java:20)",
            },
          ],
        }),
      } as unknown as ExecutionControlRepository,
      {
        putObject: async ({
          objectKey,
          content,
        }: {
          objectKey: string;
          content: AsyncIterable<Uint8Array>;
        }) => {
          for await (const bytes of content) objects.set(objectKey, bytes);
        },
      } as unknown as JarObjectStorePort,
      "key",
    );
    const configuration = aiModelConfigurationSchema.parse({
      baseUrl: "http://model/v1",
      modelId: "m",
    });
    const first = await store.collect(
      { id: "one" } as AiWork,
      configuration,
      new AbortController().signal,
    );
    partialInput = true;
    const second = await store.collect(
      { id: "two" } as AiWork,
      configuration,
      new AbortController().signal,
    );
    expect(first.evidence.signature).toMatch(/^exact-stack-bundle-v2:/u);
    expect(second.evidence.signature).toBe(first.evidence.signature);
  });
  it("preserves nested business credentials, zero and false without a second masking pass", () => {
    const value = JSON.parse(
      prepareAiJson({
        credentials: { password: "secret with spaces", apiKey: "key" },
        count: 0,
        enabled: false,
      }),
    );
    expect(value).toEqual({
      credentials: { password: "secret with spaces", apiKey: "key" },
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
  it("preserves supplied credentials while cleaning terminal color sequences", () => {
    expect(
      prepareAiText(
        '\u001b[31mpassword=very-secret apiKey:"token" Authorization: Bearer abc123 https://user:pass@host/path\u001b[0m',
      ),
    ).toEqual({
      text: 'password=very-secret apiKey:"token" Authorization: Bearer abc123 https://user:pass@host/path',
      shortened: false,
    });
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
