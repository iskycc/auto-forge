import type { DdtRepository } from "@autoforge/application";
import type { DdtScope } from "@autoforge/domain";
import { expect } from "vitest";

/** Both database adapters must enforce the same range, inheritance and concurrency rules. */
export async function expectDdtSrExecutionContract(
  repository: DdtRepository,
  scope: DdtScope,
  caseIds: [string, string],
  executionCaseDefinitionId: string,
  updatedAt: string,
) {
  const assignment = {
    scope,
    srNum: "ORDER",
    executionCaseDefinitionId,
    expectedRevision: 0,
    updatedAt,
  };
  const candidate = {
    scope,
    executionCaseDefinitionId,
    included: true,
    expectedRevision: 0,
    updatedAt,
  };
  await expect(repository.setSrExecutionClass(assignment)).rejects.toMatchObject({
    code: "DDT_EXECUTION_CLASS_OUT_OF_RANGE",
  });
  await repository.changeExecutionClassRange(candidate);
  await expect(repository.changeExecutionClassRange(candidate)).rejects.toMatchObject({
    code: "DDT_EXECUTION_MAPPING_REVISION_CONFLICT",
  });
  await expect(
    repository.listExecutionClassRange(scope, { query: "Order", limit: 1 }),
  ).resolves.toMatchObject({
    revision: 1,
    items: [{ caseDefinitionId: executionCaseDefinitionId }],
  });
  await repository.setSrExecutionClass(assignment);
  await expect(
    repository.setSrExecutionClass({ ...assignment, srNum: "order" }),
  ).rejects.toMatchObject({ code: "DDT_EXECUTION_MAPPING_REVISION_CONFLICT" });
  const cases = await repository.getCases(scope, caseIds);
  expect(cases.map((item) => item.executionClass?.caseDefinitionId)).toEqual([
    executionCaseDefinitionId,
    executionCaseDefinitionId,
  ]);
  expect(cases.map((item) => item.revision)).toEqual([1, 1]);
  await expect(
    repository.changeExecutionClassRange({ ...candidate, included: false, expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: "DDT_EXECUTION_CLASS_IN_USE" });
  await expect(
    repository.listSrExecutionMappings(scope, { query: "or", limit: 1 }),
  ).resolves.toMatchObject({
    items: [
      {
        srNum: "ORDER",
        caseCount: 2,
        revision: 1,
        legacyConflict: false,
        executionClass: { caseDefinitionId: executionCaseDefinitionId },
      },
    ],
  });
  const second = cases[1]!;
  const edit = {
    scope,
    caseId: second.caseId,
    expectedRevision: 1,
    nextData: { ...second.data, srNum: "NEW-SR" },
    historyId: `sr-move-${second.id}`,
    historyType: "edit" as const,
    sourceName: "SR move",
    updatedAt,
  };
  await repository.updateCases([edit]);
  expect((await repository.getCase(scope, second.caseId))?.executionClass).toBeUndefined();
  const firstPage = await repository.listSrExecutionMappings(scope, { query: "", limit: 1 });
  expect(firstPage.items[0]?.srNum).toBe("NEW-SR");
  expect(firstPage.nextCursor).toBeDefined();
  const nextPage = await repository.listSrExecutionMappings(scope, {
    query: "",
    limit: 1,
    cursor: firstPage.nextCursor!,
  });
  expect(nextPage.items[0]?.srNum).toBe("ORDER");
  expect(nextPage.nextCursor).toBeUndefined();

  await repository.updateCases([
    { ...edit, expectedRevision: 2, nextData: second.data, historyId: `sr-back-${second.id}` },
  ]);
  expect((await repository.getCase(scope, second.caseId))?.executionClass?.caseDefinitionId).toBe(
    executionCaseDefinitionId,
  );
  await repository.setSrExecutionClass({
    ...assignment,
    expectedRevision: 1,
    executionCaseDefinitionId: null,
  });
  await repository.changeExecutionClassRange({
    ...candidate,
    included: false,
    expectedRevision: 1,
  });
  await expect(
    repository.listExecutionClassRange(scope, { query: "", limit: 10 }),
  ).resolves.toMatchObject({ revision: 2, items: [] });
  await repository.changeExecutionClassRange({ ...candidate, expectedRevision: 2 });
  await repository.setSrExecutionClass({ ...assignment, expectedRevision: 2 });
  await expect(
    repository.listExecutionClassRange(
      { ...scope, testStageId: "other-stage" },
      { query: "", limit: 10 },
    ),
  ).resolves.toMatchObject({ items: [] });
  const competingWrites = await Promise.allSettled([
    repository.setSrExecutionClass({ ...assignment, expectedRevision: 3 }),
    repository.setSrExecutionClass({ ...assignment, expectedRevision: 3 }),
  ]);
  expect(competingWrites.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(competingWrites.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "DDT_EXECUTION_MAPPING_REVISION_CONFLICT" },
  });
}
