import { describe, expect, it, vi } from "vitest";
import { DeletedRunnerContactService } from "../src/observe-deleted-runner-contacts";

const runnerId = "00000000-0000-7000-8000-000000000001";
describe("deleted Runner connection diagnostics", () => {
  it("bounds repeated and concurrent failures and keeps only one probe per minute", async () => {
    let now = Date.parse("2026-11-12T00:00:00.000Z");
    const repository = {
      recordRejectedContact: vi.fn().mockResolvedValue(undefined),
      listRejectedContacts: vi.fn(),
    };
    const service = new DeletedRunnerContactService(
      repository,
      { now: () => new Date(now) },
      vi.fn(),
    );
    await Promise.all(Array.from({ length: 200 }, () => service.observe(runnerId)));
    expect(repository.recordRejectedContact).toHaveBeenCalledTimes(1);
    await service.observe("unknown-name");
    expect(repository.recordRejectedContact).toHaveBeenCalledTimes(1);
    now += 60_000;
    await service.observe(runnerId);
    expect(repository.recordRejectedContact).toHaveBeenCalledTimes(2);
    expect(repository.recordRejectedContact).toHaveBeenLastCalledWith({
      runnerId,
      recordedAt: "2026-11-12T00:01:00.000Z",
      previousWindowBefore: "2026-11-12T00:00:00.000Z",
    });
  });
  it("reports persistence failure without changing authentication rejection and bounds unknown-id load", async () => {
    const failure = new Error("database unavailable");
    const repository = {
      recordRejectedContact: vi.fn().mockRejectedValue(failure),
      listRejectedContacts: vi.fn().mockResolvedValue({ items: [] }),
    };
    const report = vi.fn();
    const service = new DeletedRunnerContactService(
      repository,
      { now: () => new Date("2026-11-12") },
      report,
    );
    await expect(service.observe(runnerId)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    await service.observe(runnerId);
    expect(report).toHaveBeenCalledTimes(1);
    for (let index = 2; index < 1000; index++)
      await service.observe(`00000000-0000-7000-8000-${String(index).padStart(12, "0")}`);
    expect(repository.recordRejectedContact).toHaveBeenCalledTimes(120);
    await expect(service.list({ limit: 10 })).resolves.toEqual({ items: [] });
  });
});
