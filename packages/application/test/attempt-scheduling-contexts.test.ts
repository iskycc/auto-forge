import type { ExecutionControlRepository } from "../src/ports";
import { resolveAttemptSchedulingContexts } from "../src/attempt-scheduling-contexts";
import { describe, expect, it, vi } from "vitest";

describe("resolveAttemptSchedulingContexts", () => {
  it("uses one adapter batch read for a claim wave", async () => {
    const resolveOne = vi.fn();
    const resolveMany = vi.fn().mockResolvedValue([
      {
        attemptId: "attempt-1",
        batchId: "batch-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        attemptNumber: 1,
        displayName: "Case 1",
      },
      {
        attemptId: "attempt-2",
        batchId: "batch-1",
        executionRunId: "run-2",
        runnerId: "runner-1",
        attemptNumber: 1,
        displayName: "Case 2",
      },
    ]);
    const executions = {
      resolveAttemptSchedulingContext: resolveOne,
      resolveAttemptSchedulingContexts: resolveMany,
    } as unknown as ExecutionControlRepository;

    const contexts = await resolveAttemptSchedulingContexts(executions, ["attempt-1", "attempt-2"]);

    expect(resolveMany).toHaveBeenCalledOnce();
    expect(resolveMany).toHaveBeenCalledWith(["attempt-1", "attempt-2"]);
    expect(resolveOne).not.toHaveBeenCalled();
    expect(contexts.get("attempt-2")?.displayName).toBe("Case 2");
  });
});
