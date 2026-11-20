import {
  CASE_SUITE_MARKER_COUNT,
  EXPORT_OUTCOME_FILTERS,
  type ExportOutcomeFilter,
  type CaseSuiteMarkers,
} from "@autoforge/contracts";
import {
  classifyAttemptResult,
  DomainError,
  runAttemptExecutionRound,
  runAttemptOutcome,
  runAttemptsForExecutionRound,
  type AttemptResultCategory,
  type DdtCellValue,
  type ExecutionRun,
  type RunAttempt,
  type RunBatchDetails,
} from "@autoforge/domain";

import type { RunBatchRepository } from "./ports";

/**
 * 导出单行数据。blocked 口径：除 adapter 正常成功/失败外的任何非正常结束
 * （超时强杀、未拉起 adapter、adapter 异常、取消等）；最终结果中的取消归为失败。
 * 从未执行的用例没有终止结果，不导出。round 为逻辑执行轮次；Runner 基础设施重调度不会新增轮次。
 */
export type RunBatchExportRow = {
  attemptId: string | null;
  executionRunId: string;
  casePath: string;
  displayName: string;
  /** Present only for DDT runs; missing original cells remain null. */
  ddt?: { caseName: DdtCellValue; srId: DdtCellValue };
  markers?: CaseSuiteMarkers;
  outcome: ExportOutcomeFilter;
  resultCode: string | null;
  /** 仅失败/阻塞尝试有值（一行精简堆栈）。 */
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  round: number;
};

export type RunBatchExportQuery = {
  batchId: string;
  /** round=指定轮次；final=每个用例最新一次记录；all=所有轮次逐条记录（round 字段标注轮次）。 */
  scope: "round" | "final" | "all";
  /** scope=round 时必填；初始轮次为 1，与批次详情页一致。 */
  round?: number;
  outcomes: readonly ExportOutcomeFilter[];
  projectIds?: readonly string[];
};

export type RunBatchExportData = {
  projectId: string;
  rows: RunBatchExportRow[];
};

export type RunBatchExportCursor = {
  className: string;
  displayName: string;
  runId: string;
  round: number;
};
export type RunBatchExportPageQuery = Pick<RunBatchExportQuery, "batchId" | "scope" | "round"> & {
  after?: RunBatchExportCursor;
  markers?: "include" | "only";
  limit: number;
};
export type RunBatchExportPage = {
  items: Array<{
    run: Pick<ExecutionRun, "id" | "className" | "displayName"> &
      Partial<Pick<ExecutionRun, "status">> &
      Pick<RunBatchExportRow, "ddt" | "markers">;
    attempt: Pick<
      RunAttempt,
      | "id"
      | "executionRunId"
      | "attemptNumber"
      | "executionRound"
      | "status"
      | "outcome"
      | "resultCode"
      | "resultSummary"
      | "startedAt"
      | "finishedAt"
      | "durationMs"
    >;
  }>;
  next?: RunBatchExportCursor;
};

export class RunBatchExportService {
  constructor(private readonly batches: RunBatchRepository) {}

  /** Export only bounded result pages; no batch-wide runs, class data or TestNG reports enter HTTP. */
  async prepare(
    query: RunBatchExportQuery,
    options: { includeMarkerColumns?: boolean; signal?: AbortSignal } = {},
  ): Promise<{
    projectId: string;
    batch: { suiteName: string; sequenceNumber: number };
    includesDdt: boolean;
    markerColumns: number[];
    pages: AsyncIterable<RunBatchExportRow[]>;
  }> {
    const outcomes = validatedOutcomes(query.outcomes);
    if (query.scope === "round") requiredRound(query.round);
    const metadata = await this.batches.getMetadata(query.batchId, query.projectIds);
    if (!metadata) throw new DomainError("BATCH_NOT_FOUND", "指定的执行批次不存在。");
    const includesDdt = await this.batches.hasDdtRuns(query.batchId);
    const batches = this.batches;
    async function* pages(
      markers?: RunBatchExportPageQuery["markers"],
    ): AsyncGenerator<RunBatchExportRow[]> {
      let after: RunBatchExportCursor | undefined;
      do {
        options.signal?.throwIfAborted();
        const page = await batches.readExportPage({
          batchId: query.batchId,
          scope: query.scope,
          limit: 200,
          ...(markers ? { markers } : {}),
          ...(query.round !== undefined ? { round: query.round } : {}),
          ...(after ? { after } : {}),
        });
        yield page.items.flatMap(({ run, attempt }) =>
          matchesOutcomeFilter(attempt, outcomes, query.scope, run.status)
            ? [attemptRow(attempt, run, query.scope)]
            : [],
        );
        after = page.next;
      } while (after);
    }
    const markerColumns = new Set<number>();
    if (options.includeMarkerColumns) {
      for await (const rows of pages("only")) {
        for (const row of rows)
          row.markers?.forEach((value, index) => {
            if (value) markerColumns.add(index);
          });
        if (markerColumns.size === CASE_SUITE_MARKER_COUNT) break;
      }
    }
    return {
      markerColumns: [...markerColumns].sort((a, b) => a - b),
      projectId: metadata.projectId,
      batch: { suiteName: metadata.suiteName, sequenceNumber: metadata.sequenceNumber },
      includesDdt,
      pages: { [Symbol.asyncIterator]: () => pages(markerColumns.size ? "include" : undefined) },
    };
  }

  async buildRows(query: RunBatchExportQuery): Promise<RunBatchExportRow[]> {
    return (await this.build(query)).rows;
  }

  async build(query: RunBatchExportQuery): Promise<RunBatchExportData> {
    const details = await this.batches.get(query.batchId, query.projectIds);
    if (!details) {
      // 不存在与无权访问统一为 BATCH_NOT_FOUND，避免通过差异探测批次是否存在。
      throw new DomainError("BATCH_NOT_FOUND", "指定的执行批次不存在。");
    }
    return {
      projectId: details.projectId,
      rows: buildRunBatchExportRows(details, query),
    };
  }
}

export function buildRunBatchExportRows(
  details: RunBatchDetails,
  query: Pick<RunBatchExportQuery, "scope" | "round" | "outcomes">,
): RunBatchExportRow[] {
  const outcomes = validatedOutcomes(query.outcomes);
  const rows =
    query.scope === "round"
      ? roundScopeRows(details, requiredRound(query.round), outcomes)
      : query.scope === "all"
        ? allScopeRows(details, outcomes)
        : finalScopeRows(details, outcomes);
  return sortExportRows(rows);
}

function requiredRound(round: number | undefined): number {
  if (round === undefined || !Number.isInteger(round) || round < 1) {
    throw new DomainError("INVALID_ROUND", "按轮次导出时必须提供不小于 1 的整数轮次。");
  }
  return round;
}

function validatedOutcomes(
  outcomes: readonly ExportOutcomeFilter[],
): ReadonlySet<ExportOutcomeFilter> {
  if (outcomes.length === 0) {
    throw new DomainError("INVALID_OUTCOMES", "导出必须至少选择一种执行结果。");
  }
  for (const outcome of outcomes) {
    if (!(EXPORT_OUTCOME_FILTERS as readonly string[]).includes(outcome)) {
      throw new DomainError("INVALID_OUTCOMES", `不支持的执行结果筛选项：${outcome}`);
    }
  }
  return new Set(outcomes);
}

function roundScopeRows(
  details: RunBatchDetails,
  round: number,
  outcomes: ReadonlySet<ExportOutcomeFilter>,
): RunBatchExportRow[] {
  const roundAttempts = runAttemptsForExecutionRound(details.attempts, round);
  const runsById = new Map(details.runs.map((run) => [run.id, run]));
  const rows: RunBatchExportRow[] = [];
  for (const attempt of roundAttempts) {
    if (!matchesOutcomeFilter(attempt, outcomes)) continue;
    const run = runsById.get(attempt.executionRunId);
    rows.push(attemptRow(attempt, run));
  }
  return rows;
}

// all 口径：每个用例在每个逻辑轮次导出最后一次物理 attempt；同轮前序 Runner
// 异常保留在执行机异常视图，不重复计入轮次结果。
function allScopeRows(
  details: RunBatchDetails,
  outcomes: ReadonlySet<ExportOutcomeFilter>,
): RunBatchExportRow[] {
  const runsById = new Map(details.runs.map((run) => [run.id, run]));
  const latestByRunAndRound = new Map<string, RunAttempt>();
  for (const attempt of details.attempts) {
    const key = `${attempt.executionRunId}\u0000${runAttemptExecutionRound(attempt)}`;
    const current = latestByRunAndRound.get(key);
    if (!current || attempt.attemptNumber > current.attemptNumber) {
      latestByRunAndRound.set(key, attempt);
    }
  }
  const rows: RunBatchExportRow[] = [];
  for (const attempt of latestByRunAndRound.values()) {
    if (!matchesOutcomeFilter(attempt, outcomes)) continue;
    rows.push(attemptRow(attempt, runsById.get(attempt.executionRunId)));
  }
  return rows;
}

function finalScopeRows(
  details: RunBatchDetails,
  outcomes: ReadonlySet<ExportOutcomeFilter>,
): RunBatchExportRow[] {
  const latestAttemptByRun = new Map<string, RunAttempt>();
  for (const attempt of details.attempts) {
    const current = latestAttemptByRun.get(attempt.executionRunId);
    if (!current || attempt.attemptNumber > current.attemptNumber) {
      latestAttemptByRun.set(attempt.executionRunId, attempt);
    }
  }
  const rows: RunBatchExportRow[] = [];
  for (const run of details.runs) {
    const attempt = latestAttemptByRun.get(run.id);
    // 从未产生 attempt 的 run 没有任何终止结果，按 blocked 新口径不再导出。
    if (!attempt || !matchesOutcomeFilter(attempt, outcomes, "final", run.status)) continue;
    rows.push(attemptRow(attempt, run, "final"));
  }
  return rows;
}

// blocked 口径下 timed_out/cancelled 是 blocked 的细分别名：timed_out 匹配超时类
// 非正常结束（含 adapter 用例超时），cancelled 匹配取消类；最终结果的取消归为 failed。
const TIMEOUT_BLOCKED_RESULT_CODES: ReadonlySet<string> = new Set([
  "EXECUTION_TIMEOUT",
  "EXECUTION_LOG_SILENCE_TIMEOUT",
  "ADAPTER_CASE_TIMEOUT",
]);
const CANCELLED_BLOCKED_RESULT_CODES: ReadonlySet<string> = new Set([
  "EXECUTION_CANCELLED",
  "EXECUTION_CANCELLED_DURING_RECONCILE",
]);

function matchesOutcomeFilter(
  attempt: Pick<RunAttempt, "status" | "outcome" | "resultCode">,
  outcomes: ReadonlySet<ExportOutcomeFilter>,
  scope: RunBatchExportQuery["scope"] = "round",
  runStatus?: ExecutionRun["status"],
): boolean {
  const outcome = runAttemptOutcome(attempt);
  if (!outcome) return false;
  const category = exportResultCategory(attempt, scope, runStatus);
  if (!category) return false;
  if (outcomes.has(category)) return true;
  // Keep the explicit cancellation filter usable while final exports label it failed.
  if (
    (outcome === "cancelled" || (scope === "final" && runStatus === "cancelled")) &&
    outcomes.has("cancelled")
  )
    return true;
  if (category === "blocked") {
    const resultCode = attempt.resultCode ?? "";
    if (
      outcomes.has("timed_out") &&
      (outcome === "timed_out" || TIMEOUT_BLOCKED_RESULT_CODES.has(resultCode))
    ) {
      return true;
    }
    if (
      outcomes.has("cancelled") &&
      (outcome === "cancelled" || CANCELLED_BLOCKED_RESULT_CODES.has(resultCode))
    ) {
      return true;
    }
  }
  return false;
}

function attemptRow(
  attempt: RunBatchExportPage["items"][number]["attempt"],
  run:
    | (Pick<ExecutionRun, "className" | "displayName"> &
        Partial<Pick<ExecutionRun, "status">> &
        Pick<RunBatchExportRow, "ddt" | "markers">)
    | undefined,
  scope: RunBatchExportQuery["scope"] = "round",
): RunBatchExportRow {
  const category = exportResultCategory(attempt, scope, run?.status);
  if (!category) throw new DomainError("INVALID_OUTCOMES", "进行中的执行尝试不能导出。");
  return {
    attemptId: attempt.id,
    executionRunId: attempt.executionRunId,
    casePath: run?.className ?? "",
    displayName: run?.displayName ?? "",
    ...(run?.ddt ? { ddt: run.ddt } : {}),
    ...(run?.markers ? { markers: run.markers } : {}),
    outcome: category,
    resultCode: attempt.resultCode ?? null,
    summary: category === "succeeded" ? null : (attempt.resultSummary ?? null),
    startedAt: attempt.startedAt ?? null,
    finishedAt: attempt.finishedAt ?? null,
    durationMs: attempt.durationMs ?? null,
    round: runAttemptExecutionRound(attempt),
  };
}

function exportResultCategory(
  attempt: Pick<RunAttempt, "status" | "outcome" | "resultCode">,
  scope: RunBatchExportQuery["scope"],
  runStatus?: ExecutionRun["status"],
): AttemptResultCategory | undefined {
  const outcome = runAttemptOutcome(attempt);
  if (!outcome) return undefined;
  if (scope === "final" && (outcome === "cancelled" || runStatus === "cancelled")) return "failed";
  return classifyAttemptResult({
    outcome,
    ...(attempt.resultCode ? { resultCode: attempt.resultCode } : {}),
  });
}

function sortExportRows(rows: RunBatchExportRow[]): RunBatchExportRow[] {
  return [...rows].sort((left, right) => {
    const byPath = left.casePath.localeCompare(right.casePath);
    if (byPath !== 0) return byPath;
    const byName = left.displayName.localeCompare(right.displayName);
    if (byName !== 0) return byName;
    return left.round - right.round;
  });
}
