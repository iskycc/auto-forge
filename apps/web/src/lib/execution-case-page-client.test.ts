import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBrowserSnapshots, writeBrowserSnapshot } from "./browser-read-cache";
import { loadExecutionCasePage } from "./execution-case-page-client";

beforeEach(clearBrowserSnapshots);
afterEach(() => vi.unstubAllGlobals());

describe("execution case page loading", () => {
  it("discards pages cached before ordinary cases were sorted by class path", async () => {
    const url = "/cases?sort=name&direction=asc";
    writeBrowserSnapshot(`batch-case-page:v1:${url}\u0000g1`, { items: [], total: 99 });
    const fetch = vi.fn(async () => Response.json({ items: [], total: 2 }));
    vi.stubGlobal("fetch", fetch);
    const result = await loadExecutionCasePage(url, "g1", new AbortController().signal);
    expect(result.total).toBe(2);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reuses a page only within the same scope and statistics generation", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [], total: 2 }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await loadExecutionCasePage("/cases?runnerId=a&executionRound=1", "g1", signal);
    await loadExecutionCasePage("/cases?runnerId=a&executionRound=1", "g1", signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    await loadExecutionCasePage("/cases?runnerId=b&executionRound=1", "g1", signal);
    await loadExecutionCasePage("/cases?runnerId=a&executionRound=2", "g1", signal);
    await loadExecutionCasePage("/cases?runnerId=a&executionRound=1", "g2", signal);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("bounds pending snapshot retries and exposes an actionable error", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { code: "READ_MODEL_PENDING", message: "后台正在准备数据，请稍后重试。" } },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      loadExecutionCasePage("/pending", "g1", new AbortController().signal),
    ).rejects.toThrow("后台正在准备数据");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not cache a response after logout or abort", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      clearBrowserSnapshots();
      controller.abort();
      return Response.json({ items: [], total: 1 });
    });
    vi.stubGlobal("fetch", fetch);
    await loadExecutionCasePage("/cases", "g1", controller.signal);
    await loadExecutionCasePage("/cases", "g1", new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
