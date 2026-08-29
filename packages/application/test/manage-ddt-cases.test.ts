import { describe, expect, it, vi } from "vitest";

import { DdtCaseService } from "../src/manage-ddt-cases";
import type { DdtRepository } from "../src/ports";

const scope = {
  projectId: "project-1",
  projectVersionId: "version-1",
  testStageId: "stage-1",
};
const timestamp = "2026-08-28T00:00:00.000Z";

describe("DDT execution class mapping", () => {
  it("sets one ordinary TestNG class on every selected DDT CaseID", async () => {
    const repository = {
      getCases: vi.fn().mockResolvedValue([ddtCase("ddt-1", "CASE-1"), ddtCase("ddt-2", "CASE-2")]),
      findExecutionClass: vi.fn().mockResolvedValue({
        caseDefinitionId: "class-1",
        className: "com.example.CheckoutDdtTest",
        displayName: "结算 DDT 执行类",
        sourceId: "source-1",
        currentVersion: 3,
        enabled: true,
        archived: false,
      }),
      setExecutionClass: vi.fn().mockResolvedValue(2),
    } as unknown as DdtRepository;
    const service = new DdtCaseService(
      repository,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    );

    const result = await service.setExecutionClass(
      scope,
      ["CASE-1", "CASE-2", "CASE-1"],
      "com.example.CheckoutDdtTest",
      "user-1",
    );

    expect(result.updatedCount).toBe(2);
    expect(repository.setExecutionClass).toHaveBeenCalledWith({
      scope,
      caseIds: ["CASE-1", "CASE-2"],
      executionCaseDefinitionId: "class-1",
      actorId: "user-1",
      updatedAt: timestamp,
    });
  });

  it("rejects a class outside the selected project version and stage", async () => {
    const repository = {
      getCases: vi.fn().mockResolvedValue([ddtCase("ddt-1", "CASE-1")]),
      findExecutionClass: vi.fn().mockResolvedValue(null),
      setExecutionClass: vi.fn(),
    } as unknown as DdtRepository;
    const service = new DdtCaseService(
      repository,
      { now: () => new Date(timestamp) },
      { next: () => "unused" },
    );

    await expect(
      service.setExecutionClass(scope, ["CASE-1"], "com.other.WrongVersion"),
    ).rejects.toMatchObject({ code: "DDT_EXECUTION_CLASS_NOT_FOUND" });
    expect(repository.setExecutionClass).not.toHaveBeenCalled();
  });
});

function ddtCase(id: string, caseId: string) {
  return {
    ...scope,
    id,
    caseId,
    srNum: "SR-ORDER",
    kind: "standard" as const,
    data: { CaseID: caseId, srNum: "SR-ORDER" },
    sourceName: "orders.xlsx",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
