import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemDiagnosticReader } from "./system-diagnostics";

function fixture(mode: "lite" | "full" = "lite") {
  const check = vi.fn(async () => undefined);
  const sources = {
    mode,
    clock: {
      now: () => new Date(),
      status: () => ({
        source: mode === "lite" ? ("local" as const) : ("postgres" as const),
        state: "synchronized" as const,
        lastSynchronizedAt: null,
        sampleAgeMs: 0,
      }),
    },
    configurationRevision: () => 2,
    dependencies: {
      database: { provider: mode === "lite" ? "SQLite" : "PostgreSQL", check },
      objectStore: { provider: "storage", check: async () => undefined },
      queue: { provider: "queue", check: async () => undefined },
      cache: { provider: "cache", check: async () => undefined },
    },
    queue: {
      depth: vi.fn(async () => ({ available: 2, leased: 3, deadLetter: 0 })),
      listDeadLetters: vi.fn(async () => []),
    },
    dataDirectory: "/private-data",
    disk: vi.fn(async () => ({
      capacityBytes: 1000,
      availableBytes: 600,
      usedPercent: 40,
      status: "ok" as const,
    })),
    runtime: () => ({
      nodeId: "local",
      hostname: "node",
      distributed: false,
      nodeVersion: "v24.0.0",
      platform: "linux",
      architecture: "x64",
      uptimeSeconds: 100,
      cpuCapacity: 0.5,
      memoryCapacityBytes: 1000,
      availableMemoryBytes: 500,
      processRssBytes: 100,
      heapUsedBytes: 50,
      heapLimitBytes: 200,
      backgroundAllowed: true,
    }),
  };
  return { sources, check, reader: new SystemDiagnosticReader(sources) };
}

afterEach(() => vi.useRealTimers());

describe("system diagnostic snapshots", () => {
  it.each(["lite", "full"] as const)(
    "returns bounded health and runtime information in %s",
    async (mode) => {
      const { reader, sources } = fixture(mode);
      const report = await reader.read();
      expect(report.version).toBe("dev");
      expect(report.database.ready).toBe(true);
      expect(report.database.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.queueDepth).toEqual({ available: 2, leased: 3, deadLetter: 0 });
      expect(report.runtime?.cpuCapacity).toBe(0.5);
      expect(report.recentErrors).toEqual([]);
      expect(sources.queue.listDeadLetters).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain("/private-data");
    },
  );

  it("coalesces concurrent reads, caches results and supports an explicit refresh", async () => {
    const { reader, check } = fixture();
    const [first, second] = await Promise.all([reader.read(), reader.read(true)]);
    expect(first).toBe(second);
    expect(await reader.read()).toBe(first);
    expect(check).toHaveBeenCalledTimes(1);
    await reader.read(true);
    expect(check).toHaveBeenCalledTimes(2);
    vi.spyOn(performance, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    await reader.read();
    expect(check).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  it("keeps other results visible when storage or a dependency fails and removes secrets", async () => {
    const { reader, sources, check } = fixture();
    check.mockRejectedValue(new Error("connect postgres://user:private@db/database token=private"));
    sources.disk.mockRejectedValue(new Error("disk unavailable"));
    const report = await reader.read();
    expect(report.database.ready).toBe(false);
    expect(report.objectStore.ready).toBe(true);
    expect(report.dataDisk).toBeUndefined();
    expect(report.recentErrors.map((error) => error.code)).toContain("DATA_DISK_UNAVAILABLE");
    expect(JSON.stringify(report)).not.toContain("private");
  });

  it("bounds slow queue depth reads and never accumulates a hung probe", async () => {
    vi.useFakeTimers();
    const { reader, sources } = fixture();
    sources.queue.depth.mockImplementation(() => new Promise(() => undefined));
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(3001);
    expect((await first).queue.ready).toBe(false);
    const second = reader.read(true);
    await vi.advanceTimersByTimeAsync(3001);
    expect((await second).queueDepth).toBeUndefined();
    expect(sources.queue.depth).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable shared clock instead of failing the whole diagnostics page", async () => {
    const { sources } = fixture("full");
    const reader = new SystemDiagnosticReader({
      ...sources,
      clock: {
        now: () => {
          throw new Error("clock unavailable");
        },
        status: () => ({
          source: "postgres",
          state: "unavailable",
          lastSynchronizedAt: null,
          sampleAgeMs: null,
        }),
      },
    });
    const report = await reader.read();
    expect(report.clock?.state).toBe("unavailable");
    expect(report.recentErrors.map((error) => error.code)).toContain("PLATFORM_CLOCK_UNAVAILABLE");
  });

  it("keeps dead letters bounded and sanitizes their diagnostics", async () => {
    const { sources } = fixture();
    const listDeadLetters = vi.fn(async () => [
      {
        messageId: "message",
        runId: "run",
        kind: "object-cleanup" as const,
        deliveryAttempts: 3,
        errorCode: "ERROR",
        errorSummary: "https://private/store token=private",
        failedAt: new Date().toISOString(),
      },
    ]);
    const reader = new SystemDiagnosticReader({
      ...sources,
      queue: {
        depth: async () => ({ available: 0, leased: 0, deadLetter: 42 }),
        listDeadLetters,
      },
    });
    const report = await reader.read();
    expect(listDeadLetters).toHaveBeenCalledWith(20);
    expect(report.queueDepth?.deadLetter).toBe(42);
    expect(report.deadLetters).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("private");
  });
});
