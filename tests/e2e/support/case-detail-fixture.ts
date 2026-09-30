import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { insertFailureAnalysisFixture } from "./failure-analysis-fixture";

/** Attach long historical labels and a completed analysis to a genuinely imported case. */
export function attachCaseDetailHistoryFixture(
  directory: string,
  projectId: string,
  versionId: string,
  caseId: string,
  suffix: string,
) {
  const fixture = insertFailureAnalysisFixture(directory, versionId, suffix);
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("UPDATE run_batches SET project_id=?, suite_name=? WHERE suite_id=?")
      .run(projectId, "支付回归任务_" + "LongBatchName".repeat(12), `suite-${suffix}`);
    database
      .prepare("UPDATE execution_runs SET case_definition_id=? WHERE case_definition_id=?")
      .run(caseId, `case-run-failed-2-${suffix}`);
    database
      .prepare(
        "UPDATE failure_analysis_claims SET project_id=?,case_definition_id=? WHERE case_definition_id=?",
      )
      .run(projectId, caseId, `case-run-failed-2-${suffix}`);
    database
      .prepare("UPDATE runners SET name=? WHERE id=?")
      .run("执行节点_" + "LongRunnerName".repeat(10), `analysis-runner-${suffix}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return fixture;
}
