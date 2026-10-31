import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { parseDdtAssociationSpreadsheet } from "@autoforge/ddt-import";
import type { DdtAssociationSection } from "@autoforge/contracts";
import { prepareDdtAssociationExport } from "./ddt-association-export";
vi.mock("server-only", () => ({}));
const records: Record<DdtAssociationSection, string[][]> = {
  range: [["com.example.Wallet", ""]],
  categories: [["钱包", "com.example.Wallet", ""]],
  srCategories: [
    ["0007", "钱包", ""],
    ["清除", "", ""],
  ],
  srClasses: [["OTHER", "com.example.Wallet", ""]],
};
describe("portable SR association Excel export", () => {
  it("creates an ExcelJS-readable multi-sheet workbook and roundtrips every configuration row", async () => {
    const directory = await mkdtemp(join(tmpdir(), "association-export-"));
    try {
      const prepared = await prepareDdtAssociationExport(
        async function* (section) {
          for (const values of records[section])
            yield { section, rows: [{ values, revisionIdentity: "1" }] };
        },
        directory,
        new AbortController().signal,
      );
      let bytes: Buffer;
      try {
        bytes = Buffer.alloc(prepared.sizeBytes);
        await prepared.file.read(bytes, 0, bytes.length, 0);
      } finally {
        await prepared.file.close();
      }
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
        "候选测试类",
        "分类执行类",
        "SR需求分类",
        "SR直接关联",
        "说明",
      ]);
      expect(workbook.getWorksheet("SR需求分类")!.getCell("A2").value).toBe("0007");
      const result = await parseDdtAssociationSpreadsheet(bytes, "config.xlsx");
      expect(result.issueCount).toBe(0);
      expect(result.rows).toHaveLength(5);
      expect(result.rows).toMatchObject([
        { section: "range", className: "com.example.Wallet" },
        { section: "categories", categoryName: "钱包" },
        { section: "srCategories", srNum: "0007", categoryName: "钱包" },
        { section: "srCategories", srNum: "清除", categoryName: "" },
        { section: "srClasses", srNum: "OTHER" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects changes during export and invalid XML without offering a partial file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "association-conflict-"));
    try {
      let generation = 0;
      await expect(
        prepareDdtAssociationExport(
          async function* (section) {
            yield {
              section,
              rows:
                section === "range"
                  ? [{ values: ["com.Example", ""], revisionIdentity: String(++generation) }]
                  : [],
            };
          },
          directory,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "DDT_ASSOCIATION_EXPORT_CONFLICT" });
      await expect(
        prepareDdtAssociationExport(
          async function* (section) {
            yield { section, rows: [{ values: ["bad\u0000"], revisionIdentity: "1" }] };
          },
          directory,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "EXPORT_DATA_INVALID" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
