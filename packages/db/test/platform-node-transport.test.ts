import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { signNodeLogRequest, verifyNodeLogRequest } from "../src/platform-node-transport";

describe("platform node authentication", () => {
  it("binds a short-lived request to its source, target, operation and exact content", () => {
    const secret = "test-shared-node-secret".repeat(3);
    const source = randomUUID();
    const target = randomUUID();
    const body = JSON.stringify({ operation: "list", batchId: randomUUID() });
    const now = 1788585600000;
    const headers = new Headers(signNodeLogRequest(secret, source, target, body, now));
    expect(verifyNodeLogRequest(secret, target, headers, body, now).sourceNodeId).toBe(source);
    expect(() => verifyNodeLogRequest(secret, randomUUID(), headers, body, now)).toThrow(
      "认证失败",
    );
    expect(() => verifyNodeLogRequest(secret, target, headers, body + " ", now)).toThrow(
      "认证失败",
    );
    expect(() => verifyNodeLogRequest(secret, target, headers, body, now + 30001)).toThrow(
      "认证失败",
    );
    expect(() => verifyNodeLogRequest("wrong", target, headers, body, now)).toThrow("认证失败");
    expect(() => verifyNodeLogRequest(secret, target, new Headers(), body, now)).toThrow(
      "认证失败",
    );
  });
});
