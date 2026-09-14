import { describe, expect, it, vi } from "vitest";
import { DdtCaseService } from "../src/manage-ddt-cases";
import type { DdtRepository } from "../src/ports";
import type { DdtCase } from "@autoforge/domain";

const scope = { projectId: "project-1", projectVersionId: "version-1", testStageId: "stage-1" };
const timestamp = "2026-08-28T00:00:00.000Z";
const executionClass = {
  caseDefinitionId: "class-1",
  className: "com.example.CheckoutDdtTest",
  displayName: "结算",
  sourceId: "source-1",
  currentVersion: 3,
  enabled: true,
  archived: false,
};

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
  it("rejects classes outside the scope or an available authoritative source", async () => {
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
