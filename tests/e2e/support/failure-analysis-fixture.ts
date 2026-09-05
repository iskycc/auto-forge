import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

export function insertFailureAnalysisFixture(
  dataDirectory: string,
  projectVersionId: string,
  suffix: string,
) {
  const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
  const batchId = randomUUID();
  const runnerId = `analysis-runner-${suffix}`;
  const suiteName = `E2E 失败分析任务 ${suffix}`;
  const failedNames: [string, string, string, string] = [
    `失败 Alpha ${suffix}`,
    `失败 Beta ${suffix}`,
    `失败 Gamma ${suffix}`,
    `失败 Zeta ${suffix}`,
  ];
  const passedName = `通过用例 ${suffix}`;
  const recordedAt = new Date().toISOString();
  const historicalRecordedAt = new Date(Date.now() - 86_400_000).toISOString();
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database
      .prepare(
        `INSERT INTO case_suites
      (id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at)
      VALUES (?,?,?,'',1,'active',1,1,'{}',?,?)`,
      )
      .run(`suite-${suffix}`, DEFAULT_PROJECT_ID, suiteName, recordedAt, recordedAt);
    database
      .prepare(
        `INSERT INTO runners
      (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,
       labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
      VALUES (?,?,?,0,0,'linux','amd64','1.0.0',1,'[]','[]',4,0,?,?,?)`,
      )
      .run(runnerId, `hash-${suffix}`, `分析 Runner ${suffix}`, recordedAt, recordedAt, recordedAt);
    database
      .prepare(
        `INSERT INTO run_batches
      (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,
       total_runs,project_id,policy_json,created_at,updated_at)
      VALUES (?,991,?,?,1,'succeeded',0,'[]',5,?,?,?,?)`,
      )
      .run(
        batchId,
        `suite-${suffix}`,
        suiteName,
        DEFAULT_PROJECT_ID,
        JSON.stringify({ projectVersionId }),
        recordedAt,
        recordedAt,
      );
    const historicalBatchId = `history-batch-${suffix}`;
    const historicalRunId = `history-run-${suffix}`;
    const historicalAttemptId = `history-attempt-${suffix}`;
    const historicalCaseDefinitionId = `case-run-failed-2-${suffix}`;
    database
      .prepare(
        `INSERT INTO run_batches
      (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,
       total_runs,project_id,policy_json,created_at,updated_at)
      VALUES (?,990,?,?,1,'failed',0,'[]',1,?,?,?,?)`,
      )
      .run(
        historicalBatchId,
        `suite-${suffix}`,
        `历史代码问题 ${suffix}`,
        DEFAULT_PROJECT_ID,
        JSON.stringify({ projectVersionId }),
        historicalRecordedAt,
        historicalRecordedAt,
      );
    database
      .prepare(
        `INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,
       terminal_outcome,created_at,updated_at)
      VALUES (?,?,?,1,?,?,'failed',1,'failed',?,?)`,
      )
      .run(
        historicalRunId,
        historicalBatchId,
        historicalCaseDefinitionId,
        failedNames[2],
        "e2e.analysis.Failed2Test",
        historicalRecordedAt,
        historicalRecordedAt,
      );
    database
      .prepare(
        `INSERT INTO run_attempts
      (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_code,
       result_summary,created_at,finished_at)
      VALUES (?,?,?,1,'failed',1,'failed','TEST_ASSERTION_FAILED',?,?,?)`,
      )
      .run(
        historicalAttemptId,
        historicalRunId,
        runnerId,
        "Historical assertion failure",
        historicalRecordedAt,
        historicalRecordedAt,
      );
    database
      .prepare(
        `INSERT INTO failure_analysis_claims
      (id,project_id,batch_id,execution_run_id,case_definition_id,attempt_id,case_name,class_name,
       attempt_number,failure_summary,result_code,status,category,claimant_id,claimant_username,
       claimant_display_name,claimed_at,analysis_started_at,completed_at,issue_description,
       ticket_reference,remark,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,'TEST_ASSERTION_FAILED','completed','code_issue_filed',
              'historical-analyst','c10086','历史分析员',?,?,?,?,?,?,?)`,
      )
      .run(
        `history-analysis-${suffix}`,
        DEFAULT_PROJECT_ID,
        historicalBatchId,
        historicalRunId,
        historicalCaseDefinitionId,
        historicalAttemptId,
        failedNames[2],
        "e2e.analysis.Failed2Test",
        "Historical assertion failure",
        historicalRecordedAt,
        historicalRecordedAt,
        historicalRecordedAt,
        "历史状态字段转换错误",
        "BUG-1023",
        "等待修复",
        historicalRecordedAt,
      );
    const cases = [
      ...failedNames.map(
        (name, index) =>
          [
            `run-failed-${index}-${suffix}`,
            name,
            `e2e.analysis.Failed${index}Test`,
            `Assertion failure ${index}`,
            "failed",
          ] as const,
      ),
      [`run-pass-${suffix}`, passedName, "e2e.analysis.PassedTest", "", "succeeded"] as const,
    ];
    for (const [runId, name, className, summary, outcome] of cases) {
      database
        .prepare(
          `INSERT INTO execution_runs
        (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,
         terminal_outcome,created_at,updated_at) VALUES (?,?,?,1,?,?,?,1,?,?,?)`,
        )
        .run(
          runId,
          batchId,
          `case-${runId}`,
          name,
          className,
          outcome,
          outcome,
          recordedAt,
          recordedAt,
        );
      database
        .prepare(
          `INSERT INTO run_attempts
        (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_code,
         result_summary,created_at,finished_at) VALUES (?,?,?,1,?,1,?,'TESTNG_RESULT',?,?,?)`,
        )
        .run(
          `attempt-${runId}`,
          runId,
          runnerId,
          outcome,
          outcome,
          summary,
          recordedAt,
          recordedAt,
        );
    }
    const rerunBatchId = `successful-rerun-batch-${suffix}`;
    const rerunRunId = `successful-rerun-run-${suffix}`;
    database
      .prepare(
        `INSERT INTO run_batches
      (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,batch_kind,
       parent_batch_id,source_execution_run_id,environment_json,total_runs,project_id,policy_json,
       created_at,updated_at)
      VALUES (?,992,'single:analysis','成功日志重跑',1,'succeeded',0,'case_log_rerun',?,?,
              '[]',1,?,'{}',?,?)`,
      )
      .run(
        rerunBatchId,
        batchId,
        `run-failed-0-${suffix}`,
        DEFAULT_PROJECT_ID,
        recordedAt,
        recordedAt,
      );
    database
      .prepare(
        `INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,
       terminal_outcome,created_at,updated_at)
      VALUES (?,?,'case-successful-rerun',1,'成功日志重跑','e2e.analysis.RerunTest','succeeded',1,
              'succeeded',?,?)`,
      )
      .run(rerunRunId, rerunBatchId, recordedAt, recordedAt);
    database
      .prepare(
        `INSERT INTO run_attempts
      (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_code,
       result_summary,created_at,finished_at)
      VALUES (?,?,?,1,'succeeded',1,'succeeded','TESTNG_SUCCEEDED','manual rerun passed',?,?)`,
      )
      .run(`successful-rerun-attempt-${suffix}`, rerunRunId, runnerId, recordedAt, recordedAt);
    return { batchId, failedNames, passedName, suiteName };
  } finally {
    database.close();
  }
}
