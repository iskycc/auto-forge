import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { issueRunProgressToken, verifyRunProgressToken } from "./run-progress-token";

describe("read-only run progress token", () => {
  const key = "test-master-key-with-sufficient-entropy";
  const issuedAt = new Date("2026-08-20T00:00:00.000Z");

  it("is bound to one batch and expires at the configured deadline", () => {
    const token = issueRunProgressToken(key, "batch-1", issuedAt, 30_000);

    expect(
      verifyRunProgressToken(key, token, "batch-1", new Date(issuedAt.getTime() + 29_999)),
    ).toBe(true);
    expect(verifyRunProgressToken(key, token, "batch-2", issuedAt)).toBe(false);
    expect(
      verifyRunProgressToken(key, token, "batch-1", new Date(issuedAt.getTime() + 30_000)),
    ).toBe(false);
  });

  it("rejects tampering and signatures from another platform key", () => {
    const token = issueRunProgressToken(key, "batch-1", issuedAt);
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    expect(verifyRunProgressToken(key, tampered, "batch-1", issuedAt)).toBe(false);
    expect(verifyRunProgressToken("another-key", token, "batch-1", issuedAt)).toBe(false);
    expect(verifyRunProgressToken(key, "malformed", "batch-1", issuedAt)).toBe(false);
  });
});
