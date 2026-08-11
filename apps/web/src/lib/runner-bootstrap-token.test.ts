import { describe, expect, it } from "vitest";

import { issueRunnerBootstrapToken, verifyRunnerBootstrapToken } from "./runner-bootstrap-token";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const issuedAt = new Date("2026-08-11T00:00:00.000Z");

describe("short-lived Runner bootstrap tokens", () => {
  it("accepts a signed token once it is issued and before expiry", () => {
    const token = issueRunnerBootstrapToken(masterKey, issuedAt);
    expect(verifyRunnerBootstrapToken(token, masterKey, issuedAt)).toBe(true);
    expect(verifyRunnerBootstrapToken(token, masterKey, new Date("2026-08-11T00:14:59.000Z"))).toBe(
      true,
    );
  });

  it("rejects expired and modified tokens", () => {
    const token = issueRunnerBootstrapToken(masterKey, issuedAt);
    expect(verifyRunnerBootstrapToken(token, masterKey, new Date("2026-08-11T00:15:01.000Z"))).toBe(
      false,
    );
    expect(verifyRunnerBootstrapToken(`${token}changed`, masterKey, issuedAt)).toBe(false);
  });
});
