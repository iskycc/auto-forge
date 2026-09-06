import { describe, expect, it, vi } from "vitest";
import {
  caseDirectoryPartSchema,
  suiteDirectoryPartSchema,
  type ReadModelQuery,
} from "@autoforge/contracts";
import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { readDirectoryBranch } from "../src/read-directory-branch";
import { createReadModelBuilder } from "../src/build-read-model";

const caseScope = {
  kind: "case_directory" as const,
  projectId: "project",
  projectVersionId: "version",
  testStageId: "stage",
  chunkSize: 100 as const,
};
function definition(index: number): CaseDefinitionWithMethods {
  return caseDirectoryPartSchema.parse({
    items: [
      {
        id: `case-${index}`,
        projectId: "project",
        sourceId: "source",
        directoryPath: `folder/${index % 40}`,
        displayName: `Case ${index}`,
        className: `example.Case${index}`,
        packageName: "example",
        description: "",
        tags: index === 399 ? ["needle"] : [],
        enabled: true,
        archived: false,
        groups: [],
        parameters: {},
        currentVersion: 1,
        revision: 1,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
        methods: [],
      },
    ],
    outcomes: [],
  }).items[0]! as CaseDefinitionWithMethods;
}

function harness() {
  const cases = Array.from({ length: 400 }, (_, index) => definition(index));
  const catalog = {
    getSource: vi.fn(async () => ({
      inspection: {
        classes: cases.map((item) => ({
          className: item.className,
          packageName: item.packageName,
          simpleName: item.displayName,
          enabled: true,
          classLevelTest: false,
          groups: [],
          methods: [],
        })),
      },
    })),
    listCases: vi.fn(async ({ cursor, limit }: { cursor?: string; limit: number }) => {
      const offset = Number(cursor ?? 0);
      return {
        items: cases.slice(offset, offset + limit),
        ...(offset + limit < cases.length ? { nextCursor: String(offset + limit) } : {}),
      };
    }),
    listLatestRunOutcomes: vi.fn(async (ids: string[]) =>
      ids.includes("case-399")
        ? [
            {
              caseDefinitionId: "case-399",
              outcome: "timed_out",
              executedAt: "2026-09-06T00:00:00.000Z",
            },
          ]
        : [],
    ),
  };
  const suites = {
    findMemberCaseDefinitionIds: vi.fn(async (_suiteId: string, ids: string[]) =>
      ids.filter((id) => id !== "case-399"),
    ),
    getSummary: vi.fn(async () => ({ revision: 3 })),
    listMemberPage: vi.fn(
      async ({
        afterCaseMemberId,
        afterDdtMemberId,
        limit,
      }: {
        afterCaseMemberId?: string;
        afterDdtMemberId?: string;
        limit: number;
      }) => {
        const caseOffset = afterCaseMemberId ? Number(afterCaseMemberId) + 1 : 0;
        const ddtOffset = afterDdtMemberId ? Number(afterDdtMemberId) + 1 : 0;
        return {
          items: cases.slice(caseOffset, caseOffset + limit).map((item, index) => ({
            id: String(caseOffset + index),
            suiteId: "suite",
            addedAt: item.createdAt,
            caseDefinition: item,
          })),
          ddtItems: cases.slice(ddtOffset, Math.min(3, ddtOffset + limit)).map((item, index) => ({
            id: String(ddtOffset + index),
            suiteId: "suite",
            addedAt: item.createdAt,
            ddtCase: { id: item.id, caseId: item.displayName, srNum: "SR-1", kind: "standard" },
          })),
        };
      },
    ),
  };
  const build = createReadModelBuilder({ catalog, suites } as unknown as Parameters<
    typeof createReadModelBuilder
  >[0]);
  async function project(query: ReadModelQuery) {
    const parts: unknown[] = [];
    const manifest = await build(query, async (ordinal, payload) => {
      parts[ordinal] = payload;
    });
    return { manifest, parts };
  }
  return { project, catalog, suites, cases };
}

describe("bounded directory snapshots", () => {
  it("indexes immediate children without embedding descendants or file metadata", async () => {
    const { project } = harness();
    const { manifest, parts } = await project({ ...caseScope, tree: true } as ReadModelQuery);
    const rootOrdinal = (manifest as { rootOrdinal: number }).rootOrdinal;
    const root = parts[rootOrdinal] as {
      directories: { name: string; ordinal: number; caseCount: number }[];
      entries: unknown[];
    };
    expect(root).toBeDefined();
    expect(root.directories.map((item) => item.name)).toEqual(["folder"]);
    expect(root.entries).toEqual([]);
    expect(root.directories[0]?.caseCount).toBe(400);
    const folder = parts[root.directories[0]!.ordinal] as typeof root;
    expect(folder.directories).toHaveLength(40);
    expect(folder.entries).toEqual([]);
    const leaf = parts[folder.directories[0]!.ordinal] as typeof root;
    expect(leaf.directories).toEqual([]);
    expect(leaf.entries).toHaveLength(10);
    expect(JSON.stringify(root)).not.toContain("className");
    expect(JSON.stringify(folder)).not.toContain("Case399");
  });

  it("serves a parent without reading any descendant chunks, then reads only an expanded leaf", async () => {
    const { project } = harness();
    const { manifest, parts } = await project({ ...caseScope, tree: true });
    const readPart = vi.fn(async (ordinal: number) => parts[ordinal] ?? null);
    const root = await readDirectoryBranch({
      kind: "case_directory",
      ordinal: (manifest as { rootOrdinal: number }).rootOrdinal,
      readPart,
    });
    expect(readPart).toHaveBeenCalledTimes(1);
    expect(root.items).toEqual([]);
    const folder = await readDirectoryBranch({
      kind: "case_directory",
      ordinal: root.directories[0]!.ordinal,
      readPart,
    });
    expect(readPart).toHaveBeenCalledTimes(2);
    expect(folder.items).toEqual([]);
    const leaf = await readDirectoryBranch({
      kind: "case_directory",
      ordinal: folder.directories[0]!.ordinal,
      readPart,
    });
    expect(leaf.items).toHaveLength(10);
    expect(new Set(leaf.items.map((item) => item.directoryPath))).toEqual(new Set(["folder/0"]));
  });

  it("keeps ordinary package and DDT SR contents absent from a task's collapsed root", async () => {
    const { project } = harness();
    const { manifest, parts } = await project({
      kind: "suite_directory",
      projectId: "project",
      suiteId: "suite",
      chunkSize: 100,
      tree: true,
    });
    const readPart = async (ordinal: number) => parts[ordinal] ?? null;
    const root = await readDirectoryBranch({
      kind: "suite_directory",
      ordinal: (manifest as { rootOrdinal: number }).rootOrdinal,
      readPart,
    });
    expect(root.members).toEqual({ items: [], ddtItems: [] });
    expect(root.directories.map((directory) => directory.kind).sort()).toEqual(["case", "ddt"]);
    const sr = root.directories.find((directory) => directory.kind === "ddt")!;
    const expanded = await readDirectoryBranch({
      kind: "suite_directory",
      ordinal: sr.ordinal,
      readPart,
    });
    expect(expanded.members.items).toEqual([]);
    expect(expanded.members.ddtItems).toHaveLength(3);
  });

  it("bounds a flat root with hundreds of direct files without inventing folder levels", async () => {
    const { project, cases } = harness();
    for (const item of cases) item.directoryPath = "";
    const { manifest, parts } = await project({ ...caseScope, tree: true });
    const root = await readDirectoryBranch({
      kind: "case_directory",
      ordinal: (manifest as { rootOrdinal: number }).rootOrdinal,
      readPart: async (ordinal) => parts[ordinal] ?? null,
    });
    expect(root.directories).toEqual([]);
    expect(root.items).toHaveLength(100);
    expect(root.nextOrdinal).not.toBeNull();
    expect(root.items[0]).not.toHaveProperty("methods");
    expect(root.items[0]).toHaveProperty("methodCount", 0);
  });

  it("prepares source class pages in the background with at most 100 classes each", async () => {
    const { project } = harness();
    const { manifest, parts } = await project({
      kind: "source_directory",
      projectId: "project",
      sourceId: "source",
    });
    expect(manifest).toEqual({ caseCount: 400, partCount: 4 });
    expect(parts.every((part) => Array.isArray(part) && part.length === 100)).toBe(true);
  });

  it("packs only matching cases into chunks, including matches beyond the first source page", async () => {
    const { project } = harness();
    const { parts, manifest } = await project({
      ...caseScope,
      filter: { query: "needle", outcome: "blocked" },
    });
    expect(manifest).toMatchObject({ caseCount: 1, partCount: 1 });
    const page = caseDirectoryPartSchema.parse(parts[0]);
    expect(page.items.map((item) => item.id)).toEqual(["case-399"]);
    expect(page.outcomes.map((item) => item.caseDefinitionId)).toEqual(["case-399"]);
  });

  it("bounds each storage chunk and preserves every case exactly once", async () => {
    const { project } = harness();
    const { parts, manifest } = await project(caseScope);
    expect(manifest).toMatchObject({ caseCount: 400, partCount: 4 });
    const pages = parts.map((part) => caseDirectoryPartSchema.parse(part));
    expect(pages.every((part) => part.items.length <= 100)).toBe(true);
    expect(new Set(pages.flatMap((part) => part.items.map((item) => item.id))).size).toBe(400);
  });

  it("filters missing suite members across all source pages without exporting the entire catalog", async () => {
    const { project } = harness();
    const { manifest, parts } = await project({
      ...caseScope,
      filter: { query: "", outcome: "all", missingSuiteId: "suite" },
    });
    expect(manifest).toMatchObject({ caseCount: 1, partCount: 1 });
    expect(caseDirectoryPartSchema.parse(parts[0]).items[0]?.id).toBe("case-399");
  });

  it("returns a real empty result for a search with no matches", async () => {
    const { project } = harness();
    const { manifest, parts } = await project({
      ...caseScope,
      filter: { query: "missing", outcome: "never" },
    });
    expect(manifest).toMatchObject({ caseCount: 0, partCount: 0 });
    expect(parts).toEqual([]);
  });

  it("chunks ordinary and DDT members without losing the shorter stream", async () => {
    const { project } = harness();
    const { manifest, parts } = await project({
      kind: "suite_directory",
      projectId: "project",
      suiteId: "suite",
      chunkSize: 100,
    });
    expect(manifest).toMatchObject({ caseCount: 403, revision: 3 });
    const pages = parts.map((part) => suiteDirectoryPartSchema.parse(part));
    expect(pages.every((part) => part.items.length + part.ddtItems.length <= 100)).toBe(true);
    expect(pages.flatMap((part) => part.items)).toHaveLength(400);
    expect(pages.flatMap((part) => part.ddtItems)).toHaveLength(3);
  });

  it("searches all task members before creating storage chunks", async () => {
    const { project } = harness();
    const { manifest, parts } = await project({
      kind: "suite_directory",
      projectId: "project",
      suiteId: "suite",
      chunkSize: 100,
      search: "case399",
    });
    expect(manifest).toMatchObject({ caseCount: 1, partCount: 1 });
    expect(suiteDirectoryPartSchema.parse(parts[0]).items[0]?.caseDefinition.id).toBe("case-399");
  });
});
