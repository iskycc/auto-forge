import { describe, expect, it } from "vitest";
import { connectionFailureMessage } from "./platform-infrastructure-check";

describe("infrastructure check diagnostics", () => {
  it.each([
    ["28P01", "用户名或密码"],
    ["LOG_CREATEDB", "CREATEDB"],
    ["ECONNREFUSED", "端口"],
    ["NoSuchBucket", "Bucket"],
    ["503", "JetStream"],
  ])("explains %s without returning secret-bearing driver text", (code, expected) => {
    const message = connectionFailureMessage(
      Object.assign(new Error("postgres://user:very-secret@internal"), { code }),
    );
    expect(message).toContain(expected);
    expect(message).not.toContain("very-secret");
  });
  it("keeps unexpected driver error text private", () => {
    expect(connectionFailureMessage(new Error("password=private"))).not.toContain("private");
  });
});
