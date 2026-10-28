import { describe, expect, it, vi } from "vitest";
import { DdtCaseService } from "../src/manage-ddt-cases";
import type { DdtRepository } from "../src/ports";
import type { DdtCase } from "@autoforge/domain";
import { ddtCaseListInputSchema } from "@autoforge/contracts";

const scope = { projectId: "project-1", projectVersionId: "version-1", testStageId: "stage-1" };
const timestamp = "2026-08-28T00:00:00.000Z";

describe("clearing the DDT recycle bin", () => {
  it("captures one server cutoff and reuses it for later pages without reading payloads", async () => {
    const purgeDeletedCases = vi.fn().mockResolvedValue({ deletedCount: 200, hasMore: true });
    const service = new DdtCaseService(
      { purgeDeletedCases } as unknown as DdtRepository,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    );
    expect(await service.purgeDeletedPage(scope, {})).toEqual({
      deletedCount: 200,
      hasMore: true,
      deletedBefore: timestamp,
    });
    const earlier = "2026-08-27T23:59:59.000Z";
    await service.purgeDeletedPage(scope, { deletedBefore: earlier });
    expect(purgeDeletedCases).toHaveBeenLastCalledWith({ ...scope, deletedBefore: earlier });
    await expect(service.purgeDeletedPage(scope, { deletedBefore: "invalid" })).rejects.toThrow();
    await expect(service.purgeDeletedPage(scope, { projectId: "other" })).rejects.toThrow();
    expect(purgeDeletedCases).toHaveBeenCalledTimes(2);
  });
  it("stops a locked page without spinning or hiding the remaining records", async () => {
    const purgeDeletedCases = vi.fn().mockResolvedValue({ deletedCount: 0, hasMore: true });
    const service = new DdtCaseService(
      { purgeDeletedCases } as unknown as DdtRepository,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    );
    await expect(service.purgeDeletedPage(scope, {})).rejects.toMatchObject({
      code: "PLATFORM_BUSY",
    });
    expect(purgeDeletedCases).toHaveBeenCalledOnce();
  });
});
const executionClass = {
  caseDefinitionId: "class-1",
  className: "com.example.CheckoutDdtTest",
  displayName: "结算",
  sourceId: "source-1",
  currentVersion: 3,
  enabled: true,
  archived: false,
};

describe("DDT CaseID list selection", () => {
  it.each([{ caseIds: [] }, { caseIds: ["CASE-1"] }])(
    "forwards exact IDs including an empty selection with its scope",
    async ({ caseIds }) => {
      const listCases = vi.fn().mockResolvedValue({ items: [] });
      const service = new DdtCaseService(
        { listCases } as unknown as DdtRepository,
        { now: () => new Date(timestamp) },
        { next: () => "unused" },
      );
      await service.list(ddtCaseListInputSchema.parse({ ...scope, caseIds, limit: 200 }));
      expect(listCases).toHaveBeenCalledExactlyOnceWith({
        ...scope,
        caseIds,
        limit: 200,
        filters: [],
      });
    },
  );

  it("bounds each lookup without limiting the complete imported list", () => {
    expect(
      ddtCaseListInputSchema.safeParse({ ...scope, caseIds: Array(201).fill("CASE-1") }).success,
    ).toBe(false);
    expect(ddtCaseListInputSchema.safeParse({ ...scope, caseIds: [""] }).success).toBe(false);
  });
});

it("forwards category selections including empty arrays without resolving every SR", async () => {
  const listCases = vi.fn().mockResolvedValue({ items: [] });
  const service = new DdtCaseService(
    { listCases } as unknown as DdtRepository,
    { now: () => new Date(timestamp) },
    { next: () => "unused" },
  );
  for (const categoryIds of [[], ["wallet", "payments"]]) {
    await service.list(ddtCaseListInputSchema.parse({ ...scope, categoryIds }));
    expect(listCases).toHaveBeenLastCalledWith({ ...scope, categoryIds, limit: 60, filters: [] });
  }
  expect(
    ddtCaseListInputSchema.safeParse({ ...scope, categoryIds: Array(101).fill("wallet") }).success,
  ).toBe(false);
});

describe("public DDT case data", () => {
  it.each([
    { CaseID: "PAY-1", srNum: "PAY", amount: 12, enabled: false, note: null },
    { CaseID: "PAY-1", srNum: "PAY", 用户旅程: { step1: { Action: "支付", amount: 12 } } },
  ])("returns only original fields without management or execution metadata", async (data) => {
    const getCase = vi.fn().mockResolvedValue({
      ...scope,
      id: "internal-id",
      caseId: "PAY-1",
      data,
      updatedBy: "operator",
      executionClass,
    } as unknown as DdtCase);
    const service = new DdtCaseService(
      { getCase } as unknown as DdtRepository,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    );
    await expect(service.getData(scope, " PAY-1 ")).resolves.toEqual(data);
    expect(getCase).toHaveBeenCalledExactlyOnceWith(scope, "PAY-1");
  });

  it("does not fall back to a different scope when a case is absent or recycled", async () => {
    const getCase = vi.fn().mockResolvedValue(null);
    const service = new DdtCaseService(
      { getCase } as unknown as DdtRepository,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    );
    await expect(service.getData(scope, "PAY-1")).rejects.toMatchObject({
      code: "DDT_CASE_NOT_FOUND",
    });
    expect(getCase).toHaveBeenCalledExactlyOnceWith(scope, "PAY-1");
  });
});
function fixture(found: typeof executionClass | null = executionClass) {
  const repository = {
    findExecutionClass: vi.fn().mockResolvedValue(found),
    setSrExecutionClass: vi.fn().mockResolvedValue(undefined),
    changeExecutionClassRange: vi.fn().mockResolvedValue(undefined),
  } as unknown as DdtRepository;
  return {
    repository,
    service: new DdtCaseService(
      repository,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    ),
  };
}
describe("SR execution class mapping", () => {
  it("stores one SR association without loading or updating every DDT case", async () => {
    const { service, repository } = fixture();
    await service.setSrExecutionClass(scope, {
      srNum: " SR-ORDER ",
      className: executionClass.className,
      expectedRevision: 0,
    });
    expect(repository.setSrExecutionClass).toHaveBeenCalledWith({
      scope,
      srNum: "SR-ORDER",
      executionCaseDefinitionId: "class-1",
      expectedRevision: 0,
      updatedAt: timestamp,
    });
  });
  it("rejects classes outside the scope or without an available managed JAR source", async () => {
    const { service, repository } = fixture(null);
    await expect(
      service.setSrExecutionClass(scope, {
        srNum: "ORDER",
        className: "other.Class",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "DDT_EXECUTION_CLASS_NOT_FOUND" });
    expect(repository.setSrExecutionClass).not.toHaveBeenCalled();
  });
  it("rejects disabled classes when adding a candidate or assigning an SR", async () => {
    const { service } = fixture({ ...executionClass, enabled: false });
    await expect(
      service.changeExecutionClassRange(scope, {
        caseDefinitionId: "class-1",
        className: executionClass.className,
        included: true,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "DDT_EXECUTION_CLASS_UNAVAILABLE" });
  });
  it("can unlink an SR and remove a no-longer-available candidate", async () => {
    const { service, repository } = fixture(null);
    await service.setSrExecutionClass(scope, {
      srNum: "ORDER",
      className: null,
      expectedRevision: 4,
    });
    expect(repository.setSrExecutionClass).toHaveBeenCalledWith(
      expect.objectContaining({ executionCaseDefinitionId: null, expectedRevision: 4 }),
    );
    await service.changeExecutionClassRange(scope, {
      caseDefinitionId: "class-1",
      className: executionClass.className,
      included: false,
      expectedRevision: 3,
    });
    expect(repository.findExecutionClass).not.toHaveBeenCalled();
    expect(repository.changeExecutionClassRange).toHaveBeenCalledWith(
      expect.objectContaining({ executionCaseDefinitionId: "class-1", included: false }),
    );
  });
});

it("exports bounded pages in repository collation order, forwards scope and stops on cancellation or repeated cursors", async () => {
  const readExportCasesPage = vi
    .fn()
    .mockResolvedValueOnce({ items: [{ CaseID: "first", srNum: "SR" }], nextCursor: "z" })
    .mockResolvedValueOnce({ items: [{ CaseID: "second", srNum: "SR" }], nextCursor: "a" })
    .mockResolvedValueOnce({ items: [] });
  const repository = { readExportCasesPage } as unknown as DdtRepository;
  const service = new DdtCaseService(
    repository,
    { now: () => new Date(timestamp) },
    { next: () => "unused" },
  );
  const controller = new AbortController();
  const selection = { categoryIds: ["category"], srNum: "SR" };
  const exported = [];
  for await (const page of service.exportPages(scope, selection, controller.signal))
    exported.push(...page);
  expect(exported.map((row) => row.CaseID)).toEqual(["first", "second"]);
  expect(readExportCasesPage).toHaveBeenNthCalledWith(2, { ...scope, ...selection, cursor: "z" });
  expect(readExportCasesPage).toHaveBeenNthCalledWith(3, { ...scope, ...selection, cursor: "a" });
  controller.abort();
  await expect(service.exportPages(scope, selection, controller.signal).next()).rejects.toThrow();
  expect(readExportCasesPage).toHaveBeenCalledTimes(3);
  readExportCasesPage.mockResolvedValue({
    items: [{ CaseID: "same", srNum: "SR" }],
    nextCursor: "same",
  });
  const repeated = service.exportPages(scope, {}, new AbortController().signal);
  await repeated.next();
  await expect(repeated.next()).rejects.toMatchObject({ code: "DDT_EXPORT_CURSOR_INVALID" });
});
