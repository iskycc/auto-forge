import { describe, expect, it, vi } from "vitest";
import { readOnlyLegacyAttemptLogs } from "./full-log-write-policy";
import type { AsyncAttemptLogStore } from "./attempt-log-store";

describe("Full legacy log compatibility", () => {
  it("rejects both local payload and watermark writes without invoking the local store", async () => {
    const appendChunks = vi.fn();
    const recordWatermarks = vi.fn();
    const store = readOnlyLegacyAttemptLogs({
      appendChunks,
      recordWatermarks,
    } as unknown as AsyncAttemptLogStore);
    await expect(
      store.appendChunks({ batchId: "batch", attemptId: "attempt", receivedAt: "now", chunks: [] }),
    ).rejects.toMatchObject({ code: "FULL_LOCAL_LOG_WRITE_DISABLED" });
    await expect(
      store.recordWatermarks({
        batchId: "batch",
        attemptId: "attempt",
        recordedAt: "now",
        watermarks: { stdout: 0, stderr: -1, agent: -1 },
      }),
    ).rejects.toMatchObject({ code: "FULL_LOCAL_LOG_WRITE_DISABLED" });
    expect(appendChunks).not.toHaveBeenCalled();
    expect(recordWatermarks).not.toHaveBeenCalled();
  });
  it("keeps historical reads, cleanup and lifecycle bound to the original adapter", async () => {
    const original = {
      marker: "old content",
      listChunks() {
        return Promise.resolve({ items: [this.marker], hasMore: false });
      },
      close: vi.fn(),
    };
    const store = readOnlyLegacyAttemptLogs(original as unknown as AsyncAttemptLogStore);
    expect(
      await store.listChunks({
        batchId: "batch",
        attemptId: "attempt",
        stream: "stdout",
        afterSequence: -1,
        limit: 1,
      }),
    ).toEqual({ items: ["old content"], hasMore: false });
    await store.close();
    expect(original.close).toHaveBeenCalledOnce();
  });
});
