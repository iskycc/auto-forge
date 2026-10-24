import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";

/** Exercise the production worker heap/queue with a large version, without HTTP member hydration. */
export async function insertVersionCopyScaleFixture(
  directory: string,
  scope: {
    projectId: string;
    projectVersionId: string;
    testStageId: string;
    suiteId: string;
    classId: string;
  },
) {
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  const prefix = `${scope.projectVersionId}-scale-`;
  const now = new Date().toISOString();
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=25");
    for (let first = 1; first < 100000; first += 1000) {
      const last = Math.min(99999, first + 999);
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(
            `WITH RECURSIVE numbers(n) AS (SELECT ? UNION ALL SELECT n+1 FROM numbers WHERE n<?)
          INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,execution_case_definition_id,source_name,created_at,updated_at)
          SELECT ?||n,?,?,?,'COPY-'||n,'copy-'||n,'PAY','pay','standard',json_object('CaseID','COPY-'||n,'srNum','PAY','CaseName','规模用例'),?,'规模验收',?,? FROM numbers`,
          )
          .run(
            first,
            last,
            prefix,
            scope.projectId,
            scope.projectVersionId,
            scope.testStageId,
            scope.classId,
            now,
            now,
          );
        database
          .prepare(
            `WITH RECURSIVE numbers(n) AS (SELECT ? UNION ALL SELECT n+1 FROM numbers WHERE n<?)
          INSERT INTO case_suite_ddt_items(id,suite_id,ddt_case_id,added_at) SELECT ?||n,?,?||n,? FROM numbers`,
          )
          .run(first, last, `${scope.suiteId}-member-`, scope.suiteId, prefix, now);
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
      await yieldTurn();
    }
    database
      .prepare(
        `UPDATE case_suite_versions SET snapshot_json=json_set(snapshot_json,'$.ddtCaseIds',json((SELECT json_group_array(id) FROM ddt_cases WHERE project_version_id=?))) WHERE suite_id=? AND version=(SELECT MAX(version) FROM case_suite_versions WHERE suite_id=?)`,
      )
      .run(scope.projectVersionId, scope.suiteId, scope.suiteId);
  } finally {
    database.close();
  }
}

export function copiedVersionMemberCount(directory: string, versionId: string): number {
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM case_suite_ddt_items m JOIN case_suites s ON s.id=m.suite_id WHERE json_extract(s.policy_json,'$.projectVersionId')=?",
      )
      .get(versionId) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}
