import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";
import type { IdentityAccessRepository } from "@autoforge/application";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { SqliteReadModelSnapshotRepository } from "../src/sqlite-read-model-snapshots";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";

describe("database resource budgets", () => {
  it("registers a cold page snapshot after an import holds the writer beyond a short mutation retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-cold-snapshot-"));
    const databasePath = join(directory, "platform.sqlite");
    const handle = createSqliteDatabase({
      databasePath,
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
      busyTimeoutMs: 1,
    });
    const writer = new Database(databasePath);
    const snapshots = new SqliteReadModelSnapshotRepository(handle);
    writer.exec("BEGIN IMMEDIATE");
    const release = setTimeout(() => writer.exec("COMMIT"), 1_050);
    try {
      await expect(
        snapshots.request(
          "cold-page",
          {
            kind: "dashboard",
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: "version",
            timeZone: "UTC",
          },
          "2026-09-07T00:00:00.000Z",
        ),
      ).resolves.toMatchObject({ id: "cold-page", failed: false });
    } finally {
      clearTimeout(release);
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("persists DDT completion and permission changes after a competing writer releases its lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-background-finalization-"));
    const databasePath = join(directory, "platform.sqlite");
    const handle = createSqliteDatabase({
      databasePath,
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
      busyTimeoutMs: 1,
    });
    const writer = new Database(databasePath);
    const structures = new SqliteProjectStructureRepository(handle);
    const ddt = new SqliteDdtRepository(handle);
    const operations = new SqlitePlatformOperationsRepository(handle);
    const now = "2026-09-07T00:00:00.000Z";
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      await new SqliteIdentityAccessRepository(handle).createLocalUser({
        id: "system",
        username: "system",
        normalizedUsername: "system",
        displayName: "System",
        passwordHash: "unused",
        forcePasswordChange: false,
        createdAt: now,
      });
      await structures.createVersion({
        id: "version",
        projectId: DEFAULT_PROJECT_ID,
        name: "Version",
        normalizedName: "version",
        recordedAt: now,
      });
      await structures.createStage({
        id: "stage",
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId: "version",
        name: "Stage",
        normalizedName: "stage",
        description: "",
        recordedAt: now,
      });
      await ddt.createImportPreview({
        job: {
          id: "ddt-job",
          projectId: DEFAULT_PROJECT_ID,
          projectVersionId: "version",
          testStageId: "stage",
          status: "previewed",
          uploads: [],
          progressPercent: 0,
          totalFiles: 0,
          validFiles: 0,
          failedFiles: 0,
          totalRows: 0,
          insertedCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          skippedCount: 0,
          createdAt: now,
          updatedAt: now,
        },
        files: [],
      });
      await operations.createServiceAccount({
        id: "service-account",
        name: "Service Account",
        description: "",
        status: "active",
        systemPermissions: ["settings.read"],
        projectPermissions: {},
        createdBy: "system",
        createdAt: now,
        updatedAt: now,
        revision: 1,
      });
      writer.exec("BEGIN IMMEDIATE");
      release = setTimeout(() => writer.exec("COMMIT"), 40);
      const [completed, account] = await Promise.all([
        ddt.updateImportJob({
          jobId: "ddt-job",
          status: "succeeded",
          progressPercent: 100,
          insertedCount: 4_000,
          updatedAt: now,
          finishedAt: now,
        }),
        operations.updateServiceAccount({
          accountId: "service-account",
          expectedRevision: 1,
          systemPermissions: [],
          updatedAt: now,
        }),
      ]);
      expect(completed).toMatchObject({ status: "succeeded", insertedCount: 4_000 });
      expect(account).toMatchObject({ revision: 2, systemPermissions: [] });
      await expect(
        operations.updateServiceAccount({
          accountId: "service-account",
          expectedRevision: 1,
          name: "Stale write",
          updatedAt: now,
        }),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    } finally {
      clearTimeout(release);
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts import, export and audit writes after a short background lock without holding the event loop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-background-admission-"));
    const databasePath = join(directory, "platform.sqlite");
    const handle = createSqliteDatabase({
      databasePath,
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
      busyTimeoutMs: 1,
    });
    const writer = new Database(databasePath);
    const identities = new SqliteIdentityAccessRepository(handle);
    const now = "2026-09-07T00:00:00.000Z";
    const id = randomUUID();
    await identities.createLocalUser({
      id,
      username: id,
      normalizedUsername: id,
      displayName: "Writer",
      passwordHash: "unused",
      forcePasswordChange: false,
      createdAt: now,
    });
    const job = {
      schemaVersion: 1 as const,
      messageId: id,
      runId: id,
      attempt: 1,
      createdAt: now,
      priority: 0,
      deduplicationKey: id,
      kind: "jar-import" as const,
      payload: { jobId: id },
    };
    writer.exec("BEGIN IMMEDIATE");
    let yielded = false;
    const release = setTimeout(() => {
      yielded = true;
      writer.exec("COMMIT");
    }, 40);
    try {
      await Promise.all([
        new SqliteRunBatchRepository(handle).create({
          id: `batch-${id}`,
          suiteId: "fixture-suite",
          suiteName: "Fixture suite",
          suiteVersion: 1,
          projectId: DEFAULT_PROJECT_ID,
          retryLimit: 0,
          runnerIds: [],
          runs: [
            {
              id: `run-${id}`,
              caseDefinitionId: "fixture-case",
              caseVersion: 1,
              displayName: "Fixture case",
              className: "example.Fixture",
            },
          ],
          environmentVariables: [],
          createdAt: now,
          dispatchJob: {
            ...job,
            kind: "dispatch-run",
            messageId: `batch-${id}`,
            deduplicationKey: `batch-${id}`,
            runId: `batch-${id}`,
            payload: { batchId: `batch-${id}` },
          },
        }),
        new SqliteCaseCatalogRepository(handle).createJarImportJob({
          job: {
            id,
            projectId: DEFAULT_PROJECT_ID,
            fileName: "fixture.jar",
            sha256: "a".repeat(64),
            sizeBytes: 10,
            status: "queued",
            progressPercent: 0,
            createdAt: now,
            updatedAt: now,
          },
          objectKey: "fixture",
          idempotencyKey: id,
          dispatchJob: job,
        }),
        new SqlitePlatformOperationsRepository(handle).createAnalyticsExportJob({
          job: {
            id,
            requestedBy: id,
            filter: {},
            format: "csv",
            status: "queued",
            progressPercent: 0,
            createdAt: now,
            updatedAt: now,
          },
          idempotencyKey: id,
          dispatchJob: {
            ...job,
            messageId: `export-${id}`,
            deduplicationKey: `export-${id}`,
            kind: "analytics-export",
          },
        }),
        identities.appendAudit({
          id,
          actorType: "user",
          actorId: id,
          action: "fixture",
          resourceType: "fixture",
          result: "succeeded",
          details: {},
          recordedAt: now,
        }),
      ]);
      expect(yielded).toBe(true);
      expect(handle.client.prepare("SELECT COUNT(*) AS count FROM queue_jobs").get()).toEqual({
        count: 3,
      });
      expect(handle.client.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
        count: 1,
      });
    } finally {
      clearTimeout(release);
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const mode of ["sqlite", "postgres"] as const) {
    it.skipIf(mode === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
      `authenticates on a read-only ${mode} connection and still enforces refresh and revocation`,
      async () => {
        const directory = await mkdtemp(join(tmpdir(), "autoforge-auth-priority-"));
        const sqlite =
          mode === "sqlite"
            ? createSqliteDatabase({
                databasePath: join(directory, "platform.sqlite"),
                migrationsFolder: resolve("packages/db/drizzle/sqlite"),
              })
            : undefined;
        const postgres =
          mode === "postgres"
            ? createPostgresDatabase({
                connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
                migrationsFolder: resolve("packages/db/drizzle/postgresql"),
                poolMax: 1,
              })
            : undefined;
        const repository: IdentityAccessRepository = sqlite
          ? new SqliteIdentityAccessRepository(sqlite)
          : new PostgresIdentityAccessRepository(postgres!);
        const id = randomUUID();
        const createdAt = "2026-09-07T00:00:00.000Z";
        const now = "2026-09-07T00:01:00.000Z";
        try {
          await postgres?.ready;
          await repository.createLocalUser({
            id,
            username: id,
            normalizedUsername: id,
            displayName: "Resource test",
            passwordHash: "unused",
            forcePasswordChange: false,
            createdAt,
          });
          await repository.createSessionAfterLogin({
            id,
            userId: id,
            tokenHash: id,
            createdAt,
            expiresAt: "2026-09-07T01:00:00.000Z",
          });
          if (sqlite) sqlite.client.pragma("query_only = ON");
          else await postgres!.pool.query("BEGIN READ ONLY");
          await expect(repository.resolveSession(id, now)).resolves.toMatchObject({
            sessionId: id,
          });
          await expect(
            repository.resolveSession(id, "2026-09-07T02:00:00.000Z"),
          ).resolves.toBeNull();
          if (sqlite) sqlite.client.pragma("query_only = OFF");
          else await postgres!.pool.query("COMMIT");
          expect(
            await repository.renewSession({
              sessionId: id,
              refreshedAt: now,
              expiresAt: "2026-09-07T02:00:00.000Z",
            }),
          ).toBe(true);
          expect((await repository.findSession(id))?.lastSeenAt).toBe(now);
          await repository.revokeSession(id, now);
          await expect(repository.resolveSession(id, now)).resolves.toBeNull();
        } finally {
          if (sqlite) {
            sqlite.client.pragma("query_only = OFF");
            sqlite.close();
          }
          if (postgres) {
            await postgres.pool.query("ROLLBACK");
            await postgres.pool.query("DELETE FROM user_sessions WHERE user_id=$1", [id]);
            await postgres.pool.query("DELETE FROM users WHERE id=$1", [id]);
            await postgres.close();
          }
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
  it("returns quickly on a competing SQLite writer and recovers after the lock is released", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-db-priority-"));
    const databasePath = join(directory, "platform.sqlite");
    const web = createSqliteDatabase({
      databasePath,
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
      busyTimeoutMs: 25,
    });
    web.client.exec("CREATE TABLE priority_probe (id INTEGER PRIMARY KEY)");
    const writer = new Database(databasePath);
    try {
      writer.exec("BEGIN IMMEDIATE; INSERT INTO priority_probe VALUES (1)");
      const started = performance.now();
      expect(() => web.client.exec("INSERT INTO priority_probe VALUES (2)")).toThrow(/locked/);
      expect(performance.now() - started).toBeLessThan(250);
      expect(web.client.prepare("SELECT COUNT(*) AS count FROM priority_probe").get()).toEqual({
        count: 0,
      });
      writer.exec("COMMIT");
      web.client.exec("INSERT INTO priority_probe VALUES (2)");
      expect(web.client.prepare("SELECT COUNT(*) AS count FROM priority_probe").get()).toEqual({
        count: 2,
      });
    } finally {
      writer.close();
      web.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    "cancels background PostgreSQL statements without consuming the foreground connection",
    async () => {
      const options = {
        connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      };
      const foreground = createPostgresDatabase({ ...options, poolMax: 1 });
      await foreground.ready;
      const background = createPostgresDatabase({
        ...options,
        poolMax: 1,
        statementTimeoutMs: 100,
        lockTimeoutMs: 25,
      });
      await background.ready;
      const table = `priority_${randomUUID().replaceAll("-", "")}`;
      try {
        await foreground.pool.query(
          `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO ${table} VALUES (1,0)`,
        );
        await foreground.pool.query("BEGIN");
        await foreground.pool.query(`UPDATE ${table} SET value=1 WHERE id=1`);
        await expect(
          background.pool.query(`UPDATE ${table} SET value=2 WHERE id=1`),
        ).rejects.toMatchObject({ code: "55P03" });
        await foreground.pool.query("COMMIT");
        const scan = expect(background.pool.query("SELECT pg_sleep(5)")).rejects.toMatchObject({
          code: "57014",
        });
        expect((await foreground.pool.query("SELECT 1 AS alive")).rows).toEqual([{ alive: 1 }]);
        await scan;
        expect((await background.pool.query(`SELECT value FROM ${table}`)).rows).toEqual([
          { value: 1 },
        ]);
      } finally {
        await foreground.pool.query("ROLLBACK");
        await foreground.pool.query(`DROP TABLE IF EXISTS ${table}`);
        await Promise.all([foreground.close(), background.close()]);
      }
    },
  );
});
