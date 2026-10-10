import { describe, expect, it } from "vitest";
import type { LogChunk } from "@autoforge/contracts";
import { mergeManualLogWindow, parseManualLogFrame } from "./manual-live-log";
import { SHARED_LOG_MAX_BYTES } from "./shared-attempt-log";

const chunk = (
  sequence: number,
  content = `line ${sequence}\n`,
  stream: LogChunk["stream"] = "stdout",
): LogChunk => ({ sequence, content, stream, recordedAt: "2026-10-10T00:00:00.000Z" });
describe("bounded manual live log window", () => {
  it("deduplicates replay while preserving independent stdout/stderr sequences", () => {
    const first = mergeManualLogWindow([], [chunk(0), chunk(0, "error\n", "stderr")]);
    const next = mergeManualLogWindow(first.chunks, [chunk(0), chunk(1)]);
    expect(next.chunks).toHaveLength(3);
    expect(next.chunks.map((entry) => entry.content).join("")).toBe("error\nline 0\nline 1\n");
  });
  it("retains recent output within the UTF-8 byte budget", () => {
    const result = mergeManualLogWindow(
      [chunk(0, "old".repeat(120_000))],
      [chunk(1, "新".repeat(200_000))],
    );
    const text = result.chunks.map((entry) => entry.content).join("");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SHARED_LOG_MAX_BYTES);
    expect(text).not.toContain("old");
    expect(text).not.toContain("\uFFFD");
    expect(text.endsWith("新")).toBe(true);
  });
  it("also bounds the number of tiny chunks and excludes Agent diagnostics", () => {
    const result = mergeManualLogWindow(
      [],
      [
        ...Array.from({ length: 3_000 }, (_, sequence) => chunk(sequence, "x")),
        chunk(3_001, "private diagnostic", "agent"),
      ],
    );
    expect(result.chunks.length).toBeLessThanOrEqual(1_024);
    expect(result.chunks.at(-1)?.sequence).toBe(2_999);
    expect(result.truncated).toBe(true);
  });
});
describe("manual log frames", () => {
  it("accepts only validated chunks for the selected attempt", () => {
    const frame = { schemaVersion: 1, type: "chunks", attemptId: "attempt", chunks: [chunk(0)] };
    expect(parseManualLogFrame(JSON.stringify(frame), "attempt")).toEqual([chunk(0)]);
    expect(parseManualLogFrame(JSON.stringify(frame), "other")).toBeNull();
    expect(
      parseManualLogFrame(
        JSON.stringify({ ...frame, chunks: [{ ...chunk(0), sequence: -1 }] }),
        "attempt",
      ),
    ).toBeNull();
    expect(parseManualLogFrame("{broken", "attempt")).toBeNull();
  });
});
