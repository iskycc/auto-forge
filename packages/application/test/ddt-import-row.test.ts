import { describe, expect, it } from "vitest";
import { normalizeImportedDdtCaseData } from "../src/ddt-import-row";

describe("sparse DDT import rows", () => {
  it("preserves literal parameter names without assigning object prototypes", () => {
    const input = JSON.parse(
      '{"CaseID":"literal","srNum":"SR","__proto__":"原值","constructor":"构造参数"}',
    );
    const result = normalizeImportedDdtCaseData(input);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toBe("原值");
    expect(result.constructor).toBe("构造参数");
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
  it("ignores merged blank columns and empty cells while preserving zero, false and nonblank text", () => {
    const row = Object.freeze({
      CaseID: "中文-1",
      srNum: "SR",
      本SR字段: "原值",
      nullable: null,
      zero: 0,
      false: false,
      spaces: "  ",
      padded: " value ",
      empty: "",
    });
    expect(normalizeImportedDdtCaseData(row)).toEqual({
      CaseID: "中文-1",
      srNum: "SR",
      本SR字段: "原值",
      zero: 0,
      false: false,
      padded: " value ",
    });
    expect(row).not.toHaveProperty("其他SR字段");
  });
  it("keeps present journey steps sparse and preserves missing steps", () => {
    const row = {
      CaseID: "旅程",
      srNum: "SR",
      用户旅程: { step1: { CaseID: "旅程", srNum: "SR", action: "执行", empty: "", nil: null } },
    };
    expect(normalizeImportedDdtCaseData(row)).toEqual({
      CaseID: "旅程",
      srNum: "SR",
      用户旅程: { step1: { CaseID: "旅程", srNum: "SR", action: "执行" } },
    });
  });
  it("also removes blank cells from legacy spreadsheet parsers without mutating the source", () => {
    const row = { CaseID: "legacy", srNum: "SR", empty: "" };
    expect(normalizeImportedDdtCaseData(row)).toEqual({ CaseID: "legacy", srNum: "SR" });
    expect(row).toHaveProperty("empty", "");
  });
});
