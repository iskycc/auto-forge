import { describe, expect, it } from "vitest";
import { EXPORT_OUTCOME_FILTERS } from "@autoforge/contracts";
import {
  caseSuiteExportFilename,
  ddtExportFilename,
  executionExceptionExportFilename,
  executionExportFilename,
  exportContentDisposition,
} from "./export-filename";
import { parseExportFilename } from "./run-batch-export";

const time = { exportedAt: new Date("2026-10-23T16:30:45Z"), timeZone: "Asia/Shanghai" };
const batch = { suiteName: "支付回归", sequenceNumber: 123 };

describe("business spreadsheet filenames", () => {
  it.each([
    ["final", undefined, "最终结果"],
    ["all", undefined, "全部轮次"],
    ["round", 2, "第2轮"],
  ] as const)("identifies the batch, result selection and %s scope", (scope, round, range) => {
    expect(
      executionExportFilename({
        ...time,
        batch,
        template: "results",
        scope,
        round,
        outcomes: ["failed", "succeeded"],
      }),
    ).toBe(`支付回归_用例执行结果_${range}_成功-失败_批次123_20261024-003045.xlsx`);
  });

  it.each([
    ["final", undefined, "最终结果"],
    ["all", undefined, "全部轮次"],
    ["round", 3, "第3轮"],
  ] as const)("distinguishes failure analysis for %s scope", (scope, round, range) => {
    expect(
      executionExportFilename({
        ...time,
        batch,
        template: "failure-analysis",
        scope,
        round,
        outcomes: ["failed", "blocked"],
      }),
    ).toBe(`支付回归_失败用例分析清单_${range}_批次123_20261024-003045.xlsx`);
  });

  it("names full-status results, exceptions and suite members consistently", () => {
    expect(
      executionExportFilename({
        ...time,
        batch,
        template: "results",
        scope: "final",
        outcomes: EXPORT_OUTCOME_FILTERS,
      }),
    ).toContain("_最终结果_全部状态_批次123_");
    expect(executionExceptionExportFilename({ ...time, batch })).toBe(
      "支付回归_执行异常原因_批次123_20261024-003045.xlsx",
    );
    expect(caseSuiteExportFilename({ ...time, suiteName: batch.suiteName })).toBe(
      "支付回归_任务用例清单_20261024-003045.xlsx",
    );
  });

  it.each([
    [{}, "全部用例"],
    [{ caseIds: [] }, "全部用例"],
    [{ caseIds: ["用例一"], srNum: "Wallet" }, "已选用例"],
    [{ srNum: "Wallet" }, "筛选范围"],
    [{ categoryIds: [] }, "筛选范围"],
    [{ categoryIds: ["Wallet"] }, "筛选范围"],
  ])("labels DDT export scope from the actual selection %j", (selection, range) => {
    expect(
      ddtExportFilename({ ...time, versionName: "1.20", stageName: "系统测试", selection }),
    ).toBe(`1.20-系统测试_DDT用例清单_${range}_20261024-003045.xlsx`);
  });

  it("uses the configured timezone across year boundaries independently of the host timezone", () => {
    const exportedAt = new Date("2026-12-31T16:00:00Z");
    expect(caseSuiteExportFilename({ ...time, exportedAt, suiteName: "回归" })).toContain(
      "20270101-000000",
    );
    expect(
      caseSuiteExportFilename({ ...time, exportedAt, timeZone: "UTC", suiteName: "回归" }),
    ).toContain("20261231-160000");
    expect(
      caseSuiteExportFilename({
        ...time,
        exportedAt: new Date("2026-07-01T16:00:00Z"),
        timeZone: "America/New_York",
        suiteName: "回归",
      }),
    ).toContain("20260701-120000");
  });

  it("preserves readable Chinese while removing path, header and Windows filename delimiters", () => {
    const filename = caseSuiteExportFilename({
      ...time,
      suiteName: '  ../每日\\冒烟:"任务"<>|\r\n\u0000  ',
    });
    expect(filename).toBe("每日-冒烟-任务_任务用例清单_20261024-003045.xlsx");
    expect(caseSuiteExportFilename({ ...time, suiteName: " . / \u0000 " })).toMatch(/^AutoForge_/);
    expect(caseSuiteExportFilename({ ...time, suiteName: "CON" })).toMatch(/^CON_任务用例清单_/);
  });

  it("bounds multibyte names without splitting characters or dropping the report and batch identity", () => {
    const filename = executionExportFilename({
      ...time,
      batch: { ...batch, suiteName: "支付🧪".repeat(200) },
      template: "failure-analysis",
      scope: "round",
      round: 100,
      outcomes: ["failed"],
    });
    expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(240);
    expect(filename).not.toContain("\ufffd");
    expect(filename.endsWith("_失败用例分析清单_第100轮_批次123_20261024-003045.xlsx")).toBe(true);
    expect(parseExportFilename(exportContentDisposition(filename))).toBe(filename);
  });

  it("encodes Chinese and RFC 5987 punctuation in a browser-readable download header", () => {
    const filename = caseSuiteExportFilename({ ...time, suiteName: "O'Brien(冒烟)!" });
    const disposition = exportContentDisposition(filename);
    expect(disposition).toContain("O%27Brien%28");
    expect(disposition).toContain("%29%21");
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(parseExportFilename(disposition)).toBe(filename);
    const malformed = caseSuiteExportFilename({ ...time, suiteName: "原任务\ud800名称" });
    expect(parseExportFilename(exportContentDisposition(malformed))).toBe(malformed);
  });

  it("rejects missing or invalid round numbers rather than naming the wrong range", () => {
    expect(() =>
      executionExportFilename({
        ...time,
        batch,
        template: "results",
        scope: "round",
        outcomes: ["failed"],
      }),
    ).toThrow(RangeError);
  });
});
