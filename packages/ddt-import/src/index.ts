import {
  DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  DDT_IMPORT_FILE_BYTES,
  DDT_IMPORT_FILE_LIMIT,
  DDT_IMPORT_TOTAL_BYTES,
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

export async function parseDdtUpload(upload: DdtImportUpload) {
  if (!isZipFile(upload.fileName)) {
    const parsed = parseSpreadsheet(
      Buffer.from(upload.content),
      upload.fileName,
      (upload.columnResolutions ?? []).filter((resolution) => !resolution.archiveEntryName),
    );
    return [{ fileName: parsed.fileName, rows: parsed.rows }];
  }
  const extracted = await extractSpreadsheetsFromZip(Buffer.from(upload.content), {
    archiveName: upload.fileName,
    maxFiles: DDT_IMPORT_FILE_LIMIT,
    maxFileBytes: DDT_IMPORT_FILE_BYTES,
    maxTotalBytes: DDT_IMPORT_TOTAL_BYTES,
    maxEntries: DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  });
  const parsedFiles = [];
  const conflicts: DdtImportColumnConflict[] = [];
  for (const file of extracted) {
    try {
      const parsed = parseSpreadsheet(
        file.buffer,
        file.fileName,
        (upload.columnResolutions ?? []).filter(
          (resolution) => resolution.archiveEntryName === file.archiveEntryName,
        ),
      );
      parsedFiles.push({
        fileName: parsed.fileName,
        archiveEntryName: file.archiveEntryName,
        rows: parsed.rows,
      });
    } catch (error) {
      if (!(error instanceof DdtDuplicateColumnsError)) throw error;
      conflicts.push(
        ...error.conflicts.map((conflict) => ({
          ...conflict,
          archiveEntryName: file.archiveEntryName,
        })),
      );
    }
  }
  if (conflicts.length) {
    assertResolvableColumnConflictLimit(conflicts, "ZIP ");
    throw new DdtDuplicateColumnsError(upload.fileName, conflicts);
  }
  return parsedFiles;
}
