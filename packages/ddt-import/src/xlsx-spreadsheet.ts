import { posix } from "node:path";
import {
  DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  DDT_IMPORT_TOTAL_BYTES,
  type DdtColumnResolution,
} from "@autoforge/contracts";
import { normalizeDdtStepName } from "@autoforge/domain";
import { openSpreadsheetZip, type SpreadsheetZip } from "./archive";
import { parseSpreadsheetSheets } from "./spreadsheet";
import { normalizeXlsxMatrix, readXlsxSheet, type XlsxCellFormats } from "./xlsx-sheet";
import { localXmlName, readXlsxXml, xlsxText } from "./xlsx-xml";

type Relationship = { path: string; type: string };

/** Read only DDT sheets, keeping XML inflation and cell parsing bounded by stream chunks. */
export async function parseXlsxSpreadsheet(
  content: Uint8Array,
  fileName: string,
  columnResolutions: readonly DdtColumnResolution[],
  options: { compactRows?: boolean } = {},
) {
  const startedAt = Date.now();
  const archive = openSpreadsheetZip(content, {
    maximumEntries: DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
    maximumExpandedBytes: DDT_IMPORT_TOTAL_BYTES,
  });
  const roots = archive.has("_rels/.rels")
    ? await readRelationships(archive, "_rels/.rels", "")
    : new Map<string, Relationship>();
  const workbookPath =
    [...roots.values()].find((entry) => entry.type.endsWith("/officeDocument"))?.path ??
    "xl/workbook.xml";
  const sheets: Array<{ name: string; relationshipId: string }> = [];
  let date1904 = false;
  await readXlsxXml(archive, workbookPath, {
    open(tag, name) {
      if (name === "workbookPr") date1904 = ["1", "true"].includes(tag.attributes.date1904 ?? "");
      if (name !== "sheet") return;
      const sheetName = xlsxText(tag.attributes.name ?? "");
      const relationshipId = Object.entries(tag.attributes).find(
        ([name]) => name.includes(":") && localXmlName(name) === "id",
      )?.[1];
      if (!sheetName || !relationshipId) throw new Error("Sheet 名称或关联标识缺失");
      if (sheets.some((sheet) => sheet.name === sheetName))
        throw new Error("XLSX 包含重复的 Sheet 名称");
      sheets.push({ name: sheetName, relationshipId });
    },
  });
  const relationships = await readRelationships(
    archive,
    posix.join(posix.dirname(workbookPath), "_rels", `${posix.basename(workbookPath)}.rels`),
    posix.dirname(workbookPath),
  );
  const part = (suffix: string) =>
    [...relationships.values()].find((entry) => entry.type.endsWith(suffix))?.path;
  const sharedStringsPath =
    part("/sharedStrings") ??
    (archive.has("xl/sharedStrings.xml") ? "xl/sharedStrings.xml" : undefined);
  const stylesPath =
    part("/styles") ?? (archive.has("xl/styles.xml") ? "xl/styles.xml" : undefined);
  const formats: XlsxCellFormats = {
    date1904,
    referencedStrings: new Set(),
    ...(await readStyles(archive, stylesPath)),
  };
  const matrices = new Map<string, unknown[][]>();
  const dataSheetName = sheets.find(
    (sheet) => sheet.name.trim().toLocaleLowerCase("en-US") === "data",
  )?.name;
  for (const sheet of sheets) {
    if (sheet.name !== dataSheetName && !normalizeDdtStepName(sheet.name)) continue;
    const relationship = relationships.get(sheet.relationshipId);
    if (!relationship?.type.endsWith("/worksheet"))
      throw new Error(`Sheet“${sheet.name}”的内部文件关联无效`);
    matrices.set(sheet.name, await readXlsxSheet(archive, relationship.path, formats));
  }
  if (formats.referencedStrings.size) {
    if (!sharedStringsPath) throw new Error("XLSX 缺少共享字符串文件");
    const sharedStrings = await readSharedStrings(
      archive,
      sharedStringsPath,
      formats.referencedStrings,
    );
    for (const index of formats.referencedStrings)
      if (!sharedStrings.has(index)) throw new Error("单元格引用了不存在的共享字符串");
    for (const matrix of matrices.values())
      for (const row of matrix)
        for (const key of Object.keys(row)) {
          const column = Number(key);
          const index = row[column];
          if (typeof index === "number") row[column] = sharedStrings.get(index)!;
        }
    sharedStrings.clear();
    formats.referencedStrings.clear();
  }
  return parseSpreadsheetSheets({
    fileName,
    sizeBytes: content.byteLength,
    sheetNames: sheets.map((sheet) => sheet.name),
    columnResolutions,
    startedAt,
    compactRows: options.compactRows ?? false,
    readMatrix(sheetName) {
      const matrix = matrices.get(sheetName);
      if (!matrix) throw new Error(`找不到 ${sheetName} Sheet`);
      matrices.delete(sheetName);
      return normalizeXlsxMatrix(matrix, options);
    },
  });
}

async function readRelationships(archive: SpreadsheetZip, path: string, directory: string) {
  const relationships = new Map<string, Relationship>();
  await readXlsxXml(archive, path, {
    open(tag, name) {
      if (name !== "Relationship" || tag.attributes.TargetMode === "External") return;
      const id = tag.attributes.Id;
      const target = tag.attributes.Target ? decodeURIComponent(tag.attributes.Target) : undefined;
      const type = tag.attributes.Type;
      if (!id || !target || !type || relationships.has(id)) throw new Error("XLSX 文件关联无效");
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.includes("\\") || /[?#]/.test(target))
        throw new Error("XLSX 内部关联地址无效");
      const resolved = posix.normalize(
        target.startsWith("/") ? target.slice(1) : posix.join(directory, target),
      );
      if (resolved.startsWith("../") || resolved === "..")
        throw new Error("XLSX 内部关联超出文件范围");
      relationships.set(id, { path: resolved, type });
    },
  });
  return relationships;
}

async function readSharedStrings(
  archive: SpreadsheetZip,
  path: string,
  referenced: ReadonlySet<number>,
) {
  const values = new Map<number, string>();
  let value = "";
  let index = 0;
  let inItem = false;
  let inText = false;
  let phoneticDepth = 0;
  await readXlsxXml(archive, path, {
    open(_tag, name) {
      if (name === "si") {
        inItem = referenced.has(index);
        value = "";
      }
      if (name === "rPh") phoneticDepth++;
      if (name === "t" && inItem && !phoneticDepth) inText = true;
    },
    text(text) {
      if (inText) value += text;
    },
    close(name) {
      if (name === "t") inText = false;
      if (name === "rPh") phoneticDepth--;
      if (name === "si") {
        if (inItem) values.set(index, xlsxText(value));
        index++;
        inItem = false;
      }
    },
  });
  return values;
}

async function readStyles(archive: SpreadsheetZip, path: string | undefined) {
  const formats = new Map<number, string>();
  const styleFormats: number[] = [];
  let inCellFormats = false;
  if (path)
    await readXlsxXml(archive, path, {
      open(tag, name) {
        if (name === "cellXfs") inCellFormats = true;
        if (name === "numFmt")
          formats.set(
            Number(tag.attributes.numFmtId),
            xlsxText(tag.attributes.formatCode ?? "General"),
          );
        if (name === "xf" && inCellFormats) styleFormats.push(Number(tag.attributes.numFmtId ?? 0));
      },
      close(name) {
        if (name === "cellXfs") inCellFormats = false;
      },
    });
  return { formats, styleFormats };
}
