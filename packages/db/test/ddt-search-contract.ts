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
