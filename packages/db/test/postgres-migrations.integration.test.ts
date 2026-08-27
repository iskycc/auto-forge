import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { migratePostgresDatabase } from "../../../apps/web/src/lib/migrate-database";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const scratchDatabases: string[] = [];

async function createScratchDatabase(admin: Client): Promise<string> {
  const name = `autoforge_mig_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  scratchDatabases.push(name);
  return name;
}

async function dropScratchDatabases(admin: Client): Promise<void> {
  for (const name of scratchDatabases.splice(0)) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

function connectionStringFor(database: string): string {
  const url = new URL(connectionString!);
  url.pathname = `/${database}`;
  return url.toString();
}

describe.skipIf(!connectionString)("PostgreSQL migrations", () => {
  afterAll(async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await dropScratchDatabases(admin);
    } finally {
      await admin.end();
    }
  });

  it("backfills ownership and per-project scope when upgrading to product completion", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const productMigration = "0014_product_completion.sql";
    const productMigrationIndex = migrationFiles.indexOf(productMigration);
    expect(productMigrationIndex).toBeGreaterThan(0);

    const defaultProjectId = "00000000-0000-7000-8000-000000000001";
    try {
      for (const fileName of migrationFiles.slice(0, productMigrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO roles (id, role_key, name, description, scope, built_in, permissions_json, created_at, updated_at)
        VALUES
          ('00000000-0000-7000-8100-000000000001', 'system-administrator', '系统管理员', '', 'system', TRUE, '[]',
           '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
        INSERT INTO users
          (id, username, normalized_username, display_name, source, status,
           force_password_change, failed_login_attempts, created_at, updated_at, version)
        VALUES
          ('admin-first', 'admin-first', 'admin-first', 'First Admin', 'local', 'active', FALSE, 0,
           '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 1),
          ('admin-second', 'admin-second', 'admin-second', 'Second Admin', 'local', 'active', FALSE, 0,
           '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 1);
        INSERT INTO user_system_roles (user_id, role_id, source, assigned_at, assigned_by)
        VALUES
          ('admin-first', '00000000-0000-7000-8100-000000000001', 'manual', '2026-08-01T00:00:00.000Z', NULL),
          ('admin-second', '00000000-0000-7000-8100-000000000001', 'manual', '2026-08-05T00:00:00.000Z', NULL);
        INSERT INTO projects (id, name, slug, is_default, archived, created_at, updated_at)
        VALUES
          ('project-b', '项目 B', 'project-b', FALSE, FALSE, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
        INSERT INTO case_sources
          (id, display_name, original_file_name, object_key, sha256, size_bytes, class_count,
           method_count, status, warnings_json, created_at, inspection_json, authoritative)
        VALUES
          ('source-one', 'tests-one.jar', 'tests-one.jar', 'jar/one',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1024, 2, 5,
           'ready', '[]', '2026-08-04T00:00:00.000Z', '{}', TRUE),
          ('source-two', 'tests-two.jar', 'tests-two.jar', 'jar/two',
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 2048, 1, 3,
           'ready', '[]', '2026-08-04T01:00:00.000Z', '{}', FALSE);
        INSERT INTO case_definitions
          (id, source_id, class_name, package_name, display_name, enabled, groups_json,
           current_version, created_at, updated_at)
        VALUES
          ('case-one', 'source-one', 'com.example.LoginTest', 'com.example', 'LoginTest', TRUE, '[]',
           1, '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');
        INSERT INTO case_versions (id, case_definition_id, version, snapshot_json, created_at)
        VALUES ('case-one-v1', 'case-one', 1, '{}', '2026-08-04T00:00:00.000Z');
        INSERT INTO case_suites (id, name, description, version, created_at, updated_at)
        VALUES ('suite-one', '回归任务', NULL, 1, '2026-08-04T02:00:00.000Z', '2026-08-04T02:00:00.000Z');
        INSERT INTO runners
          (id, credential_hash, name, disabled, os, architecture, agent_version, protocol_version,
           labels_json, max_concurrency, busy_slots, last_seen_at, terminal_enabled, created_at,
           updated_at, draining, capabilities_json)
        VALUES
          ('runner-one', 'hash-one', 'runner-one', FALSE, 'linux', 'amd64', '0.2.2', 1, '[]', 2, 0,
           '2026-08-04T03:00:00.000Z', FALSE, '2026-08-04T03:00:00.000Z', '2026-08-04T03:00:00.000Z',
           FALSE, '[]');
        INSERT INTO run_batches
          (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
           total_runs, created_at, updated_at, project_id, priority, version)
        VALUES
          ('batch-one', 'suite-one', '回归任务', 1, 'queued', 0, '[]', 1,
           '2026-08-04T04:00:00.000Z', '2026-08-04T04:00:00.000Z', '${defaultProjectId}', 0, 1);
        INSERT INTO execution_runs
          (id, batch_id, case_definition_id, case_version, display_name, class_name, status,
           attempt_count, created_at, updated_at, version)
        VALUES
          ('run-one', 'batch-one', 'case-one', 1, 'LoginTest', 'com.example.LoginTest', 'queued',
           0, '2026-08-04T04:00:00.000Z', '2026-08-04T04:00:00.000Z', 1);
      `);

      await client.query(await readFile(resolve(migrationsFolder, productMigration), "utf8"));

      const owners = await client.query<{ id: string; owner_user_id: string }>(
        "SELECT id, owner_user_id FROM projects ORDER BY id",
      );
      expect(owners.rows).toEqual([
        { id: defaultProjectId, owner_user_id: "admin-first" },
        { id: "project-b", owner_user_id: "admin-first" },
      ]);
      const role = await client.query<{ active: boolean }>(
        "SELECT active FROM roles WHERE id = '00000000-0000-7000-8100-000000000001'",
      );
      expect(role.rows).toEqual([{ active: true }]);
      const runner = await client.query<{
        credential_version: number;
        credential_revoked_at: string | null;
        deregistered_at: string | null;
      }>(
        "SELECT credential_version, credential_revoked_at, deregistered_at FROM runners WHERE id = 'runner-one'",
      );
      expect(runner.rows).toEqual([
        { credential_version: 1, credential_revoked_at: null, deregistered_at: null },
      ]);
      const source = await client.query<{
        project_id: string;
        lifecycle_status: string;
        revision: number;
        updated_at: string;
      }>(
        `SELECT project_id, lifecycle_status, revision, updated_at
         FROM case_sources WHERE id = 'source-one'`,
      );
      expect(source.rows).toEqual([
        {
          project_id: defaultProjectId,
          lifecycle_status: "active",
          revision: 1,
          updated_at: "2026-08-04T00:00:00.000Z",
        },
      ]);
      const updatedAtNullable = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'case_sources' AND column_name = 'updated_at'`,
      );
      expect(updatedAtNullable.rows).toEqual([{ is_nullable: "NO" }]);
      const definition = await client.query<{
        project_id: string;
        description: string;
        tags_json: string;
        parameters_json: string;
        archived: boolean;
        revision: number;
      }>(
        `SELECT project_id, description, tags_json, parameters_json, archived, revision
         FROM case_definitions WHERE id = 'case-one'`,
      );
      expect(definition.rows).toEqual([
        {
          project_id: defaultProjectId,
          description: "",
          tags_json: "[]",
          parameters_json: "{}",
          archived: false,
          revision: 1,
        },
      ]);
      const version = await client.query<{ change_reason: string; created_by: string | null }>(
        "SELECT change_reason, created_by FROM case_versions WHERE id = 'case-one-v1'",
      );
      expect(version.rows).toEqual([{ change_reason: "source.import", created_by: null }]);
      const suite = await client.query<{
        project_id: string;
        status: string;
        enabled: boolean;
        revision: number;
        policy_json: string;
      }>(
        "SELECT project_id, status, enabled, revision, policy_json FROM case_suites WHERE id = 'suite-one'",
      );
      expect(suite.rows).toEqual([
        {
          project_id: defaultProjectId,
          status: "active",
          enabled: true,
          revision: 1,
          policy_json: "{}",
        },
      ]);
      const run = await client.query<{ parameters_json: string }>(
        "SELECT parameters_json FROM execution_runs WHERE id = 'run-one'",
      );
      expect(run.rows).toEqual([{ parameters_json: "{}" }]);

      const duplicateSha256 = "b".repeat(64);
      await client.query(
        `INSERT INTO case_sources
         (id, project_id, display_name, original_file_name, object_key, sha256, size_bytes,
          class_count, method_count, status, warnings_json, inspection_json, authoritative,
          lifecycle_status, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 3, 'ready', '[]', '{}', FALSE, 'active', 1, $8, $8)`,
        [
          "source-two-project-b",
          "project-b",
          "tests-two.jar",
          "tests-two.jar",
          "jar/two-project-b",
          duplicateSha256,
          2048,
          "2026-08-05T00:00:00.000Z",
        ],
      );
      await expect(
        client.query(
          `INSERT INTO case_sources
           (id, project_id, display_name, original_file_name, object_key, sha256, size_bytes,
            class_count, method_count, status, warnings_json, inspection_json, authoritative,
            lifecycle_status, revision, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 3, 'ready', '[]', '{}', FALSE, 'active', 1, $8, $8)`,
          [
            "source-two-default-dup",
            defaultProjectId,
            "tests-two-dup.jar",
            "tests-two-dup.jar",
            "jar/two-default-dup",
            duplicateSha256,
            2048,
            "2026-08-05T00:00:00.000Z",
          ],
        ),
      ).rejects.toThrow(/case_sources_project_sha256_uq/);
      await client.query("UPDATE case_sources SET authoritative = TRUE WHERE id = $1", [
        "source-two-project-b",
      ]);
      await expect(
        client.query("UPDATE case_sources SET authoritative = TRUE WHERE id = $1", ["source-two"]),
      ).rejects.toThrow(/case_sources_project_authoritative_uq/);

      const tables = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const tableNames = new Set(tables.rows.map((row) => row.table_name));
      for (const table of [
        "case_source_comparisons",
        "case_suite_versions",
        "case_suite_schedules",
        "scheduled_trigger_receipts",
        "cleanup_jobs",
        "analytics_facts",
        "notifications",
        "system_settings",
      ]) {
        expect(tableNames.has(table), `missing table ${table}`).toBe(true);
      }
    } finally {
      await client.end();
    }
  });

  it("rolls back a failed migration set and resumes after correction", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-pg-migration-recovery-"));
    const scratchConnection = connectionStringFor(scratch);
    try {
      await writeFile(
        resolve(directory, "0001_first.sql"),
        "CREATE TABLE sample(id TEXT PRIMARY KEY);",
      );
      await writeFile(
        resolve(directory, "0002_broken.sql"),
        "INSERT INTO sample(id) VALUES('must-rollback'); INVALID SQL;",
      );

      await expect(migratePostgresDatabase(scratchConnection, directory)).rejects.toThrow();
      const failed = new Client({ connectionString: scratchConnection });
      await failed.connect();
      await expect(
        failed.query("SELECT to_regclass('public.sample') AS table_name"),
      ).resolves.toMatchObject({ rows: [{ table_name: null }] });
      await failed.end();

      await writeFile(
        resolve(directory, "0002_broken.sql"),
        "INSERT INTO sample(id) VALUES('recovered');",
      );
      await migratePostgresDatabase(scratchConnection, directory);
      const recovered = new Client({ connectionString: scratchConnection });
      await recovered.connect();
      await expect(recovered.query("SELECT id FROM sample")).resolves.toMatchObject({
        rows: [{ id: "recovered" }],
      });
      await recovered.end();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("backfills immutable case-version source ownership", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const sourceMigration = "0023_case_version_sources.sql";
    const sourceMigrationIndex = migrationFiles.indexOf(sourceMigration);
    expect(sourceMigrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, sourceMigrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO case_sources
          (id, project_id, display_name, original_file_name, object_key, sha256, size_bytes,
           class_count, method_count, status, warnings_json, inspection_json, authoritative,
           lifecycle_status, revision, created_at, updated_at)
        VALUES
          ('source-existing', '00000000-0000-7000-8000-000000000001', 'Existing',
           'existing.jar', 'jars/existing.jar',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 128,
           1, 1, 'ready', '[]', '{}', TRUE, 'active', 1,
           '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z');
        INSERT INTO case_definitions
          (id, project_id, source_id, class_name, package_name, display_name, description,
           tags_json, parameters_json, enabled, archived, revision, groups_json,
           current_version, created_at, updated_at)
        VALUES
          ('case-existing', '00000000-0000-7000-8000-000000000001', 'source-existing',
           'example.ExistingTest', 'example', 'ExistingTest', '', '[]', '{}', TRUE, FALSE, 1,
           '[]', 1, '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z');
        INSERT INTO case_versions
          (id, case_definition_id, version, snapshot_json, change_reason, created_at)
        VALUES
          ('case-existing-v1', 'case-existing', 1, '{}', 'source.import',
           '2026-08-09T00:00:00.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, sourceMigration), "utf8"));

      await expect(
        client.query("SELECT source_id FROM case_versions WHERE id = 'case-existing-v1'"),
      ).resolves.toMatchObject({ rows: [{ source_id: "source-existing" }] });
      await expect(
        client.query("DELETE FROM case_sources WHERE id = 'source-existing'"),
      ).rejects.toThrow(/case_versions_source_id_case_sources_id_fk/);
    } finally {
      await client.end();
    }
  });

  it("preserves scheduling history while allowing Runner fault rescheduling events", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const eventMigration = "0033_runner_fault_scheduling_events.sql";
    const eventMigrationIndex = migrationFiles.indexOf(eventMigration);
    expect(eventMigrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, eventMigrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO run_batches
          (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
           total_runs, project_id, created_at, updated_at)
        VALUES
          ('batch-events', 'suite-events', 'Events', 1, 'running', 0, '[]', 1,
           '00000000-0000-7000-8000-000000000001',
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
        INSERT INTO scheduling_events
          (id, batch_id, event_type, message, recorded_at)
        VALUES
          ('event-existing', 'batch-events', 'runner_metrics', 'Existing event',
           '2026-08-20T00:01:00.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, eventMigration), "utf8"));
      await expect(client.query("SELECT event_type FROM scheduling_events")).resolves.toMatchObject(
        {
          rows: [{ event_type: "runner_metrics" }],
        },
      );
      await expect(
        client.query(
          `INSERT INTO scheduling_events
             (id, batch_id, event_type, message, recorded_at)
           VALUES ('event-runner-fault', 'batch-events', 'runner_fault_rescheduled',
                   'Runner fault rescheduled', '2026-08-20T00:02:00.000Z')`,
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  it("keeps scheduling events while dropping their foreign keys", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const eventMigration = "0050_scheduling_events_drop_foreign_keys.sql";
    const eventMigrationIndex = migrationFiles.indexOf(eventMigration);
    expect(eventMigrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, eventMigrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO run_batches
          (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
           total_runs, project_id, created_at, updated_at)
        VALUES
          ('batch-events', 'suite-events', 'Events', 1, 'running', 0, '[]', 1,
           '00000000-0000-7000-8000-000000000001',
           '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
        INSERT INTO scheduling_events
          (id, batch_id, event_type, message, recorded_at)
        VALUES
          ('event-existing', 'batch-events', 'runner_metrics', 'Existing event',
           '2026-08-20T00:01:00.000Z'),
          ('event-retry-concurrency', 'batch-events', 'retry_concurrency_changed',
           'Concurrency changed', '2026-08-20T00:01:30.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, eventMigration), "utf8"));
      await expect(
        client.query("SELECT event_type FROM scheduling_events ORDER BY id"),
      ).resolves.toMatchObject({
        rows: [{ event_type: "runner_metrics" }, { event_type: "retry_concurrency_changed" }],
      });
      // 外键移除后，诊断流水允许引用已清理的历史对象（保留周期显式清理）。
      await expect(
        client.query(
          `INSERT INTO scheduling_events
             (id, batch_id, event_type, message, recorded_at)
           VALUES ('event-after-fk-drop', 'batch-missing', 'attempt_completed',
                   'Event without foreign key', '2026-08-20T00:02:00.000Z')`,
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  it("upgrades version runtime resources and repairs normal TestNG batch status", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migration = "0037_version_assets_and_batch_status.sql";
    const migrationIndex = migrationFiles.indexOf(migration);
    expect(migrationIndex).toBeGreaterThan(0);
    const projectId = "00000000-0000-7000-8000-000000000001";
    try {
      for (const fileName of migrationFiles.slice(0, migrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO project_versions
          (id, project_id, name, normalized_name, created_at, updated_at)
        VALUES
          ('version-one', '${projectId}', '1.0', '1.0',
           '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
          ('version-two', '${projectId}', '2.0', '2.0',
           '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
        INSERT INTO project_runtime_assets
          (id, project_id, kind, source_type, file_name, url, sha256, size_bytes,
           archive_format, created_at)
        VALUES
          ('jdk-global', '${projectId}', 'jdk', 'url', 'jdk.zip',
           'https://assets.example.test/jdk.zip',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1024, 'zip',
           '2026-08-22T00:00:00.000Z'),
          ('bundle-global', '${projectId}', 'jar-bundle', 'url', 'global.zip',
           'https://assets.example.test/global.zip',
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 2048, 'zip',
           '2026-08-22T00:00:00.000Z'),
          ('bundle-version-one', '${projectId}', 'jar-bundle', 'url', 'one.zip',
           'https://assets.example.test/one.zip',
           'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 4096, 'zip',
           '2026-08-22T00:00:00.000Z');
        INSERT INTO project_adapter_configurations
          (project_id, jdk_asset_id, jar_bundle_asset_id, updated_at)
        VALUES
          ('${projectId}', 'jdk-global', 'bundle-global', '2026-08-22T00:00:00.000Z');
        INSERT INTO project_version_runtime_assets
          (project_version_id, project_id, jar_bundle_asset_id, updated_at)
        VALUES
          ('version-one', '${projectId}', 'bundle-version-one', '2026-08-22T00:00:00.000Z');
        INSERT INTO run_batches
          (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
           total_runs, project_id, created_at, updated_at)
        VALUES
          ('batch-normal-failure', 'suite-one', 'Suite one', 1, 'failed', 0, '[]', 1,
           '${projectId}', '2026-08-22T01:00:00.000Z', '2026-08-22T01:01:00.000Z'),
          ('batch-runner-failure', 'suite-two', 'Suite two', 1, 'failed', 0, '[]', 1,
           '${projectId}', '2026-08-22T02:00:00.000Z', '2026-08-22T02:01:00.000Z');
        INSERT INTO execution_runs
          (id, batch_id, case_definition_id, case_version, display_name, class_name, status,
           terminal_reason_code, created_at, updated_at)
        VALUES
          ('run-normal-failure', 'batch-normal-failure', 'case-one', 1, 'Case one',
           'example.CaseOne', 'failed', 'TESTNG_ASSERTIONS_FAILED',
           '2026-08-22T01:00:00.000Z', '2026-08-22T01:01:00.000Z'),
          ('run-runner-failure', 'batch-runner-failure', 'case-two', 1, 'Case two',
           'example.CaseTwo', 'failed', 'PROCESS_START_FAILED',
           '2026-08-22T02:00:00.000Z', '2026-08-22T02:01:00.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, migration), "utf8"));

      await expect(
        client.query(
          `SELECT project_version_id, jdk_asset_id, jar_bundle_asset_id
           FROM project_version_runtime_assets ORDER BY project_version_id`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            project_version_id: "version-one",
            jdk_asset_id: "jdk-global",
            jar_bundle_asset_id: "bundle-version-one",
          },
          {
            project_version_id: "version-two",
            jdk_asset_id: "jdk-global",
            jar_bundle_asset_id: "bundle-global",
          },
        ],
      });
      await expect(
        client.query("SELECT id, status, version FROM run_batches ORDER BY id"),
      ).resolves.toMatchObject({
        rows: [
          { id: "batch-normal-failure", status: "succeeded", version: 2 },
          { id: "batch-runner-failure", status: "failed", version: 1 },
        ],
      });
      await expect(
        client.query(
          `SELECT from_status, to_status, batch_version, reason
           FROM run_batch_status_events WHERE batch_id = 'batch-normal-failure'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            from_status: "failed",
            to_status: "succeeded",
            batch_version: 2,
            reason: "migration.normal_test_failure",
          },
        ],
      });
    } finally {
      await client.end();
    }
  });

  it("preserves existing recovery state while allowing parallel same-round steps", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migration = "0042_parallel_round_recoveries.sql";
    const migrationIndex = migrationFiles.indexOf(migration);
    expect(migrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, migrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO run_batches
          (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
           retry_mode, current_round, environment_json, secret_bindings_json, total_runs,
           project_id, scheduled_for, created_at, updated_at)
        VALUES
          ('batch-parallel-migration', nextval('run_batch_sequence_numbers'), 'suite-migration',
           'Migration suite', 1, 'queued', 1, 'round', 1, '[]', '[]', 1,
           '00000000-0000-7000-8000-000000000001', '2026-08-23T00:00:00.000Z',
           '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z');
        INSERT INTO run_batch_round_recoveries
          (batch_id, rule_id, after_round, next_round, jenkins_job_url,
           api_key_ciphertext, wait_minutes, status, available_at, created_at, updated_at)
        VALUES
          ('batch-parallel-migration', 'existing-step', 1, 2,
           'https://jenkins.internal/job/existing/', 'encrypted-existing', 3, 'waiting',
           '2026-08-23T00:03:00.000Z', '2026-08-23T00:00:00.000Z',
           '2026-08-23T00:00:00.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, migration), "utf8"));
      await expect(
        client.query(
          `SELECT rule_id, status, wait_minutes FROM run_batch_round_recoveries
           WHERE batch_id = 'batch-parallel-migration'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ rule_id: "existing-step", status: "waiting", wait_minutes: 3 }],
      });
      await expect(
        client.query(`
          INSERT INTO run_batch_round_recoveries
            (batch_id, rule_id, after_round, next_round, jenkins_job_url,
             api_key_ciphertext, wait_minutes, status, available_at, created_at, updated_at)
          VALUES
            ('batch-parallel-migration', 'second-step', 1, 2,
             'https://jenkins.internal/job/second/', 'encrypted-second', 5, 'idle',
             '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z',
             '2026-08-23T00:00:00.000Z')
        `),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  it("adds empty sticky retry-concurrency state without changing existing batches", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migration = "0043_sticky_retry_concurrency.sql";
    const migrationIndex = migrationFiles.indexOf(migration);
    expect(migrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, migrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO run_batches
          (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
           retry_mode, current_round, environment_json, secret_bindings_json, total_runs,
           project_id, scheduled_for, created_at, updated_at)
        VALUES
          ('batch-sticky-migration', nextval('run_batch_sequence_numbers'), 'suite-migration',
           'Migration suite', 1, 'queued', 10, 'round', 5, '[]', '[]', 1,
           '00000000-0000-7000-8000-000000000001', '2026-08-24T00:00:00.000Z',
           '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, migration), "utf8"));
      await expect(
        client.query("SELECT COUNT(*)::int AS count FROM run_batch_retry_concurrency_states"),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await client.query(
        `INSERT INTO run_batch_retry_concurrency_states
         (batch_id, rule_id, rule_index, concurrency, activated_round, updated_at)
         VALUES ('batch-sticky-migration', 'high-pass', 0, 40, 2,
                 '2026-08-24T00:01:00.000Z')`,
      );
      await client.query("DELETE FROM run_batches WHERE id = 'batch-sticky-migration'");
      await expect(
        client.query("SELECT COUNT(*)::int AS count FROM run_batch_retry_concurrency_states"),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await client.end();
    }
  });

  it("preserves recovery rows while adding the retryable round-release state", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migration = "0044_retryable_round_release.sql";
    const migrationIndex = migrationFiles.indexOf(migration);
    expect(migrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, migrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO run_batches
          (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
           retry_mode, current_round, environment_json, secret_bindings_json, total_runs,
           project_id, scheduled_for, created_at, updated_at)
        VALUES
          ('batch-release-migration', nextval('run_batch_sequence_numbers'), 'suite-migration',
           'Migration suite', 1, 'queued', 1, 'round', 2, '[]', '[]', 1,
           '00000000-0000-7000-8000-000000000001', '2026-08-25T00:00:00.000Z',
           '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
        INSERT INTO run_batch_round_recoveries
          (batch_id, rule_id, after_round, next_round, jenkins_job_url,
           api_key_ciphertext, wait_minutes, status, available_at, created_at, updated_at)
        VALUES
          ('batch-release-migration', 'existing-step', 2, 3,
           'https://jenkins.internal/job/existing/', 'encrypted-existing', 3, 'waiting',
           '2026-08-25T00:03:00.000Z', '2026-08-25T00:00:00.000Z',
           '2026-08-25T00:00:00.000Z'),
          ('batch-release-migration', 'stranded-step', 1, 2,
           'https://jenkins.internal/job/stranded/', 'encrypted-stranded', 0, 'succeeded',
           '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z',
           '2026-08-25T00:00:00.000Z');
        INSERT INTO execution_runs
          (id, batch_id, case_definition_id, case_version, display_name, class_name,
           parameters_json, status, attempt_count, held_round, queue_deadline_at,
           execution_timeout_ms, upload_timeout_ms, version, created_at, updated_at)
        VALUES
          ('run-release-migration', 'batch-release-migration', 'case-release-migration', 1,
           'Case 1', 'example.Case1', '{}', 'queued', 1, 0,
           '2026-08-26T00:00:00.000Z', 600000, 600000, 1,
           '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, migration), "utf8"));
      await expect(
        client.query("SELECT rule_id, status FROM run_batch_round_recoveries ORDER BY rule_id"),
      ).resolves.toMatchObject({
        rows: [
          { rule_id: "existing-step", status: "waiting" },
          { rule_id: "stranded-step", status: "releasing" },
        ],
      });
      await expect(
        client.query(
          `UPDATE run_batch_round_recoveries SET status = 'releasing'
           WHERE batch_id = 'batch-release-migration'`,
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  it("backfills recovery activation while adding Jenkins timeline fields", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migration = "0045_round_recovery_timeline.sql";
    const migrationIndex = migrationFiles.indexOf(migration);
    expect(migrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, migrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO run_batches
          (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
           retry_mode, current_round, environment_json, secret_bindings_json, total_runs,
           project_id, scheduled_for, created_at, updated_at)
        VALUES
          ('batch-timeline-migration', nextval('run_batch_sequence_numbers'), 'suite-migration',
           'Migration suite', 1, 'queued', 1, 'round', 1, '[]', '[]', 1,
           '00000000-0000-7000-8000-000000000001', '2026-08-25T00:00:00.000Z',
           '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
        INSERT INTO run_batch_round_recoveries
          (batch_id, rule_id, after_round, next_round, jenkins_job_url,
           api_key_ciphertext, wait_minutes, status, available_at, created_at, updated_at)
        VALUES
          ('batch-timeline-migration', 'existing-step', 1, 2,
           'https://jenkins.internal/job/existing/', 'encrypted-existing', 3, 'waiting',
           '2026-08-25T00:03:00.000Z', '2026-08-25T00:00:00.000Z',
           '2026-08-25T00:01:00.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, migration), "utf8"));
      await expect(
        client.query(
          `SELECT activated_at, started_at, finished_at, build_result
           FROM run_batch_round_recoveries WHERE batch_id = 'batch-timeline-migration'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            activated_at: "2026-08-25T00:01:00.000Z",
            started_at: null,
            finished_at: null,
            build_result: null,
          },
        ],
      });
    } finally {
      await client.end();
    }
  });

  it("adds a zeroed Jenkins polling failure counter to existing recoveries", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migration = "0046_round_recovery_poll_retries.sql";
    const migrationIndex = migrationFiles.indexOf(migration);
    expect(migrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, migrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO run_batches
          (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
           retry_mode, current_round, environment_json, secret_bindings_json, total_runs,
           project_id, scheduled_for, created_at, updated_at)
        VALUES
          ('batch-poll-migration', nextval('run_batch_sequence_numbers'), 'suite-migration',
           'Migration suite', 1, 'queued', 1, 'round', 1, '[]', '[]', 1,
           '00000000-0000-7000-8000-000000000001', '2026-08-25T00:00:00.000Z',
           '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
        INSERT INTO run_batch_round_recoveries
          (batch_id, rule_id, after_round, next_round, jenkins_job_url,
           api_key_ciphertext, wait_minutes, status, available_at, created_at, updated_at)
        VALUES
          ('batch-poll-migration', 'existing-step', 1, 2,
           'https://jenkins.internal/job/existing/', 'encrypted-existing', 3, 'polling',
           '2026-08-25T00:03:00.000Z', '2026-08-25T00:00:00.000Z',
           '2026-08-25T00:01:00.000Z');
      `);

      await client.query(await readFile(resolve(migrationsFolder, migration), "utf8"));
      await expect(
        client.query(
          `SELECT poll_failure_count FROM run_batch_round_recoveries
           WHERE batch_id = 'batch-poll-migration'`,
        ),
      ).resolves.toMatchObject({ rows: [{ poll_failure_count: 0 }] });
    } finally {
      await client.end();
    }
  });

  it("adds rerun metadata and backfills the first-round concurrency snapshot", async () => {
    const admin = new Client({ connectionString });
    await admin.connect();
    const scratch = await createScratchDatabase(admin);
    await admin.end();
    const client = new Client({ connectionString: connectionStringFor(scratch) });
    await client.connect();
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migration = "0047_round_rerun_observability.sql";
    const migrationIndex = migrationFiles.indexOf(migration);
    expect(migrationIndex).toBeGreaterThan(0);
    try {
      for (const fileName of migrationFiles.slice(0, migrationIndex)) {
        await client.query(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      await client.query(`
        INSERT INTO run_batches
          (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
           retry_mode, current_round, environment_json, secret_bindings_json, total_runs,
           project_id, policy_json, scheduled_for, created_at, updated_at)
        VALUES
          ('batch-rerun-migration', nextval('run_batch_sequence_numbers'), 'suite-migration',
           'Migration suite', 1, 'succeeded', 1, 'round', 3, '[]', '[]', 1,
           '00000000-0000-7000-8000-000000000001', '{"concurrency":17}',
           '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z',
           '2026-08-26T00:01:00.000Z');
      `);
      await client.query(await readFile(resolve(migrationsFolder, migration), "utf8"));
      await expect(
        client.query(
          `SELECT b.batch_kind,c.execution_round,c.concurrency,c.source
           FROM run_batches b JOIN run_batch_round_concurrencies c ON c.batch_id=b.id
           WHERE b.id='batch-rerun-migration'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ batch_kind: "standard", execution_round: 1, concurrency: 17, source: "base" }],
      });
    } finally {
      await client.end();
    }
  });
});
