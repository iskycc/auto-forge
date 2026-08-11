import { describe, expect, it } from "vitest";

import { runnerAuthenticationBlock, type Runner } from "../src/runner";

function runner(overrides: Partial<Runner>): Runner {
  return {
    id: "runner-1",
    name: "Runner",
    state: "online",
    os: "linux",
    architecture: "amd64",
    agentVersion: "0.2.2",
    protocolVersion: 1,
    labels: [],
    capabilities: [],
    maxConcurrency: 2,
    busySlots: 0,
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    terminalEnabled: false,
    credentialVersion: 1,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("runnerAuthenticationBlock", () => {
  it("allows an online runner without terminal identity markers", () => {
    expect(runnerAuthenticationBlock(runner({}))).toBeNull();
  });

  it("reports deregistration before credential revocation and disabled state", () => {
    expect(
      runnerAuthenticationBlock(
        runner({
          deregisteredAt: "2026-08-09T00:01:00.000Z",
          credentialRevokedAt: "2026-08-09T00:01:00.000Z",
          state: "disabled",
        }),
      ),
    ).toBe("deregistered");
  });

  it("reports credential revocation before disabled state", () => {
    expect(
      runnerAuthenticationBlock(
        runner({ credentialRevokedAt: "2026-08-09T00:01:00.000Z", state: "disabled" }),
      ),
    ).toBe("credential-revoked");
  });

  it("reports disabled runners that still hold a valid credential", () => {
    expect(runnerAuthenticationBlock(runner({ state: "disabled" }))).toBe("disabled");
  });
});
