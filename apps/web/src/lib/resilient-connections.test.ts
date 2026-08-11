import { describe, expect, it } from "vitest";

import { natsReconnectOptions, redisReconnectDelay } from "./resilient-connections";

describe("Full infrastructure reconnection policy", () => {
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
