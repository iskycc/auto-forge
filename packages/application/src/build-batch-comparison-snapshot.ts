import { compareBatchCase, type BatchCaseVariant } from "./compare-batch-case";
import {
  batchComparisonManifestSchema,
  batchComparisonPartSchema,
  type ReadModelQuery,
} from "@autoforge/contracts";
import { DomainError, type RunBatch } from "@autoforge/domain";
import type { RunBatchRepository } from "./ports";

const CHUNK_SIZE = 250;

/** Read only the final attempt of each case, in bounded database pages. */
export async function buildBatchComparisonSnapshot(
  repository: Pick<RunBatchRepository, "getSummary" | "listCasePage">,
  query: Extract<ReadModelQuery, { kind: "batch_comparison" }>,
  writePart: (ordinal: number, payload: unknown) => Promise<void>,
) {
  const [left, right] = await Promise.all([
    repository.getSummary(query.leftBatchId, [query.projectId]),
    repository.getSummary(query.rightBatchId, [query.rightProjectId ?? query.projectId]),
  ]);
  if (
    !left ||
    !right ||
    (query.projectVersionId !== undefined &&
      (left.policy?.projectVersionId !== query.projectVersionId ||
        right.policy?.projectVersionId !== query.projectVersionId))
  )
    throw new DomainError("RUN_BATCH_NOT_FOUND", "对比批次不属于当前项目版本。");
  const leftCases = await readCases(left.id, left.projectId);
  const rightCases = await readCases(right.id, right.projectId);
  const ids = [...new Set([...leftCases.keys(), ...rightCases.keys()])].sort();
  let commonCaseCount = 0;
  let partCount = 0;
  const changes = { outcome: 0, version: 0, slower: 0, faster: 0 };
  for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
    const part = ids.slice(offset, offset + CHUNK_SIZE).map((caseDefinitionId) => {
      const baseline = leftCases.get(caseDefinitionId);
      const candidate = rightCases.get(caseDefinitionId);
      const comparison = compareBatchCase(caseDefinitionId, baseline, candidate);
      const durationDeltaMs = comparison.durationDeltaMs;
      if (baseline && candidate) {
        commonCaseCount += 1;
        if (baseline.outcome !== candidate.outcome) changes.outcome += 1;
        if (baseline.version !== candidate.version) changes.version += 1;
        if ((durationDeltaMs ?? 0) > 0) changes.slower += 1;
        if ((durationDeltaMs ?? 0) < 0) changes.faster += 1;
      }
      return comparison;
    });
    await writePart(partCount++, batchComparisonPartSchema.parse(part));
  }
  return batchComparisonManifestSchema.parse({
    left: describe(left),
    right: describe(right),
    commonCaseCount,
    onlyLeftCaseCount: leftCases.size - commonCaseCount,
    onlyRightCaseCount: rightCases.size - commonCaseCount,
    comparableScope: leftCases.size === rightCases.size && commonCaseCount === leftCases.size,
    partCount,
    changes,
  });

  async function readCases(batchId: string, projectId: string) {
    const cases = new Map<string, BatchCaseVariant>();
    for (let offset = 0; ; offset += CHUNK_SIZE) {
      const page = await repository.listCasePage({
        batchId,
        projectIds: [projectId],
        scope: "summary",
        sort: "none",
        direction: "asc",
        offset,
        limit: CHUNK_SIZE,
      });
      if (!page) throw new DomainError("RUN_BATCH_NOT_FOUND", "对比批次已被删除。");
      for (const { run, attempt } of page.items)
        cases.set(run.caseDefinitionId, {
          displayName: run.displayName,
          version: run.caseVersion,
          ...((attempt?.outcome ?? run.terminalOutcome)
            ? { outcome: attempt?.outcome ?? run.terminalOutcome }
            : {}),
          ...(attempt?.durationMs === undefined ? {} : { durationMs: attempt.durationMs }),
        });
      if (offset + page.items.length >= page.total) return cases;
      if (!page.items.length) throw new Error("Batch comparison pagination made no progress.");
    }
  }
}

function describe(batch: RunBatch) {
  return {
    batchId: batch.id,
    projectId: batch.projectId,
    suiteId: batch.suiteId,
    suiteVersion: batch.suiteVersion,
    selectedRunnerIds: [...batch.selectedRunnerIds],
    caseCount: batch.totalRuns,
  };
}
