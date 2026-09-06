import {
  caseDirectoryPartSchema,
  suiteDirectoryPartSchema,
  type CaseDirectoryPart,
  type SuiteDirectoryPart,
  type ReadModelQuery,
} from "@autoforge/contracts";
import { classifyAttemptResult, matchesCaseDirectorySearch } from "@autoforge/domain";
import type { CaseCatalogRepository, CaseSuiteRepository } from "./ports";
import type { ReadModelBuilder } from "./read-model-snapshots";

import { DirectorySnapshotIndex } from "./directory-snapshot-index";

type WritePart = Parameters<ReadModelBuilder>[1];
const SOURCE_PAGE_SIZE = 250;

export async function buildCaseDirectorySnapshot(
  catalog: CaseCatalogRepository,
  suites: CaseSuiteRepository,
  query: Extract<ReadModelQuery, { kind: "case_directory" }>,
  writePart: WritePart,
) {
  const tree = query.tree ? new DirectorySnapshotIndex() : undefined;
  const chunkSize = query.chunkSize ?? SOURCE_PAGE_SIZE;
  let chunk: CaseDirectoryPart = { items: [], outcomes: [] };
  let partCount = 0;
  let caseCount = 0;
  let cursor: string | undefined;
  const visitedCursors = new Set<string>();
  async function flush() {
    await writePart(partCount++, caseDirectoryPartSchema.parse(chunk));
    caseCount += chunk.items.length;
    chunk = { items: [], outcomes: [] };
  }
  do {
    const page = await catalog.listCases({
      projectIds: [query.projectId],
      projectVersionId: query.projectVersionId,
      testStageId: query.testStageId,
      scopedOnly: true,
      limit: SOURCE_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const ids = page.items.map((item) => item.id);
    const outcomes = new Map(
      (await catalog.listLatestRunOutcomes(ids)).map((outcome) => [
        outcome.caseDefinitionId,
        outcome,
      ]),
    );
    const members = new Set(
      query.filter?.missingSuiteId
        ? await suites.findMemberCaseDefinitionIds(query.filter.missingSuiteId, ids)
        : [],
    );
    for (const item of page.items) {
      if (!matchesCaseDirectorySearch(item, query.filter?.query ?? "") || members.has(item.id))
        continue;
      const outcome = outcomes.get(item.id);
      const filter = query.filter?.outcome ?? "all";
      if (
        filter === "never"
          ? outcome !== undefined
          : filter !== "all" && (!outcome || classifyAttemptResult(outcome) !== filter)
      )
        continue;
      tree?.add(item.directoryPath.split("/").filter(Boolean), {
        ordinal: partCount,
        index: chunk.items.length,
        kind: "case",
        name: item.displayName,
      });
      chunk.items.push(item);
      if (outcome) chunk.outcomes.push(outcome);
      if (chunk.items.length === chunkSize) await flush();
    }
    if (page.nextCursor && visitedCursors.has(page.nextCursor))
      throw new Error("Case snapshot pagination repeated a cursor.");
    cursor = page.nextCursor;
    if (cursor) visitedCursors.add(cursor);
  } while (cursor);
  if (chunk.items.length || (!query.chunkSize && partCount === 0)) await flush();
  const rootOrdinal = await tree?.write(partCount, writePart);
  return { partCount, caseCount, ...(rootOrdinal !== undefined ? { rootOrdinal } : {}) };
}

export async function buildSuiteDirectorySnapshot(
  suites: CaseSuiteRepository,
  query: Extract<ReadModelQuery, { kind: "suite_directory" }>,
  writePart: WritePart,
) {
  const suite = await suites.getSummary(query.suiteId, [query.projectId]);
  if (!suite) return null;
  const tree = query.tree ? new DirectorySnapshotIndex() : undefined;
  const chunkSize = query.chunkSize ?? SOURCE_PAGE_SIZE;
  const search = query.search?.trim().toLocaleLowerCase("zh-CN") ?? "";
  let chunk: SuiteDirectoryPart = { items: [], ddtItems: [] };
  let afterCaseMemberId: string | undefined;
  let afterDdtMemberId: string | undefined;
  let partCount = 0;
  let caseCount = 0;
  let ordinaryCount = 0;
  let ddtCount = 0;
  async function flushIfFull() {
    const count = chunk.items.length + chunk.ddtItems.length;
    if (count < chunkSize) return;
    await writePart(partCount++, chunk);
    caseCount += count;
    chunk = { items: [], ddtItems: [] };
  }
  for (;;) {
    const page = await suites.listMemberPage({
      suiteId: query.suiteId,
      projectIds: [query.projectId],
      limit: SOURCE_PAGE_SIZE,
      ...(afterCaseMemberId ? { afterCaseMemberId } : {}),
      ...(afterDdtMemberId ? { afterDdtMemberId } : {}),
    });
    if (!page || (!page.items.length && !page.ddtItems.length)) break;
    const nextCase = page.items.at(-1)?.id ?? afterCaseMemberId;
    const nextDdt = page.ddtItems.at(-1)?.id ?? afterDdtMemberId;
    if (nextCase === afterCaseMemberId && nextDdt === afterDdtMemberId)
      throw new Error("Suite snapshot pagination repeated a cursor.");
    const compact = suiteDirectoryPartSchema.parse({
      items: page.items.map((item) => ({
        ...item,
        caseDefinition: { ...item.caseDefinition, methodCount: item.caseDefinition.methods.length },
      })),
      ddtItems: page.ddtItems,
    });
    for (const item of compact.items) {
      const definition = item.caseDefinition;
      if (
        !`${definition.displayName} ${definition.className} ${definition.packageName}`
          .toLocaleLowerCase("zh-CN")
          .includes(search)
      )
        continue;
      tree?.add([definition.packageName || "默认包"], {
        ordinal: partCount,
        index: chunk.items.length,
        kind: "case",
        name: definition.displayName,
      });
      chunk.items.push(item);
      ordinaryCount++;
      await flushIfFull();
    }
    for (const item of compact.ddtItems) {
      const definition = item.ddtCase;
      if (
        !`${definition.caseId} ${definition.srNum} ${definition.executionClass?.className ?? ""}`
          .toLocaleLowerCase("zh-CN")
          .includes(search)
      )
        continue;
      tree?.add([definition.srNum], {
        ordinal: partCount,
        index: chunk.ddtItems.length,
        kind: "ddt",
        name: definition.caseId,
      });
      chunk.ddtItems.push(item);
      ddtCount++;
      await flushIfFull();
    }
    afterCaseMemberId = nextCase;
    afterDdtMemberId = nextDdt;
  }
  if (chunk.items.length || chunk.ddtItems.length) {
    await writePart(partCount++, chunk);
    caseCount += chunk.items.length + chunk.ddtItems.length;
  }
  const rootOrdinal = await tree?.write(partCount, writePart);
  return {
    partCount,
    caseCount,
    revision: suite.revision,
    ...(rootOrdinal !== undefined ? { rootOrdinal, ordinaryCount, ddtCount } : {}),
  };
}
