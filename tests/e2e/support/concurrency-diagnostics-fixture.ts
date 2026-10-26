import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

/** A stable active batch; there are no dispatch messages or Java processes. */
export function insertConcurrencyDiagnosticsFixture(
  directory: string,
  projectId: string,
  versionId: string,
) {
  const db = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  const batchId = randomUUID(),
    otherBatchId = randomUUID(),
    suiteId = randomUUID();
  const now = new Date().toISOString();
  const capabilities = [
    "executor:testng-v1",
    "isolation:cgroup-v2",
    "java:21.0.8",
    "testng:7.11.0",
    "adapter:cotest-testng-v1",
    "adapter:ddt-case-id-v1",
    "adapter:ddt-insight-url-v1",
  ];
  const policy = JSON.stringify({
    executor: "testng",
    concurrency: 40,
    projectVersionId: versionId,
    runnerLabels: ["pool-a"],
    artifactPatterns: [],
  });
  const runnerIds: string[] = [];
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO case_suites(id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at) VALUES (?,?,?,'',1,'active',1,1,?,?,?)",
    ).run(suiteId, projectId, `并发诊断验收任务-${batchId.slice(0, 8)}`, policy, now, now);
    for (const [id, name, total] of [
      [batchId, "并发诊断验收任务", 5],
      [otherBatchId, "另一并行任务", 2],
    ] as const) {
      db.prepare(
        "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,policy_json,scheduled_for,created_at,updated_at) VALUES (?,?,?,1,'running',0,'[]',?,?,?,?,?,?)",
      ).run(id, suiteId, name, total, projectId, policy, now, now, now);
    }
    db.prepare("UPDATE run_batches SET adapter_runtime_json=? WHERE id=?").run(
      JSON.stringify({
        suiteName: "DDT",
        testName: "DDT",
        requiresDdtCaseId: true,
        environmentAddresses: [],
        environmentAddressByRunId: {},
        fallbackEnvironmentAddress: "",
      }),
      batchId,
    );
    for (let index = 0; index < 8; index++) {
      const runnerId = `${String(index).padStart(8, "0")}-${randomUUID().slice(9)}`;
      runnerIds.push(runnerId);
      db.prepare(
        `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at,cpu_utilization_percent,memory_utilization_percent,memory_total_bytes,memory_available_bytes,load_average_1m,logical_cpu_count,metrics_observed_at)
        VALUES (?,?,?,'linux','amd64','1.20.15',1,?,?,10,?,?,?,?,30,70,?,?,0,16,?)`,
      ).run(
        runnerId,
        `fixture-${runnerId}`,
        index === 0
          ? `支付回归执行节点_${"PaymentIntegration_".repeat(6)}`
          : `执行节点 ${index + 1}`,
        JSON.stringify(index === 2 ? ["java", "testng"] : ["java", "testng", "pool-a"]),
        JSON.stringify(
          index === 2
            ? capabilities.filter((value) => !value.startsWith("adapter:ddt"))
            : capabilities,
        ),
        index === 0 ? 4 : index > 2 ? 10 : 0,
        now,
        now,
        now,
        32 * 1024 ** 3,
        Math.floor(32 * 1024 ** 3 * 0.3),
        index === 1 ? new Date(Date.now() - 120_000).toISOString() : now,
      );
      if (index === 0)
        db.prepare("UPDATE runners SET memory_execution_credit_bytes=? WHERE id=?").run(
          6 * 1024 ** 3,
          runnerId,
        );
      db.prepare("INSERT INTO run_batch_runners(batch_id,runner_id) VALUES (?,?)").run(
        batchId,
        runnerId,
      );
    }
    const insertRun = (
      ownerId: string,
      status: "queued" | "assigned" | "running",
      index: number,
    ) => {
      const runId = randomUUID();
      db.prepare(
        "INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,case_type,created_at,updated_at) VALUES (?,?,?,1,?,'example.DdtTest',?,?,'ddt',?,?)",
      ).run(
        runId,
        ownerId,
        `case-${runId}`,
        `中文Case-${index}`,
        status,
        status === "queued" ? 0 : 1,
        now,
        now,
      );
      if (status !== "queued")
        db.prepare(
          "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES (?,?,?,1,?,1,?)",
        ).run(randomUUID(), runId, runnerIds[0]!, status, now);
    };
    insertRun(batchId, "running", 0);
    insertRun(batchId, "assigned", 1);
    for (let index = 2; index < 5; index++) insertRun(batchId, "queued", index);
    insertRun(otherBatchId, "running", 5);
    insertRun(otherBatchId, "running", 6);
    db.exec("COMMIT");
    return { batchId };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
