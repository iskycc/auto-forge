import type { CompleteAttemptResponse } from "@autoforge/contracts";
import { describe, expect, it, vi } from "vitest";

import { refillRunnerAfterCompletion } from "./refill-runner-after-completion";

function completion(disposition: CompleteAttemptResponse["disposition"]): CompleteAttemptResponse {
  return {
    schemaVersion: 1,
    completionId: "completion-1",
    acceptedAt: "2026-08-19T00:00:00.000Z",
    disposition,
    retryScheduled: false,
    batchId: "batch-1",
    batchClosed: false,
  };
}

describe("refillRunnerAfterCompletion", () => {
  it.each(["accepted", "duplicate"] as const)(
    "immediately schedules an idempotent refill for %s completion",
    async (disposition) => {
      const schedule = vi.fn().mockResolvedValue(undefined);

      await refillRunnerAfterCompletion(completion(disposition), schedule);

      expect(schedule).toHaveBeenCalledWith();
    },
  );

  it("does not schedule for a late completion", async () => {
    const schedule = vi.fn();

    await refillRunnerAfterCompletion(completion("late"), schedule);

    expect(schedule).not.toHaveBeenCalled();
  });

  it("propagates refill failure so the Agent retries the completion", async () => {
    const failure = new Error("scheduler unavailable");
    const schedule = vi.fn().mockRejectedValue(failure);

    await expect(refillRunnerAfterCompletion(completion("accepted"), schedule)).rejects.toBe(
      failure,
    );
  });

  it.each([false, true])(
    "refills other tasks when the source has no queued work (closed=%s)",
    async (batchClosed) => {
      const schedule = vi.fn().mockResolvedValue(undefined);
      await refillRunnerAfterCompletion(
        { ...completion("accepted"), hasSchedulableRuns: false, batchClosed },
        schedule,
      );
      expect(schedule).toHaveBeenCalledOnce();
      expect(schedule).toHaveBeenCalledWith();
    },
  );

  it("does not refill an uncorrelated legacy completion", async () => {
    const schedule = vi.fn();
    await refillRunnerAfterCompletion({ ...completion("accepted"), batchId: undefined }, schedule);
    expect(schedule).not.toHaveBeenCalled();
  });
});
