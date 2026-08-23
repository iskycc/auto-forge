import { describe, expect, it } from "vitest";

import {
  createDdtJourney,
  ddtStepNames,
  diffDdtCaseData,
  updateDdtCaseField,
  validateDdtCaseAgainstTemplate,
} from "../src/ddt";

describe("DDT domain rules", () => {
  it("keeps journey identity fields synchronized across ordered steps", () => {
    const journey = createDdtJourney("ORDER-1", "ORDER", {
      step2: { CaseID: "stale", srNum: "stale", action: "pay" },
      step1: { CaseID: "stale", srNum: "stale", action: "create" },
    });

    expect(ddtStepNames(journey)).toEqual(["step1", "step2"]);
    expect(journey).toMatchObject({
      CaseID: "ORDER-1",
      srNum: "ORDER",
      用户旅程: {
        step1: { CaseID: "ORDER-1", srNum: "ORDER", action: "create" },
        step2: { CaseID: "ORDER-1", srNum: "ORDER", action: "pay" },
      },
    });
    expect(updateDdtCaseField(journey, "result", "paid", "step2")).toMatchObject({
      用户旅程: { step2: { result: "paid" } },
    });
  });

  it("applies template defaults and reports human-readable validation failures", () => {
    const template = {
      id: "template-1",
      projectId: "project-1",
      projectVersionId: "version-1",
      testStageId: "stage-1",
      srNum: "ORDER",
      name: "订单字段",
      description: "",
      rules: [
        { field: "priority", required: true, type: "number" as const, defaultValue: 3 },
        { field: "owner", required: true, type: "string" as const },
      ],
      revision: 1,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };

    const result = validateDdtCaseAgainstTemplate(
      { CaseID: "ORDER-1", srNum: "ORDER", owner: "" },
      template,
    );
    expect(result.data.priority).toBe(3);
    expect(result.errors).toEqual([
      expect.objectContaining({
        field: "owner",
        code: "required",
        message: "字段“owner”不能为空。",
      }),
    ]);
    expect(
      diffDdtCaseData({ CaseID: "A", srNum: "S" }, { CaseID: "A", srNum: "S", priority: 3 }),
    ).toEqual([
      expect.objectContaining({ field: "priority", beforeExists: false, afterExists: true }),
    ]);
  });
});
