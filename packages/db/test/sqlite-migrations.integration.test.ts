import { mkdtemp, readdir, rm } from "node:fs/promises";
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
