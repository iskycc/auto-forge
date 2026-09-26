import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { insertFailureAnalysisFixture } from "./failure-analysis-fixture";

/** Historical attempts include cancellation, timeout and a missing node directory entry. */
export function insertBatchRunnerFixture(directory: string, versionId: string, suffix: string) {
  const fixture = insertFailureAnalysisFixture(directory, versionId, suffix);
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  const longName = `支付回归执行节点_${"PaymentIntegration_".repeat(9)}`;
  const outcomes = [
    "failed",
    "timed_out",
    "cancelled",
    "cancelled",
    "succeeded",
    "succeeded",
    "failed",
    "succeeded",
  ];
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("UPDATE run_batches SET total_runs=8,scheduled_for=?,created_at=? WHERE id=?")
      .run(observedAt, observedAt, fixture.batchId);
    const originalRunner = `analysis-runner-${suffix}`;
    for (const [index, outcome] of outcomes.entries()) {
      const runnerId = `node-${index}-${suffix}`;
      database
        .prepare(
          `INSERT INTO runners
        (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,
         labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at,
         cpu_utilization_percent,memory_utilization_percent,load_average_1m,logical_cpu_count,metrics_observed_at,purged_at)
        SELECT ?,?,?,disabled,draining,os,architecture,agent_version,protocol_version,
         labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at,?,?,?,?,?,?
        FROM runners WHERE id=?`,
        )
        .run(
          runnerId,
          `hash-${runnerId}`,
          index === 0 ? longName : `回归执行节点 ${index + 1}`,
          index === 1 ? null : 12 + index * 10,
          index === 1 ? null : 25 + index * 8,
          index === 1 ? null : 1.5,
          index === 1 ? null : 8,
          index === 1 ? null : observedAt,
          index === 2 ? observedAt : null,
          originalRunner,
        );
      const runId = index === 4 ? `run-pass-${suffix}` : `run-failed-${index % 4}-${suffix}`;
      if (index < 5) {
        database
          .prepare("UPDATE execution_runs SET status=?,terminal_outcome=? WHERE id=?")
          .run(outcome === "timed_out" ? "failed" : outcome, outcome, runId);
        database
          .prepare("UPDATE run_attempts SET runner_id=?,status=?,outcome=? WHERE id=?")
          .run(runnerId, outcome, outcome, `attempt-${runId}`);
      } else {
        const extraRunId = `extra-run-${index}-${suffix}`;
        database
          .prepare(
            `INSERT INTO execution_runs
          (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,terminal_outcome,created_at,updated_at)
          VALUES (?,?,?,1,?,?,?,1,?,?,?)`,
          )
          .run(
            extraRunId,
            fixture.batchId,
            `case-${extraRunId}`,
            `补充用例 ${index + 1}`,
            `e2e.runner.Status${index}Test`,
            outcome,
            outcome,
            observedAt,
            observedAt,
          );
        database
          .prepare(
            `INSERT INTO run_attempts
          (id,execution_run_id,runner_id,attempt_number,execution_round,status,scheduling_score,outcome,created_at,finished_at)
          VALUES (?,?,?,1,1,?,1,?,?,?)`,
          )
          .run(
            `extra-${index}-${suffix}`,
            extraRunId,
            runnerId,
            outcome,
            outcome,
            observedAt,
            observedAt,
          );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return { ...fixture, longName };
}
