import "server-only";

import {
  CASE_SUITE_MARKER_SHEET,
  CASE_SUITE_MARKER_WORKBOOK_HEADERS,
  type CaseSuiteMarkerMember,
} from "@autoforge/contracts";
import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { exportWorksheetOptions, styleExportHeader, styleExportRow } from "./export-workbook-style";

export function createCaseSuiteMarkerWorkbook(
  rows: AsyncIterable<CaseSuiteMarkerMember>,
  signal: AbortSignal,
) {
  const stream = new PassThrough({ highWaterMark: 256 * 1024 });
  const disconnected = new AbortController();
  stream.once("close", () => disconnected.abort());
  const active = AbortSignal.any([signal, disconnected.signal]);
  async function write() {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream,
      useSharedStrings: false,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet(CASE_SUITE_MARKER_SHEET, exportWorksheetOptions());
    sheet.columns = CASE_SUITE_MARKER_WORKBOOK_HEADERS.map((header, index) => ({
      header,
      width: [14, 40, 52][index] ?? 22,
      style: { numFmt: "@" },
    }));
    const header = sheet.getRow(1);
    styleExportHeader(header, [
      "identity",
      "identity",
      "identity",
      "metadata",
      "metadata",
      "metadata",
      "metadata",
      "metadata",
    ]);
    header.commit();
    let count = 0;
    for await (const row of rows) {
      active.throwIfAborted();
      const cells = sheet.addRow([
        row.kind === "ddt" ? "DDT" : "普通用例",
        row.memberId,
        row.caseLabel,
        ...CASE_SUITE_MARKER_WORKBOOK_HEADERS.slice(3).map((_, index) => row.markers[index] ?? ""),
      ]);
      styleExportRow(cells, CASE_SUITE_MARKER_WORKBOOK_HEADERS.length);
      cells.commit();
      if (++count % 100 === 0) {
        await setImmediate(undefined, { signal: active });
        if (stream.writableNeedDrain) await once(stream, "drain", { signal: active });
      }
    }
    sheet.commit();
    await workbook.commit();
  }
  void write().catch((cause: unknown) =>
    stream.destroy(
      cause instanceof Error ? cause : new Error("生成任务用例标识表失败。", { cause }),
    ),
  );
  return stream;
}
