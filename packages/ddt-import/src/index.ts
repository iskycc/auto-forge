import {
  DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  DDT_IMPORT_FILE_BYTES,
  DDT_IMPORT_FILE_LIMIT,
  DDT_IMPORT_TOTAL_BYTES,
} from "@autoforge/contracts";

import { extractSpreadsheetsFromZip, isZipFile } from "./archive";
import { parseSpreadsheet } from "./spreadsheet";

export * from "./archive";
export * from "./spreadsheet";

export type DdtImportUpload = {
  fileName: string;
  mediaType: string;
  content: Uint8Array;
};

export async function parseDdtUpload(upload: DdtImportUpload) {
  if (!isZipFile(upload.fileName)) {
    const parsed = parseSpreadsheet(Buffer.from(upload.content), upload.fileName);
    return [{ fileName: parsed.fileName, rows: parsed.rows }];
  }
  const extracted = await extractSpreadsheetsFromZip(Buffer.from(upload.content), {
    archiveName: upload.fileName,
    maxFiles: DDT_IMPORT_FILE_LIMIT,
    maxFileBytes: DDT_IMPORT_FILE_BYTES,
    maxTotalBytes: DDT_IMPORT_TOTAL_BYTES,
    maxEntries: DDT_IMPORT_ARCHIVE_ENTRY_LIMIT,
  });
  return extracted.map((file) => {
    const parsed = parseSpreadsheet(file.buffer, file.fileName);
    return {
      fileName: parsed.fileName,
      archiveEntryName: file.archiveEntryName,
      rows: parsed.rows,
    };
  });
}
