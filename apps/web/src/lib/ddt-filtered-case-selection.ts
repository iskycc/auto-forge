const MAX_SELECTED_DDT_CASES = 100_000;

export type DdtCaseFilters = {
  query: string;
  srNum: string;
  categoryIds: string[];
  advancedField: string;
  advancedOperator: string;
  advancedValue: string;
};

export function ddtCaseFilterParameters(filters: DdtCaseFilters, limit = 60, cursor?: string) {
  const parameters = new URLSearchParams({ limit: String(limit) });
  if (cursor) parameters.set("cursor", cursor);
  if (filters.query.trim()) parameters.set("query", filters.query.trim());
  if (filters.srNum) parameters.set("srNum", filters.srNum);
  for (const categoryId of filters.categoryIds) parameters.append("categoryId", categoryId);
  if (filters.advancedField.trim())
    parameters.set(
      "filters",
      JSON.stringify([
        {
          field: filters.advancedField.trim(),
          operator: filters.advancedOperator,
          ...(filters.advancedOperator === "exists" ? {} : { value: filters.advancedValue }),
        },
      ]),
    );
  return parameters;
}

/** Resolve identifiers only, leaving the navigation's rendered window unchanged. */
export async function collectFilteredDdtCaseIds(
  readPage: (cursor?: string) => Promise<{ items: Array<{ caseId: string }>; nextCursor?: string }>,
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<string[]> {
  const caseIds = new Map<string, string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page <= MAX_SELECTED_DDT_CASES; page += 1) {
    signal.throwIfAborted();
    const result = await readPage(cursor);
    signal.throwIfAborted();
    for (const item of result.items)
      caseIds.set(item.caseId.toLocaleLowerCase("en-US"), item.caseId);
    if (caseIds.size > MAX_SELECTED_DDT_CASES)
      throw new Error("筛选结果超过单次任务添加的 100,000 条，请缩小筛选范围后重试。");
    onProgress(caseIds.size);
    if (!result.nextCursor) return [...caseIds.values()];
    if (cursors.has(result.nextCursor)) throw new Error("筛选分页未能继续，请刷新后重试。");
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("筛选分页过多，请缩小范围后重试。");
}
