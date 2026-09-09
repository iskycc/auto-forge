import { afterEach, describe, expect, it, vi } from "vitest";

import { MAXIMUM_COMPARISON_CHARACTERS } from "./attempt-log-diff";
import { loadComparisonLog } from "./load-comparison-log";

afterEach(() => vi.unstubAllGlobals());

function logResponse(content: string, sequence: number, nextSequence?: number) {
  return Response.json({
    items: [{ stream: "stdout", sequence, content, recordedAt: "2026-09-07T00:00:00.000Z" }],
    acknowledgedSequence: sequence,
    ...(nextSequence === undefined ? {} : { nextSequence }),
    truncated: false,
  });
}

describe("comparison log loading", () => {
  it("reads successive pages and preserves records split across chunks", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(logResponse("first\npart", 0, 0))
      .mockResolvedValueOnce(logResponse("ial\n", 1));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    await expect(loadComparisonLog("attempt/a", "stdout", signal, onProgress)).resolves.toEqual({
      text: "first\npartial\n",
      limited: false,
      incomplete: false,
    });
    expect(fetch.mock.calls[0]?.[0]).toContain("attempt%2Fa/logs?");
    expect(fetch.mock.calls[1]?.[0]).toContain("afterSequence=0");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ signal, cache: "no-store" });
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      loadedCharacters: 10,
      loadedChunks: 1,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      loadedCharacters: 14,
      loadedChunks: 2,
    });
  });

  it("stops at the content budget without requesting the remaining pages", async () => {
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return logResponse(
        "a".repeat(60_000),
        fetch.mock.calls.length - 1,
        fetch.mock.calls.length - 1,
      );
    });
    vi.stubGlobal("fetch", fetch);
    const result = await loadComparisonLog("attempt", "stdout", new AbortController().signal);
    expect(result.text).toHaveLength(MAXIMUM_COMPARISON_CHARACTERS);
    expect(result.limited).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects stalled pagination instead of retrying forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => logResponse("line", 0, 0)),
    );
    await expect(
      loadComparisonLog("attempt", "stdout", new AbortController().signal),
    ).rejects.toThrow("日志分页未前进");
  });

  it("reports gaps and propagates permission failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(logResponse("last", 2))
        .mockResolvedValueOnce(
          Response.json({ error: { message: "没有查看日志的权限。" } }, { status: 403 }),
        ),
    );
    expect(
      (await loadComparisonLog("attempt", "stdout", new AbortController().signal)).incomplete,
    ).toBe(true);
    await expect(
      loadComparisonLog("attempt", "stdout", new AbortController().signal),
    ).rejects.toThrow("没有查看日志的权限");
  });
});
