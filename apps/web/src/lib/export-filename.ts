import { EXPORT_OUTCOME_FILTERS, type ExportOutcomeFilter } from "@autoforge/contracts";
import { toUSVString } from "node:util";
import { EXPORT_OUTCOME_OPTIONS, type RunBatchExportScope } from "./run-batch-export";

type ExportTime = { exportedAt: Date; timeZone: string };
type ExportBatch = { suiteName: string; sequenceNumber: number };
type BatchExportName = ExportTime & { batch: ExportBatch };
const MAXIMUM_FILENAME_BYTES = 240;

export function executionExportFilename(
  input: BatchExportName & {
    template: "results" | "failure-analysis";
    scope: RunBatchExportScope;
    round?: number | undefined;
    outcomes: readonly ExportOutcomeFilter[];
  },
): string {
  const report = input.template === "failure-analysis" ? "失败用例分析清单" : "用例执行结果";
  const range = executionRange(input.scope, input.round);
  const filters = input.template === "results" ? [executionOutcomeSelection(input.outcomes)] : [];
  return workbookFilename(
    input.batch.suiteName,
    [report, range, ...filters, batchLabel(input.batch)],
    input,
  );
}

export function executionExceptionExportFilename(input: BatchExportName): string {
  return workbookFilename(input.batch.suiteName, ["执行异常原因", batchLabel(input.batch)], input);
}

export function caseSuiteExportFilename(input: ExportTime & { suiteName: string }): string {
  return workbookFilename(input.suiteName, ["任务用例清单"], input);
}

export function ddtExportFilename(
  input: ExportTime & {
    versionName: string;
    stageName: string;
    selection: {
      caseIds?: readonly string[] | undefined;
      categoryIds?: readonly string[] | undefined;
      srNum?: string | undefined;
    };
  },
): string {
  const scope = input.selection.caseIds?.length
    ? "已选用例"
    : input.selection.categoryIds !== undefined || input.selection.srNum
      ? "筛选范围"
      : "全部用例";
  return workbookFilename(`${input.versionName}-${input.stageName}`, ["DDT用例清单", scope], input);
}

/** Keep the business identity bounded while preserving the report, scope, batch number and time. */
function workbookFilename(
  businessName: string,
  details: readonly string[],
  time: ExportTime,
): string {
  const suffix = `_${details.join("_")}_${exportTimestamp(time)}.xlsx`;
  const name = safeFilenamePart(businessName) || "AutoForge";
  return `${truncateUtf8(name, MAXIMUM_FILENAME_BYTES - Buffer.byteLength(suffix))}${suffix}`;
}

function safeFilenamePart(value: string): string {
  return toUSVString(value)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s_-]+|[.\s_-]+$/gu, "");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > maximumBytes) break;
    result += character;
  }
  return result.trimEnd();
}

function batchLabel(batch: ExportBatch): string {
  return `批次${batch.sequenceNumber}`;
}

function executionRange(scope: RunBatchExportScope, round: number | undefined): string {
  if (scope === "final") return "最终结果";
  if (scope === "all") return "全部轮次";
  if (!Number.isSafeInteger(round) || round === undefined || round < 1)
    throw new RangeError("按轮次命名导出文件必须提供有效轮次。");
  return `第${round}轮`;
}

function executionOutcomeSelection(outcomes: readonly ExportOutcomeFilter[]): string {
  if (EXPORT_OUTCOME_FILTERS.every((outcome) => outcomes.includes(outcome))) return "全部状态";
  return EXPORT_OUTCOME_OPTIONS.filter((option) => outcomes.includes(option.value))
    .map((option) => option.label)
    .join("-");
}

function exportTimestamp({ exportedAt, timeZone }: ExportTime): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(exportedAt);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${value("year")}${value("month")}${value("day")}-${value("hour")}${value("minute")}${value("second")}`;
}

/** RFC 5987 also requires escaping apostrophes, parentheses and asterisks left by encodeURIComponent. */
export function exportContentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="AutoForge-export.xlsx"; filename*=UTF-8''${encoded}`;
}
