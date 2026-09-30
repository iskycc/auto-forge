import type { DdtRepository } from "@autoforge/application";
import type { DdtScope } from "@autoforge/domain";
import { expect } from "vitest";

export const ddtLiteralSearchFields = {
  描述: "支付订单",
  "owner.name[0]": "quality-team",
  '报价"币种': "CNY",
  "slash\\field": "literal %_\\suffix",
};

export async function expectDdtCaseSearch(
  repository: Pick<DdtRepository, "listCases">,
  scope: DdtScope,
  caseId: string,
): Promise<void> {
  const exact = await repository.listCases({
    ...scope,
    caseIds: [
      caseId.toLowerCase(),
      caseId,
      "missing",
      caseId.slice(0, -1),
      ...Array.from({ length: 196 }, (_, index) => `missing-${index}`),
    ],
    limit: 200,
    filters: [],
  });
  expect(exact.items.map((item) => item.caseId)).toEqual([caseId]);
  expect(exact.items[0]).not.toHaveProperty("data");
  const fragment = caseId.slice(1).toLowerCase();
  for (const match of [{}, { queryMatch: "contains" as const }]) {
    const fuzzy = await repository.listCases({
      ...scope,
      ...match,
      query: ` ${fragment} `,
      limit: 20,
      filters: [],
    });
    expect(fuzzy.items.map((item) => item.caseId)).toEqual([caseId]);
  }
  expect(
    (
      await repository.listCases({
        ...scope,
        query: fragment,
        queryMatch: "prefix",
        limit: 20,
        filters: [],
      })
    ).items,
  ).toEqual([]);
  const firstPage = await repository.listCases({
    ...scope,
    query: "rDeR",
    limit: 1,
    filters: [],
  });
  expect(firstPage.items).toHaveLength(1);
  expect(firstPage.nextCursor).toBeDefined();
  const secondPage = await repository.listCases({
    ...scope,
    query: "rDeR",
    cursor: firstPage.nextCursor!,
    limit: 1,
    filters: [],
  });
  expect(secondPage.items.map((item) => item.caseId)).toEqual([caseId]);
  expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
  expect(secondPage.nextCursor).toBeUndefined();
  expect(
    (
      await repository.listCases({
        ...scope,
        query: "%_",
        limit: 20,
        filters: [],
      })
    ).items,
  ).toEqual([]);
  for (const selection of [
    { ...scope, caseIds: [] },
    { ...scope, caseIds: [caseId], projectId: "other-project" },
    { ...scope, caseIds: [caseId], projectVersionId: "other-version" },
    { ...scope, caseIds: [caseId], testStageId: "other-stage" },
  ]) {
    expect(await repository.listCases({ ...selection, limit: 200, filters: [] })).toEqual({
      items: [],
    });
  }
  for (const [field, value] of Object.entries(ddtLiteralSearchFields)) {
    const result = await repository.listCases({
      ...scope,
      limit: 20,
      filters: [{ field, operator: "contains", value }],
    });
    expect(
      result.items.map((item) => item.caseId),
      field,
    ).toEqual([caseId]);
  }
  const absent = await repository.listCases({
    ...scope,
    limit: 20,
    filters: [{ field: "missing.field", operator: "exists" }],
  });
  expect(absent.items).toEqual([]);
}
