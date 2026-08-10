import { describe, expect, it } from "vitest";

import {
  createExecutionEnvironmentInputSchema,
  createExecutionSecretInputSchema,
  updateExecutionEnvironmentInputSchema,
} from "../src/environment";
import { createRunBatchInputSchema } from "../src/scheduling";

describe("execution environment contracts", () => {
  it("accepts bounded reusable environment variables", () => {
    expect(
      createExecutionEnvironmentInputSchema.parse({
        projectId: "project-1",
        name: "Staging",
        variables: [{ name: "BASE_URL", value: "https://staging.example.test" }],
      }),
    ).toMatchObject({ name: "Staging", description: "" });
  });

  it("rejects duplicate variables and empty updates", () => {
    expect(() =>
      createExecutionEnvironmentInputSchema.parse({
        projectId: "project-1",
        name: "Staging",
        variables: [
          { name: "BASE_URL", value: "one" },
          { name: "BASE_URL", value: "two" },
        ],
      }),
    ).toThrow();
    expect(() => updateExecutionEnvironmentInputSchema.parse({ expectedRevision: 1 })).toThrow();
  });

  it("does not allow a batch to combine a version reference with inline values", () => {
    expect(() =>
      createRunBatchInputSchema.parse({
        suiteId: "suite-1",
        runnerIds: ["runner-1"],
        retryLimit: 0,
        environmentVersionId: "environment-version-1",
        environmentVariables: [{ name: "BASE_URL", value: "inline" }],
      }),
    ).toThrow();
  });

  it("keeps secret values confined to bounded write inputs", () => {
    expect(
      createExecutionSecretInputSchema.parse({
        projectId: "project-1",
        name: "API token",
        value: "secret-value",
      }),
    ).toMatchObject({ description: "", value: "secret-value" });
    expect(() =>
      createExecutionEnvironmentInputSchema.parse({
        projectId: "project-1",
        name: "Staging",
        variables: [{ name: "API_TOKEN", value: "plain" }],
        secretBindings: [{ name: "API_TOKEN", secretId: "secret-1" }],
      }),
    ).toThrow();
  });
});
