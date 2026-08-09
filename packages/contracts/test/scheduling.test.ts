import { describe, expect, it } from "vitest";

import { createRunBatchInputSchema } from "../src/scheduling";

describe("createRunBatchInputSchema", () => {
  it("accepts bounded environment variables", () => {
    expect(
      createRunBatchInputSchema.parse({
        suiteId: "suite-1",
        runnerIds: ["runner-1"],
        retryLimit: 2,
        environmentVariables: [{ name: "TEST_ENV", value: "staging" }],
      }),
    ).toMatchObject({ retryLimit: 2 });
  });

  it("rejects duplicate runners and environment names", () => {
    expect(() =>
      createRunBatchInputSchema.parse({
        suiteId: "suite-1",
        runnerIds: ["runner-1", "runner-1"],
        retryLimit: 0,
        environmentVariables: [
          { name: "TEST_ENV", value: "a" },
          { name: "TEST_ENV", value: "b" },
        ],
      }),
    ).toThrow();
  });
});
