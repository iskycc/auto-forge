import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

/** Completed history for visual checks; execution protocol coverage lives in Runner E2E. */
export function insertSuiteProgressFixture(
  dataDirectory: string,
  scope: { projectId: string; projectVersionId: string },
  suites: Array<{ id: string; name: string; passedRuns: number }>,
) {
  const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
  const recordedAt = new Date().toISOString();
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.exec("BEGIN IMMEDIATE");
    for (const suite of suites) {
      const batchId = randomUUID();
      database
        .prepare(
          `INSERT INTO run_batches
          (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,
           environment_json,total_runs,project_id,policy_json,created_at,updated_at)
          VALUES (?,1,?,?,1,?,0,'[]',2,?,?,?,?)`,
        )
        .run(
          batchId,
          suite.id,
          suite.name,
          suite.passedRuns === 2 ? "succeeded" : "failed",
          scope.projectId,
          JSON.stringify({ projectVersionId: scope.projectVersionId }),
          recordedAt,
          recordedAt,
        );
      for (let index = 0; index < 2; index++) {
        const outcome = index < suite.passedRuns ? "succeeded" : "failed";
        database
          .prepare(
            `INSERT INTO execution_runs
            (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
             attempt_count,terminal_outcome,created_at,updated_at)
            VALUES (?,?,?,1,?,?,?,0,?,?,?)`,
          )
          .run(
            randomUUID(),
            batchId,
            randomUUID(),
            `显示验证用例 ${index + 1}`,
            `e2e.progress.Case${index + 1}Test`,
            outcome,
            outcome,
            recordedAt,
            recordedAt,
          );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
