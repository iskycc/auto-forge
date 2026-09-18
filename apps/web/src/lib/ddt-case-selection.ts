import { firstColumnOf } from "./case-list-column";
import { MAX_CASE_LIST_FILE_BYTES, MAX_CASE_LIST_ROWS } from "./case-list-file";

const CASE_ID_HEADERS = new Set(["caseid", "用例id", "用例编号"]);
const MATCH_BATCH_SIZE = 200;
const normalize = (value: string) => value.trim().toLocaleLowerCase("en-US");

export type DdtCaseSelectionResult = { matched: string[]; unmatched: string[] };

export function parseDdtCaseIdColumn(text: string): string[] {
  if (new TextEncoder().encode(text).byteLength > MAX_CASE_LIST_FILE_BYTES)
    throw new Error("用例清单不能超过 32 MiB。");
  return parseDdtCaseIdCells(text.split(/\r?\n/).map(firstColumnOf));
}

export function parseDdtCaseIdCells(cells: Iterable<string>): string[] {
  const identifiers = new Map<string, string>();
  let firstNonEmpty = true;
  let row = 0;
  for (const cell of cells) {
    row += 1;
    if (row > MAX_CASE_LIST_ROWS + 1)
      throw new Error(`用例清单不能超过 ${MAX_CASE_LIST_ROWS.toLocaleString()} 行。`);
    const caseId = cell.replace(/^\uFEFF/, "").trim();
    if (!caseId) continue;
    const normalized = normalize(caseId);
    if (firstNonEmpty) {
      firstNonEmpty = false;
      if (CASE_ID_HEADERS.has(normalized)) continue;
    }
    if (caseId.length > 512) throw new Error(`第 ${row} 行的 CaseID 不能超过 512 个字符。`);
    if (!identifiers.has(normalized)) identifiers.set(normalized, caseId);
  }
  return [...identifiers.values()];
}

export async function matchDdtCaseIds(
  caseIds: string[],
  resolveBatch: (ids: string[], signal: AbortSignal) => Promise<string[]>,
  signal: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<DdtCaseSelectionResult> {
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (let offset = 0; offset < caseIds.length; offset += MATCH_BATCH_SIZE) {
    signal.throwIfAborted();
    const batch = caseIds.slice(offset, offset + MATCH_BATCH_SIZE);
    const canonicalIds = await resolveBatch(batch, signal);
    signal.throwIfAborted();
    const byId = new Map(canonicalIds.map((id) => [normalize(id), id]));
    for (const requested of batch) {
      const canonical = byId.get(normalize(requested));
      if (canonical !== undefined) matched.push(canonical);
      else unmatched.push(requested);
    }
    onProgress?.(Math.min(offset + batch.length, caseIds.length), caseIds.length);
  }
  return { matched, unmatched };
}
