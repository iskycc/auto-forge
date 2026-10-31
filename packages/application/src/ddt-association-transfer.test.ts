import { describe, expect, it, vi } from "vitest";
import type { DdtRepository } from "./ports";
import type {
  DdtExecutionClass,
  DdtRequirementCategory,
  DdtSrExecutionMapping,
} from "@autoforge/domain";
import { DomainError } from "@autoforge/domain";
import type { DdtAssociationImportRow, ParsedDdtAssociationImport } from "@autoforge/contracts";
import { DdtAssociationTransferService } from "./ddt-association-transfer";
const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
const candidate: DdtExecutionClass = {
  caseDefinitionId: "target-id",
  className: "com.Wallet",
  displayName: "Wallet",
  sourceId: "source",
  currentVersion: 1,
  enabled: true,
  archived: false,
};
function fixture() {
  let rangeRevision = 0,
    included = false;
  const categories: DdtRequirementCategory[] = [];
  const mapping: DdtSrExecutionMapping = {
    srNum: "钱包-SR",
    caseCount: 1,
    revision: 0,
    legacyConflict: false,
  };
  const parsed: ParsedDdtAssociationImport = {
    rows: [
      { section: "range", className: candidate.className, sheetName: "候选测试类", rowNumber: 2 },
      {
        section: "categories",
        className: candidate.className,
        categoryName: "钱包",
        sheetName: "分类执行类",
        rowNumber: 2,
      },
      {
        section: "srCategories",
        srNum: mapping.srNum,
        categoryName: "钱包",
        sheetName: "SR需求分类",
        rowNumber: 2,
      },
    ],
    rowCount: 3,
    issueCount: 0,
    issues: [],
  };
  const repository = {
    findExecutionClass: vi.fn(async (_scope: unknown, name: string) =>
      name === candidate.className ? candidate : null,
    ),
    listExecutionClassRange: vi.fn(async () => ({
      revision: rangeRevision,
      items: included ? [candidate] : [],
    })),
    listRequirementCategories: vi.fn(async () => ({ items: categories })),
    listSrExecutionMappings: vi.fn(async () => ({ items: [mapping] })),
    changeExecutionClassRange: vi.fn(async () => {
      rangeRevision++;
      included = true;
    }),
    saveRequirementCategory: vi.fn(async (input: { id: string; name: string }) => {
      categories.push({ id: input.id, name: input.name, revision: 1, executionClass: candidate });
    }),
    setSrExecutionClass: vi.fn(
      async (input: { categoryId?: string | null; executionCaseDefinitionId: string | null }) => {
        mapping.revision++;
        delete mapping.category;
        delete mapping.executionClass;
        if (input.categoryId)
          mapping.category = categories.find((item) => item.id === input.categoryId)!;
        if (input.categoryId || input.executionCaseDefinitionId) mapping.executionClass = candidate;
      },
    ),
  };
  const service = new DdtAssociationTransferService(
    repository as unknown as DdtRepository,
    { parse: async () => parsed },
    { now: () => new Date("2026-10-31T00:00:00Z") },
    { next: () => "category-target-id" },
  );
  const inspect = (signal = new AbortController().signal) =>
    service.read(scope, { fileName: "config.xlsx", content: Uint8Array.of(1, 2, 3) }, signal);
  return { service, repository, parsed, inspect, mapping, categories };
}
describe("portable SR association import", () => {
  it("previews without writes, applies in dependency order, and re-imports idempotently", async () => {
    const f = fixture();
    const plan = await f.inspect();
    expect(plan.preview.issueCount).toBe(0);
    expect(f.repository.changeExecutionClassRange).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect(
      await f.service.apply(scope, plan, plan.preview.fingerprint, signal, () => {}),
    ).toMatchObject({ processed: 3, changed: 3 });
    expect(f.mapping.category?.name).toBe("钱包");
    expect(f.repository.saveRequirementCategory.mock.invocationCallOrder[0]!).toBeGreaterThan(
      f.repository.changeExecutionClassRange.mock.invocationCallOrder[0]!,
    );
    const again = await f.inspect();
    expect(
      await f.service.apply(scope, again, again.preview.fingerprint, signal, () => {}),
    ).toMatchObject({ changed: 0, unchanged: 3 });
    expect(f.repository.setSrExecutionClass).toHaveBeenCalledTimes(1);
  });
  it("reports missing targets and prevents every write while validation has issues", async () => {
    const f = fixture();
    f.parsed.rows.push({
      section: "srClasses",
      srNum: "missing",
      className: "com.Missing",
      sheetName: "SR直接关联",
      rowNumber: 9,
    });
    f.parsed.rowCount++;
    const plan = await f.inspect();
    expect(plan.preview.issues).toMatchObject([{ rowNumber: 9 }, { rowNumber: 9 }]);
    await expect(
      f.service.apply(
        scope,
        plan,
        plan.preview.fingerprint,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "DDT_ASSOCIATION_IMPORT_INVALID" });
    expect(f.repository.changeExecutionClassRange).not.toHaveBeenCalled();
  });
  it("rejects stale preview fingerprints before saving any change", async () => {
    const f = fixture();
    const old = await f.inspect();
    f.mapping.revision++;
    const current = await f.inspect();
    await expect(
      f.service.apply(
        scope,
        current,
        old.preview.fingerprint,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "DDT_ASSOCIATION_IMPORT_CONFLICT" });
    expect(f.repository.changeExecutionClassRange).not.toHaveBeenCalled();
  });
  it("reports committed progress, row and cause when a later write fails", async () => {
    const f = fixture();
    const cause = new DomainError("DDT_EXECUTION_MAPPING_REVISION_CONFLICT", "目标已被更新");
    f.repository.setSrExecutionClass.mockRejectedValueOnce(cause);
    const plan = await f.inspect();
    await expect(
      f.service.apply(
        scope,
        plan,
        plan.preview.fingerprint,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "DDT_ASSOCIATION_IMPORT_INTERRUPTED",
      cause,
      details: { processed: 2, changed: 2 },
      message: expect.stringContaining("SR需求分类 第 2 行"),
    });
    expect(f.categories).toHaveLength(1);
  });
  it("exports unused candidate classes and categories and allows explicit unlinking", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const plan = await f.inspect();
    await f.service.apply(scope, plan, plan.preview.fingerprint, signal, () => {});
    for (const section of ["range", "categories", "srCategories"] as const) {
      const pages = [];
      for await (const page of f.service.exportPages(scope, section, signal))
        pages.push(...page.rows);
      expect(pages).toHaveLength(1);
    }
    f.parsed.rows = [
      {
        section: "srCategories",
        srNum: f.mapping.srNum,
        categoryName: "",
        sheetName: "SR需求分类",
        rowNumber: 2,
      } satisfies DdtAssociationImportRow,
    ];
    f.parsed.rowCount = 1;
    const clear = await f.inspect();
    await f.service.apply(scope, clear, clear.preview.fingerprint, signal, () => {});
    expect(f.mapping.category).toBeUndefined();
    expect(f.mapping.executionClass).toBeUndefined();
    expect(f.categories).toHaveLength(1);
  });
  it("honors cancellation before the next write", async () => {
    const f = fixture();
    const plan = await f.inspect();
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      f.service.apply(scope, plan, plan.preview.fingerprint, cancellation.signal, () => {}),
    ).rejects.toMatchObject({
      code: "DDT_ASSOCIATION_IMPORT_INTERRUPTED",
      details: { processed: 0 },
    });
    expect(f.repository.changeExecutionClassRange).not.toHaveBeenCalled();
  });
});
