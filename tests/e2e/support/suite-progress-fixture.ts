import { randomUUID } from "node:crypto";
import { openHistoryFixtureConnection } from "./history-fixture-connection";

/** Completed history for visual checks; execution protocol coverage lives in Runner E2E. */
export async function insertSuiteProgressFixture(
  dataDirectory: string | undefined,
  scope: { projectId: string; projectVersionId: string },
  suites: Array<{ id: string; name: string; passedRuns: number }>,
  postgresUrl?: string,
) {
  const database = await openHistoryFixtureConnection({ directory: dataDirectory, postgresUrl });
  const recordedAt = new Date().toISOString();
  try {
    await database.execute(dataDirectory ? "BEGIN IMMEDIATE" : "BEGIN");
    for (const suite of suites) {
      const batchId = randomUUID();
      await database.execute(
        `INSERT INTO run_batches
          (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,
           environment_json,total_runs,project_id,policy_json,created_at,updated_at)
          VALUES (?,${database.nextBatchSequence},?,?,1,?,0,'[]',2,?,?,?,?)`,
        [
          batchId,
          suite.id,
          suite.name,
          suite.passedRuns === 2 ? "succeeded" : "failed",
          scope.projectId,
          JSON.stringify({ projectVersionId: scope.projectVersionId }),
          recordedAt,
          recordedAt,
        ],
      );
      for (let index = 0; index < 2; index++) {
        const outcome = index < suite.passedRuns ? "succeeded" : "failed";
        await database.execute(
          `INSERT INTO execution_runs
            (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
             attempt_count,terminal_outcome,created_at,updated_at)
            VALUES (?,?,?,1,?,?,?,0,?,?,?)`,
          [
            randomUUID(),
            batchId,
            randomUUID(),
            `显示验证用例 ${index + 1}`,
            `e2e.progress.Case${index + 1}Test`,
            outcome,
            outcome,
            recordedAt,
            recordedAt,
          ],
        );
      }
    }
    await database.execute("COMMIT");
  } catch (error) {
    await database.execute("ROLLBACK");
    throw error;
  } finally {
    await database.close();
  }
}
