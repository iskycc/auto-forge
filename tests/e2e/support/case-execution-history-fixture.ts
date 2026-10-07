import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { ExecutionRun, RunAttempt } from "@autoforge/domain";

type HistoryFixtureState = {
  status: ExecutionRun["status"];
  attemptStatus?: RunAttempt["status"];
  resultCode?: string;
  started?: boolean;
  finished?: boolean;
};

type FixtureConnection = {
  nextBatchSequence: string;
  execute: (statement: string, parameters?: Array<string | number | null>) => Promise<void>;
  close: () => Promise<void>;
};

async function openFixtureConnection(input: {
  directory?: string;
  postgresUrl?: string;
}): Promise<FixtureConnection> {
  if (input.directory) {
    const database = new DatabaseSync(resolve(input.directory, "db", "autoforge.sqlite"));
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    return {
      nextBatchSequence: "(SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM run_batches)",
      execute: async (statement, parameters = []) => {
        database.prepare(statement).run(...parameters);
      },
      close: async () => database.close(),
    };
  }
  if (!input.postgresUrl)
    throw new Error(
      "AUTOFORGE_E2E_DATA_DIR or AUTOFORGE_E2E_POSTGRES_URL is required for history fixtures.",
    );
  const { createPostgresDatabase } = await import("@autoforge/db/postgres");
  const database = createPostgresDatabase({
    connectionString: input.postgresUrl,
    migrationsFolder: resolve(import.meta.dirname, "../../../packages/db/drizzle/postgresql"),
    poolMax: 1,
  });
  await database.ready;
  return {
    nextBatchSequence: "nextval('run_batch_sequence_numbers')",
    execute: async (statement, parameters = []) => {
      let index = 0;
      await database.pool.query(
        statement.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    },
    close: () => database.close(),
  };
}

const completedStates: HistoryFixtureState[] = [
  { status: "succeeded", attemptStatus: "succeeded", resultCode: "TESTNG_SUCCEEDED" },
  { status: "failed", attemptStatus: "failed", resultCode: "TESTNG_ASSERTIONS_FAILED" },
  { status: "failed", attemptStatus: "timed_out", resultCode: "EXECUTION_TIMEOUT" },
];
const incompleteStates: HistoryFixtureState[] = [
  { status: "cancelled", attemptStatus: "cancelled" },
  { status: "queued" },
  { status: "assigned", attemptStatus: "assigned", finished: false },
  { status: "running", attemptStatus: "running", finished: false },
  { status: "failed" },
  { status: "failed", attemptStatus: "failed", started: false },
  { status: "failed", attemptStatus: "failed", finished: false },
];

/** Historical states are fixtures; the browser still reads the real paginated API and detail pages. */
export async function insertCaseExecutionHistoryFixture(input: {
  directory?: string;
  postgresUrl?: string;
  projectId: string;
  projectVersionId: string;
  caseId: string;
  runnerId: string;
  completedCount?: number;
}) {
  const database = await openFixtureConnection(input);
  const completedRunIds: string[] = [];
  try {
    await database.execute(input.directory ? "BEGIN IMMEDIATE" : "BEGIN");
    const insertBatch = `INSERT INTO run_batches
      (id, sequence_number, suite_id, suite_name, suite_version, project_id, policy_json, status,
       retry_limit, environment_json, total_runs, created_at, updated_at)
      VALUES (?, ${database.nextBatchSequence},
        'history-fixture', ?, 1, ?, ?, 'running', 0, '{}', 1, ?, ?)`;
    const insertRun = `INSERT INTO execution_runs
      (id, batch_id, case_definition_id, case_version, display_name, class_name, status,
       attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'History case', 'example.HistoryCase', ?, ?, ?, ?)`;
    const insertAttempt = `INSERT INTO run_attempts
      (id, execution_run_id, runner_id, attempt_number, execution_round, status, scheduling_score,
       result_code, duration_ms, created_at, started_at, finished_at)
      VALUES (?, ?, ?, 1, 1, ?, 1, ?, 1200, ?, ?, ?)`;
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
        createdAt,
        createdAt,
      ]);
      await database.execute(insertRun, [
        runId,
        batchId,
        input.caseId,
        state.status,
        state.attemptStatus ? 1 : 0,
        createdAt,
        createdAt,
      ]);
      if (state.attemptStatus)
        await database.execute(insertAttempt, [
          randomUUID(),
          runId,
          input.runnerId,
          state.attemptStatus,
          state.resultCode ?? "ASSIGNMENT_CLAIM_TIMEOUT",
          createdAt,
          state.started === false ? null : createdAt,
          state.finished === false ? null : createdAt,
        ]);
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
