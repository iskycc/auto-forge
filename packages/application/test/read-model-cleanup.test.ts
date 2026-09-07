import { describe, expect, it, vi } from "vitest";
import {
  ReadModelSnapshotWorker,
  type ReadModelSnapshotRepository,
} from "../src/read-model-snapshots";

describe("directory generation cleanup", () => {
  it("defers a temporary adapter lock without exhausting snapshot retries and publishes after recovery", async () => {
    const lockConflict = new Error("temporary lock conflict");
    const repository = {
      claim: vi.fn(async () => ({ id: "snapshot", token: "lease", query: { kind: "dashboard" } })),
      complete: vi.fn(async () => true),
      fail: vi.fn(),
    } as unknown as ReadModelSnapshotRepository;
    const build = vi
      .fn()
      .mockRejectedValueOnce(lockConflict)
      .mockResolvedValueOnce({ ready: true });
    const errors = vi.fn();
    const worker = new ReadModelSnapshotWorker(
      repository,
      build,
      { now: () => new Date("2026-09-07T00:00:00.000Z") },
      { next: () => "lease" },
      errors,
      () => true,
      () => true,
      (error: unknown) => error === lockConflict,
    );
    await worker.refreshOne();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), "2026-09-07T00:00:01.000Z", {
      deferred: true,
    });
    expect(repository.complete).not.toHaveBeenCalled();
    await worker.refreshOne();
    expect(repository.complete).toHaveBeenCalledOnce();
  });
  it("builds an uncached page during execution pressure without refreshing cached statistics", async () => {
    const repository = {
      claim: vi.fn(async () => ({
        id: "page",
        token: "lease",
        generatedAt: null,
        query: { kind: "case_directory" },
      })),
      complete: vi.fn(async () => true),
      fail: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as ReadModelSnapshotRepository;
    const build = vi.fn(async () => ({ ready: true }));
    const worker = new ReadModelSnapshotWorker(
      repository,
      build,
      { now: () => new Date("2026-09-07T00:00:00.000Z") },
      { next: () => "lease" },
      vi.fn(),
      () => false,
      () => true,
    );
    expect(await worker.refreshOne()).toBe(true);
    expect(repository.claim).toHaveBeenCalledWith(expect.any(String), expect.any(String), "lease", {
      onlyUnpublished: true,
    });
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(repository.cleanup).not.toHaveBeenCalled();
  });
  it("defers under foreground pressure without publishing an incomplete generation or consuming failure retries", async () => {
    let allowed = false;
    const repository = {
      claim: vi.fn(async () => ({
        id: "snapshot",
        token: "lease",
        query: { kind: "case_directory" },
      })),
      renew: vi.fn(async () => true),
      putPart: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cleanup: vi.fn(),
    } as unknown as ReadModelSnapshotRepository;
    const errors = vi.fn();
    const worker = new ReadModelSnapshotWorker(
      repository,
      async (_query, writePart) => {
        await writePart(0, { items: ["first"] });
        allowed = false;
        await writePart(1, { items: ["second"] });
        return { complete: true };
      },
      { now: () => new Date("2026-09-07T00:00:00.000Z") },
      { next: () => "lease" },
      errors,
      () => allowed,
    );
    expect(await worker.refreshOne()).toBe(false);
    expect(repository.claim).not.toHaveBeenCalled();
    allowed = true;
    await worker.refreshOne();
    expect(repository.putPart).toHaveBeenCalledTimes(1);
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), "2026-09-07T00:00:01.000Z", {
      deferred: true,
    });
    expect(errors).not.toHaveBeenCalled();
  });
  it("reclaims at least as many obsolete parts as a large publication creates, in bounded batches", async () => {
    let obsoleteParts = 1_000;
    const cleanup = vi.fn(async (_before: string, limit: number) => {
      obsoleteParts = Math.max(0, obsoleteParts - limit * 20);
    });
    const repository = {
      claim: vi.fn(async () => ({
        id: "snapshot",
        token: "lease",
        query: { kind: "case_directory" },
      })),
      renew: vi.fn(async () => true),
      putPart: vi.fn(async () => undefined),
      complete: vi.fn(async () => true),
      fail: vi.fn(async () => undefined),
      cleanup,
    } as unknown as ReadModelSnapshotRepository;
    const errors = vi.fn();
    const worker = new ReadModelSnapshotWorker(
      repository,
      async (_query, writePart) => {
        for (let ordinal = 0; ordinal < 1_000; ordinal++) await writePart(ordinal, { items: [] });
        return { partCount: 1_000, caseCount: 100_000 };
      },
      { now: () => new Date("2026-09-07T00:00:00.000Z") },
      { next: () => "lease" },
      errors,
    );
    await worker.refreshOne();
    expect(errors).not.toHaveBeenCalled();
    expect(obsoleteParts).toBe(0);
    expect(cleanup.mock.calls.every(([, limit]) => limit === 25)).toBe(true);
  });
});
