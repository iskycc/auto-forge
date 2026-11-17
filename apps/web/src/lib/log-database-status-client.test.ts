import { afterEach, describe, expect, it, vi } from "vitest";
import { LogDatabaseStatusClient } from "./log-database-status-client";

function response() {
  return Response.json({
    heartbeat: {
      status: "healthy",
      checkedAt: "2026-11-17T00:00:00.000Z",
      durationMs: 2,
      detail: "ready",
    },
    capacity: { status: "not_configured", detail: "no exporter" },
  });
}

describe("log database status request admission", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invokes native browser fetch with its global receiver", async () => {
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError("Failed to execute fetch: Illegal invocation");
      return Promise.resolve(response());
    });
    const client = new LogDatabaseStatusClient();
    await expect(client.read("one", false, new AbortController().signal)).resolves.toMatchObject({
      heartbeat: { status: "healthy" },
    });
  });

  it("automatically reads all requested servers with at most two active requests", async () => {
    let active = 0;
    let maximum = 0;
    const finishes: Array<() => void> = [];
    const fetcher = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => finishes.push(resolve));
      active--;
      return response();
    });
    const client = new LogDatabaseStatusClient(fetcher);
    const reads = ["write", "history", "one", "two", "three"].map((id) =>
      client.read(id, false, new AbortController().signal),
    );
    for (let index = 0; index < reads.length; index++) {
      await vi.waitFor(() => expect(finishes.length).toBeGreaterThan(index));
      finishes[index]!();
    }
    await expect(Promise.all(reads)).resolves.toHaveLength(5);
    expect(maximum).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("removes an aborted queued request and continues after an individual server fails", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("broken")) {
        await blocked;
        return Response.json(
          { error: { code: "UNAVAILABLE", message: "offline", requestId: "id" } },
          { status: 503 },
        );
      }
      await blocked;
      return response();
    });
    const client = new LogDatabaseStatusClient(fetcher);
    const first = client.read("broken", false, new AbortController().signal);
    const firstFailure = expect(first).rejects.toThrow("offline");
    const second = client.read("healthy", false, new AbortController().signal);
    const controller = new AbortController();
    const cancelled = client.read("removed", false, controller.signal);
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    const next = client.read("next", true, new AbortController().signal);
    release();
    await Promise.all([firstFailure, cancellation, second, next]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls.at(-1)![0])).toContain("next/status?refresh=1");
  });
});
