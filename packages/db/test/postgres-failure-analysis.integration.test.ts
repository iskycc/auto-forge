import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, it } from "vitest";

import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresFailureAnalysisRepository } from "../src/postgres-failure-analysis";
import { failureAnalysisContract, type FailureAnalysisHarness } from "./failure-analysis.contract";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const PROJECT_ID = "00000000-0000-7000-8000-000000000001";
const RECORDED_AT = "2026-09-01T00:00:00.000Z";

if (!connectionString) {
  describe.skip("PostgreSQL failure analysis", () => {
    it("requires AUTOFORGE_TEST_POSTGRES_URL", () => undefined);
  });
} else {
  failureAnalysisContract(
    "PostgreSQL failure analysis",
    async (): Promise<FailureAnalysisHarness> => {
      const handle = createPostgresDatabase({
        connectionString,
        migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
      });
      await handle.ready;
      const suffix = randomUUID();
      const batchId = `analysis-batch-${suffix}`;
      const activeBatchId = `analysis-active-batch-${suffix}`;
      const excludedBatchIds: [string, string] = [
        `analysis-single-batch-${suffix}`,
        `analysis-derived-batch-${suffix}`,
      ];
      const projectVersionId = `analysis-version-${suffix}`;
      const runnerId = `analysis-runner-${suffix}`;
      const derivedBatchIds: string[] = [];
      const runIds: [string, string, string] = [
        `run-zeta-${suffix}`,
        `run-alpha-${suffix}`,
        `run-middle-${suffix}`,
      ];
      await handle.pool.query(
        `INSERT INTO runners
          (id,credential_hash,name,disabled,draining,os,architecture,agent_version,
           protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,
           last_seen_at,created_at,updated_at)
         VALUES ($1,'hash','分析 Runner',FALSE,FALSE,'linux','amd64','1.0.0',1,
                 '[]','[]',4,0,$2,$2,$2)`,
        [runnerId, RECORDED_AT],
      );
      await handle.pool.query(
        `INSERT INTO case_suites
          (id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at)
         VALUES ('suite-analysis',$1,'失败分析任务','',1,'active',TRUE,1,'{}',$2,$2)
         ON CONFLICT (id) DO NOTHING`,
        [PROJECT_ID, RECORDED_AT],
      );
      await handle.pool.query(
        `INSERT INTO run_batches
          (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,
           environment_json,total_runs,current_round,project_id,policy_json,created_at,updated_at)
         VALUES ($1,81,'suite-analysis','失败分析任务',1,'succeeded',1,'[]',4,2,$2,$3,$4,$4)`,
        [batchId, PROJECT_ID, JSON.stringify({ projectVersionId }), RECORDED_AT],
      );
      await handle.pool.query(
        `INSERT INTO run_batches
          (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,
           environment_json,total_runs,project_id,policy_json,created_at,updated_at)
         VALUES ($1,82,'suite-analysis','仍在执行的任务',1,'running',0,'[]',1,$2,$3,$4,$4)`,
        [activeBatchId, PROJECT_ID, JSON.stringify({ projectVersionId }), RECORDED_AT],
      );
      await handle.pool.query(
        `INSERT INTO run_batches
          (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,batch_kind,
           environment_json,total_runs,project_id,policy_json,created_at,updated_at)
         VALUES ($1,83,$2,'单用例',1,'succeeded',0,'standard','[]',1,$3,$4,$5,$5),
                ($6,84,'suite-analysis','最后失败再次执行',1,'succeeded',0,'final_failure_rerun',
                 '[]',1,$3,$4,$5,$5)`,
        [
          excludedBatchIds[0],
          `single:case-${suffix}`,
          PROJECT_ID,
          JSON.stringify({ projectVersionId }),
          RECORDED_AT,
          excludedBatchIds[1],
        ],
      );
      const cases = [
        [runIds[0], "Zeta", "example.ZetaTest", "Assertion zeta", "failed"],
        [runIds[1], "Alpha", "example.AlphaTest", "Assertion alpha", "failed"],
        [runIds[2], "Middle", "example.MiddleTest", "Assertion middle", "failed"],
        [`run-passed-${suffix}`, "Passed", "example.PassedTest", "", "succeeded"],
      ] as const;
      for (const [runId, name, className, summary, outcome] of cases) {
        const firstAttemptOutcome = runId.startsWith("run-passed-") ? "failed" : outcome;
        await handle.pool.query(
          `INSERT INTO execution_runs
            (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
             attempt_count,terminal_outcome,created_at,updated_at)
           VALUES ($1,$2,$3,1,$4,$5,$6,1,$6,$7,$7)`,
          [runId, batchId, `case-${runId}`, name, className, outcome, RECORDED_AT],
        );
        await handle.pool.query(
          `INSERT INTO run_attempts
            (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
             result_code,result_summary,created_at,finished_at)
           VALUES ($1,$2,$3,1,$4,1,$4,'TESTNG_RESULT',$5,$6,$6)`,
          [
            `attempt-1-${runId}`,
            runId,
            runnerId,
            firstAttemptOutcome,
            runId.startsWith("run-passed-") ? "Assertion passed on retry" : summary,
            RECORDED_AT,
          ],
        );
        await handle.pool.query(
          `INSERT INTO run_attempts
            (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
             result_code,result_summary,created_at,finished_at)
           VALUES ($1,$2,$3,2,$4,1,$4,'TESTNG_RESULT',$5,$6,$6)`,
          [`attempt-2-${runId}`, runId, runnerId, outcome, summary, RECORDED_AT],
        );
      }
      await handle.pool.query(
        `INSERT INTO execution_runs
          (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
           attempt_count,terminal_outcome,created_at,updated_at)
         VALUES ($1,$2,$3,1,'Active','example.ActiveTest','failed',1,'failed',$4,$4)`,
        [
          `run-active-failure-${suffix}`,
          activeBatchId,
          `case-active-failure-${suffix}`,
          RECORDED_AT,
        ],
      );
      await handle.pool.query(
        `INSERT INTO run_attempts
          (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
           result_code,result_summary,created_at,finished_at)
         VALUES ($1,$2,$3,1,'failed',1,'failed','TESTNG_RESULT','Assertion active',$4,$4)`,
        [`attempt-active-failure-${suffix}`, `run-active-failure-${suffix}`, runnerId, RECORDED_AT],
      );
      return {
        repository: new PostgresFailureAnalysisRepository(handle),
        projectId: PROJECT_ID,
        projectVersionId,
        batchId,
        activeBatchId,
        excludedBatchIds,
        runIds,
        async readClaimReleaseReason(analysisId) {
          const result = await handle.pool.query<{ reason: string }>(
            "SELECT reason FROM failure_analysis_claim_releases WHERE analysis_id=$1",
            [analysisId],
          );
          return result.rows[0]?.reason;
        },
        async seedSuccessfulManualRerun(sourceExecutionRunId) {
          const rerunBatchId = `analysis-log-rerun-${suffix}`;
          derivedBatchIds.push(rerunBatchId);
          const rerunRunId = `analysis-log-rerun-run-${suffix}`;
          const rerunAttemptId = `analysis-log-rerun-attempt-latest-${suffix}`;
          await handle.pool.query(
            `INSERT INTO run_batches
              (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,batch_kind,
               parent_batch_id,source_execution_run_id,environment_json,total_runs,project_id,
               policy_json,created_at,updated_at)
             VALUES ($1,85,$2,'日志重跑',1,'succeeded',0,'case_log_rerun',$3,$4,
                     '[]',1,$5,'{}',$6,$6)`,
            [
              rerunBatchId,
              `single:analysis-${suffix}`,
              batchId,
              sourceExecutionRunId,
              PROJECT_ID,
              RECORDED_AT,
            ],
          );
          await handle.pool.query(
            `INSERT INTO execution_runs
              (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
               attempt_count,terminal_outcome,created_at,updated_at)
             VALUES ($1,$2,$3,1,'日志重跑','example.RerunTest','succeeded',1,'succeeded',$4,$4)`,
            [rerunRunId, rerunBatchId, `case-rerun-${suffix}`, RECORDED_AT],
          );
          await handle.pool.query(
            `INSERT INTO run_attempts
              (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
               result_code,result_summary,created_at,finished_at)
             VALUES ($1,$2,$3,1,'succeeded',1,'succeeded','TESTNG_RESULT','首次通过',$5,$5),
                    ($4,$2,$3,2,'succeeded',1,'succeeded','TESTNG_RESULT','再次通过',
                     '2026-09-01T00:01:00.000Z','2026-09-01T00:01:00.000Z')`,
            [
              `analysis-log-rerun-attempt-first-${suffix}`,
              rerunRunId,
              runnerId,
              rerunAttemptId,
              RECORDED_AT,
            ],
          );
          return rerunAttemptId;
        },
        async dispose() {
          await handle.pool.query("DELETE FROM run_batches WHERE id=ANY($1::text[])", [
            [...derivedBatchIds, batchId, activeBatchId, ...excludedBatchIds],
          ]);
          await handle.pool.query("DELETE FROM runners WHERE id=$1", [runnerId]);
          await handle.close();
        },
      };
    },
  );
}
