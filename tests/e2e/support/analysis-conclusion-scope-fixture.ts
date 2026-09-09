import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { resolve } from "node:path";

export function insertAnalysisConclusionScopeFixture(
  dataDirectory: string,
  suffix: string,
  caseName: string,
) {
  const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
  const otherTaskAnalysisId = `other-task-analysis-${suffix}`;
  const sameCaseAnalysisId = `same-case-analysis-${suffix}`;
  function copyRow(
    table: "run_batches" | "execution_runs" | "run_attempts" | "failure_analysis_claims",
    sourceId: string,
    overrides: Record<string, SQLInputValue>,
  ) {
    const source = database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(sourceId);
    if (!source) throw new Error(`Missing conclusion scope fixture: ${table}`);
    const row = { ...source, ...overrides };
    const columns = Object.keys(row);
    database
      .prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...Object.values(row));
  }
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.exec("BEGIN IMMEDIATE");
    for (const [label, analysisId, caseOverrides] of [
      ["other-task", otherTaskAnalysisId, {}],
      [
        "same-case",
        sameCaseAnalysisId,
        {
          case_definition_id: `case-run-failed-3-${suffix}`,
          class_name: "e2e.analysis.Failed3Test",
        },
      ],
    ] as const) {
      const batchId = `${label}-batch-${suffix}`;
      const runId = `${label}-run-${suffix}`;
      const attemptId = `${label}-attempt-${suffix}`;
      copyRow("run_batches", `history-batch-${suffix}`, {
        id: batchId,
        sequence_number: label === "other-task" ? 993 : 994,
        suite_name: `${label} 历史结论`,
        ...(label === "other-task" ? { suite_id: `other-suite-${suffix}` } : {}),
      });
      copyRow("execution_runs", `history-run-${suffix}`, {
        id: runId,
        batch_id: batchId,
        ...caseOverrides,
        ...(label === "same-case" ? { display_name: caseName } : {}),
      });
      copyRow("run_attempts", `history-attempt-${suffix}`, {
        id: attemptId,
        execution_run_id: runId,
      });
      copyRow("failure_analysis_claims", `history-analysis-${suffix}`, {
        id: analysisId,
        batch_id: batchId,
        execution_run_id: runId,
        attempt_id: attemptId,
        ...caseOverrides,
        ...(label === "other-task"
          ? { ticket_reference: "OTHER-TASK-ISSUE" }
          : {
              case_name: caseName,
              category: "case_fixed",
              issue_description: "测试数据字段已经失效",
              case_fix_evidence: "commit abc123，已更新断言数据",
              ticket_reference: null,
            }),
      });
    }
    database.exec("COMMIT");
    return { otherTaskAnalysisId, sameCaseAnalysisId };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
