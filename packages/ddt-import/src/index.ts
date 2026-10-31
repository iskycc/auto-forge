import {
  DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  DDT_IMPORT_FILE_BYTES,
  DDT_IMPORT_TOTAL_BYTES,
  DDT_IMPORT_ZIP_SPREADSHEET_LIMIT,
} from "@autoforge/contracts";
import type {
  DdtColumnResolution,
  DdtImportColumnConflict,
  DdtImportRowShape,
} from "@autoforge/contracts";

import { iterateSpreadsheetsFromZip, isZipFile } from "./archive";
import { parseXlsxSpreadsheet } from "./xlsx-spreadsheet";
import {
  assertResolvableColumnConflictLimit,
  DdtDuplicateColumnsError,
  parseSpreadsheet,
} from "./spreadsheet";

export * from "./archive";
export * from "./spreadsheet";

export type DdtImportUpload = {
  fileName: string;
  mediaType: string;
  content: Uint8Array;
  columnResolutions?: DdtColumnResolution[];
};

export type DdtImportParseLimits = {
  maximumZipSpreadsheets: number;
};

export type ParsedDdtUploadFile = {
  fileName: string;
  archiveEntryName?: string;
  rows: ReturnType<typeof parseSpreadsheet>["rows"];
  errorSummary?: string;
  columnConflicts?: DdtImportColumnConflict[];
  rowShape?: DdtImportRowShape;
};

const DEFAULT_PARSE_LIMITS: DdtImportParseLimits = {
  maximumZipSpreadsheets: DDT_IMPORT_ZIP_SPREADSHEET_LIMIT,
};

export async function parseDdtUpload(
  upload: DdtImportUpload,
  limits: DdtImportParseLimits = DEFAULT_PARSE_LIMITS,
  options: { compactRows?: boolean } = {},
) {
  if (!isZipFile(upload.fileName)) {
    return [
      await parseSpreadsheetOutcome(
        Buffer.from(upload.content),
        upload.fileName,
        (upload.columnResolutions ?? []).filter((resolution) => !resolution.archiveEntryName),
        undefined,
        options,
      ),
    ];
  }
  const extracted = iterateSpreadsheetsFromZip(Buffer.from(upload.content), {
    archiveName: upload.fileName,
    maxFiles: limits.maximumZipSpreadsheets,
    maxFileBytes: DDT_IMPORT_FILE_BYTES,
    maxTotalBytes: DDT_IMPORT_TOTAL_BYTES,
    maxEntries: DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  });
  const parsedFiles: ParsedDdtUploadFile[] = [];
  for await (const file of extracted) {
    parsedFiles.push(
      await parseSpreadsheetOutcome(
        file.buffer,
        file.fileName,
        (upload.columnResolutions ?? []).filter(
          (resolution) => resolution.archiveEntryName === file.archiveEntryName,
        ),
        file.archiveEntryName,
        options,
      ),
    );
  }
  const conflicts = parsedFiles.flatMap((file) => file.columnConflicts ?? []);
  if (conflicts.length) {
    assertResolvableColumnConflictLimit(conflicts, "ZIP ");
  }
  return parsedFiles;
}

async function parseSpreadsheetOutcome(
  content: Buffer,
  fileName: string,
  columnResolutions: readonly DdtColumnResolution[],
  archiveEntryName?: string,
  options: { compactRows?: boolean } = {},
): Promise<ParsedDdtUploadFile> {
  try {
    const parsed = fileName.toLocaleLowerCase("en-US").endsWith(".xlsx")
      ? await parseXlsxSpreadsheet(content, fileName, columnResolutions, options)
      : parseSpreadsheet(content, fileName, columnResolutions);
    return {
      fileName: parsed.fileName,
      ...(archiveEntryName ? { archiveEntryName } : {}),
      rows: parsed.rows,
      ...(parsed.rowShape ? { rowShape: parsed.rowShape } : {}),
    };
  } catch (error) {
    const columnConflicts =
      error instanceof DdtDuplicateColumnsError
        ? error.conflicts.map((conflict) => ({
            ...conflict,
            ...(archiveEntryName ? { archiveEntryName } : {}),
          }))
        : undefined;
    return {
      fileName,
      ...(archiveEntryName ? { archiveEntryName } : {}),
      rows: [],
      errorSummary: columnConflicts
        ? "发现重复列名，请人工选择保留、改名或删除冲突列。"
        : spreadsheetErrorMessage(error),
      ...(columnConflicts ? { columnConflicts } : {}),
    };
  }
}

function spreadsheetErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "DDT 表格解析失败。").slice(0, 1_000);
}

export * from "./sr-tags";
