import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

/** Historical snapshots for list navigation; this does not simulate Runner execution. */
export function insertExecutionRecordsFixture(
  directory: string,
  scope: { projectId: string; projectVersionId: string },
  countPerKind: number,
): void {
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  const recordedAt = new Date().toISOString();
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    const batch = database.prepare(`INSERT INTO run_batches
      (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,
       environment_json,total_runs,project_id,policy_json,created_at,updated_at)
      VALUES (?,(SELECT COALESCE(MAX(sequence_number),0)+1 FROM run_batches),?,?,1,'succeeded',0,'[]',1,?,?,?,?)`);
    const run = database.prepare(`INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
       attempt_count,terminal_outcome,created_at,updated_at)
      VALUES (?,?,?,1,?,?,'succeeded',0,'succeeded',?,?)`);
    for (const kind of ["task", "single"] as const) {
      for (let index = 0; index < countPerKind; index++) {
        const batchId = randomUUID();
        const name = `${kind === "task" ? "任务历史" : "单用例历史"}-${index + 1}`;
        batch.run(
          batchId,
          `${kind === "single" ? "single:" : "history:"}${batchId}`,
          name,
          scope.projectId,
          JSON.stringify({ projectVersionId: scope.projectVersionId }),
          recordedAt,
          recordedAt,
        );
        run.run(
          randomUUID(),
          batchId,
          randomUUID(),
          name,
          `history.Case${index + 1}`,
          recordedAt,
          recordedAt,
        );
      }
    }
    database.exec("COMMIT");
  } catch (cause) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw cause;
  } finally {
    database.close();
  }
}
