import { describe, expect, it } from "vitest";
import {
  changePublicSuiteEnvironmentSchema,
  publicSuiteViewSchema,
  startPublicSuiteExecutionSchema,
} from "./public-suite-execution";

const requestKey = "019aa000-0000-7000-8000-000000000001";

describe("public task execution environment", () => {
  it("validates shared edits without accepting client-supplied attribution", () => {
    expect(changePublicSuiteEnvironmentSchema.parse({ revision: 0, addresses: null })).toEqual({
      revision: 0,
      addresses: null,
    });
    for (const input of [
      { revision: -1, addresses: null },
      { revision: 0, addresses: [] },
      { revision: 0, addresses: ["bad"] },
      { revision: 0, addresses: null, modifiedBy: "forged" },
    ])
      expect(changePublicSuiteEnvironmentSchema.safeParse(input).success).toBe(false);
    expect(publicSuiteViewSchema.shape.environment.parse(undefined)).toMatchObject({
      revision: 0,
      change: null,
    });
  });
  it("keeps saved task defaults when no override is provided", () => {
    expect(startPublicSuiteExecutionSchema.parse({ requestKey })).toEqual({
      requestKey,
      delaySeconds: 0,
    });
  });
  it("accepts an ordered bounded list of IPv4 and IPv6 addresses for delayed execution", () => {
    expect(
      startPublicSuiteExecutionSchema.parse({
        requestKey,
        delaySeconds: 60,
        environmentAddresses: [" 10.0.0.1 ", "2001:db8::1"],
      }),
    ).toMatchObject({ environmentAddresses: ["10.0.0.1", "2001:db8::1"] });
  });
  it.for([
    [],
    [""],
    ["example.com"],
    ["10.0.0.1", "10.0.0.1"],
    ["2001:db8::A", "2001:db8::a"],
    Array.from({ length: 129 }, (_, index) => `10.0.0.${index + 1}`),
  ])("rejects empty, invalid, repeated or oversized address lists: %j", (environmentAddresses) => {
    expect(
      startPublicSuiteExecutionSchema.safeParse({ requestKey, environmentAddresses }).success,
    ).toBe(false);
  });
  it("continues rejecting unrelated policy overrides", () => {
    expect(startPublicSuiteExecutionSchema.safeParse({ requestKey, concurrency: 40 }).success).toBe(
      false,
    );
  });
});
