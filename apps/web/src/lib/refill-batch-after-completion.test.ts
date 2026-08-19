import type { CompleteAttemptResponse } from "@autoforge/contracts";
import { describe, expect, it, vi } from "vitest";

import { refillBatchAfterCompletion } from "./refill-batch-after-completion";

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

describe("refillBatchAfterCompletion", () => {
  it.each(["accepted", "duplicate"] as const)(
    "immediately schedules an idempotent refill for %s completion",
    async (disposition) => {
      const schedule = vi.fn().mockResolvedValue(undefined);

      await refillBatchAfterCompletion(completion(disposition), schedule);

      expect(schedule).toHaveBeenCalledWith("batch-1");
    },
  );

  it("does not schedule for a late completion", async () => {
    const schedule = vi.fn();

    await refillBatchAfterCompletion(completion("late"), schedule);

    expect(schedule).not.toHaveBeenCalled();
  });

  it("propagates refill failure so the Agent retries the completion", async () => {
    const failure = new Error("scheduler unavailable");
    const schedule = vi.fn().mockRejectedValue(failure);

    await expect(refillBatchAfterCompletion(completion("accepted"), schedule)).rejects.toBe(
      failure,
    );
  });
});
