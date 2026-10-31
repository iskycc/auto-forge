import { expect, it, vi } from "vitest";
import { readBatchPage } from "../src/read-batch-page";
import type { RunBatchRepository } from "../src/ports";
import type { ReadModelSnapshotService } from "../src/read-model-snapshots";

const counts = {
  queuedRuns: 0,
  assignedRuns: 0,
  runningRuns: 0,
  succeededRuns: 7,
  failedRuns: 2,
  timedOutRuns: 1,
  cancelledRuns: 0,
};
it("reuses historical results across different page compositions and refreshes only live batches", async () => {
  const read = vi.fn().mockResolvedValue({
    payload: [{ ...counts, id: "live", succeededRuns: 3 }],
    status: { state: "ready" },
  });
  const repository = {
    listMetadataPage: vi.fn().mockResolvedValue({
      items: [
        { id: "history", projectId: "project", status: "failed", version: 8 },
        { id: "live", projectId: "project", status: "running", version: 4 },
      ],
    }),
    readHistorySnapshots: vi.fn().mockResolvedValue([{ ...counts, id: "history" }]),
  } as unknown as RunBatchRepository;
  const result = await readBatchPage(repository, { read } as unknown as ReadModelSnapshotService, {
    limit: 50,
  });
  expect(result.items[0]).toMatchObject({ ...counts, statisticsPending: false });
  expect(result.items[1]).toMatchObject({ succeededRuns: 3, statisticsPending: false });
  expect(read.mock.calls[0]![0].batches).toEqual([{ id: "live", projectId: "project" }]);
  vi.mocked(repository.listMetadataPage).mockResolvedValue({ items: [result.items[0]!] });
  read.mockClear();
  const cached = await readBatchPage(repository, { read } as unknown as ReadModelSnapshotService, {
    limit: 10,
    cursor: "other-page",
  });
  expect(read).not.toHaveBeenCalled();
  expect(cached.query).toBeUndefined();
  expect(cached.items[0]).toMatchObject({ ...counts, statisticsPending: false });
});

it("queues a bounded rebuild for missing or outdated historical snapshots without inventing results", async () => {
  const read = vi.fn().mockResolvedValue({ payload: null });
  const repository = {
    listMetadataPage: vi.fn().mockResolvedValue({
      items: [{ id: "old", projectId: "project", status: "cancelled", version: 9 }],
    }),
    readHistorySnapshots: vi.fn().mockResolvedValue([]),
  } as unknown as RunBatchRepository;
  const result = await readBatchPage(repository, { read } as unknown as ReadModelSnapshotService, {
    limit: 50,
  });
  expect(result.items[0]!.statisticsPending).toBe(true);
  expect(read.mock.calls[0]![0].batches).toEqual([
    { id: "old", projectId: "project", terminalVersion: 9 },
  ]);
});
