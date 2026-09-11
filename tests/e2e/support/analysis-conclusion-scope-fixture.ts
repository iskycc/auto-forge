import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { resolve } from "node:path";

export function insertAnalysisConclusionScopeFixture(
  dataDirectory: string,
  suffix: string,
  caseName: string,
  options: {
    className?: string;
    olderIssueDescription?: string;
    olderTicketReference?: string;
  } = {},
) {
  const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
  const otherTaskAnalysisId = `other-task-analysis-${suffix}`;
  const otherCaseAnalysisId = `other-case-analysis-${suffix}`;
  const olderIssueDescription =
    options.olderIssueDescription ?? "OLDER-CASE-CONCLUSION：历史代码问题根因";
  const olderTicketReference = options.olderTicketReference ?? "BUG-OLDER-2048";
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
        "too-old",
        `too-old-analysis-${suffix}`,
        {
          case_definition_id: `case-run-failed-0-${suffix}`,
          class_name: options.className ?? "e2e.analysis.Failed0Test",
        },
      ],
      [
        "older-other-case",
        `older-other-case-analysis-${suffix}`,
        {
          case_definition_id: `case-run-failed-0-${suffix}`,
          class_name: options.className ?? "e2e.analysis.Failed0Test",
        },
      ],
      [
        "other-case",
        otherCaseAnalysisId,
        {
          case_definition_id: `case-run-failed-0-${suffix}`,
          class_name: options.className ?? "e2e.analysis.Failed0Test",
        },
      ],
    ] as const) {
      const historicalBatch = database
        .prepare("SELECT created_at FROM run_batches WHERE id=?")
        .get(`history-batch-${suffix}`) as { created_at: string };
      const olderCompletedAt = new Date(Date.parse(historicalBatch.created_at) - 1).toISOString();
      const batchId = `${label}-batch-${suffix}`;
      const runId = `${label}-run-${suffix}`;
      const attemptId = `${label}-attempt-${suffix}`;
      copyRow("run_batches", `history-batch-${suffix}`, {
        id: batchId,
        sequence_number: label === "other-task" ? 993 : label === "older-other-case" ? 995 : 994,
        suite_name: `${label} 历史结论`,
        ...(label === "too-old" ? { created_at: "2020-01-01T00:00:00.000Z" } : {}),
        ...(label === "older-other-case" ? { created_at: olderCompletedAt } : {}),
        ...(label === "other-task" ? { suite_id: `other-suite-${suffix}` } : {}),
      });
      copyRow("execution_runs", `history-run-${suffix}`, {
        id: runId,
        batch_id: batchId,
        ...caseOverrides,
        ...(label !== "other-task" ? { display_name: caseName } : {}),
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
        ...(label !== "other-task" ? { case_name: caseName } : {}),
        ...(label !== "other-case"
          ? {
              ticket_reference:
                label === "other-task" ? "OTHER-TASK-ISSUE" : "OUTSIDE-FIVE-BATCHES",
            }
          : {
              case_name: caseName,
              category: "case_fixed",
              issue_description: "测试数据字段已经失效",
              case_fix_evidence: "commit abc123，已更新断言数据",
              ticket_reference: null,
            }),
        ...(label === "older-other-case"
          ? {
              completed_at: olderCompletedAt,
              category: "code_issue_filed",
              issue_description: olderIssueDescription,
              ticket_reference: olderTicketReference,
            }
          : {}),
      });
    }
    database.exec("COMMIT");
    return {
      otherTaskAnalysisId,
      otherCaseAnalysisId,
      olderIssueDescription,
      olderTicketReference,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
