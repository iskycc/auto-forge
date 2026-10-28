import type { DdtRecycleGroupPage } from "@autoforge/contracts";

export type DdtRecycleGroupRow = {
  sr_num: string;
  sr_num_normalized: string;
  case_count: number | string;
};
export type DdtRecycleTotalsRow = { total_cases: number | string; total_groups: number | string };

export function ddtRecycleGroupPage(
  rows: readonly DdtRecycleGroupRow[],
  totals: DdtRecycleTotalsRow,
  limit: number,
): DdtRecycleGroupPage {
  const items = rows
    .slice(0, limit)
    .map((row) => ({ srNum: row.sr_num, count: Number(row.case_count) }));
  const cursor = rows.length > limit ? rows[limit - 1]!.sr_num_normalized : undefined;
  return {
    items,
    totalCases: Number(totals.total_cases),
    totalGroups: Number(totals.total_groups),
    ...(cursor !== undefined ? { nextCursor: cursor } : {}),
  };
}
