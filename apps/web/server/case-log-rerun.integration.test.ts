import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { RunBatchSchedulingService } from "@autoforge/application";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { createSqliteDatabase, type SqliteDatabaseHandle } from "../../../packages/db/src/database";
import { workerBackedBatchCreation } from "../src/lib/work-dispatch";
import { webResourcePlan } from "../src/lib/worker-sizing";
import { WorkerPool } from "./worker-pool";

it.each(["cold", "warm"] as const)(
  "keeps HTTP responsive during a Chinese DDT rerun and renews the active lease with a %s worker",
  async (startup) => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-log-rerun-"));
    const databasePath = join(directory, "platform.sqlite");
    const migrationsFolder = resolve("packages/db/drizzle/sqlite");
    const handle = createSqliteDatabase({ databasePath, migrationsFolder });
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const configurationStore = new PlatformConfigurationStore(directory);
    const persisted = configurationStore.initialize();
    const scheduler = {
      ...persisted.scheduler,
      maximumCpuUtilizationPercent: 90,
      maximumMemoryUtilizationPercent: 90,
      maximumLoadPerCpu: 2,
      metricsMaximumAgeSeconds: 60,
      projectMaximumConcurrency: 500,
      priorityAgingIntervalMinutes: 1,
    };
    configurationStore.replace(
      {
        ...persisted,
        scheduler,
        limits: { ...persisted.limits, artifactCollectionEnabled: false },
      },
      persisted.revision,
    );
    const pool = new WorkerPool(
      {
        mode: "lite",
        dataDirectory: directory,
        migrationsFolder,
        attemptLogsDirectory: join(directory, "logs"),
        sqlite: { databasePath },
        caseExecutionTimeoutSeconds: 60,
        artifactCollectionEnabled: false,
        scheduler,
      },
      1,
      1_000,
      webResourcePlan({ cpuCapacity: 1, memoryCapacityBytes: 4 * 1024 ** 3 }, "lite"),
    );
    const local = { rerunCaseFromAttempt: vi.fn() } as unknown as RunBatchSchedulingService;
    const service = workerBackedBatchCreation(local, pool);
    const server = createServer((_request, response) => response.end("responsive"));
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      seedRerun(handle, now, expiresAt);
      if (startup === "warm") {
        await expect(pool.scheduleBatch("missing")).rejects.toMatchObject({
          code: "RUN_BATCH_NOT_FOUND",
        });
      }
      // The cold case sends the rerun as the worker's first request, including migration checks.
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing HTTP probe address.");
      handle.client.exec("BEGIN IMMEDIATE");
      releaseTimer = setTimeout(() => {
        handle.client.exec("ROLLBACK");
        releaseTimer = undefined;
      }, 500);
      const rerun = service.rerunCaseFromAttempt(
        "failed-attempt",
        {
          username: "重跑操作人",
          source: "local",
        },
        { environmentIp: "10.0.0.99" },
      );
      pending = Promise.allSettled([rerun]);
      const latencies: number[] = [];
      for (let probe = 0; probe < 5; probe++) {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${address.port}`, {
          signal: AbortSignal.timeout(1_500),
        });
        expect(await response.text()).toBe("responsive");
        latencies.push(performance.now() - started);
        await delay(20);
      }
      expect(Math.max(...latencies)).toBeLessThan(1_500);
      const batch = await rerun;
      expect(local.rerunCaseFromAttempt).not.toHaveBeenCalled();
      expect(batch).toMatchObject({
        kind: "case_log_rerun",
        parentBatchId: "source",
        totalRuns: 1,
      });
      const runtime = handle.client
        .prepare("SELECT adapter_runtime_json FROM run_batches WHERE id = ?")
        .get(batch.id) as { adapter_runtime_json: string };
      expect(JSON.parse(runtime.adapter_runtime_json).environmentAddresses).toEqual(["10.0.0.99"]);
      await expect(service.getCaseLogRerunConfiguration("failed-attempt")).resolves.toEqual({
        adapterEnabled: true,
        environmentIp: "10.0.0.11",
      });
      const run = handle.client
        .prepare(
          "SELECT display_name, case_type, execution_case_definition_id FROM execution_runs WHERE batch_id = ?",
        )
        .get(batch.id);
      expect(run).toEqual({
        display_name: "订单支付_中文001",
        case_type: "ddt",
        execution_case_definition_id: "class",
      });
      await expect(
        pool.renewLease({
          runnerId: "runner",
          leaseId: "lease",
          tokenHash: "token",
          expectedVersion: 1,
          now,
          expiresAt,
        }),
      ).resolves.toMatchObject({ leaseVersion: 2, instruction: "continue" });
      expect(
        handle.client.prepare("SELECT status FROM run_attempts WHERE id='failed-attempt'").get(),
      ).toEqual({ status: "failed" });
    } finally {
      if (releaseTimer !== undefined) {
        clearTimeout(releaseTimer);
        handle.client.exec("ROLLBACK");
      }
      await pending;
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await pool.close();
      handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

function seedRerun(handle: SqliteDatabaseHandle, now: string, expiresAt: string): void {
  const runtime = {
    suiteName: "Suite",
    testName: "Test",
    environmentAddresses: ["10.0.0.11"],
    environmentAddressByRunId: { "failed-run": "10.0.0.11" },
    fallbackEnvironmentAddress: "10.0.0.11",
  };
  const policy = {
    executor: "testng",
    concurrency: 1,
    runnerLabels: [],
    artifactPatterns: [],
    retryConcurrencyRules: [],
  };
  handle.client
    .prepare(
      "INSERT INTO project_runtime_assets (id,project_id,kind,source_type,file_name,object_key,sha256,size_bytes,archive_format,created_at) VALUES ('bundle',?,'jar-bundle','upload','fixture.zip','fixture/bundle.zip',?,1,'zip',?)",
    )
    .run(DEFAULT_PROJECT_ID, "a".repeat(64), now);
  handle.client
    .prepare(
      "INSERT INTO project_adapter_configurations (project_id,jar_bundle_asset_id,updated_at) VALUES (?,'bundle',?) ON CONFLICT(project_id) DO UPDATE SET jar_bundle_asset_id='bundle'",
    )
    .run(DEFAULT_PROJECT_ID, now);
  handle.client
    .prepare(
      "INSERT INTO runners (id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('runner','credential','runner','linux','amd64','1.19.20',1,'[]',1,1,?,?,?)",
    )
    .run(now, now, now);
  handle.client
    .prepare(
      "INSERT INTO run_batches (id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,policy_json,adapter_runtime_json,created_at,updated_at) VALUES ('source','suite','DDT task',1,'running',0,2,'[]',?,?,?,?)",
    )
    .run(JSON.stringify(policy), JSON.stringify(runtime), now, now);
  for (const [id, status, caseType, name] of [
    ["failed-run", "failed", "ddt", "订单支付_中文001"],
    ["active-run", "running", "testng", "active"],
  ]) {
    handle.client
      .prepare(
        "INSERT INTO execution_runs (id,batch_id,case_definition_id,execution_case_definition_id,case_version,display_name,class_name,case_type,status,attempt_count,created_at,updated_at) VALUES (?,'source',?,'class',1,?,'example.Payment',?,?,1,?,?)",
      )
      .run(id, id, name, caseType, status, now, now);
  }
  for (const [id, runId, status] of [
    ["failed-attempt", "failed-run", "failed"],
    ["active-attempt", "active-run", "running"],
  ]) {
    handle.client
      .prepare(
        "INSERT INTO run_attempts (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES (?,?,'runner',1,?,1,?)",
      )
      .run(id, runId, status, now);
  }
  handle.client
    .prepare(
      "INSERT INTO assignments (id,attempt_id,execution_run_id,batch_id,runner_id,status,execution_spec_json,available_at,claim_deadline_at,created_at,updated_at) VALUES ('assignment','active-attempt','active-run','source','runner','running','{}',?,?,?,?)",
    )
    .run(now, expiresAt, now, now);
  handle.client
    .prepare(
      "INSERT INTO assignment_leases (id,assignment_id,runner_id,token_hash,token_encrypted,status,expires_at,renewed_at,created_at) VALUES ('lease','assignment','runner','token','unused','active',?,?,?)",
    )
    .run(expiresAt, now, now);
}
