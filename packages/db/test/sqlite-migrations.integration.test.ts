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

describe("SQLite migrations", () => {
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
