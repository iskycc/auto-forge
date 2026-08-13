import { describe, expect, it } from "vitest";

import { createClientIdempotencyKey } from "./client-idempotency-key";

describe("client idempotency keys", () => {
  it("creates an RFC 4122 version 4 identifier without randomUUID", () => {
    const key = createClientIdempotencyKey((values) => {
      values.set([0, 1, 2, 3, 4, 5, 255, 7, 255, 9, 10, 11, 12, 13, 14, 15]);
      return values;
    });

    expect(key).toBe("00010203-0405-4f07-bf09-0a0b0c0d0e0f");
  });
});
