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
  for (const item of cases) {
    const summary = await repository.getCaseSummary(scope, item.caseId);
    expect(summary).toMatchObject({
      id: item.id,
      revision: item.revision,
      executionClass: { caseDefinitionId: executionCaseDefinitionId },
    });
    expect(summary).not.toHaveProperty("data");
    expect(
      await repository.getCaseSummary({ ...scope, testStageId: "other-stage" }, item.caseId),
    ).toBeNull();
    expect(
      await repository.getCaseSummary({ ...scope, projectVersionId: "other-version" }, item.caseId),
    ).toBeNull();
    expect(
      await repository.getCaseSummary({ ...scope, projectId: "other-project" }, item.caseId),
    ).toBeNull();
  }
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
  const category = {
    scope,
    id: `category-${executionCaseDefinitionId}`,
    name: "钱包",
    executionCaseDefinitionId,
    expectedRevision: 0,
    updatedAt,
  };
  await repository.saveRequirementCategory(category);
  await expect(
    repository.saveRequirementCategory({ ...category, id: `duplicate-${category.id}` }),
  ).rejects.toMatchObject({ code: "DDT_CATEGORY_NAME_CONFLICT" });
  await expect(
    repository.saveRequirementCategory({
      ...category,
      executionCaseDefinitionId: "missing",
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ code: "DDT_EXECUTION_CLASS_OUT_OF_RANGE" });
  await repository.setSrExecutionClass({
    ...assignment,
    expectedRevision: 4,
    categoryId: category.id,
    executionCaseDefinitionId: null,
  });
  await expect(
    repository.listSrExecutionMappings(scope, { query: "ORDER", limit: 10 }),
  ).resolves.toMatchObject({
    items: [
      {
        category: { id: category.id, name: "钱包" },
        executionClass: { caseDefinitionId: executionCaseDefinitionId },
      },
    ],
  });
  await expect(repository.getCase(scope, caseIds[0])).resolves.toMatchObject({
    executionClass: { caseDefinitionId: executionCaseDefinitionId },
    revision: 1,
  });
  await expect(
    repository.deleteRequirementCategory({ scope, id: category.id, expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: "DDT_CATEGORY_IN_USE" });
  await expect(
    repository.changeExecutionClassRange({ ...candidate, included: false, expectedRevision: 3 }),
  ).rejects.toMatchObject({ code: "DDT_EXECUTION_CLASS_IN_USE" });
  await repository.changeExecutionClassRange({
    ...candidate,
    executionCaseDefinitionId: executionCaseDefinitionId + "-replacement",
    expectedRevision: 3,
  });
  const beforeCategoryChange = await repository.getCases(scope, caseIds);
  await repository.saveRequirementCategory({
    ...category,
    name: "支付",
    executionCaseDefinitionId: executionCaseDefinitionId + "-replacement",
    expectedRevision: 1,
  });
  await expect(
    repository.saveRequirementCategory({ ...category, expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: "DDT_EXECUTION_MAPPING_REVISION_CONFLICT" });
  await expect(
    repository.listSrExecutionMappings(scope, { query: "ORDER", limit: 10 }),
  ).resolves.toMatchObject({ items: [{ category: { name: "支付" } }] });
  expect(
    (await repository.getCases(scope, caseIds)).map(
      (item) => item.executionClass?.caseDefinitionId,
    ),
  ).toEqual([
    executionCaseDefinitionId + "-replacement",
    executionCaseDefinitionId + "-replacement",
  ]);
  expect(beforeCategoryChange.map((item) => item.executionClass?.caseDefinitionId)).toEqual([
    executionCaseDefinitionId,
    executionCaseDefinitionId,
  ]);
  const anotherCategory = { ...category, id: category.id + "-second", name: "其他分类" };
  await repository.saveRequirementCategory(anotherCategory);
  const firstCategories = await repository.listRequirementCategories(scope, {
    query: "",
    limit: 1,
  });
  expect(firstCategories.items).toHaveLength(1);
  expect(firstCategories.nextCursor).toBeDefined();
  const nextCategories = await repository.listRequirementCategories(scope, {
    query: "",
    limit: 1,
    cursor: firstCategories.nextCursor!,
  });
  expect(nextCategories.items[0]?.id).not.toBe(firstCategories.items[0]?.id);
  expect(nextCategories.nextCursor).toBeUndefined();
  await repository.deleteRequirementCategory({
    scope,
    id: anotherCategory.id,
    expectedRevision: 1,
  });
  await expect(
    repository.listRequirementCategories(
      { ...scope, testStageId: "other-stage" },
      { query: "", limit: 10 },
    ),
  ).resolves.toEqual({ items: [] });
  await expect(
    repository.setSrExecutionClass({
      ...assignment,
      expectedRevision: 5,
      categoryId: "missing",
      executionCaseDefinitionId: null,
    }),
  ).rejects.toMatchObject({ code: "DDT_CATEGORY_NOT_FOUND" });
  await repository.setSrExecutionClass({
    ...assignment,
    expectedRevision: 5,
    categoryId: null,
    executionCaseDefinitionId: null,
  });
  await repository.deleteRequirementCategory({ scope, id: category.id, expectedRevision: 2 });
  await expect(repository.getCase(scope, caseIds[0])).resolves.not.toHaveProperty("executionClass");

  await repository.setSrExecutionClass({ ...assignment, expectedRevision: 6 });
}
