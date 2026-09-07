import { mkdtemp, mkdir, readdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { runSqliteMigrations } from "../src/migrations";

describe("queue work class index upgrade", () => {
  it.each([false, true])(
    "preserves queued work across an upgrade (injected failure: %s)",
    async (fail) => {
      const directory = await mkdtemp(join(tmpdir(), "autoforge-queue-upgrade-"));
      const previous = join(directory, "previous");
      const current = resolve(import.meta.dirname, "../drizzle/sqlite");
      const migration = "0067_queue_work_class_indexes.sql";
      await mkdir(previous);
      for (const file of await readdir(current))
        if (file.endsWith(".sql") && file < migration)
          await copyFile(join(current, file), join(previous, file));
      const handle = createSqliteDatabase({
        databasePath: join(directory, "platform.sqlite"),
        migrationsFolder: previous,
      });
      try {
        handle.client.exec(
          `INSERT INTO queue_jobs(message_id,run_id,attempt,schema_version,kind,payload_json,priority,deduplication_key,status,available_at,created_at,updated_at) VALUES ('preserved','run',1,1,'jar-import','{}',0,'preserved','available','2026-09-01','2026-09-01','2026-09-01')`,
        );
        const sql = await readFile(join(current, migration), "utf8");
        await writeFile(
          join(previous, migration),
          sql + (fail ? "\nSELECT * FROM missing_upgrade_fixture;" : ""),
        );
        if (fail) {
          expect(() => runSqliteMigrations(handle.client, previous)).toThrow(
            "missing_upgrade_fixture",
          );
          expect(
            handle.client
              .prepare("SELECT name FROM sqlite_master WHERE name='queue_jobs_execution_claim_idx'")
              .get(),
          ).toBeUndefined();
          await writeFile(join(previous, migration), sql);
        }
        runSqliteMigrations(handle.client, previous);
        expect(
          handle.client.prepare("SELECT status FROM queue_jobs WHERE message_id='preserved'").get(),
        ).toEqual({ status: "available" });
        expect(
          handle.client
            .prepare("SELECT name FROM sqlite_master WHERE name='queue_jobs_execution_claim_idx'")
            .get(),
        ).toBeDefined();
        expect(
          handle.client
            .prepare("SELECT name FROM _autoforge_migrations WHERE name=?")
            .get(migration),
        ).toBeDefined();
      } finally {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
