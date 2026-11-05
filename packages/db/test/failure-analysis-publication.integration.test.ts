import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import {
  SqliteFailureAnalysisPublicationRepository,
  PostgresFailureAnalysisPublicationRepository,
} from "../src/failure-analysis-publication";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-11-05T06:00:00.000Z";
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} analysis publication`,
    () => {
      it("persists explicit publication, revocation, disabled publishers, archival and close cascades", async () => {
        const h = await harness(dialect);
        try {
          expect(await h.repository.batch(h.batchId)).toMatchObject({
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: h.version,
          });
          expect(await h.repository.read(h.batchId)).toBeNull();
          await h.repository.publish(h.batchId, h.publisher, now);
          expect(await h.repository.read(h.batchId)).toMatchObject({
            batchId: h.batchId,
            publisher: { id: h.publisher },
          });
          expect(
            await h.query("SELECT * FROM public_batch_access WHERE batch_id=?", [h.batchId]),
          ).toEqual([]);
          await h.repository.revoke(h.batchId, now);
          expect(await h.repository.read(h.batchId)).toBeNull();
          await h.repository.publish(h.batchId, h.publisher, now);
          await h.query("UPDATE users SET status='disabled' WHERE id=?", [h.publisher]);
          expect(await h.repository.read(h.batchId)).toBeNull();
          await h.query("UPDATE users SET status='active' WHERE id=?", [h.publisher]);
          await h.query("UPDATE failure_analysis_batches SET archived_at=? WHERE batch_id=?", [
            now,
            h.batchId,
          ]);
          expect(await h.repository.read(h.batchId)).toMatchObject({ archivedAt: now });
          await h.query("DELETE FROM failure_analysis_batches WHERE batch_id=?", [h.batchId]);
          expect(await h.repository.read(h.batchId)).toBeNull();
          expect(
            await h.query("SELECT * FROM public_failure_analysis_links WHERE batch_id=?", [
              h.batchId,
            ]),
          ).toEqual([]);
        } finally {
          await h.dispose();
        }
      });
      it("exposes only the current final failed attempt, excluding passed, earlier and other-batch records", async () => {
        const h = await harness(dialect);
        try {
          await h.query(
            `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES (?,?,'runner',FALSE,FALSE,'linux','amd64','1',1,'[]','[]',1,0,?,?,?)`,
            [h.runner, h.runner, now, now, now],
          );
          await h.query(
            `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,terminal_outcome,created_at,updated_at) VALUES (?,?,'case',1,'case','Test','failed',2,'failed',?,?)`,
            [h.run, h.batchId, now, now],
          );
          for (const number of [1, 2])
            await h.query(
              `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,created_at,finished_at) VALUES (?,?,?,${number},'failed',1,'failed',?,?)`,
              [`${h.run}-${number}`, h.run, h.runner, now, now],
            );
          expect(await h.repository.failureAttempt(h.batchId, h.run)).toBe(`${h.run}-2`);
          expect(await h.repository.failureAttempt("other-batch", h.run)).toBeNull();
          await h.query("UPDATE execution_runs SET terminal_outcome='succeeded' WHERE id=?", [
            h.run,
          ]);
          expect(await h.repository.failureAttempt(h.batchId, h.run)).toBeNull();
        } finally {
          await h.dispose();
        }
      });
    },
  );

async function harness(dialect: "sqlite" | "postgresql") {
  const directory = await mkdtemp(join(tmpdir(), "analysis-publication-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: join(directory, "db.sqlite"),
          migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
        })
      : undefined;
  const postgres =
    dialect === "postgresql"
      ? createPostgresDatabase({
          connectionString: postgresUrl!,
          migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
          poolMax: 2,
        })
      : undefined;
  await postgres?.ready;
  async function query(sql: string, parameters: string[] = []) {
    if (sqlite) {
      const statement = sqlite.client.prepare(sql);
      if (statement.reader) return statement.all(...parameters) as Record<string, unknown>[];
      statement.run(...parameters);
      return [];
    }
    let index = 0;
    return (
      await postgres!.pool.query(
        sql.replace(/\?/g, () => `$${++index}`),
        parameters,
      )
    ).rows as Record<string, unknown>[];
  }
  const batchId = randomUUID(),
    publisher = randomUUID(),
    version = randomUUID(),
    runner = randomUUID(),
    run = randomUUID();
  await query(
    "INSERT INTO users(id,username,normalized_username,display_name,source,status,created_at,updated_at) VALUES (?,?,?,?,'local','active',?,?)",
    [publisher, publisher, publisher, publisher, now, now],
  );
  await query(
    `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,project_id,policy_json,created_at,updated_at) VALUES (?,'suite','分析任务',1,'failed',0,1,'[]',?,?,?,?)`,
    [batchId, DEFAULT_PROJECT_ID, JSON.stringify({ projectVersionId: version }), now, now],
  );
  await query(
    "INSERT INTO failure_analysis_batches(batch_id,project_id,started_by,started_at) VALUES (?,?,?,?)",
    [batchId, DEFAULT_PROJECT_ID, publisher, now],
  );
  return {
    query,
    batchId,
    publisher,
    version,
    runner,
    run,
    repository: sqlite
      ? new SqliteFailureAnalysisPublicationRepository(sqlite)
      : new PostgresFailureAnalysisPublicationRepository(postgres!),
    async dispose() {
      await query("DELETE FROM run_batches WHERE id=?", [batchId]);
      await query("DELETE FROM runners WHERE id=?", [runner]);
      await query("DELETE FROM users WHERE id=?", [publisher]);
      sqlite?.client.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
