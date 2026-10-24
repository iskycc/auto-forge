import "server-only";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import ExcelJS from "exceljs";
import { DomainError } from "@autoforge/domain";
import type { SrTagClassification } from "@autoforge/contracts";
import { openTemporaryExportFile } from "./export-temporary-file";
import {
  exportWorksheetOptions,
  exportColumnWidth,
  styleExportHeader,
  styleExportRow,
} from "./export-workbook-style";
import { exportCellTextIssues } from "./export-cell-validation";

export async function prepareSrTagExport(
  pages: AsyncIterable<SrTagClassification[]>,
  directory: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const file = await openTemporaryExportFile(directory);
  const stream = new PassThrough({ highWaterMark: 256 * 1024 });
  const destination = new Writable({
    write(chunk: Buffer, _encoding, complete) {
      void file.writeFile(chunk).then(() => complete(), complete);
    },
  });
  const transferred = pipeline(stream, destination, { signal });
  // Observe errors immediately; the caller waits for both ZIP finalization and the final file write.
  const observed = transferred.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream,
      useSharedStrings: false,
      useStyles: true,
    });
    workbook.creator = "AutoForge";
    const sheet = workbook.addWorksheet("SR标签分类", exportWorksheetOptions());
    let initialized = false;
    const initialize = (samples: SrTagClassification[]) => {
      sheet.columns = [
        {
          header: "SR",
          width: exportColumnWidth(
            "SR",
            samples.map((row) => row.srNum),
            { minimum: 20, maximum: 64 },
          ),
        },
        {
          header: "标签",
          width: exportColumnWidth(
            "标签",
            samples.map((row) => row.tagName),
            { minimum: 16, maximum: 42 },
          ),
        },
      ];
      sheet.autoFilter = "A1:B1";
      const header = sheet.getRow(1);
      styleExportHeader(header);
      header.commit();
      initialized = true;
    };
    for await (const page of pages) {
      signal.throwIfAborted();
      if (!initialized) initialize(page);
      for (const entry of page) {
        if (exportCellTextIssues(entry.srNum).length || exportCellTextIssues(entry.tagName).length)
          throw new DomainError(
            "EXPORT_DATA_INVALID",
            `SR“${entry.srNum.slice(0, 64)}”的标签关联包含 Excel 不支持的字符或文本，请修正后导出。`,
          );
        const row = sheet.addRow([entry.srNum, entry.tagName]);
        styleExportRow(row, 2);
        row.commit();
      }
      await yieldTurn();
    }
    if (!initialized) initialize([]);
    sheet.commit();
    await workbook.commit();
    const failure = await observed;
    if (failure) throw failure;
    return { file, sizeBytes: (await file.stat()).size };
  } catch (cause) {
    stream.destroy(
      cause instanceof Error ? cause : new Error("生成 SR 标签 Excel 失败。", { cause }),
    );
    await observed;
    await file.close();
    throw cause;
  }
}
