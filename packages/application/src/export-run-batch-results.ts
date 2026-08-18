import { EXPORT_OUTCOME_FILTERS, type ExportOutcomeFilter } from "@autoforge/contracts";
import {
  classifyAttemptResult,
  DomainError,
  runAttemptOutcome,
  type AttemptResultCategory,
  type ExecutionRun,
  type RunAttempt,
  type RunBatchDetails,
} from "@autoforge/domain";

import type { RunBatchRepository } from "./ports";

/**
 * 导出单行数据。blocked 口径：除 adapter 正常成功/失败外的任何非正常结束
 * （超时强杀、未拉起 adapter、adapter 异常、取消等）；从未执行的用例没有终止
 * 结果，不导出。round 为轮次号（即 attemptNumber）。
 */
export type RunBatchExportRow = {
  attemptId: string | null;
  casePath: string;
  displayName: string;
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
  scope: "round" | "final";
  /** scope=round 时必填；轮次号即 attemptNumber，初始轮次为 1，与批次详情页一致。 */
  round?: number;
  outcomes: readonly ExportOutcomeFilter[];
  projectIds?: readonly string[];
};

export class RunBatchExportService {
  constructor(private readonly batches: RunBatchRepository) {}

  async buildRows(query: RunBatchExportQuery): Promise<RunBatchExportRow[]> {
    const details = await this.batches.get(query.batchId, query.projectIds);
    if (!details) {
      // 不存在与无权访问统一为 BATCH_NOT_FOUND，避免通过差异探测批次是否存在。
      throw new DomainError("BATCH_NOT_FOUND", "指定的执行批次不存在。");
    }
    return buildRunBatchExportRows(details, query);
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
  const roundAttempts = details.attempts.filter((attempt) => attempt.attemptNumber === round);
  const runsById = new Map(details.runs.map((run) => [run.id, run]));
  const rows: RunBatchExportRow[] = [];
  for (const attempt of roundAttempts) {
    if (!matchesOutcomeFilter(attempt, outcomes)) continue;
    const run = runsById.get(attempt.executionRunId);
    rows.push(attemptRow(attempt, run));
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
    if (!attempt || !matchesOutcomeFilter(attempt, outcomes)) continue;
    rows.push(attemptRow(attempt, run));
  }
  return rows;
}

// blocked 口径下 timed_out/cancelled 是 blocked 的细分别名：timed_out 匹配超时类
// 非正常结束（含 adapter 用例超时），cancelled 匹配取消类；blocked 匹配全部。
const TIMEOUT_BLOCKED_RESULT_CODES: ReadonlySet<string> = new Set([
  "EXECUTION_TIMEOUT",
  "ADAPTER_CASE_TIMEOUT",
]);
const CANCELLED_BLOCKED_RESULT_CODES: ReadonlySet<string> = new Set([
  "EXECUTION_CANCELLED",
  "EXECUTION_CANCELLED_DURING_RECONCILE",
]);

function matchesOutcomeFilter(
  attempt: RunAttempt,
  outcomes: ReadonlySet<ExportOutcomeFilter>,
): boolean {
  const outcome = runAttemptOutcome(attempt);
  if (!outcome) return false;
  const category = classifyAttemptResult({
    outcome,
    ...(attempt.resultCode ? { resultCode: attempt.resultCode } : {}),
  });
  if (outcomes.has(category)) return true;
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

function attemptRow(attempt: RunAttempt, run: ExecutionRun | undefined): RunBatchExportRow {
  const outcome = runAttemptOutcome(attempt);
  if (!outcome) throw new DomainError("INVALID_OUTCOMES", "进行中的执行尝试不能导出。");
  const category: AttemptResultCategory = classifyAttemptResult({
    outcome,
    ...(attempt.resultCode ? { resultCode: attempt.resultCode } : {}),
  });
  return {
    attemptId: attempt.id,
    casePath: run?.className ?? "",
    displayName: run?.displayName ?? "",
    outcome: category,
    resultCode: attempt.resultCode ?? null,
    summary: category === "succeeded" ? null : (attempt.resultSummary ?? null),
    startedAt: attempt.startedAt ?? null,
    finishedAt: attempt.finishedAt ?? null,
    durationMs: attempt.durationMs ?? null,
    round: attempt.attemptNumber,
  };
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
