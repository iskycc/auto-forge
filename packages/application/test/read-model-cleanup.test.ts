import { describe, expect, it, vi } from "vitest";
import {
  ReadModelSnapshotWorker,
  type ReadModelSnapshotRepository,
} from "../src/read-model-snapshots";

describe("directory generation cleanup", () => {
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
