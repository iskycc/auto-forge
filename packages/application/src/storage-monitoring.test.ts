import { describe, expect, it, vi } from "vitest";
import type { StorageMonitoringConfiguration } from "@autoforge/contracts";
import type { AuthenticatedIdentity } from "@autoforge/domain";
import { StorageMonitoringService } from "./storage-monitoring";
const now = new Date("2026-11-02T00:00:00Z");
const source = { host: "db-host", port: 19100, tls: false, mountpoint: "/pgdata" };
const actor = {
  user: { id: "admin" },
  systemPermissions: ["settings.read", "settings.manage"],
  projectPermissions: {},
} as unknown as AuthenticatedIdentity;
function fixture() {
  const repository = {
    read: vi.fn(async () => ({ target: { kind: "primary" as const }, source, revision: 1 })),
    save: vi.fn(async (value: StorageMonitoringConfiguration) => ({ ...value, revision: 2 })),
  };
  const probe = {
    read: vi.fn(async () => ({
      status: "available" as const,
      detail: "filesystem",
      capacityBytes: 100,
      availableBytes: 80,
      sampledAt: now.toISOString(),
    })),
  };
  return {
    repository,
    probe,
    service: new StorageMonitoringService(repository, probe, { now: () => now }),
  };
}
describe("storage monitoring configuration", () => {
  it("checks system permissions before touching configuration or remote endpoints", () => {
    const f = fixture(),
      reader = { ...actor, systemPermissions: [] };
    expect(() => f.service.read(reader, { kind: "primary" })).toThrow();
    expect(() => f.service.save(reader, {})).toThrow();
    expect(() => f.service.check(reader, source)).toThrow();
    expect(f.repository.read).not.toHaveBeenCalled();
    expect(f.probe.read).not.toHaveBeenCalled();
  });
  it("validates endpoints and target IDs, persists revision and supports disabling monitoring", async () => {
    const f = fixture();
    expect(() => f.service.check(actor, { ...source, host: "user:password@host/path" })).toThrow();
    expect(() => f.service.read(actor, { kind: "logs", databaseId: "invalid" })).toThrow();
    await f.service.save(actor, { target: { kind: "primary" }, source: null, revision: 1 });
    expect(f.repository.save).toHaveBeenCalledWith(
      { target: { kind: "primary" }, source: null, revision: 1 },
      now.toISOString(),
    );
    await f.service.capacity({ kind: "primary" }, now);
    expect(f.probe.read).toHaveBeenCalledWith(source, now);
  });
  it("bounds simultaneous probes and releases admission after failures", async () => {
    const f = fixture();
    const finish: Array<() => void> = [];
    f.probe.read.mockImplementation(
      () => new Promise((_, reject) => finish.push(() => reject(new Error("offline")))),
    );
    const requests = Array.from({ length: 4 }, () =>
      f.service.check(actor, source).catch(() => undefined),
    );
    await expect(f.service.check(actor, source)).rejects.toMatchObject({
      code: "PLATFORM_LOG_BUSY",
    });
    finish.forEach((resolve) => resolve());
    await Promise.all(requests);
    f.probe.read.mockResolvedValue({
      status: "available",
      detail: "ok",
      capacityBytes: 100,
      availableBytes: 80,
      sampledAt: now.toISOString(),
    });
    await expect(f.service.check(actor, source)).resolves.toMatchObject({ status: "available" });
  });
});
