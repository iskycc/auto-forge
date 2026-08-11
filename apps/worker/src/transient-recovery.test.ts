import { describe, expect, it, vi } from "vitest";

import { runWithTransientRecovery } from "./transient-recovery";

const logger = { info: vi.fn(), error: vi.fn() };

describe("worker transient recovery", () => {
  it("retries a temporary failure and stops cleanly after abort", async () => {
    const controller = new AbortController();
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("dependency unavailable"))
      .mockImplementationOnce(async () => controller.abort());

    await expect(
      runWithTransientRecovery(controller.signal, operation, logger, {
        operationName: "test loop",
        initialDelayMs: 1,
        maximumDelayMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "test loop temporarily unavailable",
      expect.objectContaining({ consecutiveFailures: 1, retryDelayMs: 1 }),
    );
  });

  it("surfaces repeated failures after the configured finite limit", async () => {
    const operation = vi.fn(async () => {
      throw new Error("still unavailable");
    });

    await expect(
      runWithTransientRecovery(new AbortController().signal, operation, logger, {
        operationName: "test loop",
        maximumConsecutiveFailures: 3,
        initialDelayMs: 1,
        maximumDelayMs: 1,
      }),
    ).rejects.toThrow("exceeded its transient recovery limit");
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
