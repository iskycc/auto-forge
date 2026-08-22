import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// 迁移测试会从历史版本逐份回放全部 DDL；GitHub 并行 job 的磁盘抖动可能超过
// Vitest 默认 5 秒，但每条仍应在独立的 15 秒边界内完成。
describe("SQLite migrations", { timeout: 15_000 }, () => {
  it("serializes concurrent startup workers without repeating DDL", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-migrations-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const initializer = new Database(databasePath);
    initializer.pragma("journal_mode = WAL");
    initializer.close();

    const workerCount = 4;
    const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const results = await Promise.all(
      Array.from({ length: workerCount }, () =>
        runMigrationWorker({ barrierBuffer, databasePath, migrationsFolder, workerCount }),
      ),
    );

    expect(results).toEqual(Array.from({ length: workerCount }, () => ({ status: "ok" })));
    const migrationFiles = (await readdir(migrationsFolder)).filter((name) =>
      /^\d+_.+\.sql$/.test(name),
    );
    const verifier = new Database(databasePath, { readonly: true });
    try {
      const applied = verifier
        .prepare("SELECT COUNT(*) AS count FROM _autoforge_migrations")
        .get() as { count: number };
      expect(applied.count).toBe(migrationFiles.length);
    } finally {
      verifier.close();
    }
  });

  it("backfills a status-history baseline when upgrading an existing database", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-batch-history-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const historyMigration = "0011_run_batch_history.sql";
    const historyMigrationIndex = migrationFiles.indexOf(historyMigration);
    expect(historyMigration).toBe("0011_run_batch_history.sql");
    expect(historyMigrationIndex).toBeGreaterThan(0);

    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      for (const fileName of migrationFiles.slice(0, historyMigrationIndex)) {
        database.exec(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      database
        .prepare(
          `INSERT INTO run_batches
           (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
            total_runs, project_id, priority, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "batch-existing",
          "suite-existing",
          "Existing suite",
          1,
          "running",
          0,
          "[]",
          1,
          "00000000-0000-7000-8000-000000000001",
          0,
          "2026-08-09T00:00:00.000Z",
          "2026-08-09T00:05:00.000Z",
        );

      database.exec(await readFile(resolve(migrationsFolder, historyMigration), "utf8"));

      expect(
        database
          .prepare("SELECT status, version FROM run_batches WHERE id = ?")
          .get("batch-existing"),
      ).toEqual({ status: "running", version: 1 });
      expect(
        database
          .prepare(
            `SELECT batch_id, from_status, to_status, batch_version, reason, recorded_at
             FROM run_batch_status_events WHERE batch_id = ?`,
          )
          .get("batch-existing"),
      ).toEqual({
        batch_id: "batch-existing",
        from_status: null,
        to_status: "running",
        batch_version: 1,
        reason: "history.baseline",
        recorded_at: "2026-08-09T00:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("preserves inline batch snapshots when adding reusable environments", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-environment-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const environmentMigration = "0013_execution_environments.sql";
    const environmentMigrationIndex = migrationFiles.indexOf(environmentMigration);
    expect(environmentMigrationIndex).toBeGreaterThan(0);

    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      for (const fileName of migrationFiles.slice(0, environmentMigrationIndex)) {
        database.exec(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      database
        .prepare(
          `INSERT INTO run_batches
           (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
            total_runs, project_id, priority, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', 0, ?, 1, ?, 0, ?, ?)`,
        )
        .run(
          "legacy-inline-batch",
          "legacy-suite",
          "Legacy suite",
          1,
          JSON.stringify([{ name: "BASE_URL", value: "https://legacy.example.test" }]),
          "00000000-0000-7000-8000-000000000001",
          "2026-08-09T00:00:00.000Z",
          "2026-08-09T00:00:00.000Z",
        );

      database.exec(await readFile(resolve(migrationsFolder, environmentMigration), "utf8"));

      expect(
        database
          .prepare(
            "SELECT environment_json, environment_id, environment_version_id FROM run_batches WHERE id = ?",
          )
          .get("legacy-inline-batch"),
      ).toEqual({
        environment_json: JSON.stringify([
          { name: "BASE_URL", value: "https://legacy.example.test" },
        ]),
        environment_id: null,
        environment_version_id: null,
      });
    } finally {
      database.close();
    }
  });

  it("adds empty secret references without exposing or rewriting existing values", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-secret-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const secretMigration = "0014_execution_secrets.sql";
    const secretMigrationIndex = migrationFiles.indexOf(secretMigration);
    expect(secretMigrationIndex).toBeGreaterThan(0);

    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      for (const fileName of migrationFiles.slice(0, secretMigrationIndex)) {
        database.exec(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      database.exec(`
        INSERT INTO users
          (id, username, normalized_username, display_name, source, status,
           force_password_change, failed_login_attempts, created_at, updated_at, version)
        VALUES
          ('migration-actor', 'migration-actor', 'migration-actor', 'Migration Actor',
           'local', 'active', 0, 0, '2026-08-09T00:00:00.000Z',
           '2026-08-09T00:00:00.000Z', 1);
        INSERT INTO execution_environments
          (id, project_id, name, normalized_name, description, status, current_version,
           revision, created_by, created_at, updated_at)
        VALUES
          ('existing-environment', '00000000-0000-7000-8000-000000000001', 'Existing',
           'existing', '', 'active', 1, 1, 'migration-actor',
           '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z');
        INSERT INTO execution_environment_versions
          (id, environment_id, version, variables_json, created_by, created_at)
        VALUES
          ('existing-environment-version', 'existing-environment', 1,
           '[{"name":"BASE_URL","value":"https://existing.example.test"}]',
           'migration-actor', '2026-08-09T00:00:00.000Z');
      `);

      database.exec(await readFile(resolve(migrationsFolder, secretMigration), "utf8"));

      expect(
        database
          .prepare(
            "SELECT variables_json, secret_bindings_json FROM execution_environment_versions WHERE id = ?",
          )
          .get("existing-environment-version"),
      ).toEqual({
        variables_json: '[{"name":"BASE_URL","value":"https://existing.example.test"}]',
        secret_bindings_json: "[]",
      });
    } finally {
      database.close();
    }
  }, 30_000);

  it("backfills ownership and per-project scope when upgrading to product completion", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-product-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const productMigration = "0015_product_completion.sql";
    const productMigrationIndex = migrationFiles.indexOf(productMigration);
    expect(productMigrationIndex).toBeGreaterThan(0);

    const defaultProjectId = "00000000-0000-7000-8000-000000000001";
    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      for (const fileName of migrationFiles.slice(0, productMigrationIndex)) {
        database.exec(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      database.exec(`
        INSERT INTO roles (id, role_key, name, description, scope, built_in, permissions_json, created_at, updated_at)
        VALUES
          ('00000000-0000-7000-8100-000000000001', 'system-administrator', '系统管理员', '', 'system', 1, '[]',
           '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
        INSERT INTO users
          (id, username, normalized_username, display_name, source, status,
           force_password_change, failed_login_attempts, created_at, updated_at, version)
        VALUES
          ('admin-first', 'admin-first', 'admin-first', 'First Admin', 'local', 'active', 0, 0,
           '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 1),
          ('admin-second', 'admin-second', 'admin-second', 'Second Admin', 'local', 'active', 0, 0,
           '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 1);
        INSERT INTO user_system_roles (user_id, role_id, source, assigned_at, assigned_by)
        VALUES
          ('admin-first', '00000000-0000-7000-8100-000000000001', 'manual', '2026-08-01T00:00:00.000Z', NULL),
          ('admin-second', '00000000-0000-7000-8100-000000000001', 'manual', '2026-08-05T00:00:00.000Z', NULL);
        INSERT INTO projects (id, name, slug, is_default, archived, created_at, updated_at)
        VALUES
          ('project-b', '项目 B', 'project-b', 0, 0, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
        INSERT INTO case_sources
          (id, display_name, original_file_name, object_key, sha256, size_bytes, class_count,
           method_count, status, warnings_json, created_at, inspection_json, authoritative)
        VALUES
          ('source-one', 'tests-one.jar', 'tests-one.jar', 'jar/one',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1024, 2, 5,
           'ready', '[]', '2026-08-04T00:00:00.000Z', '{}', 1),
          ('source-two', 'tests-two.jar', 'tests-two.jar', 'jar/two',
           'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 2048, 1, 3,
           'ready', '[]', '2026-08-04T01:00:00.000Z', '{}', 0);
        INSERT INTO case_definitions
          (id, source_id, class_name, package_name, display_name, enabled, groups_json,
           current_version, created_at, updated_at)
        VALUES
          ('case-one', 'source-one', 'com.example.LoginTest', 'com.example', 'LoginTest', 1, '[]',
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
          ('runner-one', 'hash-one', 'runner-one', 0, 'linux', 'amd64', '0.2.2', 1, '[]', 2, 0,
           '2026-08-04T03:00:00.000Z', 0, '2026-08-04T03:00:00.000Z', '2026-08-04T03:00:00.000Z',
           0, '[]');
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

      database.exec(await readFile(resolve(migrationsFolder, productMigration), "utf8"));

      expect(database.prepare("SELECT id, owner_user_id FROM projects ORDER BY id").all()).toEqual([
        { id: defaultProjectId, owner_user_id: "admin-first" },
        { id: "project-b", owner_user_id: "admin-first" },
      ]);
      expect(
        database
          .prepare("SELECT active FROM roles WHERE id = '00000000-0000-7000-8100-000000000001'")
          .get(),
      ).toEqual({ active: 1 });
      expect(
        database
          .prepare(
            "SELECT credential_version, credential_revoked_at, deregistered_at FROM runners WHERE id = 'runner-one'",
          )
          .get(),
      ).toEqual({ credential_version: 1, credential_revoked_at: null, deregistered_at: null });
      expect(
        database
          .prepare(
            `SELECT project_id, lifecycle_status, revision, updated_at
             FROM case_sources WHERE id = 'source-one'`,
          )
          .get(),
      ).toEqual({
        project_id: defaultProjectId,
        lifecycle_status: "active",
        revision: 1,
        updated_at: "2026-08-04T00:00:00.000Z",
      });
      expect(
        database
          .prepare(
            `SELECT project_id, description, tags_json, parameters_json, archived, revision
             FROM case_definitions WHERE id = 'case-one'`,
          )
          .get(),
      ).toEqual({
        project_id: defaultProjectId,
        description: "",
        tags_json: "[]",
        parameters_json: "{}",
        archived: 0,
        revision: 1,
      });
      expect(
        database
          .prepare("SELECT change_reason, created_by FROM case_versions WHERE id = 'case-one-v1'")
          .get(),
      ).toEqual({ change_reason: "source.import", created_by: null });
      expect(
        database
          .prepare(
            "SELECT project_id, status, enabled, revision, policy_json FROM case_suites WHERE id = 'suite-one'",
          )
          .get(),
      ).toEqual({
        project_id: defaultProjectId,
        status: "active",
        enabled: 1,
        revision: 1,
        policy_json: "{}",
      });
      expect(
        database.prepare("SELECT parameters_json FROM execution_runs WHERE id = 'run-one'").get(),
      ).toEqual({ parameters_json: "{}" });

      const duplicateSha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      database
        .prepare(
          `INSERT INTO case_sources
           (id, project_id, display_name, original_file_name, object_key, sha256, size_bytes,
            class_count, method_count, status, warnings_json, inspection_json, authoritative,
            lifecycle_status, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', 0, 'active', 1, ?, ?)`,
        )
        .run(
          "source-two-project-b",
          "project-b",
          "tests-two.jar",
          "tests-two.jar",
          "jar/two-project-b",
          duplicateSha256,
          2048,
          1,
          3,
          "ready",
          "2026-08-05T00:00:00.000Z",
          "2026-08-05T00:00:00.000Z",
        );
      expect(() =>
        database
          .prepare(
            `INSERT INTO case_sources
             (id, project_id, display_name, original_file_name, object_key, sha256, size_bytes,
              class_count, method_count, status, warnings_json, inspection_json, authoritative,
              lifecycle_status, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', 0, 'active', 1, ?, ?)`,
          )
          .run(
            "source-two-default-dup",
            defaultProjectId,
            "tests-two-dup.jar",
            "tests-two-dup.jar",
            "jar/two-default-dup",
            duplicateSha256,
            2048,
            1,
            3,
            "ready",
            "2026-08-05T00:00:00.000Z",
            "2026-08-05T00:00:00.000Z",
          ),
      ).toThrow(/UNIQUE constraint failed: case_sources\.project_id, case_sources\.sha256/);
      database
        .prepare("UPDATE case_sources SET authoritative = 1 WHERE id = 'source-two-project-b'")
        .run();
      expect(() =>
        database.prepare("UPDATE case_sources SET authoritative = 1 WHERE id = 'source-two'").run(),
      ).toThrow(/UNIQUE constraint failed: case_sources\.project_id, case_sources\.authoritative/);

      const createdTables = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => (row as { name: string }).name),
      );
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
        expect(createdTables.has(table), `missing table ${table}`).toBe(true);
      }
    } finally {
      database.close();
    }
  });

  it("backfills immutable case-version source ownership", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-case-version-source-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const sourceMigration = "0024_case_version_sources.sql";
    const sourceMigrationIndex = migrationFiles.indexOf(sourceMigration);
    expect(sourceMigrationIndex).toBeGreaterThan(0);

    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      for (const fileName of migrationFiles.slice(0, sourceMigrationIndex)) {
        database.exec(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      database.exec(`
        INSERT INTO case_sources
          (id, project_id, display_name, original_file_name, object_key, sha256, size_bytes,
           class_count, method_count, status, warnings_json, inspection_json, authoritative,
           lifecycle_status, revision, created_at, updated_at)
        VALUES
          ('source-existing', '00000000-0000-7000-8000-000000000001', 'Existing',
           'existing.jar', 'jars/existing.jar',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 128,
           1, 1, 'ready', '[]', '{}', 1, 'active', 1,
           '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z');
        INSERT INTO case_definitions
          (id, project_id, source_id, class_name, package_name, display_name, description,
           tags_json, parameters_json, enabled, archived, revision, groups_json,
           current_version, created_at, updated_at)
        VALUES
          ('case-existing', '00000000-0000-7000-8000-000000000001', 'source-existing',
           'example.ExistingTest', 'example', 'ExistingTest', '', '[]', '{}', 1, 0, 1,
           '[]', 1, '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z');
        INSERT INTO case_versions
          (id, case_definition_id, version, snapshot_json, change_reason, created_at)
        VALUES
          ('case-existing-v1', 'case-existing', 1, '{}', 'source.import',
           '2026-08-09T00:00:00.000Z');
      `);

      database.exec(await readFile(resolve(migrationsFolder, sourceMigration), "utf8"));

      expect(
        database.prepare("SELECT source_id FROM case_versions WHERE id = 'case-existing-v1'").get(),
      ).toEqual({ source_id: "source-existing" });
      expect(() =>
        database.prepare("DELETE FROM case_sources WHERE id = 'source-existing'").run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      database.close();
    }
  });

  it("backfills dense batch sequence numbers in creation order when upgrading", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-batch-sequence-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const sequenceMigration = "0031_run_batch_sequence_number.sql";
    const sequenceMigrationIndex = migrationFiles.indexOf(sequenceMigration);
    expect(sequenceMigrationIndex).toBeGreaterThan(0);

    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      for (const fileName of migrationFiles.slice(0, sequenceMigrationIndex)) {
        database.exec(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      const insertBatch = database.prepare(
        `INSERT INTO run_batches
         (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
          total_runs, project_id, priority, created_at, updated_at)
         VALUES (?, 'suite-sequence', ?, 1, 'succeeded', 0, '[]', 1,
          '00000000-0000-7000-8000-000000000001', 0, ?, ?)`,
      );
      insertBatch.run(
        "batch-oldest",
        "Oldest",
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
      insertBatch.run(
        "batch-newest",
        "Newest",
        "2026-08-03T00:00:00.000Z",
        "2026-08-03T00:00:00.000Z",
      );
      insertBatch.run(
        "batch-middle",
        "Middle",
        "2026-08-02T00:00:00.000Z",
        "2026-08-02T00:00:00.000Z",
      );

      database.exec(await readFile(resolve(migrationsFolder, sequenceMigration), "utf8"));

      expect(
        database
          .prepare("SELECT id, sequence_number FROM run_batches ORDER BY sequence_number")
          .all(),
      ).toEqual([
        { id: "batch-oldest", sequence_number: 1 },
        { id: "batch-middle", sequence_number: 2 },
        { id: "batch-newest", sequence_number: 3 },
      ]);
    } finally {
      database.close();
    }
  });

  it("preserves scheduling history while allowing Runner fault rescheduling events", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-runner-fault-events-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const eventMigration = "0034_runner_fault_scheduling_events.sql";
    const eventMigrationIndex = migrationFiles.indexOf(eventMigration);
    expect(eventMigrationIndex).toBeGreaterThan(0);

    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      for (const fileName of migrationFiles.slice(0, eventMigrationIndex)) {
        database.exec(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      database.exec(`
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

      database.exec(await readFile(resolve(migrationsFolder, eventMigration), "utf8"));
      expect(database.prepare("SELECT event_type FROM scheduling_events").all()).toEqual([
        { event_type: "runner_metrics" },
      ]);
      expect(() =>
        database
          .prepare(
            `INSERT INTO scheduling_events
             (id, batch_id, event_type, message, recorded_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "event-runner-fault",
            "batch-events",
            "runner_fault_rescheduled",
            "Runner fault rescheduled",
            "2026-08-20T00:02:00.000Z",
          ),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("upgrades version runtime resources and repairs normal TestNG batch status", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-version-runtime-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../drizzle/sqlite");
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const migration = "0038_version_assets_and_batch_status.sql";
    const migrationIndex = migrationFiles.indexOf(migration);
    expect(migrationIndex).toBeGreaterThan(0);

    const projectId = "00000000-0000-7000-8000-000000000001";
    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = ON");
      for (const fileName of migrationFiles.slice(0, migrationIndex)) {
        database.exec(await readFile(resolve(migrationsFolder, fileName), "utf8"));
      }
      database.exec(`
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

      database.exec(await readFile(resolve(migrationsFolder, migration), "utf8"));

      expect(
        database
          .prepare(
            `SELECT project_version_id, jdk_asset_id, jar_bundle_asset_id
             FROM project_version_runtime_assets ORDER BY project_version_id`,
          )
          .all(),
      ).toEqual([
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
      ]);
      expect(
        database.prepare("SELECT id, status, version FROM run_batches ORDER BY id").all(),
      ).toEqual([
        { id: "batch-normal-failure", status: "succeeded", version: 2 },
        { id: "batch-runner-failure", status: "failed", version: 1 },
      ]);
      expect(
        database
          .prepare(
            `SELECT from_status, to_status, batch_version, reason
             FROM run_batch_status_events WHERE batch_id = 'batch-normal-failure'`,
          )
          .get(),
      ).toEqual({
        from_status: "failed",
        to_status: "succeeded",
        batch_version: 2,
        reason: "migration.normal_test_failure",
      });
    } finally {
      database.close();
    }
  });
});

type MigrationWorkerInput = {
  barrierBuffer: SharedArrayBuffer;
  databasePath: string;
  migrationsFolder: string;
  workerCount: number;
};

function runMigrationWorker(input: MigrationWorkerInput): Promise<{ status: string }> {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(new URL("./fixtures/sqlite-migration-worker.mjs", import.meta.url), {
      workerData: input,
    });
    worker.once("message", (result: { status: string; message?: string }) => {
      if (result.status === "ok") {
        resolveWorker({ status: "ok" });
        return;
      }
      rejectWorker(new Error(result.message ?? "Migration worker failed."));
    });
    worker.once("error", rejectWorker);
    worker.once("exit", (code) => {
      if (code !== 0) rejectWorker(new Error(`Migration worker exited with code ${code}.`));
    });
  });
}
