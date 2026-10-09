import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../packages/db/src/database";
import { createPostgresDatabase } from "../../../packages/db/src/postgres-database";
import { WorkerPool } from "./worker-pool";
import { webResourcePlan } from "../src/lib/worker-sizing";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-10-09T00:00:00.000Z";
const later = "2026-10-09T00:01:00.000Z";

for (const mode of ["lite", "full"] as const) {
  describe.skipIf(mode === "full" && !postgresUrl)(`${mode} isolated Runner diagnostics`, () => {
    it("keeps HTTP and active lease renewals responsive during a stalled SQL read, then recovers", async () => {
      const database = await diagnosticDatabase(mode);
      const pool = new WorkerPool(
        {
          mode,
          dataDirectory: database.directory,
          migrationsFolder: resolve(
            `packages/db/drizzle/${mode === "lite" ? "sqlite" : "postgresql"}`,
          ),
          attemptLogsDirectory: join(database.directory, "attempt-logs"),
          caseExecutionTimeoutSeconds: 60,
          artifactCollectionEnabled: false,
          scheduler: {
            maximumCpuUtilizationPercent: 90,
            maximumMemoryUtilizationPercent: 90,
            maximumLoadPerCpu: 2,
            metricsMaximumAgeSeconds: 60,
            projectMaximumConcurrency: 500,
            priorityAgingIntervalMinutes: 1,
          },
          ...(mode === "lite"
            ? { sqlite: { databasePath: database.path! } }
            : {
                full: {
                  databaseUrl: database.url!,
                  databasePoolMax: 1,
                  minio: {
                    endPoint: "unused",
                    useSSL: false,
                    accessKey: "unused",
                    secretKey: "unused",
                    bucket: "unused",
                    region: "unused",
                  },
                },
              }),
        },
        1,
        1_000,
        webResourcePlan({ cpuCapacity: 1, memoryCapacityBytes: 4 * 1024 ** 3 }, mode),
      );
      let leaseVersion = 1;
      const renew = async () => {
        const result = (await pool.renewLease({
          runnerId: "runner",
          leaseId: "lease",
          tokenHash: "token-hash",
          expectedVersion: leaseVersion,
          now,
          expiresAt: later,
        })) as { leaseVersion: number; instruction: string };
        leaseVersion = result.leaseVersion;
        return result;
      };
      const server = createServer((_request, response) => {
        void renew().then(
          (result) => response.end(JSON.stringify(result)),
          () => {
            response.writeHead(500);
            response.end("renewal failed");
          },
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test listener.");
      try {
        await seedLease(database.execute);
        await expect(renew()).resolves.toMatchObject({ leaseVersion: 2, instruction: "continue" });
        await expect(
          pool.listSchedulingEvents({ batchId: "batch", limit: 500 }),
        ).resolves.toMatchObject({ items: [] });
        await database.execute("ALTER TABLE scheduling_events RENAME TO diagnostic_events_fixture");
        // An adversarial view gives the real repository a scan that cannot finish in its budget.
        await database.execute(
          mode === "lite"
            ? `CREATE VIEW scheduling_events AS
          WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 1000000000)
          SELECT CAST(value AS TEXT) AS id, 'batch' AS batch_id, 'runner' AS runner_id,
            NULL AS execution_run_id, NULL AS attempt_id, 'run_assigned' AS event_type,
            CAST(value AS TEXT) AS message, NULL AS payload_json, '${now}' AS recorded_at FROM counter`
            : `CREATE VIEW scheduling_events AS SELECT value::text AS id, 'batch'::text AS batch_id, 'runner'::text AS runner_id,
            NULL::text AS execution_run_id, NULL::text AS attempt_id, 'run_assigned'::text AS event_type,
            value::text AS message, NULL::text AS payload_json, '${now}'::text AS recorded_at FROM generate_series(1, 1000000000) value`,
        );
        const blocked = Promise.allSettled([
          pool.listSchedulingEvents({
            batchId: "batch",
            runnerId: "runner",
            query: "absent-message",
            limit: 500,
          }),
          pool.readRunnerResourceSamples({ runnerId: "runner", since: now, until: later }),
        ]);
        await expect(
          pool.listSchedulingEvents({ batchId: "batch", limit: 500 }),
        ).rejects.toMatchObject({ code: "PLATFORM_BUSY" });
        for (let probe = 0; probe < 10; probe++) {
          await delay(200);
          const started = performance.now();
          const response = await fetch(`http://127.0.0.1:${address.port}`);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            instruction: "continue",
            leaseVersion: probe + 3,
          });
          expect(performance.now() - started).toBeLessThan(1_500);
        }
        const failures = await blocked;
        expect(failures[0]).toMatchObject({
          status: "rejected",
          reason: { code: "PLATFORM_BUSY" },
        });
        await database.execute("DROP VIEW scheduling_events");
        await database.execute("ALTER TABLE diagnostic_events_fixture RENAME TO scheduling_events");
        await expect(
          pool.listSchedulingEvents({ batchId: "batch", limit: 500 }),
        ).resolves.toMatchObject({ items: [] });
        await expect(renew()).resolves.toMatchObject({ leaseVersion: 13, instruction: "continue" });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.close();
        await database.close();
      }
    }, 20_000);
  });
}

async function seedLease(execute: (sql: string) => Promise<void>) {
  await execute(
    `INSERT INTO runners (id, credential_hash, name, os, architecture, agent_version, protocol_version, labels_json, max_concurrency, busy_slots, last_seen_at, created_at, updated_at) VALUES ('runner', 'credential-hash', 'runner', 'linux', 'amd64', '1.19.8', 1, '[]', 1, 1, '${now}', '${now}', '${now}')`,
  );
  await execute(
    `INSERT INTO run_batches (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json, total_runs, project_id, created_at, updated_at) VALUES ('batch', 'suite', 'suite', 1, 'running', 0, '[]', 1, '00000000-0000-7000-8000-000000000001', '${now}', '${now}')`,
  );
  await execute(
    `INSERT INTO execution_runs (id, batch_id, case_definition_id, case_version, display_name, class_name, status, attempt_count, created_at, updated_at) VALUES ('run', 'batch', 'case', 1, 'case', 'example.Test', 'running', 1, '${now}', '${now}')`,
  );
  await execute(
    `INSERT INTO run_attempts (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at) VALUES ('attempt', 'run', 'runner', 1, 'running', 1, '${now}')`,
  );
  await execute(
    `INSERT INTO assignments (id, attempt_id, execution_run_id, batch_id, runner_id, status, execution_spec_json, available_at, claim_deadline_at, created_at, updated_at) VALUES ('assignment', 'attempt', 'run', 'batch', 'runner', 'running', '{}', '${now}', '${later}', '${now}', '${now}')`,
  );
  await execute(
    `INSERT INTO assignment_leases (id, assignment_id, runner_id, token_hash, token_encrypted, status, expires_at, renewed_at, created_at) VALUES ('lease', 'assignment', 'runner', 'token-hash', 'unused', 'active', '${later}', '${now}', '${now}')`,
  );
}

async function diagnosticDatabase(mode: "lite" | "full") {
  const directory = await mkdtemp(join(tmpdir(), "runner-diagnostic-isolation-"));
  if (mode === "lite") {
    const path = join(directory, "platform.sqlite");
    const handle = createSqliteDatabase({
      databasePath: path,
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    return {
      directory,
      path,
      url: undefined,
      execute: async (sql: string) => {
        handle.client.exec(sql);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const name = `diagnostic_isolation_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve("packages/db/drizzle/postgresql"),
    poolMax: 1,
  });
  await handle.ready;
  return {
    directory,
    path: undefined,
    url: url.toString(),
    execute: async (sql: string) => {
      await handle.pool.query(sql);
    },
    close: async () => {
      await handle.close();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
