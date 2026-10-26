import { randomUUID } from "node:crypto";
import { openHistoryFixtureConnection } from "./history-fixture-connection";

/** Historical snapshots for list navigation; this does not simulate Runner execution. */
export async function insertExecutionRecordsFixture(
  directory: string | undefined,
  scope: { projectId: string; projectVersionId: string },
  countPerKind: number,
  postgresUrl?: string,
): Promise<void> {
  const database = await openHistoryFixtureConnection({ directory, postgresUrl });
  const recordedAt = new Date().toISOString();
  try {
    await database.execute(directory ? "BEGIN IMMEDIATE" : "BEGIN");
    const batch = `INSERT INTO run_batches
      (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,
       environment_json,total_runs,project_id,policy_json,created_at,updated_at)
      VALUES (?,${database.nextBatchSequence},?,?,1,'succeeded',0,'[]',1,?,?,?,?)`;
    const run = `INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
       attempt_count,terminal_outcome,created_at,updated_at)
      VALUES (?,?,?,1,?,?,'succeeded',0,'succeeded',?,?)`;
    for (const kind of ["task", "single"] as const) {
      for (let index = 0; index < countPerKind; index++) {
        const batchId = randomUUID();
        const name = `${kind === "task" ? "任务历史" : "单用例历史"}-${index + 1}`;
        await database.execute(batch, [
          batchId,
          `${kind === "single" ? "single:" : "history:"}${batchId}`,
          name,
          scope.projectId,
          JSON.stringify({ projectVersionId: scope.projectVersionId }),
          recordedAt,
          recordedAt,
        ]);
        await database.execute(run, [
          randomUUID(),
          batchId,
          randomUUID(),
          name,
          `history.Case${index + 1}`,
          recordedAt,
          recordedAt,
        ]);
      }
    }
    await database.execute("COMMIT");
  } catch (cause) {
    await database.execute("ROLLBACK");
    throw cause;
  } finally {
    await database.close();
  }
}
