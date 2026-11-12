import { randomUUID } from "node:crypto";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { openHistoryFixtureConnection } from "./history-fixture-connection";

/** A 100-case first round followed by exactly ten eligible retry members. */
export async function insertRoundChartFixture(versionId: string) {
  const db = await openHistoryFixtureConnection({
    directory: process.env.AUTOFORGE_E2E_POSTGRES_URL
      ? undefined
      : process.env.AUTOFORGE_E2E_DATA_DIR,
    postgresUrl: process.env.AUTOFORGE_E2E_POSTGRES_URL,
  });
  const suiteId = randomUUID(),
    batchId = randomUUID(),
    runnerId = randomUUID();
  const now = new Date().toISOString();
  try {
    await db.execute(
      `INSERT INTO case_suites (id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at) VALUES (?,?,?,'',1,'active',TRUE,1,?,?,?)`,
      [
        suiteId,
        DEFAULT_PROJECT_ID,
        "轮次统计验证任务",
        JSON.stringify({ projectVersionId: versionId }),
        now,
        now,
      ],
    );
    await db.execute(
      `INSERT INTO runners (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES (?,?,?,TRUE,FALSE,'linux','amd64','1.22.11',1,'[]','[]',1,0,?,?,?)`,
      [runnerId, randomUUID(), "轮次图表历史节点", now, now, now],
    );
    await db.execute(
      `INSERT INTO run_batches (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,retry_mode,current_round,environment_json,total_runs,project_id,policy_json,created_at,updated_at,scheduled_for) VALUES (?,${db.nextBatchSequence},?,'百例任务重跑十例',1,'succeeded',1,'round',2,'[]',100,?,?,?,?,?)`,
      [
        batchId,
        suiteId,
        DEFAULT_PROJECT_ID,
        JSON.stringify({ projectVersionId: versionId }),
        now,
        now,
        now,
      ],
    );
    for (let index = 0; index < 100; index++) {
      const runId = randomUUID();
      const retried = index >= 90;
      const passed = index < 94;
      const status = passed ? "succeeded" : "failed";
      await db.execute(
        `INSERT INTO execution_runs (id,batch_id,case_definition_id,case_version,display_name,class_name,status,execution_round,attempt_count,terminal_outcome,created_at,updated_at) VALUES (?,?,?,1,?,?,?,?,?,?,?,?)`,
        [
          runId,
          batchId,
          randomUUID(),
          `用例 ${index}`,
          `example.Round${index}Test`,
          status,
          retried ? 2 : 1,
          retried ? 2 : 1,
          status,
          now,
          now,
        ],
      );
      for (let round = 1; round <= (retried ? 2 : 1); round++) {
        const outcome = round === 1 && retried ? "failed" : status;
        await db.execute(
          `INSERT INTO run_attempts (id,execution_run_id,runner_id,attempt_number,execution_round,status,outcome,result_code,result_summary,scheduling_score,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,'fixture',1,?,?)`,
          [
            randomUUID(),
            runId,
            runnerId,
            round,
            round,
            outcome,
            outcome,
            outcome === "succeeded" ? "TESTNG_SUCCEEDED" : "TESTNG_ASSERTIONS_FAILED",
            now,
            now,
          ],
        );
      }
    }
    return { batchId, suiteId };
  } finally {
    await db.close();
  }
}
