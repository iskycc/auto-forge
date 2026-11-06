import { describe, expect, it, vi } from "vitest";
import type {
  AiAnalysisRepository,
  AiWork,
  ExecutionControlRepository,
  JarObjectStorePort,
} from "@autoforge/application";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import { AiEvidenceStore, redactAiJson } from "./ai-evidence";

function evidenceFixture(chunks: string[], source: Record<string, unknown> = {}) {
  const objects = new Map<string, Uint8Array>();
  const listLogChunks = vi.fn(
    async ({ afterSequence, limit }: { afterSequence: number; limit: number }) => {
      const selected = chunks.slice(afterSequence + 1, afterSequence + 1 + limit);
      return {
        items: selected.map((content, index) => ({
          sequence: afterSequence + index + 1,
          content,
          recordedAt: "now",
        })),
        ...(afterSequence + 1 + selected.length < chunks.length
          ? { nextSequence: afterSequence + selected.length }
          : {}),
      };
    },
  );
  const store = new AiEvidenceStore(
    { source: async () => source } as unknown as AiAnalysisRepository,
    { listLogChunks } as unknown as ExecutionControlRepository,
    {
      putObject: async ({
        objectKey,
        content,
      }: {
        objectKey: string;
        content: AsyncIterable<Uint8Array>;
      }) => {
        const blocks = [];
        for await (const block of content) blocks.push(block);
        objects.set(objectKey, Buffer.concat(blocks));
      },
      read: async (key: string) => objects.get(key)!,
    } as unknown as JarObjectStorePort,
    "signature-key",
  );
  return {
    store,
    listLogChunks,
    collect: () =>
      store.collect(
        {
          id: "item",
          jobId: "job",
          projectId: "project",
          executionRunId: "run",
          attemptId: "attempt",
          strategy: "single_full_v2",
        } as AiWork,
        aiModelConfigurationSchema.parse({ baseUrl: "http://model/v1", modelId: "fixture" }),
        new AbortController().signal,
      ),
    text: async (parts: Awaited<ReturnType<AiEvidenceStore["collect"]>>["evidence"]["parts"]) =>
      (
        await Promise.all(
          parts.filter((part) => part.id.startsWith("stdout-")).map((part) => store.part(part)),
        )
      ).join(""),
  };
}

describe("AI evidence text preparation", () => {
  it.each([4999, 5000, 5001])(
    "applies the tail rule to a complete %i-character stream across chunk boundaries",
    async (length) => {
      const text = "前".repeat(length - 1) + "尾";
      const fixture = evidenceFixture([text.slice(0, 2500), text.slice(2500)]);
      const result = await fixture.collect();
      expect(await fixture.text(result.evidence.parts)).toBe(
        length > 5000 ? text.slice(-2500) : text,
      );
      expect(result.evidence.stdoutComplete).toBe(true);
      expect(result.evidence.limitations).not.toContainEqual(expect.stringContaining("超过 5000"));
      expect(result.evidence.inputTransformations?.some((note) => note.includes("末尾 2500"))).toBe(
        length > 5000,
      );
    },
  );
  it("cleans color, OSC and other terminal controls before measuring the threshold", async () => {
    const visible = "彩".repeat(5000);
    const fixture = evidenceFixture([
      "\u001b[31m" +
        visible +
        "\u001b[0m\u001b]8;;https://ignored.test\u0007\u001b]8;;\u001b\\\u0000\u007f",
    ]);
    const result = await fixture.collect();
    expect(await fixture.text(result.evidence.parts)).toBe(visible);
  });
  it("keeps ANSI parsing state across log pages and removes the complete control sequence", async () => {
    const chunks = [
      ...Array.from({ length: 15 }, () => "业务\n"),
      "\u001b[3",
      "1m红色\u001b[0m\u001b]8;;https://hidden.test",
      "\u0007标签\u001b]8;;\u001b\\\u0000",
    ];
    const fixture = evidenceFixture(chunks);
    const result = await fixture.collect();
    expect(await fixture.text(result.evidence.parts)).toBe("业务\n".repeat(15) + "红色标签");
    expect(fixture.listLogChunks.mock.calls.map(([input]) => input.afterSequence)).toEqual([
      -1, 15,
    ]);
  });
  it("counts non-BMP characters without splitting their surrogate pairs", async () => {
    for (const count of [5000, 5001]) {
      const fixture = evidenceFixture(["🧪".repeat(count)]);
      const result = await fixture.collect();
      const text = await fixture.text(result.evidence.parts);
      expect(text).toBe("🧪".repeat(count > 5000 ? 2500 : count));
      expect(text).not.toContain("\ufffd");
    }
  });
  it("redacts secrets before tail selection even when the secret spans log chunks", async () => {
    const fixture = evidenceFixture([
      "x".repeat(5100) + "pass",
      "word=" + "s".repeat(4000) + "\n业务尾部",
    ]);
    const result = await fixture.collect();
    const text = await fixture.text(result.evidence.parts);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("s".repeat(20));
  });
  it("prepares nested business strings without changing JSON structure, zero or false", () => {
    const long = "前".repeat(3000) + "尾".repeat(2500);
    expect(
      JSON.parse(
        redactAiJson({
          nested: { message: "\u001b[31m" + long + "\u001b[0m" },
          values: ["短文本", 0, false, null],
          password: long,
        }),
      ),
    ).toEqual({
      nested: { message: "尾".repeat(2500) },
      values: ["短文本", 0, false, null],
      password: "[REDACTED]",
    });
  });
  it("keeps full-stack grouping independent of the model's equal tail samples", async () => {
    const tail =
      "正文\n".repeat(2000) +
      "java.lang.AssertionError: same tail\n\tat example.Last.run(Last.java:9)";
    const fixtures = [1, 2].map((line) =>
      evidenceFixture([
        `java.lang.AssertionError: first\n\tat example.First.run(First.java:${line})\n\n` + tail,
      ]),
    );
    const results = await Promise.all(fixtures.map((fixture) => fixture.collect()));
    expect(results[0]!.evidence.signature).not.toBe(results[1]!.evidence.signature);
    expect(await fixtures[0]!.text(results[0]!.evidence.parts)).toBe(
      await fixtures[1]!.text(results[1]!.evidence.parts),
    );
  });
});
