import type { DdtValueSearchInput, DdtValueSearchPage } from "@autoforge/contracts";
import { findDdtValueMatches } from "@autoforge/domain";
import type { DdtRepository } from "./ports";

/** Each slice releases DB reads between bounded windows and never persists search state. */
export async function searchDdtValues(
  repository: Pick<DdtRepository, "readValueSearchCandidates">,
  input: DdtValueSearchInput,
  yieldWindow: () => Promise<"continue" | "pause">,
  signal?: AbortSignal,
): Promise<DdtValueSearchPage> {
  const items: DdtValueSearchPage["items"] = [];
  let cursor = input.cursor;
  let scannedCount = 0;
  for (let window = 0; window < 16; window += 1) {
    signal?.throwIfAborted();
    const candidates = await repository.readValueSearchCandidates(input, cursor);
    if (!candidates.length) return { items, scannedCount };
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      scannedCount += 1;
      cursor = candidate.cursor;
      const result = findDdtValueMatches(candidate.data, input.keyword);
      if (result.matchCount) {
        items.push({
          id: candidate.id,
          caseId: candidate.caseId,
          srNum: candidate.srNum,
          ...result,
        });
      }
      if (items.length >= input.limit) return { items, scannedCount, nextCursor: cursor };
    }
    if ((await yieldWindow()) === "pause") break;
  }
  return { items, scannedCount, ...(cursor ? { nextCursor: cursor } : {}) };
}
