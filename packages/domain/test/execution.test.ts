import { describe, expect, it } from "vitest";

import {
  aggregateBatchStatus,
  assertActiveLease,
  outcomeAfterCompletion,
  transitionAssignment,
} from "../src/execution";

describe("execution state machine", () => {
  it("rejects terminal assignment transitions", () => {
    expect(transitionAssignment("pending", "claimed")).toBe("claimed");
    expect(() => transitionAssignment("completed", "running")).toThrow(
      "Assignment cannot transition",
    );
  });

  it("uses lease version and server UTC expiry as the execution authority", () => {
    expect(() =>
      assertActiveLease({
        status: "active",
        expiresAt: "2026-08-09T00:00:00.000Z",
        expectedVersion: 2,
        actualVersion: 2,
        now: "2026-08-09T00:00:01.000Z",
      }),
    ).toThrow("租约已过期");
    expect(() =>
      assertActiveLease({
        status: "active",
        expiresAt: "2026-08-09T00:01:00.000Z",
        expectedVersion: 1,
        actualVersion: 2,
        now: "2026-08-09T00:00:01.000Z",
      }),
    ).toThrow("租约版本已变化");
  });

  it("retries only failures and derives batch status from authoritative runs", () => {
    expect(
      outcomeAfterCompletion({
        outcome: "failed",
        attemptNumber: 1,
        retryLimit: 1,
        cancellationRequested: false,
      }),
    ).toEqual({ runStatus: "queued", retryScheduled: true });
    expect(
      outcomeAfterCompletion({
        outcome: "cancelled",
        attemptNumber: 1,
        retryLimit: 10,
        cancellationRequested: false,
      }),
    ).toEqual({ runStatus: "cancelled", retryScheduled: false });
    expect(aggregateBatchStatus(["succeeded", "failed", "cancelled"])).toBe("failed");
    expect(aggregateBatchStatus(["assigned", "queued"])).toBe("dispatching");
  });
});
