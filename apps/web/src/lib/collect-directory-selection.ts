import {
  caseDirectorySelectionPartSchema,
  type CaseDirectorySelection,
} from "@autoforge/contracts";
import { directoryResponseError, readDirectoryProjection } from "./directory-projection";
import { casePathOf, normalizeCasePath } from "./case-path-import";
import type { CaseLatestRun } from "./case-selection-stats";

export type DirectorySelection = {
  items: CaseDirectorySelection[];
  outcomes: Map<string, CaseLatestRun>;
};

/** Full-scope identifiers are requested only for an explicit bulk action, never for page rendering. */
export async function collectDirectorySelection(input: {
  baseId: string;
  filters: string;
  signal: AbortSignal;
  paths?: string[];
  directoryPath?: string;
  onProgress(completed: number, total: number): void;
}): Promise<DirectorySelection> {
  input.signal.throwIfAborted();
  const projection = await readDirectoryProjection(input.baseId, input.filters, input.signal);
  if (!projection.status.generation || !projection.manifest || projection.synchronized === false)
    throw new Error("当前范围正在后台准备，请稍后重试。");
  const paths = input.paths ? new Set(input.paths.map(normalizeCasePath)) : null;
  const result: DirectorySelection = { items: [], outcomes: new Map() };
  for (let ordinal = 0; ordinal < projection.manifest.partCount; ordinal++) {
    input.signal.throwIfAborted();
    const response = await fetch(
      `/api/v1/read-models/${projection.status.id}/parts?generation=${projection.status.generation}&ordinal=${ordinal}&selection=1`,
      { signal: input.signal, cache: "no-store" },
    );
    if (!response.ok) throw new Error(await directoryResponseError(response));
    const part = caseDirectorySelectionPartSchema.parse(await response.json());
    const matched = part.items.filter(
      (item) =>
        (input.directoryPath === undefined ||
          item.directoryPath === input.directoryPath ||
          item.directoryPath.startsWith(`${input.directoryPath}/`)) &&
        (!paths ||
          paths.has(normalizeCasePath(casePathOf(item))) ||
          paths.has(normalizeCasePath(item.className))),
    );
    result.items.push(...matched);
    const ids = new Set(matched.map((item) => item.id));
    for (const outcome of part.outcomes)
      if (ids.has(outcome.caseDefinitionId))
        result.outcomes.set(outcome.caseDefinitionId, {
          outcome: outcome.outcome,
          ...(outcome.resultCode ? { resultCode: outcome.resultCode } : {}),
        });
    input.onProgress(ordinal + 1, projection.manifest.partCount);
  }
  return result;
}
