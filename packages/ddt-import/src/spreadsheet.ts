import * as XLSX from "xlsx";
import {
  DDT_IMPORT_COLUMN_RESOLUTION_LIMIT,
  type DdtColumnResolution,
  type DdtImportColumnConflict,
} from "@autoforge/contracts";
import {
  createDdtJourney as createJourneyCase,
  ddtCaseCell as getCaseCell,
  ddtJourneySteps as getJourneySteps,
  ddtStepNames,
  isDdtJourney as isJourneyCase,
  normalizeDdtStepName as normalizeStepName,
  type DdtCaseData as CaseData,
  type DdtCaseStep as CaseStepData,
  type DdtCellValue as CellValue,
} from "@autoforge/domain";

const SUPPORTED_EXTENSIONS = new Set(["xlsx", "xls", "xlsb", "csv", "ods"]);
const EXPORTED_STEP_PRESENT_COLUMN = "__DDT_INSIGHT_STEP_PRESENT__";
const COLUMN_SAMPLE_LIMIT = 8;
const COLUMN_SAMPLE_VALUE_LENGTH = 256;
const utf8CsvDecoder = new TextDecoder("utf-8", { fatal: true });
const utf16LeCsvDecoder = new TextDecoder("utf-16le", { fatal: true });
const utf16BeCsvDecoder = new TextDecoder("utf-16be", { fatal: true });
const gb18030CsvDecoder = new TextDecoder("gb18030", { fatal: true });
const windows1252CsvDecoder = new TextDecoder("windows-1252");

export interface ParsedSpreadsheet {
  fileName: string;
  sizeBytes: number;
  columns: string[];
  rows: CaseData[];
  startedAt: number;
}

export class DdtDuplicateColumnsError extends Error {
  readonly code = "DDT_DUPLICATE_COLUMNS";

  constructor(
    readonly fileName: string,
    readonly conflicts: DdtImportColumnConflict[],
  ) {
    const locations = conflicts.map(
      (conflict) =>
        `${conflict.sheetName} Sheet 的“${conflict.columns[0]?.currentName ?? conflict.normalizedName}”`,
    );
    super(`存在重复列名：${locations.join("、")}，请人工确认列名后重试`);
    this.name = "DdtDuplicateColumnsError";
  }
}

function extensionOf(fileName: string) {
  const extension = fileName.split(".").pop()?.toLocaleLowerCase("en-US");
  return extension ?? "";
}

export function isSupportedSpreadsheetFile(fileName: string) {
  return SUPPORTED_EXTENSIONS.has(extensionOf(fileName));
}

function decodeCsvBuffer(buffer: Buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return utf16LeCsvDecoder.decode(buffer);
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return utf16BeCsvDecoder.decode(buffer);
  }
  const sampleLength = Math.min(buffer.byteLength, 1024) & ~1;
  if (sampleLength >= 8) {
    let evenNulls = 0;
    let oddNulls = 0;
    for (let index = 0; index < sampleLength; index += 2) {
      if (buffer[index] === 0) evenNulls += 1;
      if (buffer[index + 1] === 0) oddNulls += 1;
    }
    const pairs = sampleLength / 2;
    if (oddNulls >= 4 && oddNulls / pairs >= 0.2 && oddNulls >= Math.max(1, evenNulls) * 4) {
      return utf16LeCsvDecoder.decode(buffer);
    }
    if (evenNulls >= 4 && evenNulls / pairs >= 0.2 && evenNulls >= Math.max(1, oddNulls) * 4) {
      return utf16BeCsvDecoder.decode(buffer);
    }
  }
  try {
    return utf8CsvDecoder.decode(buffer);
  } catch {
    // Excel on Chinese Windows commonly writes CSV as GBK/CP936 without a
    // BOM. Prefer it when decoding produces CJK text, then retain a Western
    // single-byte fallback for legacy CSV files from other locales.
  }
  try {
    const decoded = gb18030CsvDecoder.decode(buffer);
    const cjkCharacters =
      decoded.match(/\p{Script=Han}|[\u3000-\u30ff\uff00-\uffef]/gu)?.length ?? 0;
    if (cjkCharacters >= 2) {
      return decoded;
    }
  } catch {
    // Fall through to the always-defined Windows-1252 decoder.
  }
  return windows1252CsvDecoder.decode(buffer);
}

function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

interface ParsedSheet {
  name: string;
  columns: string[];
  rows: CaseStepData[];
}

function duplicateColumnConflicts(
  sheetName: string,
  originalColumns: readonly string[],
  columns: readonly (string | undefined)[],
  matrix: readonly unknown[][],
): DdtImportColumnConflict[] {
  const indexesByName = new Map<string, number[]>();
  columns.forEach((column, columnIndex) => {
    if (column === undefined) return;
    const normalized = column.toLocaleLowerCase("en-US");
    indexesByName.set(normalized, [...(indexesByName.get(normalized) ?? []), columnIndex]);
  });
  const duplicateIndexes = new Set(
    [...indexesByName.values()].filter((indexes) => indexes.length > 1).flat(),
  );
  const usedNames = new Set(
    columns
      .filter(
        (column, columnIndex): column is string =>
          column !== undefined && !duplicateIndexes.has(columnIndex),
      )
      .map((column) => column.toLocaleLowerCase("en-US")),
  );

  return [...indexesByName.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([normalizedName, indexes]) => ({
      sheetName,
      normalizedName: normalizedName.slice(0, 256),
      columns: indexes.map((columnIndex, occurrenceIndex) => {
        const currentName = columns[columnIndex]!;
        const suggestedName = availableColumnName(currentName, occurrenceIndex + 1, usedNames);
        usedNames.add(suggestedName.toLocaleLowerCase("en-US"));
        return {
          columnIndex,
          originalName: originalColumns[columnIndex]!,
          currentName,
          suggestedName,
          ...columnContentSummary(matrix, columnIndex),
        };
      }),
    }));
}

function columnContentSummary(
  matrix: readonly unknown[][],
  columnIndex: number,
): Pick<DdtImportColumnConflict["columns"][number], "nonEmptyCount" | "sampleValues"> {
  let nonEmptyCount = 0;
  const sampleValues: Array<{ rowNumber: number; value: string }> = [];
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const value = String(matrix[rowIndex]?.[columnIndex] ?? "").trim();
    if (!value) continue;
    nonEmptyCount += 1;
    if (sampleValues.length < COLUMN_SAMPLE_LIMIT) {
      sampleValues.push({
        rowNumber: rowIndex + 1,
        value: value.replace(/\s+/gu, " ").slice(0, COLUMN_SAMPLE_VALUE_LENGTH),
      });
    }
  }
  return { nonEmptyCount, sampleValues };
}

export function assertResolvableColumnConflictLimit(
  conflicts: readonly DdtImportColumnConflict[],
  location: string,
): void {
  const conflictColumnCount = conflicts.reduce(
    (total, conflict) => total + conflict.columns.length,
    0,
  );
  if (conflictColumnCount > DDT_IMPORT_COLUMN_RESOLUTION_LIMIT) {
    throw new Error(
      `${location}中的重复列超过 ${DDT_IMPORT_COLUMN_RESOLUTION_LIMIT} 列，请先在表格中整理列名`,
    );
  }
}

function availableColumnName(baseName: string, occurrence: number, usedNames: Set<string>): string {
  let suffix = occurrence;
  let candidate = occurrence === 1 ? baseName : columnNameWithSuffix(baseName, occurrence);
  while (usedNames.has(candidate.toLocaleLowerCase("en-US"))) {
    suffix += 1;
    candidate = columnNameWithSuffix(baseName, suffix);
  }
  return candidate;
}

function columnNameWithSuffix(baseName: string, suffix: number): string {
  const ending = `_${suffix}`;
  return `${baseName.slice(0, 256 - ending.length)}${ending}`;
}

function parseCaseSheet(
  workbook: XLSX.WorkBook,
  sheetName: string,
  fileName: string,
  columnResolutions: readonly DdtColumnResolution[],
): ParsedSheet {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`找不到 ${sheetName} Sheet`);
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: false,
  });

  if (matrix.length < 2) {
    throw new Error(`${sheetName} Sheet 中没有可导入的用例数据`);
  }

  const originalColumns = matrix[0]!.map((cell) => String(cell ?? "").trim());
  const emptyHeaderIndex = originalColumns.findIndex((column) => !column);
  if (emptyHeaderIndex >= 0) {
    throw new Error(`${sheetName} Sheet 第 ${emptyHeaderIndex + 1} 列缺少列名`);
  }
  const longHeaderIndex = originalColumns.findIndex((column) => column.length > 256);
  if (longHeaderIndex >= 0) {
    throw new Error(`${sheetName} Sheet 第 ${longHeaderIndex + 1} 列的列名超过 256 个字符`);
  }

  const resolutions = columnResolutions.filter((resolution) => resolution.sheetName === sheetName);
  const resolutionByIndex = new Map<number, { deleteColumn: boolean; resolvedName: string }>();
  for (const resolution of resolutions) {
    if (resolution.columnIndex >= originalColumns.length) {
      throw new Error(
        `${sheetName} Sheet 不存在第 ${resolution.columnIndex + 1} 列，无法应用列名冲突处理结果`,
      );
    }
    const resolvedName = resolution.resolvedName.trim();
    if (!resolvedName || resolvedName.length > 256) {
      throw new Error(`${sheetName} Sheet 第 ${resolution.columnIndex + 1} 列的新列名无效`);
    }
    if (resolutionByIndex.has(resolution.columnIndex)) {
      throw new Error(`${sheetName} Sheet 第 ${resolution.columnIndex + 1} 列存在重复处理结果`);
    }
    resolutionByIndex.set(resolution.columnIndex, {
      deleteColumn: resolution.deleteColumn === true,
      resolvedName,
    });
  }
  const columns = originalColumns.map((column, columnIndex) => {
    const resolution = resolutionByIndex.get(columnIndex);
    if (resolution?.deleteColumn) return undefined;
    return resolution?.resolvedName ?? column;
  });
  const removedConflictName = fullyRemovedDuplicateColumnName(originalColumns, columns);
  if (removedConflictName) {
    throw new Error(`${sheetName} Sheet 的重复列“${removedConflictName}”至少需要保留一列`);
  }
  const conflicts = duplicateColumnConflicts(sheetName, originalColumns, columns, matrix);
  if (conflicts.length) {
    assertResolvableColumnConflictLimit(conflicts, `${sheetName} Sheet `);
    throw new DdtDuplicateColumnsError(fileName, conflicts);
  }

  const caseIdIndex = columns.findIndex((column) => column === "CaseID");
  const srNumIndex = columns.findIndex((column) => column === "srNum");
  if (caseIdIndex < 0) {
    throw new Error(`${sheetName} Sheet 缺少必需列 CaseID`);
  }
  if (srNumIndex < 0) {
    throw new Error(`${sheetName} Sheet 缺少必需列 srNum`);
  }

  const rows: CaseStepData[] = [];
  const seenCaseIds = new Set<string>();
  for (let index = 1; index < matrix.length; index += 1) {
    const sourceRow = matrix[index]!;
    if (sourceRow.every((value) => String(value ?? "").trim() === "")) {
      continue;
    }

    const caseId = String(sourceRow[caseIdIndex] ?? "").trim();
    const srNum = String(sourceRow[srNumIndex] ?? "").trim();
    const sheetRow = index + 1;
    if (!caseId) {
      throw new Error(`${sheetName} Sheet 第 ${sheetRow} 行的 CaseID 为空`);
    }
    if (/[\r\n\u0085\u2028\u2029]/u.test(caseId)) {
      throw new Error(`${sheetName} Sheet 第 ${sheetRow} 行的 CaseID 不能包含换行符`);
    }
    if (!srNum) {
      throw new Error(`${sheetName} Sheet 第 ${sheetRow} 行的 srNum 为空`);
    }

    const normalizedCaseId = caseId.toLocaleLowerCase("en-US");
    if (seenCaseIds.has(normalizedCaseId)) {
      throw new Error(`CaseID “${caseId}”在 ${sheetName} Sheet 中重复`);
    }
    seenCaseIds.add(normalizedCaseId);

    const row: CaseStepData = {};
    columns.forEach((column, columnIndex) => {
      if (column === undefined) return;
      row[column] = normalizeCell(sourceRow[columnIndex]);
    });
    row.CaseID = caseId;
    row.srNum = srNum;
    rows.push(row);
  }

  if (!rows.length) {
    throw new Error(`${sheetName} Sheet 中没有可导入的有效用例`);
  }
  return { name: sheetName, columns: columns.filter((column) => column !== undefined), rows };
}

function fullyRemovedDuplicateColumnName(
  originalColumns: readonly string[],
  columns: readonly (string | undefined)[],
): string | undefined {
  const indexesByName = new Map<string, number[]>();
  originalColumns.forEach((column, columnIndex) => {
    const normalized = column.toLocaleLowerCase("en-US");
    indexesByName.set(normalized, [...(indexesByName.get(normalized) ?? []), columnIndex]);
  });
  const removed = [...indexesByName.values()].find(
    (indexes) =>
      indexes.length > 1 && indexes.every((columnIndex) => columns[columnIndex] === undefined),
  );
  return removed ? originalColumns[removed[0]!] : undefined;
}

export function parseSpreadsheet(
  buffer: Buffer,
  fileName: string,
  columnResolutions: readonly DdtColumnResolution[] = [],
): ParsedSpreadsheet {
  const startedAt = Date.now();
  const extension = extensionOf(fileName);

  if (!isSupportedSpreadsheetFile(fileName)) {
    throw new Error("不支持该文件格式。请使用 .xlsx、.xls、.xlsb、.csv 或 .ods 文件");
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook =
      extension === "csv"
        ? XLSX.read(decodeCsvBuffer(buffer), {
            type: "string",
            cellDates: true,
            dense: true,
          })
        : XLSX.read(buffer, {
            type: "buffer",
            cellDates: true,
            dense: true,
          });
  } catch {
    throw new Error("无法解析该表格，请确认文件未损坏且格式正确");
  }

  const dataSheetName =
    workbook.SheetNames.find((name) => name.trim().toLocaleLowerCase("en-US") === "data") ??
    (extension === "csv" ? workbook.SheetNames[0] : undefined);

  const stepSheetNames = workbook.SheetNames.flatMap((name) => {
    const normalized = normalizeStepName(name);
    return normalized ? [{ original: name, normalized }] : [];
  });
  const duplicateStepName = stepSheetNames.find(
    (entry, index) =>
      stepSheetNames.findIndex((candidate) => candidate.normalized === entry.normalized) !== index,
  );
  if (duplicateStepName) {
    throw new Error(`存在多个代表 ${duplicateStepName.normalized} 的 Sheet 页`);
  }

  const orderedStepSheets = stepSheetNames.sort(
    (left, right) => Number(left.normalized.slice(4)) - Number(right.normalized.slice(4)),
  );
  if (orderedStepSheets.length) {
    for (let index = 0; index < orderedStepSheets.length; index += 1) {
      const expected = `step${index + 1}`;
      if (orderedStepSheets[index]!.normalized !== expected) {
        throw new Error(`用户旅程 Sheet 必须从 step1 开始且连续，缺少 ${expected}`);
      }
    }
  }

  if (!dataSheetName && !orderedStepSheets.length) {
    throw new Error("未找到 data Sheet，也未找到从 step1 开始的用户旅程 Sheet");
  }

  const columnConflicts: DdtImportColumnConflict[] = [];
  const parseSelectedSheet = (sheetName: string): ParsedSheet | undefined => {
    try {
      return parseCaseSheet(workbook, sheetName, fileName, columnResolutions);
    } catch (error) {
      if (!(error instanceof DdtDuplicateColumnsError)) throw error;
      columnConflicts.push(...error.conflicts);
      return undefined;
    }
  };
  const parsedDataSheet = dataSheetName ? parseSelectedSheet(dataSheetName) : undefined;
  const parsedStepCandidates = orderedStepSheets.map((entry) => ({
    normalized: entry.normalized,
    sheet: parseSelectedSheet(entry.original),
  }));
  if (columnConflicts.length) {
    assertResolvableColumnConflictLimit(columnConflicts, "当前表格");
    throw new DdtDuplicateColumnsError(fileName, columnConflicts);
  }
  const parsedSteps = parsedStepCandidates.map(({ normalized, sheet }) => ({
    normalized,
    sheet: sheet!,
  }));

  const columns: string[] = [];
  const rows: CaseData[] = [];
  const seenCaseIds = new Set<string>();
  if (parsedDataSheet) {
    columns.push(...parsedDataSheet.columns);
    for (const row of parsedDataSheet.rows) {
      const caseId = String(row.CaseID);
      const normalizedCaseId = caseId.toLocaleLowerCase("en-US");
      if (seenCaseIds.has(normalizedCaseId)) {
        throw new Error(`CaseID “${caseId}”在当前表格中重复`);
      }
      seenCaseIds.add(normalizedCaseId);
      rows.push(row);
    }
  }

  if (parsedSteps.length) {
    const firstParsedStep = parsedSteps[0]!;
    const expectedRows = firstParsedStep.sheet.rows.length;
    const mismatched = parsedSteps.find(({ sheet }) => sheet.rows.length !== expectedRows);
    if (mismatched) {
      throw new Error(
        `用户旅程各 Step 的数据行数必须一致：${firstParsedStep.sheet.name} 有 ${expectedRows} 行，${mismatched.sheet.name} 有 ${mismatched.sheet.rows.length} 行`,
      );
    }

    for (const { normalized, sheet } of parsedSteps) {
      for (const column of sheet.columns) {
        if (column === EXPORTED_STEP_PRESENT_COLUMN) continue;
        columns.push(`${normalized}.${column}`);
      }
    }

    for (let rowIndex = 0; rowIndex < expectedRows; rowIndex += 1) {
      const first = firstParsedStep.sheet.rows[rowIndex]!;
      const caseId = String(first.CaseID);
      const srNum = String(first.srNum);
      for (const current of parsedSteps.slice(1)) {
        const currentRow = current.sheet.rows[rowIndex]!;
        if (String(currentRow.CaseID) !== caseId) {
          throw new Error(
            `用户旅程第 ${rowIndex + 1} 条用例的 CaseID 不一致：step1 为“${caseId}”，${current.normalized} 为“${String(currentRow.CaseID)}”`,
          );
        }
        if (String(currentRow.srNum) !== srNum) {
          throw new Error(
            `用户旅程 CaseID “${caseId}”的 srNum 不一致：step1 为“${srNum}”，${current.normalized} 为“${String(currentRow.srNum)}”`,
          );
        }
      }

      const normalizedCaseId = caseId.toLocaleLowerCase("en-US");
      if (seenCaseIds.has(normalizedCaseId)) {
        throw new Error(`CaseID “${caseId}”在当前表格中重复`);
      }
      seenCaseIds.add(normalizedCaseId);
      rows.push(
        createJourneyCase(
          caseId,
          srNum,
          Object.fromEntries(
            parsedSteps.flatMap(({ normalized, sheet }) => {
              const source = sheet.rows[rowIndex]!;
              const presentValue = String(
                source[EXPORTED_STEP_PRESENT_COLUMN] ?? "true",
              ).toLocaleLowerCase("en-US");
              if (["false", "0", "no"].includes(presentValue)) return [];
              return [
                [
                  normalized,
                  Object.fromEntries(
                    Object.entries(source).filter(
                      ([column]) => column !== EXPORTED_STEP_PRESENT_COLUMN,
                    ),
                  ),
                ],
              ];
            }),
          ),
        ),
      );
    }
  }

  return {
    fileName,
    sizeBytes: buffer.byteLength,
    columns,
    rows,
    startedAt,
  };
}

export function buildExportWorkbook(rows: CaseData[]) {
  if (!rows.length) throw new Error("没有符合条件的用例可导出");

  const workbook = XLSX.utils.book_new();
  const appendSheet = (sheetRows: CaseStepData[], sheetName: string) => {
    const columnSet = new Set<string>(["CaseID", "srNum"]);
    for (const row of sheetRows) {
      for (const column of Object.keys(row)) columnSet.add(column);
    }
    const columns = [...columnSet];
    const sheet = XLSX.utils.json_to_sheet(sheetRows, { header: columns });
    sheet["!autofilter"] = { ref: sheet["!ref"] ?? "A1" };
    sheet["!cols"] = columns.map((column) => ({
      wch: Math.min(Math.max(column.length + 2, 14), 42),
      ...(column === EXPORTED_STEP_PRESENT_COLUMN ? { hidden: true } : {}),
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  };

  const standardRows = rows.filter((row) => !isJourneyCase(row));
  if (standardRows.length) {
    appendSheet(
      standardRows.map(
        (row) =>
          Object.fromEntries(
            Object.entries(row).filter(([, value]) => {
              return value === null || ["string", "number", "boolean"].includes(typeof value);
            }),
          ) as CaseStepData,
      ),
      "data",
    );
  }

  const journeyRows = rows.filter(isJourneyCase);
  const stepNames = [...new Set(journeyRows.flatMap((row) => ddtStepNames(row)))].sort(
    (left, right) => Number(left.slice(4)) - Number(right.slice(4)),
  );
  for (const stepName of stepNames) {
    const hasMissingStep = journeyRows.some((row) => !getJourneySteps(row)?.[stepName]);
    appendSheet(
      journeyRows.map((row) => {
        const step = getJourneySteps(row)?.[stepName];
        if (!hasMissingStep) return step!;
        return step
          ? { ...step, [EXPORTED_STEP_PRESENT_COLUMN]: true }
          : {
              CaseID: String(getCaseCell(row, "CaseID") ?? ""),
              srNum: String(getCaseCell(row, "srNum") ?? ""),
              [EXPORTED_STEP_PRESENT_COLUMN]: false,
            };
      }),
      stepName,
    );
  }

  return XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
  }) as Buffer;
}
