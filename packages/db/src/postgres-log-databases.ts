import { Pool } from "pg";
import { DomainError } from "@autoforge/domain";
import type { LogDatabaseRepository, SecretCipherPort } from "@autoforge/application";
import type {
  LogDatabase,
  RegisterLogDatabaseInput,
  RegisterDailyLogServerInput,
} from "@autoforge/contracts";
import { runPostgresMigrations, type PostgresDatabaseHandle } from "./postgres-database";

import { PostgresDailyLogDatabases, type LogDatabaseRecord } from "./postgres-daily-log-databases";
import { logDatabaseError } from "./postgres-log-database-errors";
export { logDatabaseError } from "./postgres-log-database-errors";

const MAX_OPEN_DATABASES = 4;
type PoolEntry = { pool: Pool; lockPool: Pool; users: number; encryptedConnection: string };
type DatabaseRow = LogDatabaseRecord;

/** Registry lives in the business database; payload pools never use its connection settings. */
export class PostgresLogDatabaseRepository implements LogDatabaseRepository {
  private readonly pools = new Map<string, PoolEntry>();
  readonly daily: PostgresDailyLogDatabases;
  private allocation: Promise<void> = Promise.resolve();
  constructor(
    readonly database: PostgresDatabaseHandle,
    private readonly cipher: SecretCipherPort,
    private readonly platformId: string,
    private readonly migrationsFolder: string,
  ) {
    this.daily = new PostgresDailyLogDatabases({
      database,
      cipher,
      platformId,
      migrationsFolder,
      createPool: (url, max) => this.createPool(url, max),
    });
  }

  async list(cursor?: string) {
    const result = await this.database.pool.query<
      DatabaseRow & { batch_count: string; stored_bytes: string }
    >(
      `SELECT d.*,COALESCE(s.batch_count,0) AS batch_count,
       COALESCE(s.stored_bytes,0) AS stored_bytes FROM log_databases d
       LEFT JOIN (SELECT database_id,count(*) AS batch_count,sum(stored_bytes) AS stored_bytes
         FROM run_batch_log_storage GROUP BY database_id) s ON s.database_id=d.id
       WHERE d.storage_mode<>'day' AND d.id>$1 ORDER BY d.id LIMIT 51`,
      [cursor ?? ""],
    );
    const settings = await this.settings();
    return {
      items: result.rows
        .slice(0, 50)
        .map((row) =>
          this.view(
            row,
            settings.activeDatabaseId,
            Number(row.batch_count),
            Number(row.stored_bytes),
          ),
        ),
      ...(result.rows.length > 50 ? { nextCursor: result.rows[49]!.id } : {}),
      ...settings,
    };
  }

  async registerDaily(
    id: string,
    input: RegisterDailyLogServerInput,
    now: string,
  ): Promise<LogDatabase> {
    return this.view(
      await this.daily.register(id, input, now),
      (await this.settings()).activeDatabaseId,
      0,
      0,
    );
  }
  async updateDailyConnection(
    id: string,
    input: RegisterDailyLogServerInput,
  ): Promise<LogDatabase> {
    return this.view(
      await this.daily.updateConnection(id, input),
      (await this.settings()).activeDatabaseId,
      0,
      0,
    );
  }
  checkForWrite(id: string): Promise<void> {
    return this.daily.check(id);
  }

  async register(id: string, input: RegisterLogDatabaseInput, now: string): Promise<LogDatabase> {
    const databaseId = await this.withTemporaryDatabase(input.databaseUrl, id, async (pool) => {
      const existing = await pool.query("SELECT to_regclass('public.run_batches') AS business");
      if (existing.rows[0].business)
        throw new DomainError(
          "LOG_DATABASE_INVALID",
          "日志必须使用独立数据库，不能连接主平台业务数据库。",
        );
      await runPostgresMigrations(pool, this.migrationsFolder, {
        statementTimeoutMs: 10000,
        lockTimeoutMs: 1000,
      });
      await pool.query(
        "INSERT INTO log_storage_identity(id,database_id,platform_id) VALUES(1,$1,$2) ON CONFLICT(id) DO NOTHING",
        [id, this.platformId],
      );
      const identity = await pool.query<{ database_id: string; platform_id: string }>(
        "SELECT database_id,platform_id FROM log_storage_identity WHERE id=1",
      );
      if (identity.rows[0]?.platform_id !== this.platformId)
        throw new DomainError(
          "LOG_DATABASE_CONFLICT",
          "该日志数据库已登记到另一个平台，不能覆盖其身份。",
        );
      return identity.rows[0].database_id;
    });
    const address = logDatabaseAddress(input.databaseUrl);
    const encrypted = this.cipher.encrypt(input.databaseUrl, `log-database:${databaseId}`);
    // Identity is the natural idempotency key across registration crashes and concurrent retries.
    // Business metadata failure leaves the identity intact for a subsequent retry to adopt.
    await this.database.pool.query(
      "INSERT INTO log_databases(id,name,address,connection_encrypted,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
      [databaseId, input.name, address, encrypted, now],
    );
    const saved = await this.database.pool.query<DatabaseRow>(
      "SELECT * FROM log_databases WHERE id=$1",
      [databaseId],
    );
    return this.view(saved.rows[0]!, (await this.settings()).activeDatabaseId, 0, 0);
  }

  async select(databaseId: string | null, revision: number): Promise<void> {
    const result = await this.database.pool.query(
      "UPDATE log_database_settings SET active_database_id=$1,revision=revision+1 WHERE id=1 AND revision=$2",
      [databaseId, revision],
    );
    if (!result.rowCount)
      throw new DomainError(
        "LOG_DATABASE_CONFLICT",
        "写入库配置已被其他操作人修改，请刷新后重试。",
      );
  }

  async updateConnection(id: string, input: RegisterLogDatabaseInput): Promise<LogDatabase> {
    await this.withTemporaryDatabase(input.databaseUrl, id, async (pool) => {
      const identity = await pool.query(
        "SELECT database_id,platform_id FROM log_storage_identity WHERE id=1",
      );
      if (identity.rows[0]?.database_id !== id || identity.rows[0]?.platform_id !== this.platformId)
        throw new DomainError(
          "LOG_DATABASE_IDENTITY_CONFLICT",
          "新地址必须指向同一个日志数据库，不能替换为空库或其他日志库。",
        );
    });
    const updated = await this.database.pool.query<DatabaseRow>(
      "UPDATE log_databases SET name=$2,address=$3,connection_encrypted=$4 WHERE id=$1 RETURNING *",
      [
        id,
        input.name,
        logDatabaseAddress(input.databaseUrl),
        this.cipher.encrypt(input.databaseUrl, `log-database:${id}`),
      ],
    );
    if (!updated.rowCount) throw new DomainError("LOG_DATABASE_NOT_FOUND", "日志数据库未登记。");
    return this.view(updated.rows[0]!, (await this.settings()).activeDatabaseId, 0, 0);
  }

  async check(id: string): Promise<void> {
    const found = await this.database.pool.query<DatabaseRow>(
      "SELECT * FROM log_databases WHERE id=$1",
      [id],
    );
    if (found.rows[0]?.storage_mode === "daily") return this.daily.check(id);
    await this.withDatabase(id, async (pool) => {
      const result = await pool.query(
        "SELECT database_id,platform_id FROM log_storage_identity WHERE id=1",
      );
      if (result.rows[0]?.database_id !== id || result.rows[0]?.platform_id !== this.platformId)
        throw new DomainError(
          "LOG_DATABASE_IDENTITY_CONFLICT",
          "日志数据库身份不匹配，请恢复原数据库，不能把历史记录指向空库或其他库。",
        );
    });
  }

  async settings() {
    const result = await this.database.pool.query<{
      active_database_id: string | null;
      revision: number;
    }>("SELECT active_database_id,revision FROM log_database_settings WHERE id=1");
    const row = result.rows[0];
    if (!row) throw new Error("Log database settings have not been migrated.");
    return { activeDatabaseId: row.active_database_id, revision: row.revision };
  }

  async withDatabase<T>(id: string, operation: (pool: Pool) => Promise<T>): Promise<T> {
    const entry = await this.acquirePool(id);
    try {
      const identity = await entry.pool.query(
        "SELECT database_id,platform_id FROM log_storage_identity WHERE id=1",
      );
      if (identity.rows[0]?.database_id !== id || identity.rows[0]?.platform_id !== this.platformId)
        throw new DomainError(
          "LOG_DATABASE_IDENTITY_CONFLICT",
          "日志数据库身份不匹配，请恢复原日志数据库。",
        );
      return await operation(entry.pool);
    } catch (cause) {
      throw logDatabaseError(cause, id);
    } finally {
      entry.users--;
    }
  }

  async withAttemptLock<T>(
    databaseId: string,
    attemptId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = await this.acquirePool(databaseId);
    let client: import("pg").PoolClient | undefined;
    let locked = false;
    try {
      client = await entry.lockPool.connect();
      const identity = await client.query(
        "SELECT database_id,platform_id FROM log_storage_identity WHERE id=1",
      );
      if (
        identity.rows[0]?.database_id !== databaseId ||
        identity.rows[0]?.platform_id !== this.platformId
      )
        throw new DomainError("LOG_DATABASE_IDENTITY_CONFLICT", "日志数据库身份不匹配。");
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [`autoforge.log.${attemptId}`],
      );
      if (!lock.rows[0]?.locked)
        throw new DomainError("PLATFORM_LOG_BUSY", "此执行的日志正在写入，请重试上传。");
      locked = true;
      return await operation();
    } catch (cause) {
      throw logDatabaseError(cause, databaseId);
    } finally {
      try {
        if (locked && client)
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `autoforge.log.${attemptId}`,
          ]);
      } finally {
        client?.release();
        entry.users--;
      }
    }
  }

  private async acquirePool(id: string): Promise<PoolEntry> {
    const previous = this.allocation;
    let release!: () => void;
    this.allocation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const row = await this.database.pool.query<DatabaseRow>(
        "SELECT * FROM log_databases WHERE id=$1",
        [id],
      );
      if (!row.rows[0])
        throw new DomainError("LOG_DATABASE_NOT_FOUND", `日志数据库 ${id} 未登记。`);
      const connection = await this.daily.resolveConnection(row.rows[0]);
      const existing = this.pools.get(id);
      if (existing && existing.encryptedConnection === connection.cacheKey) {
        existing.users++;
        return existing;
      }
      if (existing) {
        if (existing.users)
          throw new DomainError("PLATFORM_LOG_BUSY", "日志库凭据正在切换，请稍后重试。");
        this.pools.delete(id);
        await Promise.all([existing.pool.end(), existing.lockPool.end()]);
      }
      if (this.pools.size >= MAX_OPEN_DATABASES) {
        const idle = [...this.pools].find(([, candidate]) => candidate.users === 0);
        if (!idle) throw new DomainError("PLATFORM_LOG_BUSY", "日志数据库连接繁忙，请稍后重试。");
        this.pools.delete(idle[0]);
        await Promise.all([idle[1].pool.end(), idle[1].lockPool.end()]);
      }
      const pool = this.createPool(connection.url, 2);
      const entry = {
        pool,
        lockPool: this.createPool(connection.url, 2),
        users: 1,
        encryptedConnection: connection.cacheKey,
      };
      this.pools.set(id, entry);
      return entry;
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.pools.values()].flatMap((entry) => [entry.pool.end(), entry.lockPool.end()]),
    );
    this.pools.clear();
  }

  async reclaimUnusedDays(today: string): Promise<number> {
    const rows = await this.database.pool.query<DatabaseRow>(
      `SELECT d.* FROM log_databases d WHERE storage_mode='day' AND storage_day<$1 AND provisioning_state='ready'
      AND NOT EXISTS(SELECT 1 FROM attempt_log_database_locations l WHERE l.database_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM attempt_log_database_routes r WHERE r.anchor_database_id=d.id) ORDER BY storage_day,id LIMIT 4`,
      [today],
    );
    let reclaimed = 0;
    for (const row of rows.rows) {
      const cached = this.pools.get(row.id);
      if (cached?.users) continue;
      if (cached) {
        this.pools.delete(row.id);
        await Promise.all([cached.pool.end(), cached.lockPool.end()]);
      }
      reclaimed += await this.daily.dropEmptyDay(row);
    }
    return reclaimed;
  }

  private async withTemporaryDatabase<T>(
    url: string,
    id: string,
    operation: (pool: Pool) => Promise<T>,
  ): Promise<T> {
    const pool = this.createPool(url, 1);
    try {
      return await operation(pool);
    } catch (cause) {
      throw logDatabaseError(cause, id);
    } finally {
      await pool.end();
    }
  }

  private createPool(connectionString: string, max: number) {
    const pool = new Pool({
      connectionString,
      max,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      lock_timeout: 1000,
      application_name: "autoforge-logs",
    });
    // An idle socket failure must not crash Web; the next operation returns a stable, redacted error.
    pool.on("error", () => {
      process.stderr.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", requestId: "log-database-pool", message: "Log database idle connection lost; the pool will reconnect" })}\n`,
      );
    });
    return pool;
  }
  private view(
    row: DatabaseRow,
    active: string | null,
    batchCount: number,
    storedBytes: number,
  ): LogDatabase {
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      createdAt: row.created_at,
      storageMode: row.storage_mode,
      ...(row.storage_mode === "daily" ? { server: this.daily.describe(row) } : {}),
      active: row.id === active,
      batchCount,
      storedBytes,
    };
  }
}

function logDatabaseAddress(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}
