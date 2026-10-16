import { expect, it, vi } from "vitest";
import { readBatchPage } from "../src/read-batch-page";
import type { RunBatchRepository } from "../src/ports";
import type { ReadModelSnapshotService } from "../src/read-model-snapshots";

it("reads one bounded single-case page without scheduling aggregate snapshots", async () => {
  const listMetadataPage = vi
    .fn()
    .mockResolvedValue({ items: [{ id: "single", status: "succeeded" }], nextCursor: "next" });
  const readSingleCaseExecutionEntries = vi.fn().mockResolvedValue([
    {
      batchId: "single",
      runId: "run",
      status: "failed",
      attempt: { id: "attempt", status: "failed", outcome: "failed" },
    },
  ]);
  const read = vi.fn();
  const result = await readBatchPage(
    { listMetadataPage, readSingleCaseExecutionEntries } as unknown as RunBatchRepository,
    { read } as unknown as ReadModelSnapshotService,
    { executionKind: "single", limit: 500 },
  );
  expect(listMetadataPage).toHaveBeenCalledWith({ executionKind: "single", limit: 200 });
  expect(readSingleCaseExecutionEntries).toHaveBeenCalledWith(["single"]);
  expect(result.items[0]).toMatchObject({
    failedRuns: 1,
    succeededRuns: 0,
    statisticsPending: false,
    singleCase: { attempt: { outcome: "failed" } },
  });
  expect(result.nextCursor).toBe("next");
  expect(read).not.toHaveBeenCalled();
});
