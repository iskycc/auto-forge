import { parseCasePathCells, parseCasePathColumn } from "./case-path-import";

export const MAX_CASE_PATH_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_CASE_PATH_ROWS = 100_001;

type CasePathFile = {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

const TEXT_EXTENSIONS = new Set(["csv", "tsv", "txt"]);
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function parseCasePathFile(file: CasePathFile): Promise<string[]> {
  validateFileSize(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("所选文件为空，请重新选择。");

  const extension = fileExtension(file.name);
  if (extension === "xls") {
    throw new Error("暂不支持旧版 .xls，请另存为 .xlsx 后重新导入。");
  }
  if (extension === "xlsx" || file.type === XLSX_MEDIA_TYPE || hasZipSignature(bytes)) {
    return parseXlsxFirstColumn(bytes);
  }
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw new Error("仅支持 .xlsx、.csv、.tsv 或 .txt 用例列表。");
  }
  return parseCasePathColumn(decodeText(bytes));
}

function validateFileSize(file: CasePathFile): void {
  if (file.size > MAX_CASE_PATH_FILE_BYTES) {
    throw new Error(`用例列表不能超过 ${MAX_CASE_PATH_FILE_BYTES / 1024 / 1024} MiB。`);
  }
}

async function parseXlsxFirstColumn(bytes: Uint8Array): Promise<string[]> {
  try {
    // ExcelJS 只在用户实际选择 XLSX 时进入独立客户端分包，避免增加用例页首屏体积。
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    // ExcelJS 的声明仍写作 Node Buffer，但浏览器实现底层 JSZip 原生接受 Uint8Array。
    const loadXlsx = workbook.xlsx.load.bind(workbook.xlsx) as unknown as (
      content: Uint8Array,
    ) => Promise<unknown>;
    await loadXlsx(bytes);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("工作簿不包含工作表。");
    if (worksheet.rowCount > MAX_CASE_PATH_ROWS) {
      throw new Error(`首个工作表不能超过 ${MAX_CASE_PATH_ROWS.toLocaleString()} 行。`);
    }
    const cells: string[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      cells.push(row.getCell(1).text);
    });
    return parseCasePathCells(cells);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("不能超过")) throw cause;
    throw new Error("无法读取 XLSX，请确认文件未加密、未损坏，并将用例路径放在首列。", {
      cause,
    });
  }
}

function decodeText(bytes: Uint8Array): string {
  if (hasPrefix(bytes, [0xef, 0xbb, 0xbf])) return new TextDecoder("utf-8").decode(bytes);
  if (hasPrefix(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes);
  if (hasPrefix(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      // Windows 中文环境导出的 CSV 通常是 GBK；GB18030 与其向后兼容。
      return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new Error("无法识别文本文件编码，请使用 UTF-8、UTF-16 或 GB18030。", { cause });
    }
  }
}

function fileExtension(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator === -1 ? "" : name.slice(separator + 1).toLowerCase();
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return (
    hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08])
  );
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}
