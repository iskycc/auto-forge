import { describe, expect, it } from "vitest";
import { caseSuiteAdapterConfigurationSchema } from "../src/management";
import {
  createSingleCaseRunInputSchema,
  createVersionCaseExecutionSchema,
} from "../src/scheduling";

describe("CoTest is the default execution runtime", () => {
  it.each([undefined, false, true])("normalizes the legacy enabled flag %s", (enabled) => {
    const configuration = caseSuiteAdapterConfigurationSchema.parse({
      ...(enabled === undefined ? {} : { enabled }),
      suiteName: "Payments",
      testName: "Release · Regression",
      environmentAddresses: ["10.0.0.21", "10.0.0.22"],
    });
    expect(configuration).toEqual({
      enabled: true,
      suiteName: "Payments",
      testName: "Release · Regression",
      environmentAddresses: ["10.0.0.21", "10.0.0.22"],
    });
  });

  it("keeps single-case validation even when an old caller sends enabled=false", () => {
    const input = createSingleCaseRunInputSchema.parse({
      runnerIds: ["runner"],
      adapter: {
        enabled: false,
        suiteName: "Payments",
        testName: "Regression",
        environmentAddresses: ["10.0.0.21"],
      },
    });
    expect(input.adapter.enabled).toBe(true);
    expect(() => createSingleCaseRunInputSchema.parse({ runnerIds: ["runner"] })).toThrow();
  });

  it("cannot disable CoTest through the version execution API", () => {
    const input = createVersionCaseExecutionSchema.parse({
      className: "example.PaymentTest",
      environmentIp: "10.0.0.21",
      execution: { adapter: { enabled: false } },
    });
    expect(input.execution.adapter?.enabled).toBe(true);
  });
});
