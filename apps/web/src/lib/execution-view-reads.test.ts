import { describe, it, expect, vi } from "vitest";
import type { RunBatchRepository } from "@autoforge/application";
import { readExecutionView } from "./execution-view-reads";

describe("isolated execution view boundaries", () => {
  it("retains explicit project scope and permits omitted optional arguments", async () => {
    const getSummary = vi.fn().mockResolvedValue({ id: "batch" });
    const batches = { getSummary } as unknown as RunBatchRepository;
    await expect(
      readExecutionView(batches, { method: "getSummary", args: ["batch"] }),
    ).resolves.toEqual({ id: "batch" });
    await readExecutionView(batches, { method: "getSummary", args: ["batch", ["project"]] });
    expect(getSummary).toHaveBeenLastCalledWith("batch", ["project"]);
  });
  it("rejects writes, oversized pages and unbounded legacy details before touching them", async () => {
    const get = vi.fn();
    const batches = {
      get,
      getMetadata: async () => ({ totalRuns: 100_000 }),
    } as unknown as RunBatchRepository;
    await expect(
      readExecutionView(batches, { method: "get", args: ["batch"] }),
    ).rejects.toMatchObject({ code: "DETAIL_RESPONSE_TOO_LARGE" });
    await expect(readExecutionView(batches, { method: "create", args: [{}] })).rejects.toThrow();
    await expect(
      readExecutionView(batches, {
        method: "readExportPage",
        args: [{ batchId: "batch", scope: "final", limit: 100_000 }],
      }),
    ).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});
