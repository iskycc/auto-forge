import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
import { LogDatabaseMonitoringService } from "./log-database-monitoring";
import type { LogDatabasePage, PostgresStorageCapacity } from "@autoforge/contracts";

const capacity: PostgresStorageCapacity = {
  status: "available",
  detail: "fixture data volume",
  capacityBytes: 1000,
  availableBytes: 600,
  sampledAt: "2026-11-17T00:00:00.000Z",
};

function fixture() {
  let now = Date.parse("2026-11-17T00:00:00.000Z");
  const ports = {
    list: vi.fn(async (): Promise<LogDatabasePage> => ({
      items: [],
      activeDatabaseId: null,
      revision: 1,
    })),
    check: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    capacity: vi.fn<(id: string) => Promise<PostgresStorageCapacity>>().mockResolvedValue(capacity),
  };
  const service = new LogDatabaseMonitoringService(ports, { now: () => new Date(now) });
  return { ports, service, advance: (ms: number) => (now += ms) };
}

describe("log database monitoring", () => {
  it("samples connection and capacity independently, coalesces requests, and expires snapshots", async () => {
    const f = fixture();
    const [one, two] = await Promise.all([f.service.read("one"), f.service.read("one")]);
    expect(one).toEqual(two);
    expect(one.heartbeat.status).toBe("healthy");
    expect(one.capacity).toEqual(capacity);
    expect(f.ports.check).toHaveBeenCalledTimes(1);
    await f.service.read("one");
    expect(f.ports.check).toHaveBeenCalledTimes(1);
    f.advance(90_001);
    await f.service.read("one");
    expect(f.ports.check).toHaveBeenCalledTimes(2);
  });

  it("isolates an offline historical database and records recovery without exposing credentials", async () => {
    const f = fixture();
    f.ports.check.mockRejectedValueOnce(new Error("password=private-value"));
    const offline = await f.service.read("history");
    expect(offline.heartbeat.status).toBe("unavailable");
    expect(JSON.stringify(offline)).not.toContain("private-value");
    expect(offline.capacity).toEqual(capacity);
    f.advance(1000);
    const recovered = await f.service.read("history", true);
    expect(recovered.heartbeat.status).toBe("healthy");
    expect(recovered.heartbeat.lastSucceededAt).toBe(recovered.heartbeat.checkedAt);
  });

  it("keeps last successful heartbeat and marks old capacity stale after a sampling failure", async () => {
    const f = fixture();
    const first = await f.service.read("one");
    f.ports.check.mockRejectedValueOnce(
      new DomainError("PLATFORM_LOG_DATABASE_UNAVAILABLE", "offline"),
    );
    f.ports.capacity.mockRejectedValueOnce(new Error("private endpoint"));
    f.advance(1000);
    const failed = await f.service.read("one", true);
    expect(failed.heartbeat.lastSucceededAt).toBe(first.heartbeat.lastSucceededAt);
    expect(failed.capacity).toMatchObject({ status: "stale", availableBytes: 600 });
    expect(JSON.stringify(failed)).not.toContain("private endpoint");
  });

  it("monitors every registered server including inactive ones, across pages, with two probes at once", async () => {
    const f = fixture();
    const page = (ids: string[], nextCursor?: string): LogDatabasePage => ({
      items: ids.map((id) => ({
        id,
        name: id,
        address: id,
        active: id === "active",
        batchCount: 0,
        storedBytes: 0,
        createdAt: "now",
      })),
      ...(nextCursor ? { nextCursor } : {}),
      activeDatabaseId: "active",
      revision: 1,
    });
    f.ports.list
      .mockResolvedValueOnce(page(["active", "history"], "history"))
      .mockResolvedValueOnce(page(["other"]));
    let pending = 0;
    let maximum = 0;
    f.ports.check.mockImplementation(async () => {
      maximum = Math.max(maximum, ++pending);
      await Promise.resolve();
      pending--;
    });
    await f.service.refreshAll(new AbortController().signal, () => true);
    expect(f.ports.check.mock.calls.map(([id]) => id)).toEqual(["active", "history", "other"]);
    expect(f.ports.capacity).toHaveBeenCalledTimes(3);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(f.ports.list).toHaveBeenLastCalledWith("history");
  });

  it("defers monitoring under load and stops starting probes during shutdown", async () => {
    const f = fixture();
    const controller = new AbortController();
    await f.service.refreshAll(controller.signal, () => false);
    expect(f.ports.list).not.toHaveBeenCalled();
    controller.abort();
    await f.service.refreshAll(controller.signal, () => true);
    expect(f.ports.check).not.toHaveBeenCalled();
  });

  it("keeps admission occupied until capacity I/O finishes after an early heartbeat rejection", async () => {
    const f = fixture();
    f.ports.check.mockRejectedValue(new DomainError("PLATFORM_LOG_BUSY", "busy"));
    const finishes: Array<(value: PostgresStorageCapacity) => void> = [];
    f.ports.capacity.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
    const pending = Promise.allSettled(["a", "b", "c", "d"].map((id) => f.service.read(id)));
    await Promise.resolve();
    expect(() => f.service.read("e")).toThrow(
      expect.objectContaining({ code: "PLATFORM_LOG_BUSY" }),
    );
    for (const finish of finishes) finish(capacity);
    expect((await pending).every((result) => result.status === "rejected")).toBe(true);
    f.ports.check.mockResolvedValue(undefined);
    f.ports.capacity.mockResolvedValue(capacity);
    expect((await f.service.read("e")).heartbeat.status).toBe("healthy");
  });

  it("does not mark admission pressure as database failure or overwrite a new connection with an old sample", async () => {
    const f = fixture();
    let release!: () => void;
    f.ports.check.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const old = f.service.read("one");
    f.service.invalidate();
    const fresh = await f.service.read("one");
    release();
    await old;
    expect(await f.service.read("one")).toEqual(fresh);
    f.ports.check.mockRejectedValueOnce(new DomainError("PLATFORM_LOG_BUSY", "busy"));
    await expect(f.service.read("one", true)).rejects.toMatchObject({ code: "PLATFORM_LOG_BUSY" });
    expect((await f.service.read("one")).heartbeat.status).toBe("healthy");
  });
});
