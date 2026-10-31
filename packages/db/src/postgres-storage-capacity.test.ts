import { describe, expect, it, vi } from "vitest";
import { readPostgresStorageCapacity } from "./postgres-storage-capacity";

const now = new Date("2026-10-31T08:00:00Z");
const payload = {
  schemaVersion: 1,
  capacityBytes: 1_000_000,
  availableBytes: 200_000,
  sampledAt: "2026-10-31T07:59:40Z",
};

describe("PostgreSQL data-volume capacity", () => {
  it("reads the host collector sample through a fixed bounded SQL file read", async () => {
    const query = vi.fn(async () => ({ rows: [{ sample: JSON.stringify(payload) }] }));
    expect(await readPostgresStorageCapacity({ query }, now)).toMatchObject({
      status: "available",
      capacityBytes: 1_000_000,
      availableBytes: 200_000,
      usedPercent: 80,
      sampledAt: payload.sampledAt,
    });
    expect(query.mock.calls[0]).toEqual([
      "SELECT pg_read_file('autoforge-storage-capacity.json', 0, 4096, true) AS sample",
    ]);
  });
  it("does not substitute database size or the Web host's free space for missing host metrics", async () => {
    expect(
      await readPostgresStorageCapacity({ query: async () => ({ rows: [{ sample: null }] }) }, now),
    ).toMatchObject({ status: "not_configured" });
  });
  it("marks stale host samples without claiming they are current capacity", async () => {
    const sample = JSON.stringify({ ...payload, sampledAt: "2026-10-31T07:00:00Z" });
    expect(
      await readPostgresStorageCapacity({ query: async () => ({ rows: [{ sample }] }) }, now),
    ).toMatchObject({ status: "stale", availableBytes: 200_000 });
  });
  it.each(["42501", "08006"])("returns a safe state for server error %s", async (code) => {
    const query = async () => {
      throw Object.assign(new Error("postgres://secret:password@host/db"), { code });
    };
    const capacity = await readPostgresStorageCapacity({ query }, now);
    expect(capacity.status).toBe(code === "42501" ? "permission_denied" : "unavailable");
    expect(JSON.stringify(capacity)).not.toContain("secret");
  });
  it.each([
    "not-json",
    JSON.stringify({ ...payload, availableBytes: 2_000_000 }),
    JSON.stringify({ ...payload, availableBytes: -1 }),
    JSON.stringify({ ...payload, schemaVersion: 2 }),
  ])("rejects malformed or impossible capacity samples", async (sample) => {
    expect(
      await readPostgresStorageCapacity({ query: async () => ({ rows: [{ sample }] }) }, now),
    ).toMatchObject({ status: "unavailable" });
  });
});
