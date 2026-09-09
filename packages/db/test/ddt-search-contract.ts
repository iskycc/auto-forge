import type { DdtRepository } from "@autoforge/application";
import type { DdtScope } from "@autoforge/domain";
import { expect } from "vitest";

export const ddtLiteralSearchFields = {
  描述: "支付订单",
  "owner.name[0]": "quality-team",
  '报价"币种': "CNY",
  "slash\\field": "literal %_\\suffix",
};

export async function expectDdtLiteralFieldSearch(
  repository: Pick<DdtRepository, "listCases">,
  scope: DdtScope,
  caseId: string,
): Promise<void> {
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
