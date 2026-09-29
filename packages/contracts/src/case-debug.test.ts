import { describe, expect, it } from "vitest";
import { createCaseDebugRunSchema } from "./case-debug";

const input = {
  projectId: "project",
  projectVersionId: "version",
  testStageId: "stage",
  kind: "testng",
  caseDefinitionId: "class",
  execution: { runnerIds: ["runner"] },
};

describe("case debug execution input", () => {
  it("accepts one existing class with bounded single-case configuration", () => {
    expect(createCaseDebugRunSchema.parse(input).execution.runnerIds).toEqual(["runner"]);
  });
  it("rejects DDT execution without an explicit case or Adapter", () => {
    expect(createCaseDebugRunSchema.safeParse({ ...input, kind: "ddt" }).success).toBe(false);
    expect(
      createCaseDebugRunSchema.safeParse({
        ...input,
        kind: "ddt",
        ddtCaseId: "Case-1",
      }).success,
    ).toBe(false);
  });
  it("rejects client object paths, inline environment variables and arbitrary parameters", () => {
    expect(
      createCaseDebugRunSchema.safeParse({
        ...input,
        executionClass: { source: "upload", objectKey: "/tmp/arbitrary.jar", key: "Test" },
      }).success,
    ).toBe(false);
    expect(
      createCaseDebugRunSchema.safeParse({
        ...input,
        execution: { runnerIds: ["runner"], parameters: { password: "secret" } },
      }).success,
    ).toBe(false);
  });
});
