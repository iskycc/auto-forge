import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { LogDatabaseService } from "@autoforge/application";
import { AesGcmSecretCipher } from "../../../apps/web/src/lib/secret-cipher-core";
import { createPostgresDatabase, type PostgresDatabaseHandle } from "../src/postgres-database";
import { createAttemptLogStore } from "../src/attempt-log-store";
import { PostgresLogDatabaseRepository } from "../src/postgres-log-databases";
import { PostgresRoutedAttemptLogStore } from "../src/postgres-routed-attempt-logs";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-10-27T00:00:00.000Z";
describe.skipIf(!connectionString)("independent PostgreSQL log database routing", () => {
  let admin: Pool;
  let database: PostgresDatabaseHandle;
  let registry: PostgresLogDatabaseRepository;
  let service: LogDatabaseService;
  let logs: PostgresRoutedAttemptLogStore;
  let directory: string;
  let runnerId: string;
  const cipher = new AesGcmSecretCipher(randomBytes(32).toString("base64"));
  const names = Array.from({ length: 7 }, () => `af_logs_${randomUUID().replaceAll("-", "")}`);
  const urls: string[] = [];
  let firstId: string;
  let secondId: string;
  const extras: PostgresLogDatabaseRepository[] = [];
  function registryForTest() {
    const value = new PostgresLogDatabaseRepository(
      database,
      cipher,
      "test-platform",
      resolve(import.meta.dirname, "../drizzle/log-postgresql"),
    );
    extras.push(value);
    return value;
  }
  async function select(id: string | null) {
    await registry.check(id ?? firstId);
    await registry.select(id, (await service.list()).revision);
  }
  async function batch() {
    const id = randomUUID();
    await database.pool.query(
      `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at)
      VALUES($1,'suite-1','日志测试',1,'running',0,1,'[]',$2,$2)`,
      [id, now],
    );
    const attemptId = randomUUID();
    await database.pool.query(
      `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at)
      VALUES($1,$2,$1,1,'case','example.Case','running',1,$3,$3)`,
      [attemptId, id, now],
    );
    await database.pool.query(
      `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES($1,$1,$2,1,'running',1,$3)`,
      [attemptId, runnerId, now],
    );
    // These fixtures represent batches bound to legacy databases before the daily-storage upgrade.
    await database.pool.query(
      "INSERT INTO run_batch_log_storage(batch_id,database_id) SELECT $1,active_database_id FROM log_database_settings WHERE id=1",
      [id],
    );
    return { batchId: id, attemptId };
  }
  function append(
    target: Awaited<ReturnType<typeof batch>>,
    sequence = 0,
    content = "中文日志\u0000🚀",
  ) {
    return {
      ...target,
      receivedAt: now,
      chunks: [{ stream: "stdout" as const, sequence, content, recordedAt: now }],
    };
  }
  function read(target: Awaited<ReturnType<typeof batch>>) {
    return { ...target, stream: "stdout" as const, afterSequence: -1, limit: 32 };
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    for (const name of names) {
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(connectionString!);
      url.pathname = `/${name}`;
      urls.push(url.toString());
    }
    database = createPostgresDatabase({
      connectionString: urls[0]!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
      poolMax: 1,
    });
    await database.ready;
    directory = await mkdtemp(join(tmpdir(), "af-postgres-log-routing-"));
    registry = registryForTest();
    service = new LogDatabaseService(
      registry,
      { now: () => new Date(now) },
      { next: () => randomUUID() },
    );
    logs = new PostgresRoutedAttemptLogStore(registry, createAttemptLogStore(directory));
    firstId = (
      await registry.register(randomUUID(), { name: "日志库一", databaseUrl: urls[1]! }, now)
    ).id;
    secondId = (
      await registry.register(randomUUID(), { name: "日志库二", databaseUrl: urls[2]! }, now)
    ).id;
    runnerId = randomUUID();
    await database.pool.query(
      `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
      VALUES($1,$1,'日志执行机',FALSE,FALSE,'linux','amd64','1.20.22',1,'{}','[]',2,0,$2,$2,$2)`,
      [runnerId, now],
    );
  }, 60000);
  afterAll(async () => {
    if (logs) await logs.close();
    for (const extra of extras) if (extra !== registry) await extra.close();
    if (database) await database.close();
    if (admin) {
      for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("keeps complete batches in their original database across switches, process restarts and another reader", async () => {
    await select(firstId);
    const first = await batch();
    await logs.appendChunks(append(first));
    await select(secondId);
    const second = await batch();
    await logs.appendChunks(append(second, 0, "second database"));
    await logs.appendChunks(append(first, 1, "still first database"));
    const reader = new PostgresRoutedAttemptLogStore(
      registryForTest(),
      createAttemptLogStore(directory),
    );
    expect((await reader.listChunks(read(first))).items.map((item) => item.content)).toEqual([
      "中文日志\u0000🚀",
      "still first database",
    ]);
    expect((await reader.listChunks(read(second))).items[0]?.content).toBe("second database");
    const bindings = await database.pool.query(
      "SELECT batch_id,database_id FROM run_batch_log_storage WHERE batch_id=ANY($1::text[])",
      [[first.batchId, second.batchId]],
    );
    expect(new Map(bindings.rows.map((row) => [row.batch_id, row.database_id]))).toEqual(
      new Map([
        [first.batchId, firstId],
        [second.batchId, secondId],
      ]),
    );
    expect(
      (await database.pool.query("SELECT count(*)::int AS total FROM attempt_log_chunks")).rows[0]
        .total,
    ).toBe(0);
    expect(JSON.stringify(await service.list())).not.toContain("connection_encrypted");
    const encrypted = (
      await database.pool.query("SELECT connection_encrypted FROM log_databases WHERE id=$1", [
        firstId,
      ])
    ).rows[0].connection_encrypted;
    expect(encrypted).not.toContain(urls[1]);
    await reader.close();
  });

  it("handles concurrent retransmission, gaps and conflicts atomically and reads completion watermarks using one business connection", async () => {
    await select(firstId);
    const target = await batch();
    await Promise.all([
      logs.appendChunks(append(target, 0, "zero")),
      logs.appendChunks(append(target, 2, "two")),
    ]);
    expect(await logs.acknowledgedSequence(target.batchId, target.attemptId, "stdout")).toBe(0);
    expect((await logs.appendChunks(append(target, 1, "one"))).stdout).toBe(2);
    await logs.appendChunks(append(target, 1, "one"));
    await expect(
      logs.appendChunks({
        ...append(target, 1, "changed"),
        chunks: [
          ...append(target, 3, "should roll back").chunks,
          ...append(target, 1, "changed").chunks,
        ],
      }),
    ).rejects.toMatchObject({ code: "LOG_CHUNK_CONFLICT" });
    expect((await logs.listChunks(read(target))).items.map((item) => item.sequence)).toEqual([
      0, 1, 2,
    ]);
    const page = await logs.listChunks({ ...read(target), limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(
      (await logs.listChunks({ ...read(target), afterSequence: 1, query: "two" })).items.map(
        (item) => item.sequence,
      ),
    ).toEqual([2]);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      expect(
        await logs.acknowledgedSequence(target.batchId, target.attemptId, "stdout", client),
      ).toBe(2);
      await logs.recordWatermarks(
        { ...target, watermarks: { stdout: 2, stderr: -1, agent: -1 }, recordedAt: now },
        client,
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect((await logs.batchStoreStats([target.batchId])).get(target.batchId)).toBe(10);
  });

  it("keeps historical local logs readable but rejects every further local write", async () => {
    const target = await batch();
    const local = createAttemptLogStore(directory);
    try {
      await local.appendChunks(append(target, 0, "legacy"));
    } finally {
      local.close();
    }
    await database.pool.query("UPDATE run_batches SET attempt_logs_path=$2 WHERE id=$1", [
      target.batchId,
      logs.relativeStorePath(target.batchId),
    ]);
    await database.pool.query(
      "UPDATE run_batch_log_storage SET database_id=NULL WHERE batch_id=$1",
      [target.batchId],
    );
    await expect(registry.select(null, (await registry.settings()).revision)).rejects.toMatchObject(
      { code: "FULL_LOCAL_LOG_WRITE_DISABLED" },
    );
    await expect(logs.appendChunks(append(target, 1, "must not be stored"))).rejects.toMatchObject({
      code: "FULL_LOCAL_LOG_WRITE_DISABLED",
    });
    expect((await logs.listChunks(read(target))).items.map((item) => item.content)).toEqual([
      "legacy",
    ]);
  });

  it("reuses a registered identity and rejects business databases, stale switches, unavailable databases and wrong identities without changing bindings", async () => {
    await expect(
      registry.register(randomUUID(), { name: "错误的主库", databaseUrl: urls[0]! }, now),
    ).rejects.toMatchObject({ code: "LOG_DATABASE_INVALID" });
    expect(
      (await registry.register(randomUUID(), { name: "重复库", databaseUrl: urls[1]! }, now)).id,
    ).toBe(firstId);
    const revision = (await service.list()).revision;
    await select(firstId);
    await expect(registry.select(secondId, revision)).rejects.toMatchObject({
      code: "LOG_DATABASE_CONFLICT",
    });
    const target = await batch();
    await logs.appendChunks(append(target));
    const purpose = `log-database:${firstId}`;
    try {
      await database.pool.query("UPDATE log_databases SET connection_encrypted=$2 WHERE id=$1", [
        firstId,
        cipher.encrypt(urls[2]!, purpose),
      ]);
      const invalid = new PostgresRoutedAttemptLogStore(
        registryForTest(),
        createAttemptLogStore(directory),
      );
      await expect(invalid.listChunks(read(target))).rejects.toMatchObject({
        code: "LOG_DATABASE_IDENTITY_CONFLICT",
      });
      await invalid.close();
      const unreachable = new URL(urls[1]!);
      unreachable.port = "1";
      await database.pool.query("UPDATE log_databases SET connection_encrypted=$2 WHERE id=$1", [
        firstId,
        cipher.encrypt(unreachable.toString(), purpose),
      ]);
      const offline = new PostgresRoutedAttemptLogStore(
        registryForTest(),
        createAttemptLogStore(directory),
      );
      await expect(offline.listChunks(read(target))).rejects.toMatchObject({
        code: "PLATFORM_LOG_DATABASE_UNAVAILABLE",
      });
      await offline.close();
      expect(
        (
          await database.pool.query(
            "SELECT database_id FROM run_batch_log_storage WHERE batch_id=$1",
            [target.batchId],
          )
        ).rows[0].database_id,
      ).toBe(firstId);
    } finally {
      await database.pool.query("UPDATE log_databases SET connection_encrypted=$2 WHERE id=$1", [
        firstId,
        cipher.encrypt(urls[1]!, purpose),
      ]);
    }
    expect((await logs.listChunks(read(target))).items).toHaveLength(1);
  });

  it("expands past the pool cache size and reads all databases after idle pool eviction", async () => {
    const targets = [];
    for (let index = 3; index < urls.length; index++) {
      const id = (
        await registry.register(
          randomUUID(),
          { name: `扩展库 ${index}`, databaseUrl: urls[index]! },
          now,
        )
      ).id;
      await select(id);
      const target = await batch();
      await logs.appendChunks(append(target, 0, `database ${index}`));
      targets.push({ target, index, id });
    }
    await select(firstId);
    const old = await batch();
    await logs.appendChunks(append(old, 0, "first store after eviction"));
    for (const { target, index } of targets)
      expect((await logs.listChunks(read(target))).items[0]?.content).toBe(`database ${index}`);
    expect((await logs.listChunks(read(old))).items[0]?.content).toBe("first store after eviction");
  });

  it("retries a committed payload after business metadata fails without duplicating content or bytes", async () => {
    await select(firstId);
    const target = await batch();
    const trigger = `fail_metadata_${randomUUID().replaceAll("-", "")}`;
    await database.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected metadata failure'; END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON run_batch_log_storage FOR EACH ROW WHEN (NEW.batch_id='${target.batchId}') EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      await expect(logs.appendChunks(append(target, 0, "durable payload"))).rejects.toThrow(
        "injected metadata failure",
      );
    } finally {
      await database.pool.query(`DROP TRIGGER ${trigger} ON run_batch_log_storage`);
      await database.pool.query(`DROP FUNCTION ${trigger}()`);
    }
    expect((await logs.appendChunks(append(target, 0, "durable payload"))).stdout).toBe(0);
    expect((await logs.listChunks(read(target))).items.map((row) => row.content)).toEqual([
      "durable payload",
    ]);
    expect((await logs.batchStoreStats([target.batchId])).get(target.batchId)).toBe(
      Buffer.byteLength("durable payload"),
    );
  });

  it("recovers an interrupted registration through the log database's durable identity", async () => {
    const orphanName = `registration_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${orphanName}`);
    const orphanUrl = new URL(connectionString!);
    orphanUrl.pathname = `/${orphanName}`;
    let recoveredId: string | undefined;
    const probe = registryForTest();
    try {
      const registration = await registry.register(
        randomUUID(),
        {
          name: "登记恢复测试",
          databaseUrl: orphanUrl.toString(),
        },
        now,
      );
      recoveredId = registration.id;
      await database.pool.query("DELETE FROM log_databases WHERE id=$1", [registration.id]);
      const recovered = await registry.register(
        randomUUID(),
        {
          name: "重试登记",
          databaseUrl: orphanUrl.toString(),
        },
        now,
      );
      expect(recovered.id).toBe(registration.id);
      await probe.check(recovered.id);
    } finally {
      await probe.close();
      if (recoveredId)
        await database.pool.query("DELETE FROM log_databases WHERE id=$1", [recoveredId]);
      await admin.query(`DROP DATABASE ${orphanName} WITH (FORCE)`);
    }
  });

  it("preserves the Runner Protocol safe-integer sequence range", async () => {
    await select(firstId);
    const target = await batch();
    const sequence = Number.MAX_SAFE_INTEGER;
    expect((await logs.appendChunks(append(target, sequence, "large sequence"))).stdout).toBe(-1);
    const result = await logs.listChunks({ ...read(target), afterSequence: sequence - 1 });
    expect(result.items.map((row) => row.sequence)).toEqual([sequence]);
  });

  it("updates credentials for the same database across readers while rejecting another target", async () => {
    await select(firstId);
    const target = await batch();
    await logs.appendChunks(append(target, 0, "before connection update"));
    const alternate = new URL(urls[1]!);
    alternate.searchParams.set("application_name", "updated-log-client");
    await service.updateConnection(firstId, {
      name: "日志库一（更新连接）",
      databaseUrl: alternate.toString(),
    });
    await logs.appendChunks(append(target, 1, "after connection update"));
    expect((await logs.listChunks(read(target))).items).toHaveLength(2);
    await expect(
      service.updateConnection(firstId, { name: "错误目标", databaseUrl: urls[2]! }),
    ).rejects.toMatchObject({ code: "LOG_DATABASE_IDENTITY_CONFLICT" });
    expect((await logs.listChunks(read(target))).items).toHaveLength(2);
  });

  it("cleans routed payloads and orphan bindings without deleting another database's logs", async () => {
    await select(firstId);
    const removed = await batch();
    await logs.appendChunks(append(removed));
    await select(secondId);
    const retained = await batch();
    await logs.appendChunks(append(retained));
    await database.pool.query("DELETE FROM run_batches WHERE id=$1", [removed.batchId]);
    await logs.cleanupOrphans();
    expect(
      (
        await database.pool.query("SELECT 1 FROM run_batch_log_storage WHERE batch_id=$1", [
          removed.batchId,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await logs.listChunks(read(retained))).items).toHaveLength(1);
  });
});
