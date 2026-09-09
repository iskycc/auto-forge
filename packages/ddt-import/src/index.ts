import {
  DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  DDT_IMPORT_FILE_BYTES,
  DDT_IMPORT_TOTAL_BYTES,
  DDT_IMPORT_ZIP_SPREADSHEET_LIMIT,
} from "@autoforge/contracts";
import type { DdtColumnResolution, DdtImportColumnConflict } from "@autoforge/contracts";

import { extractSpreadsheetsFromZip, isZipFile } from "./archive";
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
};

const DEFAULT_PARSE_LIMITS: DdtImportParseLimits = {
  maximumZipSpreadsheets: DDT_IMPORT_ZIP_SPREADSHEET_LIMIT,
};

export async function parseDdtUpload(
  upload: DdtImportUpload,
  limits: DdtImportParseLimits = DEFAULT_PARSE_LIMITS,
) {
  if (!isZipFile(upload.fileName)) {
    return [
      parseSpreadsheetOutcome(
        Buffer.from(upload.content),
        upload.fileName,
        (upload.columnResolutions ?? []).filter((resolution) => !resolution.archiveEntryName),
      ),
    ];
  }
  const extracted = await extractSpreadsheetsFromZip(Buffer.from(upload.content), {
    archiveName: upload.fileName,
    maxFiles: limits.maximumZipSpreadsheets,
    maxFileBytes: DDT_IMPORT_FILE_BYTES,
    maxTotalBytes: DDT_IMPORT_TOTAL_BYTES,
    maxEntries: DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  });
  const parsedFiles: ParsedDdtUploadFile[] = [];
  for (const file of extracted) {
    parsedFiles.push(
      parseSpreadsheetOutcome(
        file.buffer,
        file.fileName,
        (upload.columnResolutions ?? []).filter(
          (resolution) => resolution.archiveEntryName === file.archiveEntryName,
        ),
        file.archiveEntryName,
      ),
    );
  }
  const conflicts = parsedFiles.flatMap((file) => file.columnConflicts ?? []);
  if (conflicts.length) {
    assertResolvableColumnConflictLimit(conflicts, "ZIP ");
  }
  return parsedFiles;
}

function parseSpreadsheetOutcome(
  content: Buffer,
  fileName: string,
  columnResolutions: readonly DdtColumnResolution[],
  archiveEntryName?: string,
): ParsedDdtUploadFile {
  try {
    const parsed = parseSpreadsheet(content, fileName, columnResolutions);
    return {
      fileName: parsed.fileName,
      ...(archiveEntryName ? { archiveEntryName } : {}),
      rows: parsed.rows,
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
