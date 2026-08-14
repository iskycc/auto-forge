import { describe, expect, it } from "vitest";

import { issueLogStreamTicket, verifyLogStreamTicket } from "./log-stream-ticket";

const secret = "log-stream-test-secret-that-is-longer-than-32-bytes";
const now = new Date("2026-08-14T00:00:00.000Z");

describe("log stream tickets", () => {
  it("round-trips an attempt-scoped browser ticket", () => {
    const encoded = issueLogStreamTicket(secret, {
      attemptId: "attempt-1",
      actorId: "user-1",
      ttlSeconds: 120,
      now,
    });

    expect(verifyLogStreamTicket(secret, encoded, now)).toMatchObject({
      schemaVersion: 1,
      attemptId: "attempt-1",
      actorId: "user-1",
    });
  });

  it("rejects tampered and expired tickets", () => {
    const encoded = issueLogStreamTicket(secret, {
      attemptId: "attempt-1",
      actorId: "user-1",
      ttlSeconds: 30,
      now,
    });

    expect(verifyLogStreamTicket(secret, `${encoded}x`, now)).toBeNull();
    expect(verifyLogStreamTicket(secret, encoded, new Date("2026-08-14T00:00:31.000Z"))).toBeNull();
  });
});
