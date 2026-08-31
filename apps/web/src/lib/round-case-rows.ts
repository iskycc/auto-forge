import {
  executionRunsForRound,
  finalRunAttemptByExecutionRun,
  isTerminalAttemptStatus,
  runBatchRoundNumbers,
  type ExecutionRun,
  type RunAttempt,
  type RunBatchDetails,
} from "@autoforge/domain";

export type RoundCaseRowModel = {
  run: ExecutionRun;
  attempt: RunAttempt | undefined;
  round: number;
};

/**
 * 组装轮次用例表的行。
 *
 * 具体轮次：首轮包含全部用例，后续轮次只包含上一轮失败/超时或已经存在本轮
 * attempt 的用例；无 attempt 的资格行表示真正等待本轮调度。
 *
 * "all" 虚拟轮次：按轮次资格展开，同一用例在每个所属轮次各占一行；尚未产生
 * attempt 的资格行同样保留，保证详情行数与“全部轮次”总数/未执行数完全一致。
 */
export function buildRoundCaseRows(
  batch: Pick<RunBatchDetails, "currentRound" | "runs" | "attempts">,
  round: number | "all" | "summary",
): RoundCaseRowModel[] {
  if (round === "summary") {
    const finalAttempts = finalRunAttemptByExecutionRun(batch.attempts);
    return batch.runs.map((run) => {
      const attempt = finalAttempts.get(run.id);
      return { run, attempt, round: attempt?.attemptNumber ?? 1 };
    });
  }
  if (round === "all") {
    const roundNumbers = runBatchRoundNumbers(batch, batch.runs, batch.attempts);
    const eligibleRunIdsByRound = new Map(
      roundNumbers.map((roundNumber) => [
        roundNumber,
        new Set(
          executionRunsForRound(batch.runs, batch.attempts, roundNumber).map((run) => run.id),
        ),
      ]),
    );
    const attemptsByRunAndRound = new Map(
      batch.attempts.map((attempt) => [
        runRoundKey(attempt.executionRunId, attempt.attemptNumber),
        attempt,
      ]),
    );
    const rows: RoundCaseRowModel[] = [];
    for (const run of batch.runs) {
      for (const roundNumber of roundNumbers) {
        if (!eligibleRunIdsByRound.get(roundNumber)?.has(run.id)) continue;
        rows.push({
          run,
          round: roundNumber,
          attempt: attemptsByRunAndRound.get(runRoundKey(run.id, roundNumber)),
        });
      }
    }
    return rows;
  }

  return executionRunsForRound(batch.runs, batch.attempts, round).map((run) => ({
    run,
    round,
    attempt: batch.attempts.find(
      (attempt) => attempt.executionRunId === run.id && attempt.attemptNumber === round,
    ),
  }));
}

/** 终态行只表示历史结果；run 已排队重跑也不能在该历史行上提供取消操作。 */
export function canCancelRoundCaseRow(row: RoundCaseRowModel): boolean {
  const runCanBeCancelled = ["queued", "assigned", "running"].includes(row.run.status);
  if (!runCanBeCancelled) return false;
  return row.attempt === undefined || !isTerminalAttemptStatus(row.attempt.status);
}

function runRoundKey(runId: string, round: number): string {
  return `${runId}:${round}`;
}
