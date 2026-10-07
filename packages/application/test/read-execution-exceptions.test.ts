import { describe, expect, it, vi } from "vitest";
import {
  readExecutionExceptions,
  prepareExecutionExceptionExport,
} from "../src/read-execution-exceptions";
import type { RunBatchRepository } from "../src/ports";

function fixture() {
  const getMetadata = vi
    .fn()
    .mockResolvedValue({ id: "batch", status: "failed", queueTimeoutMs: 1000 });
  const readExceptionRecords = vi.fn().mockResolvedValue({
    items: [],
    completions: [{ status: "failed", abnormal: true, count: 1 }],
  });
  return { getMetadata, readExceptionRecords } as Pick<
    RunBatchRepository,
    "getMetadata" | "readExceptionRecords"
  > & { getMetadata: typeof getMetadata; readExceptionRecords: typeof readExceptionRecords };
}
describe("execution exception evidence", () => {
  it("exports all records through bounded cursor pages and reads subsequent pages only on demand", async () => {
    const repository = fixture();
    const items = Array.from({ length: 103 }, (_, index) => ({
      id: `run:${index}`,
      kind: "run",
      round: 1,
      attemptNumber: null,
      runId: String(index),
      caseName: `用例 ${index}`,
      className: "example.Case",
      resultCode: "QUEUE_TIMEOUT",
      summary: "原始说明",
      occurredAt: "2026-10-06T00:00:00.000Z",
      affectsBatchStatus: true,
    }));
    const completions = [{ status: "failed", abnormal: true, count: 103 }];
    repository.readExceptionRecords
      .mockResolvedValueOnce({ items: items.slice(0, 101), completions })
      .mockResolvedValueOnce({ items: items.slice(100), completions: [] });
    const prepared = await prepareExecutionExceptionExport(repository, {
      batchId: "batch",
      projectIds: [],
    });
    expect(prepared.firstPage.items).toHaveLength(100);
    expect(repository.readExceptionRecords).toHaveBeenCalledTimes(1);
    const pages = [];
    for await (const page of prepared.pages) pages.push(page);
    expect(pages.map((page) => page.items.length)).toEqual([100, 3]);
    expect(pages.every((page) => page.abnormalRuns === 103 && page.consistent)).toBe(true);
    expect(pages[1]!.items[0]!.summary).toContain("1 秒时限");
    expect(pages.flatMap((page) => page.items).map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(repository.getMetadata).toHaveBeenLastCalledWith("batch", []);
    expect(repository.getMetadata).toHaveBeenCalledTimes(1);
    expect(repository.readExceptionRecords).toHaveBeenLastCalledWith({
      batchId: "batch",
      scope: "all",
      limit: 101,
      includeCompletions: false,
      after: { occurredAt: items[99]!.occurredAt, id: items[99]!.id },
    });
  });
  it("rejects inaccessible exports before generating a download and stops paging when iteration closes", async () => {
    const repository = fixture();
    repository.getMetadata.mockResolvedValueOnce(null);
    await expect(
      prepareExecutionExceptionExport(repository, { batchId: "batch" }),
    ).rejects.toMatchObject({ code: "RUN_BATCH_NOT_FOUND" });
    expect(repository.readExceptionRecords).not.toHaveBeenCalled();
    const prepared = await prepareExecutionExceptionExport(repository, { batchId: "batch" });
    for await (const page of prepared.pages) {
      expect(page).toBe(prepared.firstPage);
      break;
    }
    expect(repository.readExceptionRecords).toHaveBeenCalledTimes(1);
  });
  it("pages with stable cursors and explains the stored queue timeout rather than current settings", async () => {
    const repository = fixture();
    const item = {
      id: "run:first",
      kind: "run",
      round: 1,
      attemptNumber: null,
      runId: "first",
      caseName: "用例",
      className: "example.Case",
      resultCode: "QUEUE_TIMEOUT",
      summary: "原始记录",
      occurredAt: "2026-10-06T00:00:00.000Z",
      affectsBatchStatus: true,
    };
    repository.readExceptionRecords.mockResolvedValue({
      items: [item, { ...item, id: "run:second" }],
      completions: [{ status: "failed", abnormal: true, count: 2 }],
    });
    const first = await readExecutionExceptions(repository, { batchId: "batch", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.summary).toContain("1 秒时限");
    expect(first.nextCursor).toBeDefined();
    await readExecutionExceptions(repository, {
      batchId: "batch",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(repository.readExceptionRecords).toHaveBeenLastCalledWith({
      batchId: "batch",
      limit: 2,
      after: { occurredAt: item.occurredAt, id: item.id },
    });
  });
  it("verifies scope before reading persisted causes", async () => {
    const repository = fixture();
    expect(
      await readExecutionExceptions(repository, { batchId: "batch", projectIds: ["project"] }),
    ).toMatchObject({ consistent: true, expectedStatus: "failed", abnormalRuns: 1 });
    expect(repository.getMetadata).toHaveBeenCalledWith("batch", ["project"]);
  });
  it("requests a bounded preview of terminal causes without changing the status audit", async () => {
    const repository = fixture();
    expect(
      await readExecutionExceptions(repository, { batchId: "batch", scope: "terminal", limit: 3 }),
    ).toMatchObject({ consistent: true, abnormalRuns: 1 });
    expect(repository.readExceptionRecords).toHaveBeenCalledWith({
      batchId: "batch",
      scope: "terminal",
      limit: 4,
    });
  });
  it("detects an inconsistent failed batch with only normal test failures", async () => {
    const repository = fixture();
    repository.readExceptionRecords.mockResolvedValue({
      items: [],
      completions: [{ status: "failed", abnormal: false, count: 10 }],
    });
    expect(await readExecutionExceptions(repository, { batchId: "batch" })).toMatchObject({
      consistent: false,
      expectedStatus: "succeeded",
      abnormalRuns: 0,
    });
  });
  it("rejects inaccessible batches and diagnostic reruns without reading evidence", async () => {
    for (const batch of [null, { id: "batch", kind: "case_log_rerun" }]) {
      const repository = fixture();
      repository.getMetadata.mockResolvedValue(batch);
      await expect(readExecutionExceptions(repository, { batchId: "batch" })).rejects.toMatchObject(
        { code: "RUN_BATCH_NOT_FOUND" },
      );
      expect(repository.readExceptionRecords).not.toHaveBeenCalled();
    }
  });
  it("rejects invalid cursors", async () => {
    await expect(
      readExecutionExceptions(fixture(), { batchId: "batch", cursor: "invalid" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  it("keeps in-flight and cancellation priority while excluding normal failure counts", async () => {
    const repository = fixture();
    repository.readExceptionRecords.mockResolvedValue({
      items: [],
      completions: [
        { status: "failed", abnormal: true, count: 4 },
        { status: "failed", abnormal: false, count: 20 },
        { status: "running", abnormal: false, count: 1 },
      ],
    });
    repository.getMetadata.mockResolvedValue({
      id: "batch",
      status: "running",
      terminationRequestedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(await readExecutionExceptions(repository, { batchId: "batch" })).toMatchObject({
      consistent: true,
      expectedStatus: "running",
      abnormalRuns: 4,
    });
    repository.readExceptionRecords.mockResolvedValue({
      items: [],
      completions: [
        { status: "failed", abnormal: true, count: 4 },
        { status: "cancelled", abnormal: false, count: 1 },
      ],
    });
    repository.getMetadata.mockResolvedValue({
      id: "batch",
      status: "cancelled",
      terminationRequestedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(await readExecutionExceptions(repository, { batchId: "batch" })).toMatchObject({
      consistent: true,
      expectedStatus: "cancelled",
      abnormalRuns: 4,
    });
  });
});
