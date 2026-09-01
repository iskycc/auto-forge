import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createSqliteDatabase } from "../src/database";
import { SqliteFailureAnalysisRepository } from "../src/sqlite-failure-analysis";
import { failureAnalysisContract, type FailureAnalysisHarness } from "./failure-analysis.contract";

const PROJECT_ID = "00000000-0000-7000-8000-000000000001";
const PROJECT_VERSION_ID = "analysis-version";
const RECORDED_AT = "2026-09-01T00:00:00.000Z";

failureAnalysisContract("SQLite failure analysis", async (): Promise<FailureAnalysisHarness> => {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-failure-analysis-"));
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const batchId = "analysis-batch";
  const activeBatchId = "analysis-active-batch";
  const excludedBatchIds: [string, string] = ["analysis-single-batch", "analysis-derived-batch"];
  const runIds: [string, string, string] = ["run-zeta", "run-alpha", "run-middle"];
  handle.client
    .prepare(
      `INSERT INTO runners
        (id,credential_hash,name,disabled,draining,os,architecture,agent_version,
         protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,
         last_seen_at,created_at,updated_at)
       VALUES ('analysis-runner','hash','分析 Runner',0,0,'linux','amd64','1.0.0',1,
               '[]','[]',4,0,?,?,?)`,
    )
    .run(RECORDED_AT, RECORDED_AT, RECORDED_AT);
  handle.client
    .prepare(
      `INSERT INTO case_suites
        (id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at)
       VALUES ('suite-analysis',?,'失败分析任务','',1,'active',1,1,'{}',?,?)`,
    )
    .run(PROJECT_ID, RECORDED_AT, RECORDED_AT);
  handle.client
    .prepare(
      `INSERT INTO run_batches
        (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,
         environment_json,total_runs,current_round,project_id,policy_json,created_at,updated_at)
       VALUES (?,81,'suite-analysis','失败分析任务',1,'succeeded',1,'[]',4,2,?,?,?,?)`,
    )
    .run(
      batchId,
      PROJECT_ID,
      JSON.stringify({ projectVersionId: PROJECT_VERSION_ID }),
      RECORDED_AT,
      RECORDED_AT,
    );
  handle.client
    .prepare(
      `INSERT INTO run_batches
        (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,batch_kind,
         environment_json,total_runs,project_id,policy_json,created_at,updated_at)
       VALUES (?,83,?,'单用例',1,'succeeded',0,'standard','[]',1,?,?,?,?),
              (?,84,'suite-analysis','最后失败再次执行',1,'succeeded',0,'final_failure_rerun',
               '[]',1,?,?,?,?)`,
    )
    .run(
      excludedBatchIds[0],
      "single:case-a",
      PROJECT_ID,
      JSON.stringify({ projectVersionId: PROJECT_VERSION_ID }),
      RECORDED_AT,
      RECORDED_AT,
      excludedBatchIds[1],
      PROJECT_ID,
      JSON.stringify({ projectVersionId: PROJECT_VERSION_ID }),
      RECORDED_AT,
      RECORDED_AT,
    );
  handle.client
    .prepare(
      `INSERT INTO run_batches
        (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,
         environment_json,total_runs,project_id,policy_json,created_at,updated_at)
       VALUES (?,82,'suite-analysis','仍在执行的任务',1,'running',0,'[]',1,?,?,?,?)`,
    )
    .run(
      activeBatchId,
      PROJECT_ID,
      JSON.stringify({ projectVersionId: PROJECT_VERSION_ID }),
      RECORDED_AT,
      RECORDED_AT,
    );
  const cases = [
    [runIds[0], "Zeta", "example.ZetaTest", "Assertion zeta", "failed"],
    [runIds[1], "Alpha", "example.AlphaTest", "Assertion alpha", "failed"],
    [runIds[2], "Middle", "example.MiddleTest", "Assertion middle", "failed"],
    ["run-passed", "Passed", "example.PassedTest", "", "succeeded"],
  ] as const;
  for (const [runId, name, className, summary, outcome] of cases) {
    const firstAttemptOutcome = runId === "run-passed" ? "failed" : outcome;
    handle.client
      .prepare(
        `INSERT INTO execution_runs
          (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
           attempt_count,terminal_outcome,created_at,updated_at)
         VALUES (?,?,?,1,?,?,?,1,?,?,?)`,
      )
      .run(
        runId,
        batchId,
        `case-${runId}`,
        name,
        className,
        outcome,
        outcome,
        RECORDED_AT,
        RECORDED_AT,
      );
    handle.client
      .prepare(
        `INSERT INTO run_attempts
          (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
           result_code,result_summary,created_at,finished_at)
         VALUES (?,?, 'analysis-runner',1,?,1,?,'TESTNG_RESULT',?,?,?)`,
      )
      .run(
        `attempt-1-${runId}`,
        runId,
        firstAttemptOutcome,
        firstAttemptOutcome,
        runId === "run-passed" ? "Assertion passed on retry" : summary,
        RECORDED_AT,
        RECORDED_AT,
      );
    handle.client
      .prepare(
        `INSERT INTO run_attempts
          (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
           result_code,result_summary,created_at,finished_at)
         VALUES (?,?, 'analysis-runner',2,?,1,?,'TESTNG_RESULT',?,?,?)`,
      )
      .run(`attempt-2-${runId}`, runId, outcome, outcome, summary, RECORDED_AT, RECORDED_AT);
  }
  handle.client
    .prepare(
      `INSERT INTO execution_runs
        (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
         attempt_count,terminal_outcome,created_at,updated_at)
       VALUES ('run-active-failure',?,'case-active-failure',1,'Active','example.ActiveTest',
               'failed',1,'failed',?,?)`,
    )
    .run(activeBatchId, RECORDED_AT, RECORDED_AT);
  handle.client
    .prepare(
      `INSERT INTO run_attempts
        (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
         result_code,result_summary,created_at,finished_at)
       VALUES ('attempt-active-failure','run-active-failure','analysis-runner',1,'failed',1,
               'failed','TESTNG_RESULT','Assertion active',?,?)`,
    )
    .run(RECORDED_AT, RECORDED_AT);
  return {
    repository: new SqliteFailureAnalysisRepository(handle),
    projectId: PROJECT_ID,
    projectVersionId: PROJECT_VERSION_ID,
    batchId,
    activeBatchId,
    excludedBatchIds,
    runIds,
    async seedSuccessfulManualRerun(sourceExecutionRunId) {
      const rerunBatchId = "analysis-log-rerun";
      const rerunRunId = "analysis-log-rerun-run";
      const rerunAttemptId = "analysis-log-rerun-attempt-latest";
      handle.client
        .prepare(
          `INSERT INTO run_batches
            (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,batch_kind,
             parent_batch_id,source_execution_run_id,environment_json,total_runs,project_id,
             policy_json,created_at,updated_at)
           VALUES (?,85,'single:analysis','日志重跑',1,'succeeded',0,'case_log_rerun',?,?,
                   '[]',1,?,'{}',?,?)`,
        )
        .run(rerunBatchId, batchId, sourceExecutionRunId, PROJECT_ID, RECORDED_AT, RECORDED_AT);
      handle.client
        .prepare(
          `INSERT INTO execution_runs
            (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
             attempt_count,terminal_outcome,created_at,updated_at)
           VALUES (?,?,'case-rerun',1,'日志重跑','example.RerunTest','succeeded',1,
                   'succeeded',?,?)`,
        )
        .run(rerunRunId, rerunBatchId, RECORDED_AT, RECORDED_AT);
      handle.client
        .prepare(
          `INSERT INTO run_attempts
            (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
             result_code,result_summary,created_at,finished_at)
           VALUES ('analysis-log-rerun-attempt-first',?,'analysis-runner',1,'succeeded',1,
                   'succeeded','TESTNG_RESULT','首次通过',?,?),
                  (?,?,'analysis-runner',2,'succeeded',1,'succeeded','TESTNG_RESULT','再次通过',
                   '2026-09-01T00:01:00.000Z','2026-09-01T00:01:00.000Z')`,
        )
        .run(rerunRunId, RECORDED_AT, RECORDED_AT, rerunAttemptId, rerunRunId);
      return rerunAttemptId;
    },
    async dispose() {
      handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
