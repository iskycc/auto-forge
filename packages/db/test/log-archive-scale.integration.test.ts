import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { LocalObjectStore } from "../../object-store/src/local-object-store";
import { createSqliteDatabase } from "../src/database";
import { createAttemptLogStore, isolatedThreadLogCompression } from "../src/attempt-log-store";
import { SqliteLogArchiveRepository } from "../src/sqlite-log-archives";
import { ArchivedAttemptLogStore } from "../src/archived-attempt-log-store";
import { LogArchiveWorker } from "../src/log-archive-worker";

// Opt-in: run alone with one worker and an external CPU/memory limit. This creates real
// history and log databases; it does not launch Runner processes or represent a production compression ratio.
describe.skipIf(process.env.AUTOFORGE_TEST_LOG_ARCHIVE_SCALE !== "1")(
  "monthly archive production-sized history",
  () => {
    it("archives 20,000 cases across ten rounds with bounded memory and retains first/last logs after cleanup", async () => {
      const directory = await mkdtemp(join(tmpdir(), "af-log-archive-scale-"));
      const main = createSqliteDatabase({
        databasePath: join(directory, "main.sqlite"),
        migrationsFolder: resolve("packages/db/drizzle/sqlite"),
      });
      const batchId = randomUUID(),
        runnerId = randomUUID(),
        archiveId = randomUUID();
      const timestamp = "2026-10-27T00:00:00.000Z",
        now = "2026-11-03T00:00:00.000Z";
      const content =
        "Synthetic archive scale fixture: 日志正文、中文 CaseId、离线读取校验。\n".repeat(16);
      const bytes = Buffer.from(content),
        digest = createHash("sha256").update(bytes).digest("hex");
      const caseCount = 20000,
        rounds = 10,
        attemptCount = caseCount * rounds;
      const identity = (prefix: string, index: number) =>
        `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      let logs = createAttemptLogStore(
        join(directory, "attempt-logs"),
        isolatedThreadLogCompression,
      );
      let raw: Database.Database | undefined;
      let archived: ArchivedAttemptLogStore | undefined;
      const started = performance.now();
      try {
        await logs.appendChunks({
          batchId,
          attemptId: randomUUID(),
          receivedAt: timestamp,
          chunks: [],
        });
        logs.close();
        raw = new Database(join(directory, "attempt-logs", `${batchId}.sqlite`));
        raw.pragma("journal_mode=WAL");
        raw.pragma("synchronous=NORMAL");
        main.client
          .prepare(
            "INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES(?,?,?,0,0,'linux','amd64','scale-fixture',1,'{}','[]',1,0,?,?,?)",
          )
          .run(runnerId, runnerId, "归档规模验证", timestamp, timestamp, timestamp);
        main.client
          .prepare(
            "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at,attempt_logs_path) VALUES(?,'scale','20,000 用例 × 10 轮归档验证',1,'failed',0,?,'[]',?,?,?)",
          )
          .run(batchId, caseCount, timestamp, timestamp, logs.relativeStorePath(batchId));
        const insertRun = main.client.prepare(
          "INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES(?,?,?,1,?,?,'failed',10,?,?)",
        );
        const insertAttempt = main.client.prepare(
          "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,scheduling_score,created_at,started_at,finished_at) VALUES(?,?,?,?,?,'failed',1,?,?,?)",
        );
        const insertChunk = raw.prepare(
          "INSERT INTO attempt_log_chunks(attempt_id,stream,sequence,content,content_encoding,size_bytes,stored_size_bytes,content_sha256,recorded_at,received_at) VALUES(?,'stdout',0,?,'identity',?,?,?,?,?)",
        );
        const insertWatermark = raw.prepare(
          "INSERT INTO attempt_log_watermarks(attempt_id,stream,acknowledged_sequence,updated_at) VALUES(?,'stdout',0,?)",
        );
        for (let offset = 0; offset < caseCount; offset += 250) {
          // Keep the source fixture bounded too; no 200,000-element input array or giant SQL.
          const seedMain = main.client.transaction(() => {
            for (let index = offset; index < Math.min(caseCount, offset + 250); index++) {
              const runId = identity("20000000", index);
              insertRun.run(
                runId,
                batchId,
                runId,
                `规模用例 ${index}`,
                `example.ArchiveCase${index}`,
                timestamp,
                timestamp,
              );
              for (let round = 1; round <= rounds; round++)
                insertAttempt.run(
                  identity("10000000", index * rounds + round - 1),
                  runId,
                  runnerId,
                  round,
                  round,
                  timestamp,
                  timestamp,
                  timestamp,
                );
            }
          });
          seedMain();
          raw.transaction(() => {
            for (
              let index = offset * rounds;
              index < Math.min(attemptCount, (offset + 250) * rounds);
              index++
            ) {
              const id = identity("10000000", index);
              insertChunk.run(id, bytes, bytes.length, bytes.length, digest, timestamp, timestamp);
              insertWatermark.run(id, timestamp);
            }
          })();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        raw.close();
        raw = undefined;
        logs = createAttemptLogStore(join(directory, "attempt-logs"), isolatedThreadLogCompression);
        const sourceBytes = logs.batchStoreStats([batchId]).get(batchId)!;
        const repository = new SqliteLogArchiveRepository(main),
          objects = new LocalObjectStore(directory);
        await objects.ready();
        archived = new ArchivedAttemptLogStore(logs, repository, objects);
        await repository.create(archiveId, "2026-10", undefined, "scale-fixture", now, {
          targetVolumeMiB: 1024,
          minimumFreeMiB: 1024,
          minimumFreePercent: 10,
        });
        const worker = new LogArchiveWorker({
          repository,
          logs,
          objects,
          dataDirectory: directory,
          viewerResourcesDirectory: resolve("resources/log-archive-viewer"),
          clock: { now: () => new Date(now) },
          ids: { next: randomUUID },
          backgroundAllowed: () => true,
        });
        const seeded = performance.now();
        process.stdout.write(
          JSON.stringify({
            phase: "scale-source-seeded",
            attemptCount,
            sourceBytes,
            seedDurationMs: Math.round(seeded - started),
          }) + "\n",
        );
        await worker.run(new AbortController().signal);
        const ready = await repository.find(archiveId);
        expect(ready).toMatchObject({ status: "ready", attemptCount, chunkCount: attemptCount });
        const generated = performance.now();
        process.stdout.write(
          JSON.stringify({
            phase: "scale-archive-verified",
            archiveBytes: ready.archiveBytes,
            archiveDurationMs: Math.round(generated - seeded),
          }) + "\n",
        );
        await repository.requestCleanup(archiveId, now);
        await worker.run(new AbortController().signal);
        expect((await repository.find(archiveId)).status).toBe("completed");
        for (const index of [0, attemptCount - 1]) {
          const page = await archived.listChunks({
            batchId,
            attemptId: identity("10000000", index),
            stream: "stdout",
            afterSequence: -1,
            limit: 10,
          });
          expect(page.items).toHaveLength(1);
          expect(page.items[0]!.content).toBe(content);
        }
        process.stdout.write(
          JSON.stringify({
            fixture: "20k-cases-10-rounds",
            caseCount,
            attemptCount,
            chunkCount: ready.chunkCount,
            sourceBytes,
            archiveBytes: ready.archiveBytes,
            estimatedTemporaryBytes: ready.estimatedTemporaryBytes,
            seedDurationMs: Math.round(seeded - started),
            archiveDurationMs: Math.round(generated - seeded),
            cleanupAndReadDurationMs: Math.round(performance.now() - generated),
            maximumRssKiB: process.resourceUsage().maxRSS,
          }) + "\n",
        );
      } finally {
        raw?.close();
        if (archived) await archived.close();
        else logs.close();
        main.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 600000);
  },
);
