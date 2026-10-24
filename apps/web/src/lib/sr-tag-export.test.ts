import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { parseSrTagSpreadsheet } from "@autoforge/ddt-import";
import { prepareSrTagExport } from "./sr-tag-export";
vi.mock("server-only", () => ({}));
async function fixture(pages: Array<Array<{ srNum: string; tagName: string }>>) {
  const directory = await mkdtemp(join(tmpdir(), "sr-tag-export-"));
  const prepared = await prepareSrTagExport(
    (async function* () {
      for (const page of pages) yield page;
    })(),
    directory,
    new AbortController().signal,
  );
  const bytes = Buffer.alloc(prepared.sizeBytes);
  await prepared.file.read(bytes, 0, bytes.length, 0);
  return {
    bytes,
    close: async () => {
      await prepared.file.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
describe("SR label classification Excel", () => {
  it("writes exactly two headers, preserves repeated SRs and literal strings, and can be imported again", async () => {
    const rows = [
      { srNum: "0007", tagName: "Wallet" },
      { srNum: "0007", tagName: "=SUM(1,2)" },
      { srNum: "其他SR", tagName: "Wallet" },
    ];
    const f = await fixture([rows.slice(0, 2), rows.slice(2)]);
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Uint8Array.from(f.bytes).buffer);
      const sheet = workbook.worksheets[0]!;
      expect(sheet.getRow(1).values).toEqual([undefined, "SR", "标签"]);
      expect(sheet.columnCount).toBe(2);
      expect(sheet.getCell("A2").value).toBe("0007");
      expect(sheet.getCell("B3").type).toBe(ExcelJS.ValueType.String);
      expect(sheet.getColumn(1).width).not.toBe(sheet.getColumn(2).width);
      const parsed = parseSrTagSpreadsheet(f.bytes, "labels.xlsx");
      expect(parsed.issueCount).toBe(0);
      expect(parsed.rows.map(({ srNum, tagName }) => ({ srNum, tagName }))).toEqual(rows);
    } finally {
      await f.close();
    }
  });
  it("produces a usable header-only template when no classifications exist", async () => {
    const f = await fixture([[]]);
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Uint8Array.from(f.bytes).buffer);
      expect(workbook.worksheets[0]!.rowCount).toBe(1);
      expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, "SR", "标签"]);
    } finally {
      await f.close();
    }
  });
  it("rejects incompatible XML values before offering a workbook and handles cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-tag-export-invalid-"));
    try {
      await expect(
        prepareSrTagExport(
          (async function* () {
            yield [{ srNum: "SR", tagName: "bad\u0000" }];
          })(),
          directory,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "EXPORT_DATA_INVALID" });
      const controller = new AbortController();
      controller.abort();
      await expect(
        prepareSrTagExport(
          (async function* () {
            yield [];
          })(),
          directory,
          controller.signal,
        ),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
