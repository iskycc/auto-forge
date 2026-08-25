import { describe, expect, it } from "vitest";

import { retryQueueTiming } from "../src/execution-queue-timing";

const eligibleAt = "2026-08-25T00:00:00.000Z";

describe("retryQueueTiming", () => {
  it("pauses queue timeout while an ordinary failure waits for the next round", () => {
    expect(
      retryQueueTiming({
        runStatus: "queued",
        retryMode: "round",
        retryableRunnerFailure: false,
        attemptNumber: 1,
        eligibleAt,
        queueTimeoutMs: 60_000,
      }),
    ).toEqual({ heldRound: 2, queueDeadlineAt: null });
  });

  it("starts a fresh queue timeout window for an immediately eligible retry", () => {
    expect(
      retryQueueTiming({
        runStatus: "queued",
        retryMode: "immediate",
        retryableRunnerFailure: false,
        attemptNumber: 1,
        eligibleAt,
        queueTimeoutMs: 60_000,
      }),
    ).toEqual({ heldRound: 0, queueDeadlineAt: "2026-08-25T00:01:00.000Z" });
  });

  it("starts a fresh queue timeout window for runner-fault retries in round mode", () => {
    expect(
      retryQueueTiming({
        runStatus: "queued",
        retryMode: "round",
        retryableRunnerFailure: true,
        attemptNumber: 1,
        eligibleAt,
        queueTimeoutMs: 60_000,
      }),
    ).toEqual({ heldRound: 0, queueDeadlineAt: "2026-08-25T00:01:00.000Z" });
  });
});
