import { CASE_SUITE_DDT_MATCH_BATCH_SIZE, type CaseSuiteDdtSelection } from "@autoforge/contracts";

/** Collect a complete preview before allowing the existing atomic member-removal operation. */
export async function collectSuiteDdtRemovalSelection(
  caseIds: string[],
  readBatch: (ids: string[], signal: AbortSignal) => Promise<CaseSuiteDdtSelection>,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
): Promise<CaseSuiteDdtSelection> {
  if (caseIds.length > 100_000) throw new Error("一次最多选择 100,000 条用例。");
  const items: CaseSuiteDdtSelection["items"] = [];
  const unmatchedCaseIds: string[] = [];
  for (let offset = 0; offset < caseIds.length; offset += CASE_SUITE_DDT_MATCH_BATCH_SIZE) {
    signal.throwIfAborted();
    const batch = caseIds.slice(offset, offset + CASE_SUITE_DDT_MATCH_BATCH_SIZE);
    const result = await readBatch(batch, signal);
    signal.throwIfAborted();
    items.push(...result.items);
    unmatchedCaseIds.push(...result.unmatchedCaseIds);
    onProgress(Math.min(offset + batch.length, caseIds.length), caseIds.length);
  }
  return { items, unmatchedCaseIds };
}
