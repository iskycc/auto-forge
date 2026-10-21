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
