import { isRetryableRunnerFailure, type RunBatchDetails } from "@autoforge/domain";

export type RunnerFaultIncident = {
  key: string;
  runnerId: string;
  resultCode: string;
  summary: string;
  count: number;
  caseNames: string[];
  attemptNumbers: number[];
  lastOccurredAt: string;
};

/** 按执行机、错误码和错误描述聚合可自动重调度的基础设施异常。 */
export function buildRunnerFaultIncidents(
  batch: Pick<RunBatchDetails, "runs" | "attempts">,
): RunnerFaultIncident[] {
  const names = new Map(batch.runs.map((run) => [run.id, run.displayName]));
  const grouped = new Map<string, RunnerFaultIncident>();
  for (const attempt of batch.attempts) {
    if (!isRetryableRunnerFailure(attempt.resultCode)) continue;
    const resultCode = attempt.resultCode!;
    const summary = compact(attempt.resultSummary) || "执行机未提供错误描述。";
    const key = `${attempt.runnerId}\u0000${resultCode}\u0000${summary}`;
    const occurredAt = attempt.finishedAt ?? attempt.startedAt ?? attempt.createdAt;
    const incident = grouped.get(key) ?? {
      key,
      runnerId: attempt.runnerId,
      resultCode,
      summary,
      count: 0,
      caseNames: [],
      attemptNumbers: [],
      lastOccurredAt: occurredAt,
    };
    incident.count += 1;
    const caseName = names.get(attempt.executionRunId) ?? attempt.executionRunId;
    if (!incident.caseNames.includes(caseName)) incident.caseNames.push(caseName);
    if (!incident.attemptNumbers.includes(attempt.attemptNumber)) {
      incident.attemptNumbers.push(attempt.attemptNumber);
    }
    if (Date.parse(occurredAt) > Date.parse(incident.lastOccurredAt)) {
      incident.lastOccurredAt = occurredAt;
    }
    grouped.set(key, incident);
  }
  return [...grouped.values()].sort(
    (left, right) =>
      right.count - left.count ||
      Date.parse(right.lastOccurredAt) - Date.parse(left.lastOccurredAt),
  );
}

function compact(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
