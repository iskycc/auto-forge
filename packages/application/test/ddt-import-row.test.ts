import { describe, expect, it } from "vitest";
import type { DdtImportRowShape } from "@autoforge/contracts";
import { materializeDdtImportRow } from "../src/ddt-import-row";

const shape: DdtImportRowShape = {
  schemaVersion: 1,
  standard: [
    "CaseID",
    "srNum",
    "本SR字段",
    "其他SR字段",
    "全空列",
    "nullable",
    "zero",
    "false",
    "spaces",
  ],
  steps: { step1: ["CaseID", "srNum", "action", "可选"], step2: ["CaseID", "srNum", "结果"] },
};

describe("compact import row restoration", () => {
  it("restores all missing sheet cells without replacing null, false, zero or significant spaces", () => {
    const row = Object.freeze({
      CaseID: "中文-1",
      srNum: "SR",
      本SR字段: "原值",
      nullable: null,
      zero: 0,
      false: false,
      spaces: "  ",
    });
    expect(materializeDdtImportRow(row, shape)).toEqual({
      CaseID: "中文-1",
      srNum: "SR",
      本SR字段: "原值",
      其他SR字段: "",
      全空列: "",
      nullable: null,
      zero: 0,
      false: false,
      spaces: "  ",
    });
    expect(row).not.toHaveProperty("其他SR字段");
  });
  it("restores only present journey steps and preserves missing steps", () => {
    const row = {
      CaseID: "旅程",
      srNum: "SR",
      用户旅程: { step1: { CaseID: "旅程", srNum: "SR", action: "执行" } },
    };
    expect(materializeDdtImportRow(row, shape)).toEqual({
      CaseID: "旅程",
      srNum: "SR",
      用户旅程: { step1: { CaseID: "旅程", srNum: "SR", action: "执行", 可选: "" } },
    });
  });
  it("preserves legacy parser rows when there is no compact schema", () => {
    const row = { CaseID: "legacy", srNum: "SR", empty: "" };
    expect(materializeDdtImportRow(row)).toBe(row);
  });
});
