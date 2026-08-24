import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { issuePermanentShareToken, readPermanentShareToken } from "./permanent-share-token";

describe("permanent share tokens", () => {
  const masterKey = "test-master-key";

  it("round-trips a resource-scoped token without an expiry", () => {
    const token = issuePermanentShareToken(masterKey, "case_definition", "case-1");

    expect(readPermanentShareToken(masterKey, token, "case_definition")).toBe("case-1");
    expect(readPermanentShareToken(masterKey, token, "run_batch")).toBeNull();
  });

  it("rejects tampering, another key and malformed input", () => {
    const token = issuePermanentShareToken(masterKey, "run_batch", "batch-1");
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    expect(readPermanentShareToken(masterKey, tampered, "run_batch")).toBeNull();
    expect(readPermanentShareToken("another-key", token, "run_batch")).toBeNull();
    expect(readPermanentShareToken(masterKey, "malformed", "run_batch")).toBeNull();
    expect(readPermanentShareToken(masterKey, "x".repeat(2_049), "run_batch")).toBeNull();
  });

  it("rejects empty or oversized resource identifiers when issuing", () => {
    expect(() => issuePermanentShareToken(masterKey, "case_definition", "")).toThrow();
    expect(() => issuePermanentShareToken(masterKey, "case_definition", "x".repeat(513))).toThrow();
  });
});
