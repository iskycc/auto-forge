import { describe, expect, it, vi } from "vitest";
import type {
  AiAnalysisRepository,
  AiWork,
  ExecutionControlRepository,
  JarObjectStorePort,
} from "@autoforge/application";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import { AiEvidenceStore, prepareAiJson } from "./ai-evidence";
import { shortenAiInput } from "./ai-input-text";

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
  it.each(["\n", "\r\n", "\r"])(
    "extends the tail back to the first line's start with %j line endings",
    (newline) => {
      const firstLine = "完整首行🧪";
      const retained = firstLine + newline + "尾".repeat(24998);
      const result = shortenAiInput("前".repeat(30000) + newline + retained);
      expect(result).toEqual({ text: retained, shortened: true });
      expect([...result.text].length).toBeGreaterThan(25000);
    },
  );
  it("keeps an exactly aligned line boundary without including the previous line", () => {
    const tail = "尾".repeat(25000);
    expect(shortenAiInput("前".repeat(30000) + "\n" + tail)).toEqual({
      text: tail,
      shortened: true,
    });
  });
  it.each([24998, 24999])(
    "keeps the preceding full line when a %i-character suffix puts the cut inside CRLF",
    (suffixLength) => {
      const retained = "完整首行\r\n" + "尾".repeat(suffixLength);
      expect(shortenAiInput("前".repeat(30000) + "\r\n" + retained)).toEqual({
        text: retained,
        shortened: true,
      });
    },
  );
  it("retains an entire long first line and does not falsely describe it as shortened", () => {
    const line = "🧪".repeat(50001);
    expect(shortenAiInput(line)).toEqual({ text: line, shortened: false });
  });
  it("preserves empty first lines and a missing final newline", () => {
    const retained = "\n" + "尾".repeat(24999);
    expect(shortenAiInput("前".repeat(30000) + "\n" + retained)).toEqual({
      text: retained,
      shortened: true,
    });
  });
  it("sends the full stdout and its stack when the log is longer than the previous 5000-character limit", async () => {
    const stack =
      "java.lang.AssertionError: BUSINESS_ROOT_CAUSE\n" +
      Array.from(
        { length: 160 },
        (_, index) => `\tat example.Business.step${index}(Business.java:${index})`,
      ).join("\n") +
      "\nCaused by: java.io.IOException: upstream reset\n\tat example.Connection.read(Connection.java:7)";
    const fixture = evidenceFixture([
      `\u001b[31m${stack}\u001b[0m\n\n` + "无关收尾\n".repeat(800) + "TestNG exit code:1\n",
    ]);
    const result = await fixture.collect();
    const delivered = await fixture.text(result.evidence.parts);
    expect([...stack].length).toBeGreaterThan(5000);
    expect(delivered).toContain(stack);
    expect(delivered).toContain("无关收尾");
    expect(await fixture.text(result.evidence.parts)).not.toMatch(/TestNG exit code/iu);
    expect(delivered).not.toContain("\u001b");
  });
  it.each(["TestNG exit code:1", "TestNG exit status: 1", "TestNG exited with code 1."])(
    "does not produce an analysis from the generic summary %s alone",
    async (summary) => {
      await expect(evidenceFixture([summary]).collect()).rejects.toThrow("退出码");
    },
  );
  it.each([49999, 50000, 50001])(
    "applies the tail rule to a complete %i-character stream across chunk boundaries",
    async (length) => {
      const text = "前".repeat(length - 25001) + "\n" + "尾".repeat(25000);
      const fixture = evidenceFixture([text.slice(0, 25000), text.slice(25000)]);
      const result = await fixture.collect();
      expect(await fixture.text(result.evidence.parts)).toBe(
        length > 50000 ? text.slice(-25000) : text,
      );
      expect(result.evidence.stdoutComplete).toBe(true);
      expect(result.evidence.limitations).not.toContainEqual(expect.stringContaining("超过 50000"));
      expect(
        result.evidence.inputTransformations?.some((note) => note.includes("末尾 25000")),
      ).toBe(length > 50000);
    },
  );
  it("cleans color, OSC and other terminal controls before measuring the threshold", async () => {
    const visible = "彩".repeat(50000);
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
    for (const count of [50000, 50001]) {
      const fixture = evidenceFixture(["🧪".repeat(count)]);
      const result = await fixture.collect();
      const text = await fixture.text(result.evidence.parts);
      expect(text).toBe("🧪".repeat(count));
      expect(text).not.toContain("\ufffd");
    }
  });
  it("preserves original password and token text across chunks before applying the tail rule", async () => {
    const fixture = evidenceFixture([
      "x".repeat(51000) + "pass",
      "word=" + "s".repeat(4000) + "\n业务尾部",
    ]);
    const result = await fixture.collect();
    const text = await fixture.text(result.evidence.parts);
    expect(text).toContain("password=" + "s".repeat(4000));
    expect(text).not.toContain("[REDACTED]");
  });
  it("prepares nested business strings without changing JSON structure, zero or false", () => {
    const long = "前".repeat(30000) + "尾".repeat(25000);
    expect(
      JSON.parse(
        prepareAiJson({
          nested: { message: "\u001b[31m" + long + "\u001b[0m" },
          values: ["短文本", 0, false, null],
          password: long,
        }),
      ),
    ).toEqual({
      nested: { message: long },
      values: ["短文本", 0, false, null],
      password: long,
    });
  });
  it("keeps full-stack grouping independent of the model's equal tail samples", async () => {
    const tail =
      "正文\n".repeat(20000) +
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
