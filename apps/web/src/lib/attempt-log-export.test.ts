import { describe, expect, it, vi } from "vitest";
import { attemptLogExportText, type ExportLogPageReader } from "./attempt-log-export";

async function collect(parts: AsyncIterable<string>) {
  const values: string[] = [];
  for await (const part of parts) values.push(part);
  return values;
}

describe("complete attempt log export", () => {
  it("identifies a capture limit without silently claiming logs discarded before export", async () => {
    const parts = await collect(
      attemptLogExportText(
        async () => ({ items: [], truncated: true }),
        "attempt",
        new AbortController().signal,
      ),
    );
    expect(parts.join("")).toContain("全部已保存日志");
  });
  it("reads all streams and pages and removes split ANSI, OSC and control sequences", async () => {
    const read = vi.fn(async ({ stream, afterSequence }: Parameters<ExportLogPageReader>[0]) => {
      const content =
        stream === "stdout"
          ? afterSequence === -1
            ? "中文\u001b[3"
            : "1m失败\u001b[0m\r\n\u001b]8;;https://secret.test\u0007链接\u001b]8;;\u001b\\\u0000"
          : stream === "stderr"
            ? "堆栈😀\n"
            : "诊断";
      return {
        items: [{ content }],
        acknowledgedSequence: 1,
        truncated: false,
        ...(stream === "stdout" && afterSequence === -1 ? { nextSequence: 0 } : {}),
      };
    });
    const parts = await collect(
      attemptLogExportText(read, "attempt", new AbortController().signal),
    );
    expect(parts.join("")).toBe(
      "===== stdout =====\n中文失败\n链接\n===== stderr =====\n堆栈😀\n\n===== agent =====\n诊断",
    );
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("preserves long logs without Excel character or line limits, including emoji and literal escape text", async () => {
    const original = `${"中文😀".repeat(9000)}\n${"stack line\n".repeat(600)}literal \\u001b[31m`;
    const read = vi.fn(async ({ stream }: Parameters<ExportLogPageReader>[0]) => ({
      items: stream === "stdout" ? [{ content: original }] : [],
      acknowledgedSequence: 0,
      truncated: false,
    }));
    const parts = await collect(
      attemptLogExportText(read, "attempt", new AbortController().signal),
    );
    expect(parts.join("")).toBe(`===== stdout =====\n${original}`);
  });

  it("fails explicitly on unreadable pages and stops reading after cancellation", async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => {
      controller.abort(new Error("cancelled"));
      return {
        items: [{ content: "partial" }],
        nextSequence: 0,
        acknowledgedSequence: 0,
        truncated: false,
      };
    });
    await expect(collect(attemptLogExportText(read, "attempt", controller.signal))).rejects.toThrow(
      "cancelled",
    );
    expect(read).toHaveBeenCalledTimes(1);
    await expect(
      collect(
        attemptLogExportText(
          async () => {
            throw new Error("日志已离线归档");
          },
          "attempt",
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("日志已离线归档");
  });

  it("rejects a stalled cursor instead of looping or returning incomplete logs", async () => {
    const read = vi.fn(async () => ({
      items: [{ content: "chunk" }],
      nextSequence: 0,
      acknowledgedSequence: 0,
      truncated: false,
    }));
    await expect(
      collect(attemptLogExportText(read, "attempt", new AbortController().signal)),
    ).rejects.toThrow(/游标/u);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
