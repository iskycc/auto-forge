import type { ExecutionRun, RunAttempt, RunBatchDetails } from "@autoforge/domain";

export type RoundCaseRowModel = {
  run: ExecutionRun;
  attempt: RunAttempt | undefined;
};

/**
 * 组装轮次用例表的行。
 *
 * 具体轮次：每个未在前轮通过的用例一行，attempt 为该轮记录（无记录即等待本轮）。
 * 调度语义上前轮已通过的用例不再进入后续轮次，把它们显示为「未执行」是误导，
 * 因此直接过滤；remaining 无 attempt 的行才是真正等待本轮调度的用例。
 *
 * "all" 虚拟轮次：同一用例的每条 attempt 各占一行（按轮次升序），由轮次列区分；
 * 从未执行的用例保留一行占位，便于筛选「未执行」。
 */
export function buildRoundCaseRows(
  batch: Pick<RunBatchDetails, "runs" | "attempts">,
  round: number | "all",
): RoundCaseRowModel[] {
  if (round === "all") {
    const attemptsByRun = new Map<string, RunAttempt[]>();
    for (const attempt of batch.attempts) {
      const list = attemptsByRun.get(attempt.executionRunId) ?? [];
      list.push(attempt);
      attemptsByRun.set(attempt.executionRunId, list);
    }
    const rows: RoundCaseRowModel[] = [];
    for (const run of batch.runs) {
      const runAttempts = (attemptsByRun.get(run.id) ?? [])
        .slice()
        .sort((left, right) => left.attemptNumber - right.attemptNumber);
      if (runAttempts.length === 0) {
        rows.push({ run, attempt: undefined });
      } else {
        for (const attempt of runAttempts) rows.push({ run, attempt });
      }
    }
    return rows;
  }

  const passedBeforeRound = new Set<string>();
  for (const attempt of batch.attempts) {
    if (attempt.attemptNumber < round && attempt.outcome === "succeeded") {
      passedBeforeRound.add(attempt.executionRunId);
    }
  }
  return batch.runs
    .filter((run) => !passedBeforeRound.has(run.id))
    .map((run) => ({
      run,
      attempt: batch.attempts.find(
        (attempt) => attempt.executionRunId === run.id && attempt.attemptNumber === round,
      ),
    }));
}
