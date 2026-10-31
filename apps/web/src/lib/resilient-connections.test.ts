import { describe, expect, it, vi } from "vitest";

import {
  awaitRedisReply,
  natsReconnectOptions,
  redisReconnectDelay,
  redisRuntimeCommandOptions,
} from "./resilient-connections";

describe("Full infrastructure reconnection policy", () => {
  it("bounds Redis command wait and queueing independently of reconnect attempts", () => {
    expect(redisRuntimeCommandOptions).toEqual({
      disableOfflineQueue: true,
      commandsQueueMaxLength: 128,
      commandOptions: { timeout: 3000 },
    });
  });
  it("backs Redis reconnects off and stops at a finite limit", () => {
    expect(redisReconnectDelay(0)).toBe(50);
    expect(redisReconnectDelay(5)).toBe(1_000);
    expect(redisReconnectDelay(59)).toBe(1_000);
    expect(redisReconnectDelay(60)).toBeInstanceOf(Error);
    expect(redisReconnectDelay(-1)).toBeInstanceOf(Error);
  });

  it("uses bounded NATS reconnect attempts", () => {
    expect(natsReconnectOptions).toEqual({
      reconnect: true,
      maxReconnectAttempts: 60,
      reconnectTimeWait: 250,
    });
  });
});

it("bounds waiting for a sent Redis command and observes a late rejection", async () => {
  vi.useFakeTimers();
  try {
    let fail!: (cause: Error) => void;
    const pending = awaitRedisReply(
      new Promise<never>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const rejected = expect(pending).rejects.toThrow("exceeded 3000");
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    fail(new Error("late transport failure"));
    await Promise.resolve();
    expect(await awaitRedisReply(Promise.resolve("ready"))).toBe("ready");
  } finally {
    vi.useRealTimers();
  }
});
