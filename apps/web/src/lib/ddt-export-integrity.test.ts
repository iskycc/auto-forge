import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import type { DdtCaseData } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
import { prepareDdtExportFile } from "./ddt-export-file";
import { buildStyledDdtExportWorkbook } from "./ddt-export-xlsx";

async function exportPagedWorkbook(rows: DdtCaseData[]): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "ddt-export-integrity-"));
  async function* source() {
    for (let start = 0; start < rows.length; start += 64) yield rows.slice(start, start + 64);
  }
  try {
    const prepared = await prepareDdtExportFile(source(), new AbortController().signal, directory);
    try {
      const bytes = Buffer.alloc(prepared.sizeBytes);
      await prepared.file.read(bytes, 0, bytes.length, 0);
      return bytes;
    } finally {
      await prepared.file.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readWorkbook(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const load = workbook.xlsx.load.bind(workbook.xlsx) as unknown as (
    bytes: Uint8Array,
  ) => Promise<ExcelJS.Workbook>;
  await load(bytes);
  return workbook;
}

function headers(sheet: ExcelJS.Worksheet): string[] {
  const names: string[] = [];
  sheet.getRow(1).eachCell((cell) => names.push(String(cell.value)));
  return names;
}

function populatedValues(sheet: ExcelJS.Worksheet, rowNumber: number) {
  const cells: Record<string, ExcelJS.CellValue> = {};
  sheet.getRow(rowNumber).eachCell((cell, column) => {
    cells[String(sheet.getRow(1).getCell(column).value)] = cell.value;
  });
  return cells;
}

for (const [writer, write] of [
  ["paged file", exportPagedWorkbook],
  ["in-memory workbook", buildStyledDdtExportWorkbook],
] as const) {
  describe(`${writer} DDT data integrity with an independent Excel reader`, () => {
    it("preserves every typed value across page boundaries and keeps blank-only columns", async () => {
      const values = {
        srNum: "钱包-SR",
        zero: 0,
        negative: -12.375,
        enabled: false,
        required: true,
        numericText: "000123456789012345678901234567890",
        whitespace: " \t前后空格\n ",
        onlySpaces: "   ",
        unicode: "中文钱包🙂𠮷",
        xml: '<tag key="value">&\'正文</tag>',
        literalFormula: '=HYPERLINK("https://example.invalid","text")',
        longText: "钱包🙂".repeat(8_000),
      };
      const rows: DdtCaseData[] = Array.from({ length: 65 }, (_, index) => ({
        CaseID: `000${index}`,
        ...values,
        empty: "",
        nullable: null,
        ...(index === 64 ? { lastPageOnly: "最后一页字段" } : {}),
      }));
      const workbook = await readWorkbook(await write(rows));
      const sheet = workbook.getWorksheet("data")!;
      expect(headers(sheet)).toEqual([
        "CaseID",
        ...Object.keys(values),
        "empty",
        "nullable",
        "lastPageOnly",
      ]);
      expect(sheet.actualRowCount).toBe(66);
      for (let index = 0; index < rows.length; index++) {
        expect(populatedValues(sheet, index + 2)).toEqual({
          CaseID: `000${index}`,
          ...values,
          ...(index === 64 ? { lastPageOnly: "最后一页字段" } : {}),
        });
      }
    });

    it("merges equal aliases but preserves conflicting values without colliding with existing suffixes", async () => {
      const workbook = await readWorkbook(
        await write([
          {
            CaseID: "中文-001",
            srNum: "SR",
            CaseName: "同值",
            " casename ": "同值",
            owner: "Alice",
            Owner: "Bob",
            Owner_2: "原有带后缀列",
            blankOnly: "",
          },
          { CaseID: "中文-002", srNum: "SR", casename: "另一用例", Owner: "Carol" },
        ]),
      );
      const sheet = workbook.getWorksheet("data")!;
      expect(headers(sheet)).toEqual([
        "CaseID",
        "srNum",
        "CaseName",
        "owner",
        "Owner_2",
        "blankOnly",
        "Owner_3",
      ]);
      expect(populatedValues(sheet, 2)).toEqual({
        CaseID: "中文-001",
        srNum: "SR",
        CaseName: "同值",
        owner: "Alice",
        Owner_2: "原有带后缀列",
        Owner_3: "Bob",
      });
      expect(populatedValues(sheet, 3)).toEqual({
        CaseID: "中文-002",
        srNum: "SR",
        CaseName: "另一用例",
        Owner_3: "Carol",
      });
    });

    it("preserves mixed ordinary and journey cases, including false, zero and missing steps", async () => {
      const workbook = await readWorkbook(
        await write([
          { CaseID: "普通", srNum: "SR", text: "原始普通用例" },
          {
            CaseID: "旅程一",
            srNum: "SR",
            用户旅程: {
              step1: { CaseID: "旅程一", srNum: "SR", action: "创建" },
              step3: { CaseID: "旅程一", srNum: "SR", enabled: false, count: 0 },
            },
          },
          {
            CaseID: "旅程二",
            srNum: "SR",
            用户旅程: { step1: { CaseID: "旅程二", srNum: "SR", action: "取消" } },
          },
        ]),
      );
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["data", "step1", "step3"]);
      expect(populatedValues(workbook.getWorksheet("data")!, 2)).toEqual({
        CaseID: "普通",
        srNum: "SR",
        text: "原始普通用例",
      });
      const step1 = workbook.getWorksheet("step1")!;
      expect(step1.actualRowCount).toBe(3);
      for (const [index, [CaseID, action]] of [
        ["旅程一", "创建"],
        ["旅程二", "取消"],
      ].entries()) {
        expect(populatedValues(step1, index + 2)).toEqual({ CaseID, srNum: "SR", action });
      }
      const step3 = workbook.getWorksheet("step3")!;
      expect(step3.actualRowCount).toBe(3);
      expect(populatedValues(step3, 2)).toEqual({
        CaseID: "旅程一",
        srNum: "SR",
        enabled: false,
        count: 0,
        __DDT_INSIGHT_STEP_PRESENT__: true,
      });
      expect(populatedValues(step3, 3)).toEqual({
        CaseID: "旅程二",
        srNum: "SR",
        __DDT_INSIGHT_STEP_PRESENT__: false,
      });
      expect(step3.getColumn(5).hidden).toBe(true);
    });
  });
}
