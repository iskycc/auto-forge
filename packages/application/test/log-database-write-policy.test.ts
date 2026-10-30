import { describe, expect, it, vi } from "vitest";
import { LogDatabaseService, type LogDatabaseRepository } from "../src/log-databases";

describe("Full log target policy", () => {
  it("never permits switching new execution logs back to local SQLite", async () => {
    const repository = { select: vi.fn(), checkForWrite: vi.fn() };
    const service = new LogDatabaseService(
      repository as unknown as LogDatabaseRepository,
      { now: () => new Date(0) },
      { next: () => "id" },
    );
    await expect(service.select({ databaseId: null, revision: 1 })).rejects.toMatchObject({
      code: "FULL_LOCAL_LOG_WRITE_DISABLED",
    });
    expect(repository.select).not.toHaveBeenCalled();
    expect(repository.checkForWrite).not.toHaveBeenCalled();
  });
});
