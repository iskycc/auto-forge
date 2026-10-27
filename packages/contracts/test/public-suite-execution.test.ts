import { describe, expect, it } from "vitest";
import { publicSuiteExecutionPath, startPublicSuiteExecutionSchema } from "../src";

describe("public task execution contract", () => {
  const requestKey = "019aa000-0000-7000-8000-000000000001";
  it("accepts an immediate or durable delayed execution", () => {
    expect(startPublicSuiteExecutionSchema.parse({ requestKey })).toEqual({
      requestKey,
      delaySeconds: 0,
    });
    expect(
      startPublicSuiteExecutionSchema.parse({ requestKey, delaySeconds: 60 }).delaySeconds,
    ).toBe(60);
  });
  it.each([
    { requestKey, delaySeconds: -1 },
    { requestKey, delaySeconds: 604801 },
    { requestKey, runnerIds: ["runner"] },
    { requestKey: "invalid" },
  ])("rejects invalid execution and configuration overrides: %j", (input) => {
    expect(startPublicSuiteExecutionSchema.safeParse(input).success).toBe(false);
  });
  it("uses business identifiers without opaque sharing strings", () => {
    expect(publicSuiteExecutionPath("suite-a", "user-a")).toBe(
      "/RunTask?SuiteId=suite-a&PublisherId=user-a",
    );
  });
});
