import { randomUUID } from "node:crypto";
import type { ExecutionRun, RunAttempt } from "@autoforge/domain";
import { openHistoryFixtureConnection } from "./history-fixture-connection";

type HistoryFixtureAttempt = {
  status: RunAttempt["status"];
  resultCode?: string;
  started?: boolean;
  finished?: boolean;
};

type HistoryFixtureState = {
  status: ExecutionRun["status"];
  batchStatus?: "running" | "cancelled" | "failed";
  attempts: HistoryFixtureAttempt[];
};

const passed: HistoryFixtureAttempt = { status: "succeeded", resultCode: "TESTNG_SUCCEEDED" };
const failed: HistoryFixtureAttempt = { status: "failed", resultCode: "TESTNG_ASSERTIONS_FAILED" };
const completedStates: HistoryFixtureState[] = [
  { status: "succeeded", attempts: [passed] },
  { status: "failed", attempts: [failed] },
  { status: "failed", attempts: [{ status: "timed_out", resultCode: "EXECUTION_TIMEOUT" }] },
  { status: "cancelled", batchStatus: "cancelled", attempts: [failed, failed, passed] },
  { status: "cancelled", batchStatus: "failed", attempts: [passed, failed] },
  {
    status: "cancelled",
    batchStatus: "cancelled",
    attempts: [failed, { status: "cancelled", started: false }],
  },
  {
    status: "cancelled",
    batchStatus: "cancelled",
    attempts: [{ status: "cancelled", resultCode: "EXECUTION_CANCELLED" }],
  },
];
const incompleteStates: HistoryFixtureState[] = [
  { status: "cancelled", attempts: [{ status: "cancelled", started: false }] },
  { status: "queued", attempts: [] },
  { status: "assigned", attempts: [{ status: "assigned", started: false, finished: false }] },
  { status: "running", attempts: [{ status: "running", finished: false }] },
  { status: "failed", attempts: [] },
  { status: "failed", attempts: [{ status: "failed", started: false }] },
  { status: "failed", attempts: [{ status: "failed", finished: false }] },
];

/** Historical states are fixtures; the browser still reads the real paginated API and detail pages. */
export async function insertCaseExecutionHistoryFixture(input: {
  directory?: string;
  postgresUrl?: string;
  projectId: string;
  projectVersionId: string;
  caseId: string;
  caseType?: "testng" | "ddt";
  runnerId: string;
  completedCount?: number;
}) {
  const database = await openHistoryFixtureConnection(input);
  const completedRunIds: string[] = [];
  try {
    await database.execute(input.directory ? "BEGIN IMMEDIATE" : "BEGIN");
    const insertBatch = `INSERT INTO run_batches
      (id, sequence_number, suite_id, suite_name, suite_version, project_id, policy_json, status,
       retry_limit, environment_json, total_runs, created_at, updated_at)
      VALUES (?, ${database.nextBatchSequence},
        'history-fixture', ?, 1, ?, ?, ?, 0, '{}', 1, ?, ?)`;
    const insertRun = `INSERT INTO execution_runs
      (id, batch_id, case_definition_id, case_version, display_name, class_name, case_type, status,
       attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'History case', 'example.HistoryCase', ?, ?, ?, ?, ?)`;
    const insertAttempt = `INSERT INTO run_attempts
      (id, execution_run_id, runner_id, attempt_number, execution_round, status, scheduling_score,
       result_code, duration_ms, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1200, ?, ?, ?)`;
    const completedCount = input.completedCount ?? 51;
    const states = [
      ...Array.from(
        { length: completedCount },
        (_, index) => completedStates[index % completedStates.length]!,
      ),
      ...incompleteStates,
    ];
    for (const [index, state] of states.entries()) {
      const batchId = randomUUID();
      const runId = randomUUID();
      const createdAt = new Date(Date.UTC(2026, 9, 6, 0, index)).toISOString();
      const completed = index < completedCount;
      await database.execute(insertBatch, [
        batchId,
        `${completed ? "已完成历史" : "隐藏历史"} ${index + 1}`,
        input.projectId,
        JSON.stringify({ projectVersionId: input.projectVersionId }),
        state.batchStatus ?? "running",
        createdAt,
        createdAt,
      ]);
      await database.execute(insertRun, [
        runId,
        batchId,
        input.caseId,
        input.caseType ?? "testng",
        state.status,
        state.attempts.length,
        createdAt,
        createdAt,
      ]);
      for (const [attemptIndex, attempt] of state.attempts.entries()) {
        await database.execute(insertAttempt, [
          randomUUID(),
          runId,
          input.runnerId,
          attemptIndex + 1,
          attemptIndex + 1,
          attempt.status,
          attempt.resultCode ?? "ASSIGNMENT_CLAIM_TIMEOUT",
          createdAt,
          attempt.started === false ? null : createdAt,
          attempt.finished === false ? null : createdAt,
        ]);
      }
      if (completed) completedRunIds.unshift(runId);
    }
    await database.execute("COMMIT");
    return { completedRunIds };
  } catch (error) {
    await database.execute("ROLLBACK");
    throw error;
  } finally {
    await database.close();
  }
}
