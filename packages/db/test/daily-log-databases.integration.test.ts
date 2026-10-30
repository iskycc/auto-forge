import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { LogDatabaseService } from "@autoforge/application";
import { registerDailyLogServerSchema } from "@autoforge/contracts";
import { AesGcmSecretCipher } from "../../../apps/web/src/lib/secret-cipher-core";
import { createPostgresDatabase, type PostgresDatabaseHandle } from "../src/postgres-database";
import { PostgresLogDatabaseRepository } from "../src/postgres-log-databases";
import { PostgresRoutedAttemptLogStore } from "../src/postgres-routed-attempt-logs";
import { createAttemptLogStore } from "../src/attempt-log-store";
const url = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const beforeMidnight = "2026-10-27T15:59:59.000Z",
  afterMidnight = "2026-10-27T16:00:00.000Z";
describe.skipIf(!url)("daily PostgreSQL logs", () => {
  let admin: Pool,
    db: PostgresDatabaseHandle,
    registry: PostgresLogDatabaseRepository,
    logs: PostgresRoutedAttemptLogStore,
    service: LogDatabaseService,
    directory: string,
    serverId: string,
    runnerId: string;
  const businessName = `af_daily_${randomUUID().replaceAll("-", "")}`;
  const maintenanceName = `${businessName}_admin`;
  const prefix = `aft_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const connection = new URL(url ?? "postgres://postgres:fixture-only@127.0.0.1:55438/postgres");
  const server = registerDailyLogServerSchema.parse({
    name: "每日独立日志",
    host: connection.hostname,
    port: Number(connection.port || 5432),
    username: decodeURIComponent(connection.username),
    password: decodeURIComponent(connection.password),
    maintenanceDatabase: maintenanceName,
    databasePrefix: prefix,
  });
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${businessName}"`);
    await admin.query(`CREATE DATABASE "${maintenanceName}"`);
    const business = new URL(connection);
    business.pathname = `/${businessName}`;
    db = createPostgresDatabase({
      connectionString: business.toString(),
      migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      poolMax: 1,
    });
    await db.ready;
    directory = await mkdtemp(join(tmpdir(), "af-daily-logs-"));
    registry = new PostgresLogDatabaseRepository(
      db,
      new AesGcmSecretCipher(randomBytes(32).toString("base64")),
      "daily-platform",
      resolve("packages/db/drizzle/log-postgresql"),
    );
    service = new LogDatabaseService(
      registry,
      { now: () => new Date(beforeMidnight) },
      { next: randomUUID },
    );
    await Promise.all([
      registry.initializeDaily(server, randomUUID(), beforeMidnight),
      registry.initializeDaily(server, randomUUID(), beforeMidnight),
    ]);
    serverId = (await registry.settings()).activeDatabaseId!;
    logs = new PostgresRoutedAttemptLogStore(registry, createAttemptLogStore(directory));
    runnerId = randomUUID();
    await db.pool.query(
      `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES($1,$1,'runner',FALSE,FALSE,'linux','amd64','test',1,'{}','[]',10,0,$2,$2,$2)`,
      [runnerId, beforeMidnight],
    );
  }, 60000);
  afterAll(async () => {
    if (logs) await logs.close();
    if (db) await db.close();
    if (admin) {
      const names = await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE starts_with(datname,$1)",
        [prefix + "_"],
      );
      for (const row of names.rows) await admin.query(`DROP DATABASE "${row.datname}"`);
      await admin.query(`DROP DATABASE IF EXISTS "${businessName}"`);
      await admin.query(`DROP DATABASE IF EXISTS "${maintenanceName}"`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function target() {
    const batchId = randomUUID(),
      attemptId = randomUUID();
    await db.pool.query(
      `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES($1,'suite','daily',1,'running',0,1,'[]',$2,$2)`,
      [batchId, beforeMidnight],
    );
    await db.pool.query(
      `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES($1,$2,$1,1,'中文','example.Case','running',1,$3,$3)`,
      [attemptId, batchId, beforeMidnight],
    );
    await db.pool.query(
      `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES($1,$1,$2,1,'running',1,$3)`,
      [attemptId, runnerId, beforeMidnight],
    );
    return { batchId, attemptId };
  }
  it("initializes a daily server once and preserves later manual switches on restart", async () => {
    expect(serverId).toBeTruthy();
    const current = await registry.settings();
    expect(current.revision).toBe(2);
    await registry.initializeDaily(
      { ...server, password: "invalid-never-used" },
      randomUUID(),
      afterMidnight,
    );
    expect(await registry.settings()).toEqual(current);
    expect((await service.list()).items).toHaveLength(1);
    await service.select({ databaseId: null, revision: current.revision });
    await registry.initializeDaily(server, randomUUID(), afterMidnight);
    const deselected = await registry.settings();
    expect(deselected.activeDatabaseId).toBeNull();
    await service.select({ databaseId: serverId, revision: deselected.revision });
  });
  it("creates separate Beijing daily databases, joins cross-midnight streams and deduplicates retries without early acknowledgement", async () => {
    const subject = await target();
    const append = (sequence: number, recordedAt: string, content = `中文\0日志${sequence}`) =>
      logs.appendChunks({
        ...subject,
        receivedAt: afterMidnight,
        chunks: [{ stream: "stdout", sequence, content, recordedAt }],
      });
    expect((await append(0, beforeMidnight)).stdout).toBe(0);
    expect((await append(2, afterMidnight)).stdout).toBe(0);
    expect((await append(1, afterMidnight)).stdout).toBe(2);
    await append(0, beforeMidnight);
    const locations = await db.pool.query(
      "SELECT d.storage_day FROM attempt_log_database_locations l JOIN log_databases d ON d.id=l.database_id WHERE l.attempt_id=$1 ORDER BY d.storage_day",
      [subject.attemptId],
    );
    expect(locations.rows.map((r) => r.storage_day)).toEqual(["2026-10-27", "2026-10-28"]);
    const read = { ...subject, stream: "stdout" as const, afterSequence: -1, limit: 32 };
    expect((await logs.listChunks(read)).items.map((c) => c.sequence)).toEqual([0, 1, 2]);
    await expect(append(0, afterMidnight, "changed")).rejects.toMatchObject({
      code: "LOG_CHUNK_CONFLICT",
    });
    expect((await logs.batchStoreStats([subject.batchId])).get(subject.batchId)).toBe(
      Buffer.byteLength("中文\0日志0中文\0日志1中文\0日志2"),
    );
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      expect(
        await logs.acknowledgedSequence(subject.batchId, subject.attemptId, "stdout", client),
      ).toBe(2);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await logs.removeBatchPayload(subject.batchId);
    expect((await logs.listChunks(read)).items).toEqual([]);
    expect(await logs.acknowledgedSequence(subject.batchId, subject.attemptId, "stdout")).toBe(2);
  });
  it("shows redacted server fields and rejects changing the historical prefix", async () => {
    const page = await service.list();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.storageMode).toBe("daily");
    expect(page.items[0]?.server?.username).toBe(server.username);
    expect(JSON.stringify(page)).not.toContain(server.password);
    await expect(
      service.updateConnection(serverId, { ...server, databasePrefix: "different" }),
    ).rejects.toMatchObject({ code: "LOG_DATABASE_PREFIX_IMMUTABLE" });
  });
  it("does not create an unbounded set of databases for invalid dates", async () => {
    await expect(registry.daily.ensureDay(serverId, "2026-02-30")).rejects.toThrow();
  });
  it("allows opposite cross-day uploads concurrently without holding payload connections while waiting on another day", async () => {
    const first = await target(),
      second = await target();
    const append = (subject: typeof first, sequence: number, recordedAt: string) =>
      logs.appendChunks({
        ...subject,
        receivedAt: afterMidnight,
        chunks: [
          { stream: "stdout", sequence, recordedAt, content: `${subject.attemptId}:${sequence}` },
        ],
      });
    await append(first, 0, beforeMidnight);
    await append(second, 0, afterMidnight);
    const results = await Promise.all([
      append(first, 1, afterMidnight),
      append(second, 1, beforeMidnight),
    ]);
    expect(results.map((result) => result.stdout)).toEqual([1, 1]);
  }, 10000);
  it("rejects accounts without database-creation privileges before persisting their credentials", async () => {
    const role = `af_no_create_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'fixture-only' NOCREATEDB`);
    try {
      await expect(
        service.register({ ...server, name: "权限不足", username: role, password: "fixture-only" }),
      ).rejects.toMatchObject({ code: "LOG_DATABASE_CREATE_PERMISSION_REQUIRED" });
    } finally {
      await admin.query(`DROP ROLE "${role}"`);
    }
  });
  it("does not recreate an externally missing ready database during read or retransmission", async () => {
    const subject = await target();
    const timestamp = "2026-10-29T00:00:00.000Z";
    const input = {
      ...subject,
      receivedAt: timestamp,
      chunks: [
        {
          stream: "stdout" as const,
          sequence: 0,
          content: "preserve missing-store diagnostic",
          recordedAt: timestamp,
        },
      ],
    };
    await logs.appendChunks(input);
    const day = (
      await db.pool.query<{ physical_name: string }>(
        "SELECT physical_name FROM log_databases WHERE parent_database_id=$1 AND storage_day='2026-10-29'",
        [serverId],
      )
    ).rows[0]!;
    await admin.query(`DROP DATABASE "${day.physical_name}" WITH (FORCE)`);
    await expect(
      logs.listChunks({ ...subject, stream: "stdout", afterSequence: -1, limit: 10 }),
    ).rejects.toMatchObject({ code: "PLATFORM_LOG_DATABASE_UNAVAILABLE" });
    await expect(logs.appendChunks(input)).rejects.toMatchObject({
      code: "PLATFORM_LOG_DATABASE_UNAVAILABLE",
    });
    expect(
      (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [day.physical_name])).rows,
    ).toEqual([]);
  });
});
