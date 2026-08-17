import { EXPORT_OUTCOME_FILTERS, type ExportOutcomeFilter } from "@autoforge/contracts";
import {
  blockedRunsForRound,
  DomainError,
  runAttemptOutcome,
  type ExecutionRun,
  type RunAttempt,
  type RunBatchDetails,
} from "@autoforge/domain";

import type { RunBatchRepository } from "./ports";

/**
 * 导出单行数据。blocked 行没有 attempt：attemptId/时间/耗时均为 null，日志链接由路由层留空。
 * round 为轮次号（即 attemptNumber）；final 范围内没有 attempt 的 blocked 行固定为 0。
 */
export type RunBatchExportRow = {
  attemptId: string | null;
  casePath: string;
  displayName: string;
  outcome: ExportOutcomeFilter;
  resultCode: string | null;
  /** 仅失败/超时尝试有值（一行精简堆栈）。 */
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
    const outcome = runAttemptOutcome(attempt);
    if (!outcome || !outcomes.has(outcome)) continue;
    const run = runsById.get(attempt.executionRunId);
    rows.push(attemptRow(attempt, run));
  }
  if (outcomes.has("blocked")) {
    for (const run of blockedRunsForRound(details.runs, roundAttempts, round)) {
      rows.push(blockedRow(run, round));
    }
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
    if (!attempt) {
      // 从未产生 attempt 的 run 没有最终结果，按阻塞导出。
      if (outcomes.has("blocked")) rows.push(blockedRow(run, 0));
      continue;
    }
    const outcome = runAttemptOutcome(attempt);
    if (!outcome || !outcomes.has(outcome)) continue;
    rows.push(attemptRow(attempt, run));
  }
  return rows;
}

function attemptRow(attempt: RunAttempt, run: ExecutionRun | undefined): RunBatchExportRow {
  const outcome = runAttemptOutcome(attempt);
  if (!outcome) throw new DomainError("INVALID_OUTCOMES", "进行中的执行尝试不能导出。");
  return {
    attemptId: attempt.id,
    casePath: run?.className ?? "",
    displayName: run?.displayName ?? "",
    outcome,
    resultCode: attempt.resultCode ?? null,
    summary:
      outcome === "failed" || outcome === "timed_out" ? (attempt.resultSummary ?? null) : null,
    startedAt: attempt.startedAt ?? null,
    finishedAt: attempt.finishedAt ?? null,
    durationMs: attempt.durationMs ?? null,
    round: attempt.attemptNumber,
  };
}

function blockedRow(run: ExecutionRun, round: number): RunBatchExportRow {
  return {
    attemptId: null,
    casePath: run.className,
    displayName: run.displayName,
    outcome: "blocked",
    resultCode: null,
    summary: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    round,
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
