import {
  DDT_VALUE_SEARCH_CASE_NAME_MAX_LENGTH,
  DDT_VALUE_SEARCH_PAGE_SIZE,
  type DdtValueSearchInput,
  type DdtValueSearchPage,
} from "@autoforge/contracts";
import { ddtCaseCell, findDdtValueMatches, type DdtCaseData } from "@autoforge/domain";
import type { DdtRepository } from "./ports";

/** Each slice releases DB reads between bounded windows and never persists search state. */
export async function searchDdtValues(
  repository: Pick<DdtRepository, "readValueSearchCandidates">,
  input: DdtValueSearchInput,
  yieldWindow: () => Promise<"continue" | "pause">,
  signal?: AbortSignal,
): Promise<DdtValueSearchPage> {
  const items: DdtValueSearchPage["items"] = [];
  const index =
    input.indexOffset === undefined ? undefined : { matchedCount: 0, pageCursors: [] as string[] };
  let cursor = input.cursor;
  let scannedCount = 0;
  const page = (nextCursor?: string): DdtValueSearchPage => ({
    items,
    scannedCount,
    ...(index ? { index } : {}),
    ...(nextCursor ? { nextCursor } : {}),
  });
  for (let window = 0; window < 16; window += 1) {
    signal?.throwIfAborted();
    const candidates = await repository.readValueSearchCandidates(input, cursor);
    if (!candidates.length) return page();
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      scannedCount += 1;
      const result = findDdtValueMatches(candidate.data, input.keyword);
      if (result.matchCount) {
        if (index) {
          if (((input.indexOffset ?? 0) + index.matchedCount) % DDT_VALUE_SEARCH_PAGE_SIZE === 0)
            index.pageCursors.push(cursor ?? "");
          index.matchedCount += 1;
        } else
          items.push({
            id: candidate.id,
            caseId: candidate.caseId,
            caseName: caseNamePreview(candidate.data),
            srNum: candidate.srNum,
            ...result,
          });
      }
      cursor = candidate.cursor;
      if (!index && items.length >= input.limit) return page(cursor);
    }
    if ((await yieldWindow()) === "pause") break;
  }
  return page(cursor);
}

function caseNamePreview(data: DdtCaseData): string | undefined {
  const name = String(ddtCaseCell(data, "CaseName") ?? "").trim();
  if (!name) return undefined;
  return name.length > DDT_VALUE_SEARCH_CASE_NAME_MAX_LENGTH
    ? `${name.slice(0, DDT_VALUE_SEARCH_CASE_NAME_MAX_LENGTH - 1)}…`
    : name;
}
