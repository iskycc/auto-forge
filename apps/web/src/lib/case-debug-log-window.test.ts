import { describe, expect, it } from "vitest";
import type { LogChunk } from "@autoforge/contracts";
import { debugLogWindow } from "./case-debug-log-window";

const chunk = (sequence: number, content = String(sequence)): LogChunk => ({
  stream: "stdout",
  sequence,
  content,
  recordedAt: "2026-09-29T01:00:00.000Z",
});
describe("debug live log window", () => {
  it("deduplicates retransmitted chunks and follows the latest 200", () => {
    const result = debugLogWindow(
      [chunk(0)],
      Array.from({ length: 250 }, (_, index) => chunk(index)),
    );
    expect(result.items).toHaveLength(200);
    expect(result.items[0]?.sequence).toBe(50);
    expect(result.items.at(-1)?.sequence).toBe(249);
    expect(result.trimmed).toBe(true);
  });
  it("bounds one oversized chunk without losing the latest output", () => {
    const result = debugLogWindow([chunk(0, "old")], [chunk(1, `${"x".repeat(300_000)}END`)]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.content).toHaveLength(256 * 1_024);
    expect(result.items[0]?.content.endsWith("END")).toBe(true);
    expect(result.trimmed).toBe(true);
  });
});
