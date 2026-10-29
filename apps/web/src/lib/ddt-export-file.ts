import "server-only";

import type { FileHandle } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as yieldTurn } from "node:timers/promises";
import ExcelJS from "exceljs";
import { appendStyledDdtExportRow, ddtColumnMinimumWidth } from "./ddt-export-xlsx";
import {
  DomainError,
  ddtCaseCell,
  ddtJourneySteps,
  ddtStepNames,
  isDdtJourney,
  type DdtCaseData,
  type DdtCaseStep,
} from "@autoforge/domain";
import { DdtExportColumnPlanner, EXPORTED_STEP_PRESENT_COLUMN } from "@autoforge/ddt-import";
import { openTemporaryExportFile } from "./export-temporary-file";
import {
  exportCellTextIssues,
  exportIssueText,
  EXCEL_SHEET_ROW_LIMIT,
} from "./export-cell-validation";
import {
  exportColumnWidth,
  exportWorksheetOptions,
  styleExportHeader,
  EXPORT_WIDTH_SAMPLE_ROWS,
} from "./export-workbook-style";

type SheetPlan = {
  name: string;
  count: number;
  planner: DdtExportColumnPlanner;
  samples: DdtCaseStep[];
  missingSteps: boolean;
};

function sheetFields(
  row: DdtCaseData,
  plan: Pick<SheetPlan, "name" | "missingSteps">,
): DdtCaseStep | undefined {
  if (plan.name === "data") {
    if (isDdtJourney(row)) return undefined;
    return Object.fromEntries(
      Object.entries(row).filter(([, value]) => value === null || typeof value !== "object"),
    ) as DdtCaseStep;
  }
  if (!isDdtJourney(row)) return undefined;
  const step = ddtJourneySteps(row)?.[plan.name];
  if (!plan.missingSteps) return step;
  return {
    ...(step ?? {
      CaseID: String(ddtCaseCell(row, "CaseID") ?? ""),
      srNum: String(ddtCaseCell(row, "srNum") ?? ""),
    }),
    [EXPORTED_STEP_PRESENT_COLUMN]: Boolean(step),
  };
}

function observeFields(plan: SheetPlan, fields: DdtCaseStep, caseId: string) {
  for (const [field, value] of Object.entries(fields)) {
    const reasons = [
      ...exportCellTextIssues(field),
      ...(typeof value === "string" ? exportCellTextIssues(value) : []),
    ];
    if (reasons.length)
      throw new DomainError(
        "EXPORT_DATA_INVALID",
        `DDT 用例 ${exportIssueText(caseId, 512)}，字段 ${exportIssueText(field, 128)}：${reasons[0]}请修正后重新导出。`,
      );
  }
  plan.planner.add(fields);
  plan.count++;
  if (plan.count < EXCEL_SHEET_ROW_LIMIT) {
    if (plan.samples.length < EXPORT_WIDTH_SAMPLE_ROWS)
      plan.samples.push(
        Object.fromEntries(
          Object.entries(fields).map(([field, value]) => [
            field,
            typeof value === "string" ? value.slice(0, 42) : value,
          ]),
        ),
      );
    return;
  }
  throw new DomainError(
    "EXPORT_DATA_INVALID",
    `DDT 工作表 ${plan.name} 超过 Excel 行数上限，请按业务分组导出。`,
  );
}

/** Pull one bounded file chunk at a time; no reader can prefetch or outlive cancellation. */
async function* snapshotRows(file: FileHandle, signal: AbortSignal): AsyncGenerator<DdtCaseData> {
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(64 * 1_024);
  const fragments: string[] = [];
  let position = 0;
  while (true) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    position += bytesRead;
    const chunk = bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
    let start = 0;
    let newline = chunk.indexOf("\n", start);
    while (newline >= 0) {
      signal.throwIfAborted();
      fragments.push(chunk.slice(start, newline));
      const line = fragments.join("");
      fragments.length = 0;
      yield JSON.parse(line) as DdtCaseData;
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) fragments.push(chunk.slice(start));
    if (!bytesRead) break;
  }
  signal.throwIfAborted();
  if (fragments.length) yield JSON.parse(fragments.join("")) as DdtCaseData;
}

async function writeWorkbook(
  snapshot: FileHandle,
  plans: SheetPlan[],
  output: PassThrough,
  signal: AbortSignal,
) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useSharedStrings: false,
    useStyles: true,
  });
  workbook.creator = "AutoForge";
  for (const plan of plans) {
    signal.throwIfAborted();
    const { columns, headerByField } = plan.planner.build();
    if (columns.length > 16_384)
      throw new DomainError(
        "EXPORT_DATA_INVALID",
        `DDT 工作表 ${plan.name} 超过 Excel 列数上限，请减少字段后重新导出。`,
      );
    const samples = plan.samples.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([field, value]) => [headerByField.get(field)!, value]),
      ),
    );
    const columnIndexes = new Map(columns.map((name, index) => [name, index + 1]));
    const sheet = workbook.addWorksheet(plan.name, exportWorksheetOptions());
    sheet.columns = columns.map((name) => ({
      header: name,
      width: exportColumnWidth(
        name,
        samples.map((row) => String(row[name] ?? "")),
        {
          minimum: ddtColumnMinimumWidth(name),
          maximum: 42,
        },
      ),
      hidden: name === EXPORTED_STEP_PRESENT_COLUMN,
    }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    const header = sheet.getRow(1);
    styleExportHeader(header);
    header.commit();
    let written = 0;
    let yieldedAt = performance.now();
    for await (const source of snapshotRows(snapshot, signal)) {
      const fields = sheetFields(source, plan);
      if (!fields) continue;
      const normalized = new Map(
        Object.entries(fields).map(([field, value]) => [headerByField.get(field)!, value]),
      );
      appendStyledDdtExportRow(sheet, columnIndexes, normalized);
      if (++written % 32 === 0 || performance.now() - yieldedAt >= 8) {
        await yieldTurn(undefined, { signal });
        yieldedAt = performance.now();
      }
    }
    sheet.commit();
  }
  await workbook.commit();
}

/** Snapshot bounded DB pages, then commit rows to disk before sending any download headers. */
export async function prepareDdtExportFile(
  pages: AsyncIterable<DdtCaseData[]>,
  signal: AbortSignal,
  directory: string,
): Promise<{ file: FileHandle; sizeBytes: number }> {
  signal.throwIfAborted();
  const snapshot = await openTemporaryExportFile(directory);
  let file: FileHandle | undefined;
  try {
    const sheets = new Map<string, SheetPlan>();
    let journeyCount = 0;
    let totalCount = 0;
    let yieldedAt = performance.now();
    const observe = (name: string, fields: DdtCaseStep, caseId: string) => {
      let plan = sheets.get(name);
      if (!plan) {
        plan = {
          name,
          count: 0,
          planner: new DdtExportColumnPlanner(),
          samples: [],
          missingSteps: false,
        };
        sheets.set(name, plan);
      }
      observeFields(plan, fields, caseId);
    };
    for await (const page of pages) {
      signal.throwIfAborted();
      for (const row of page) {
        const caseId = String(ddtCaseCell(row, "CaseID") ?? "");
        if (isDdtJourney(row)) {
          journeyCount++;
          for (const name of ddtStepNames(row)) observe(name, ddtJourneySteps(row)![name]!, caseId);
        } else observe("data", sheetFields(row, { name: "data", missingSteps: false })!, caseId);
        totalCount++;
        if (performance.now() - yieldedAt >= 8) {
          await yieldTurn(undefined, { signal });
          yieldedAt = performance.now();
        }
      }
      await snapshot.writeFile(page.map((row) => JSON.stringify(row) + "\n").join(""));
      await yieldTurn(undefined, { signal });
    }
    if (!totalCount) throw new DomainError("DDT_SELECTION_REQUIRED", "没有符合条件的用例可导出。");
    if (journeyCount >= EXCEL_SHEET_ROW_LIMIT)
      throw new DomainError(
        "EXPORT_DATA_INVALID",
        "用户旅程数量超过 Excel 行数上限，请按业务分组导出。",
      );
    for (const plan of sheets.values()) {
      if (plan.name === "data" || plan.count === journeyCount) continue;
      plan.missingSteps = true;
      plan.planner.add({ CaseID: "", srNum: "", [EXPORTED_STEP_PRESENT_COLUMN]: false });
    }
    const plans = [...sheets.values()].sort((a, b) =>
      a.name === "data"
        ? -1
        : b.name === "data"
          ? 1
          : Number(a.name.slice(4)) - Number(b.name.slice(4)),
    );
    file = await openTemporaryExportFile(directory);
    const output = new PassThrough({ highWaterMark: 256 * 1_024 });
    const destinationFile = file;
    const destination = new Writable({
      highWaterMark: 256 * 1_024,
      write(chunk: Buffer, _encoding, complete) {
        void destinationFile.writeFile(chunk).then(
          () => complete(),
          (cause: unknown) =>
            complete(cause instanceof Error ? cause : new Error("写入 DDT 导出失败。", { cause })),
        );
      },
    });
    const stopWriting = new AbortController();
    const writingSignal = AbortSignal.any([signal, stopWriting.signal]);
    const writing = writeWorkbook(snapshot, plans, output, writingSignal);
    const copying = pipeline(output, destination, { signal: writingSignal });
    const results = await Promise.allSettled(
      [writing, copying].map((completion) =>
        completion.catch((cause: unknown) => {
          stopWriting.abort(cause);
          output.destroy(
            cause instanceof Error ? cause : new Error("生成 DDT 导出失败。", { cause }),
          );
          throw cause;
        }),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw failures[0];
    signal.throwIfAborted();
    await snapshot.close();
    return { file, sizeBytes: (await file.stat()).size };
  } catch (cause) {
    const cleanup = await Promise.allSettled([snapshot.close(), ...(file ? [file.close()] : [])]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError([cause, ...failures], "DDT 导出失败且文件清理未完成。");
    throw cause;
  }
}
