import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { insertFailureAnalysisFixture } from "./failure-analysis-fixture";

/** Historical snapshots exercise real list queries without running Java processes. */
export function insertExecutionCaseSortFixture(
  directory: string,
  versionId: string,
  suffix: string,
) {
  const fixture = insertFailureAnalysisFixture(directory, versionId, suffix);
  const entries = [
    {
      id: `run-failed-0-${suffix}`,
      displayName: "ZebraTest",
      className: "com.alpha.integration.ZebraTest",
      caseType: "testng",
    },
    {
      id: `run-failed-1-${suffix}`,
      displayName: "AlphaTest",
      className: "com.beta.integration.AlphaTest",
      caseType: "testng",
    },
    {
      id: `run-failed-2-${suffix}`,
      displayName: "MiddleTest",
      className: "com.alpha.integration.MiddleTest",
      caseType: "testng",
    },
    {
      id: `run-failed-3-${suffix}`,
      displayName: "a DDT 01",
      className: "com.zeta.adapter.ZebraTest",
      caseType: "ddt",
    },
    {
      id: `run-pass-${suffix}`,
      displayName: "b DDT 02",
      className: "com.alpha.adapter.AlphaTest",
      caseType: "ddt",
    },
  ];
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    database
      .prepare("UPDATE run_batches SET scheduled_for=created_at WHERE id=?")
      .run(fixture.batchId);
    database
      .prepare(
        "UPDATE run_attempts SET started_at=created_at WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id=?)",
      )
      .run(fixture.batchId);
    const updateRun = database.prepare(
      "UPDATE execution_runs SET display_name=?,class_name=?,case_type=? WHERE id=? AND batch_id=?",
    );
    for (const entry of entries)
      updateRun.run(entry.displayName, entry.className, entry.caseType, entry.id, fixture.batchId);
    database.exec("COMMIT");
    return {
      batchId: fixture.batchId,
      originalNames: entries.map(({ displayName }) => displayName),
      ascendingNames: [
        entries[3]!.displayName,
        entries[4]!.displayName,
        entries[2]!.displayName,
        entries[0]!.displayName,
        entries[1]!.displayName,
      ],
    };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
