import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DdtCaseData } from "@autoforge/domain";
import { buildExportWorkbook, parseSpreadsheet } from "@autoforge/ddt-import";
vi.mock("server-only", () => ({}));
import { prepareDdtExportFile } from "./ddt-export-file";

async function* pages(rows: DdtCaseData[]) {
  for (const row of rows) yield [row];
}

describe("paged DDT export", () => {
  it("writes only populated cells when a full-scope export merges different SR field schemas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-sparse-"));
    const fields = Array.from({ length: 128 }, (_, index) => `SR_${index}_参数`);
    const rows: DdtCaseData[] = Array.from({ length: 128 }, (_, index) => ({
      CaseID: `CASE-${index}`,
      srNum: `SR-${index}`,
      ...Object.fromEntries(
        fields.map((name, column) => [name, column === index ? `原值-${index}` : ""]),
      ),
    }));
    try {
      const prepared = await prepareDdtExportFile(
        pages(rows),
        new AbortController().signal,
        directory,
      );
      try {
        const bytes = Buffer.alloc(prepared.sizeBytes);
        await prepared.file.read(bytes, 0, bytes.length, 0);
        const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
        const actualFields = rows.reduce(
          (count, row) =>
            count + Object.values(row).filter((value) => value !== "" && value !== null).length,
          0,
        );
        const headerFields = 130;
        expect([...sheet.matchAll(/<c\s/g)]).toHaveLength(actualFields + headerFields);
        expect(parseSpreadsheet(bytes, "sparse.xlsx").rows).toEqual(
          parseSpreadsheet(buildExportWorkbook(rows), "legacy.xlsx").rows,
        );
      } finally {
        await prepared.file.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exports twenty thousand heterogeneous ordinary cases without a dense cell matrix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-schema-scale-"));
    const rowCount = 20_000;
    const schemaCount = 512;
    async function* source() {
      for (let start = 0; start < rowCount; start += 64) {
        yield Array.from({ length: Math.min(64, rowCount - start) }, (_, offset) => {
          const index = start + offset,
            schema = index % schemaCount;
          return {
            CaseID: `CASE-${index}`,
            srNum: `SR-${schema}`,
            [`参数_${schema}`]: `值-${index}`,
            [`结果_${schema}`]: index % 2 === 0,
          };
        });
      }
    }
    try {
      const prepared = await prepareDdtExportFile(
        source(),
        new AbortController().signal,
        directory,
      );
      try {
        const bytes = Buffer.alloc(prepared.sizeBytes);
        await prepared.file.read(bytes, 0, bytes.length, 0);
        const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
        expect([...sheet.matchAll(/<row\s/g)]).toHaveLength(rowCount + 1);
        expect([...sheet.matchAll(/<c\s/g)]).toHaveLength(rowCount * 4 + schemaCount * 2 + 2);
        const reader = new ExcelJS.Workbook();
        // The document reader decodes complete XML strings, avoiding the stream
        // reader's stateless UTF-8 decoder splitting Chinese characters at ZIP chunks.
        const load = reader.xlsx.load.bind(reader.xlsx) as unknown as (
          bytes: Uint8Array,
        ) => Promise<ExcelJS.Workbook>;
        await load(bytes);
        const seenCaseIds = new Set<string>();
        let exportedCount = 0;
        let sheetCount = 0;
        for (const worksheet of reader.worksheets) {
          sheetCount++;
          const columns = new Map<number, string>();
          for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            if (row.number === 1) {
              row.eachCell((cell, column) => columns.set(column, String(cell.value)));
              expect(columns.size).toBe(schemaCount * 2 + 2);
              continue;
            }
            const index = exportedCount++;
            const schema = index % schemaCount;
            const actual: Record<string, ExcelJS.CellValue> = {};
            row.eachCell((cell, column) => {
              const name = columns.get(column);
              expect(name).toBeDefined();
              actual[name!] = cell.value;
            });
            expect(actual).toEqual({
              CaseID: `CASE-${index}`,
              srNum: `SR-${schema}`,
              [`参数_${schema}`]: `值-${index}`,
              [`结果_${schema}`]: index % 2 === 0,
            });
            seenCaseIds.add(String(actual.CaseID));
          }
        }
        expect(sheetCount).toBe(1);
        expect(exportedCount).toBe(rowCount);
        expect(seenCaseIds.size).toBe(rowCount);
      } finally {
        await prepared.file.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects invalid data on a later page without returning a partial workbook", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-invalid-page-"));
    async function* source() {
      yield Array.from({ length: 64 }, (_, index) => ({ CaseID: `OK-${index}`, srNum: "SR" }));
      yield [{ CaseID: "中文-错误用例", srNum: "SR", 问题字段: "bad\u0000value" }];
    }
    try {
      await expect(
        prepareDdtExportFile(source(), new AbortController().signal, directory),
      ).rejects.toMatchObject({
        code: "EXPORT_DATA_INVALID",
        message: expect.stringContaining("中文-错误用例，字段 问题字段"),
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles cancellation when the XLSX writer starts finalizing its ZIP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-commit-cancel-"));
    const controller = new AbortController();
    const commit = ExcelJS.stream.xlsx.WorkbookWriter.prototype.commit;
    const interruption = vi
      .spyOn(ExcelJS.stream.xlsx.WorkbookWriter.prototype, "commit")
      .mockImplementation(function (this: ExcelJS.stream.xlsx.WorkbookWriter) {
        controller.abort(new Error("cancel ZIP commit"));
        return commit.call(this);
      });
    try {
      await expect(
        prepareDdtExportFile(
          pages([{ CaseID: "ordinary", srNum: "Wallet" }]),
          controller.signal,
          directory,
        ),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      interruption.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  }, 5_000);

  it("finishes a few ordinary cases whose long cells exceed snapshot and download buffer sizes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-long-cells-"));
    const rows: DdtCaseData[] = Array.from({ length: 3 }, (_, index) => ({
      CaseID: `中文-00${index}`,
      srNum: "Wallet",
      多字节边界: "钱包".repeat(16_000),
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, column) => [
          `字段${column}`,
          randomBytes(18_000).toString("base64"),
        ]),
      ),
    }));
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error("DDT export failed to finish")),
      10_000,
    );
    try {
      const prepared = await prepareDdtExportFile(pages(rows), controller.signal, directory);
      try {
        expect(prepared.sizeBytes).toBeGreaterThan(256 * 1024);
        const bytes = Buffer.alloc(prepared.sizeBytes);
        await prepared.file.read(bytes, 0, bytes.length, 0);
        expect(parseSpreadsheet(bytes, "long-cells.xlsx").rows).toEqual(rows);
      } finally {
        await prepared.file.close();
      }
    } finally {
      clearTimeout(deadline);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("plans aliases across pages and preserves all standard and missing journey step values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-"));
    const rows: DdtCaseData[] = [
      {
        CaseID: "普通-001",
        srNum: "SR",
        CaseName: " first ",
        owner: "A",
        enabled: false,
        number: 0,
      },
      {
        CaseID: "普通-002",
        srNum: "SR",
        casename: "second",
        owner: "C",
        Owner: "D",
        "Owner (2)": "reserved",
      },
      {
        CaseID: "旅程-001",
        srNum: "SR",
        用户旅程: { step1: { CaseID: "旅程-001", srNum: "SR", action: "create" } },
      },
      {
        CaseID: "旅程-002",
        srNum: "SR",
        用户旅程: {
          step1: { CaseID: "旅程-002", srNum: "SR", Action: "cancel" },
          step2: { CaseID: "旅程-002", srNum: "SR", result: "=1+1" },
        },
      },
    ];
    try {
      const prepared = await prepareDdtExportFile(
        pages(rows),
        new AbortController().signal,
        directory,
      );
      try {
        const bytes = Buffer.alloc(prepared.sizeBytes);
        await prepared.file.read(bytes, 0, bytes.length, 0);
        expect(parseSpreadsheet(bytes, "paged.xlsx").rows).toEqual(
          parseSpreadsheet(buildExportWorkbook(rows), "legacy.xlsx").rows,
        );
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await prepared.file.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects empty or invalid data and cancels without leaving files or dropping rows silently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-"));
    try {
      const signal = new AbortController().signal;
      await expect(prepareDdtExportFile(pages([]), signal, directory)).rejects.toThrow(
        "没有符合条件",
      );
      await expect(
        prepareDdtExportFile(
          pages([{ CaseID: "错误用例", srNum: "SR", text: "bad\u0000value" }]),
          signal,
          directory,
        ),
      ).rejects.toMatchObject({
        code: "EXPORT_DATA_INVALID",
        message: expect.stringContaining("错误用例"),
      });
      const controller = new AbortController();
      async function* cancelledPages() {
        yield [{ CaseID: "kept", srNum: "SR" }];
        controller.abort();
        yield [{ CaseID: "cancelled", srNum: "SR" }];
      }
      await expect(
        prepareDdtExportFile(cancelledPages(), controller.signal, directory),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels during XLSX writing and closes both temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-"));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function* source() {
      for (let page = 0; page < 40; page++)
        yield Array.from({ length: 64 }, (_, index) => ({
          CaseID: `CASE-${page * 64 + index}`,
          srNum: "SR",
        }));
      timer = setTimeout(() => controller.abort(), 10);
    }
    try {
      await expect(prepareDdtExportFile(source(), controller.signal, directory)).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("consumes every page once and yields while generating a large workbook", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-"));
    let pageReads = 0;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    async function* largePages() {
      for (let page = 0; page < 160; page++) {
        pageReads++;
        yield Array.from({ length: 64 }, (_, index) => ({
          CaseID: `CASE-${page * 64 + index}`,
          srNum: "SR",
          text: "原值",
        }));
      }
    }
    try {
      const prepared = await prepareDdtExportFile(
        largePages(),
        new AbortController().signal,
        directory,
      );
      try {
        const bytes = Buffer.alloc(prepared.sizeBytes);
        await prepared.file.read(bytes, 0, bytes.length, 0);
        expect(parseSpreadsheet(bytes, "large.xlsx").rows).toHaveLength(10_240);
        expect(pageReads).toBe(160);
        expect(ticks).toBeGreaterThan(10);
      } finally {
        await prepared.file.close();
      }
    } finally {
      clearInterval(timer);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
