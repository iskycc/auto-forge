import { describe, expect, it, vi } from "vitest";
import type { LogDatabaseRepository } from "./log-databases";
import { LogDatabaseService } from "./log-databases";
import type { PostgresStorageCapacity } from "@autoforge/contracts";
const value: PostgresStorageCapacity = { status: "not_configured", detail: "not sampled" };
function fixture() {
  let now = 0;
  const repository = { storageCapacity: vi.fn(async () => value) };
  const service = new LogDatabaseService(
    repository as unknown as LogDatabaseRepository,
    { now: () => new Date(now) },
    { next: () => "id" },
  );
  return { repository, service, advance: () => (now += 15001) };
}
describe("log database capacity admission", () => {
  it("coalesces concurrent reads, caches for fifteen seconds, and supports explicit refresh", async () => {
    const f = fixture();
    await Promise.all([f.service.storageCapacity("one"), f.service.storageCapacity("one")]);
    expect(f.repository.storageCapacity).toHaveBeenCalledTimes(1);
    await f.service.storageCapacity("one");
    expect(f.repository.storageCapacity).toHaveBeenCalledTimes(1);
    await f.service.storageCapacity("one", true);
    expect(f.repository.storageCapacity).toHaveBeenCalledTimes(2);
    f.advance();
    await f.service.storageCapacity("one");
    expect(f.repository.storageCapacity).toHaveBeenCalledTimes(3);
  });
  it("admits at most four different servers and releases admission after completion", async () => {
    const f = fixture();
    const finishes: Array<(value: PostgresStorageCapacity) => void> = [];
    f.repository.storageCapacity.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const pending = ["a", "b", "c", "d"].map((id) => f.service.storageCapacity(id));
    expect(() => f.service.storageCapacity("e")).toThrow(
      expect.objectContaining({ code: "PLATFORM_LOG_BUSY" }),
    );
    // End all pending probes deterministically, without a timing race.
    f.repository.storageCapacity.mockResolvedValue(value);
    for (const finish of finishes) finish(value);
    await Promise.all(pending);
    expect(await f.service.storageCapacity("e")).toEqual(value);
  });
  it("does not cache failed probes and leaves unsupported stores explicit", async () => {
    const f = fixture();
    f.repository.storageCapacity.mockRejectedValueOnce(new Error("offline"));
    await expect(f.service.storageCapacity("one")).rejects.toThrow("offline");
    expect(await f.service.storageCapacity("one")).toEqual(value);
    const service = new LogDatabaseService(
      {} as LogDatabaseRepository,
      { now: () => new Date() },
      { next: () => "id" },
    );
    expect(() => service.storageCapacity("one")).toThrow(
      expect.objectContaining({ code: "LOG_DATABASE_UNSUPPORTED" }),
    );
  });
});

it("uses new connection samples immediately and prevents an older in-flight sample from replacing them", async () => {
  const f = fixture();
  let finish!: (value: PostgresStorageCapacity) => void;
  f.repository.storageCapacity.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = f.service.storageCapacity("one");
  Object.assign(f.repository, { updateDailyConnection: vi.fn(async () => ({})) });
  await f.service.updateConnection("one", {
    name: "logs",
    host: "new-host",
    port: 5432,
    username: "postgres",
    password: "fixture-only",
    maintenanceDatabase: "postgres",
    databasePrefix: "af_logs",
    sslMode: "disable",
  });
  const fresh: PostgresStorageCapacity = {
    status: "unavailable",
    detail: "new server has no current sample",
  };
  f.repository.storageCapacity.mockResolvedValue(fresh);
  expect(await f.service.storageCapacity("one")).toEqual(fresh);
  finish(value);
  await old;
  expect(await f.service.storageCapacity("one")).toEqual(fresh);
});
