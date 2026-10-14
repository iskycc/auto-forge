import type { RunBatchExportRow } from "@autoforge/application";
import type { FailureAnalysisClaim } from "@autoforge/domain";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildRunBatchExportWorkbook,
  createRunBatchExportWorkbookStream,
} from "./run-batch-export-xlsx";

const row: RunBatchExportRow = {
  attemptId: "attempt",
  executionRunId: "run",
  casePath: "example.PaymentTest",
  displayName: "支付验证",
  outcome: "failed",
  resultCode: "TESTNG_ASSERTIONS_FAILED",
  summary: "失败堆栈",
  startedAt: null,
  finishedAt: null,
  durationMs: 100,
  round: 1,
};
const input = {
  batchId: "batch",
  template: "failure-analysis" as const,
  scope: "final" as const,
  shareLinks: new Map<string, string>(),
};

describe("Excel export data safety", () => {
  it.each([
    ["XML noncharacter", "错误\ufffe消息"],
    ["XML forbidden control", "错误\u0000消息"],
    ["incomplete Unicode", "错误\ud800消息"],
    ["cell text limit", "x".repeat(32_768)],
    ["cell line feed limit", "line\n".repeat(254)],
    ["XML-normalized carriage return limit", "line\r".repeat(254)],
    ["mixed XML-normalized line break limit", "line\r\n".repeat(126) + "line\r".repeat(128)],
  ])("rejects %s instead of returning an unsafe workbook", async (_reason, summary) => {
    await expect(
      buildRunBatchExportWorkbook({ ...input, rows: [{ ...row, summary }] }),
    ).rejects.toMatchObject({ code: "EXPORT_DATA_INVALID" });
  });

  it("retains legal Unicode, whitespace, XML punctuation and literal formulas", async () => {
    const summary = "中文😀\t\n<&>=SUM(1,2)";
    const result = await buildRunBatchExportWorkbook({ ...input, rows: [{ ...row, summary }] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(result.buffer).buffer);
    expect(workbook.worksheets[0]!.getCell("C2").value).toBe(summary);
  });

  it("counts CRLF as one line break at Excel's exact limit", async () => {
    const summary = "line\r\n".repeat(253);
    const result = await buildRunBatchExportWorkbook({ ...input, rows: [{ ...row, summary }] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(result.buffer).buffer);
    expect(workbook.worksheets[0]!.getCell("C2").value).toBe("line\n".repeat(253));
  });

  it("splits analysis sheets before their hyperlinks exceed Excel's limit", async () => {
    const claim: FailureAnalysisClaim = {
      id: "analysis",
      projectId: "project",
      batchId: "batch",
      executionRunId: "run",
      caseDefinitionId: "case",
      attemptId: "attempt",
      caseName: row.displayName,
      className: row.casePath,
      attemptNumber: 1,
      failureSummary: row.summary!,
      status: "completed",
      category: "case_fixed",
      claimantId: "analyst",
      claimantUsername: "analyst",
      claimantDisplayName: "分析员",
      caseFixEvidence: "https://example.test/fix",
      claimedAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
    };
    const pages = (async function* () {
      for (let offset = 0; offset < 32_766; offset += 200) {
        yield {
          ...input,
          rows: Array.from({ length: Math.min(200, 32_766 - offset) }, () => row),
          shareLinks: new Map([["attempt", "https://example.test/CaseLog?ExecutionId=attempt"]]),
          analysisClaims: new Map([["attempt", claim]]),
        };
      }
    })();
    const result = await createRunBatchExportWorkbookStream(pages, new AbortController().signal);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    const archive = unzipSync(Buffer.concat(chunks));
    const sheets = Object.entries(archive).filter(([name]) =>
      /^xl\/worksheets\/sheet\d+\.xml$/u.test(name),
    );
    expect(sheets).toHaveLength(2);
    let rows = 0;
    for (const [, content] of sheets) {
      const xml = new TextDecoder().decode(content);
      expect((xml.match(/<hyperlink /gu) ?? []).length).toBeLessThanOrEqual(65_530);
      rows += (xml.match(/<row /gu) ?? []).length - 1;
      expect(xml).toContain("用例编号");
    }
    expect(rows).toBe(32_766);
  }, 120_000);
});
