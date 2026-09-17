import type { DdtCaseData } from "./ddt";

/** Only scalar values are searchable; object keys are returned solely as locations. */
export function findDdtValueMatches(data: DdtCaseData, keyword: string) {
  const needle = keyword.trim().toLocaleLowerCase("en-US");
  const matches: Array<{ path: string[]; value: string }> = [];
  let matchCount = 0;
  if (!needle) return { matches, matchCount };

  function visit(value: unknown, path: string[]) {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
      return;
    }
    const text = String(value);
    const index = text.toLocaleLowerCase("en-US").indexOf(needle);
    if (index < 0) return;
    matchCount += 1;
    if (matches.length === 8) return;
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + needle.length + 160);
    matches.push({
      path,
      value: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    });
  }
  visit(data, []);
  return { matches, matchCount };
}
