import { describe, expect, it } from "vitest";

import {
  issueTerminalTicket,
  verifyTerminalTicket,
  verifyTerminalUpgradeTicket,
} from "./terminal-ticket";

const secret = "terminal-test-secret-that-is-longer-than-32-bytes";
const now = new Date("2026-08-09T00:00:00.000Z");

describe("terminal tickets", () => {
  it("round-trips a short-lived browser ticket", () => {
    const encoded = issueTerminalTicket(secret, {
      role: "browser",
      runnerId: "runner-1",
      sessionId: "session-1",
      actorId: "user-1",
      columns: 120,
      rows: 32,
      ttlSeconds: 30,
      now,
    });

    expect(verifyTerminalTicket(secret, encoded, now)).toMatchObject({
      schemaVersion: 1,
      role: "browser",
      runnerId: "runner-1",
      sessionId: "session-1",
      actorId: "user-1",
      columns: 120,
      rows: 32,
    });
  });

  it("rejects tampered and expired tickets", () => {
    const encoded = issueTerminalTicket(secret, {
      role: "agent",
      runnerId: "runner-1",
      ttlSeconds: 30,
      now,
    });

    expect(verifyTerminalTicket(secret, `${encoded}x`, now)).toBeNull();
    expect(verifyTerminalTicket(secret, encoded, new Date("2026-08-09T00:00:31.000Z"))).toBeNull();
  });

  it("accepts an Agent ticket from the WebSocket subprotocol when a proxy removed Authorization", () => {
    const encoded = issueTerminalTicket(secret, {
      role: "agent",
      runnerId: "runner-behind-proxy",
      ttlSeconds: 90,
      now,
    });

    expect(
      verifyTerminalUpgradeTicket(
        secret,
        {
          "sec-websocket-protocol": `autoforge-runner-terminal-v1, autoforge-ticket.${encoded}`,
        },
        now,
      ),
    ).toMatchObject({ role: "agent", runnerId: "runner-behind-proxy" });
  });
});
