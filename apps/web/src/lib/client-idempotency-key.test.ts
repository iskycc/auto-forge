import { afterEach, describe, expect, it, vi } from "vitest";

import { createClientIdempotencyKey } from "./client-idempotency-key";

describe("client idempotency keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the browser random source when randomUUID is unavailable on HTTP", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (values: Uint8Array) => values.fill(0x71),
    });

    expect(createClientIdempotencyKey()).toBe("71717171-7171-4171-b171-717171717171");
  });

  it("creates an RFC 4122 version 4 identifier without randomUUID", () => {
    const key = createClientIdempotencyKey((values) => {
      values.set([0, 1, 2, 3, 4, 5, 255, 7, 255, 9, 10, 11, 12, 13, 14, 15]);
      return values;
    });

    expect(key).toBe("00010203-0405-4f07-bf09-0a0b0c0d0e0f");
  });
});
