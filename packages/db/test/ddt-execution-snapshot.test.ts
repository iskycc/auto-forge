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
