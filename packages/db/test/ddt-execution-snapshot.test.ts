import { expect, it } from "vitest";
import { freezeDdtSrExecutionClasses } from "../src/ddt-execution-sql";

it("keeps one SR class within a snapshot when the mapping changes between SQL windows", () => {
  const base = {
    projectId: "p",
    projectVersionId: "v",
    testStageId: "s",
    srNumNormalized: "order",
    executionCaseDefinitionId: "first",
  };
  const rows = [
    base,
    { ...base, executionCaseDefinitionId: "later" },
    { ...base, testStageId: "another", executionCaseDefinitionId: "other-stage" },
    { ...base, srNumNormalized: "pending", executionCaseDefinitionId: null },
    { ...base, srNumNormalized: "pending", executionCaseDefinitionId: "assigned-later" },
  ];
  expect(freezeDdtSrExecutionClasses(rows).map((row) => row.executionCaseDefinitionId)).toEqual([
    "first",
    "first",
    "other-stage",
    null,
    null,
  ]);
  expect(rows[1]?.executionCaseDefinitionId).toBe("later");
});

it("uses one category class across different SRs while preserving each SR's first observed mapping", () => {
  const base = {
    projectId: "p",
    projectVersionId: "v",
    testStageId: "s",
    srNumNormalized: "first",
    requirementCategoryId: "wallet",
    executionCaseDefinitionId: "class-a",
  };
  const rows = [
    base,
    { ...base, srNumNormalized: "second", executionCaseDefinitionId: "class-b" },
    { ...base, requirementCategoryId: "payment", executionCaseDefinitionId: "class-c" },
  ];
  expect(freezeDdtSrExecutionClasses(rows).map((row) => row.executionCaseDefinitionId)).toEqual([
    "class-a",
    "class-a",
    "class-a",
  ]);
});
