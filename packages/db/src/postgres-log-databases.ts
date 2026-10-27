import { Pool } from "pg";
import { DomainError, isDomainError } from "@autoforge/domain";
import type { LogDatabaseRepository, SecretCipherPort } from "@autoforge/application";
import type { LogDatabase, RegisterLogDatabaseInput } from "@autoforge/contracts";
import { runPostgresMigrations, type PostgresDatabaseHandle } from "./postgres-database";

const MAX_OPEN_DATABASES = 4;
type PoolEntry = { pool: Pool; users: number; encryptedConnection: string };
type DatabaseRow = {
  id: string;
  name: string;
  address: string;
  connection_encrypted: string;
  created_at: string;
};

/** Registry lives in the business database; payload pools never use its connection settings. */
export class PostgresLogDatabaseRepository implements LogDatabaseRepository {
  private readonly pools = new Map<string, PoolEntry>();
  private allocation: Promise<void> = Promise.resolve();
  constructor(
    readonly database: PostgresDatabaseHandle,
    private readonly cipher: SecretCipherPort,
    private readonly platformId: string,
    private readonly migrationsFolder: string,
  ) {}

  async list(cursor?: string) {
    const result = await this.database.pool.query<
      DatabaseRow & { batch_count: string; stored_bytes: string }
    >(
      `SELECT d.id,d.name,d.address,d.created_at,COALESCE(s.batch_count,0) AS batch_count,
       COALESCE(s.stored_bytes,0) AS stored_bytes FROM log_databases d
       LEFT JOIN (SELECT database_id,count(*) AS batch_count,sum(stored_bytes) AS stored_bytes
         FROM run_batch_log_storage GROUP BY database_id) s ON s.database_id=d.id
       WHERE d.id>$1 ORDER BY d.id LIMIT 51`,
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
      const existing = this.pools.get(id);
      if (existing && existing.encryptedConnection === row.rows[0].connection_encrypted) {
        existing.users++;
        return existing;
      }
      if (existing) {
        this.pools.delete(id);
        await existing.pool.end();
      }
      if (this.pools.size >= MAX_OPEN_DATABASES) {
        const idle = [...this.pools].find(([, candidate]) => candidate.users === 0);
        if (!idle) throw new DomainError("PLATFORM_LOG_BUSY", "日志数据库连接繁忙，请稍后重试。");
        this.pools.delete(idle[0]);
        await idle[1].pool.end();
      }
      const pool = this.createPool(
        this.cipher.decrypt(row.rows[0].connection_encrypted, `log-database:${id}`),
        2,
      );
      const entry = { pool, users: 1, encryptedConnection: row.rows[0].connection_encrypted };
      this.pools.set(id, entry);
      return entry;
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((entry) => entry.pool.end()));
    this.pools.clear();
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
    row: Pick<DatabaseRow, "id" | "name" | "address" | "created_at">,
    active: string | null,
    batchCount: number,
    storedBytes: number,
  ): LogDatabase {
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      createdAt: row.created_at,
      active: row.id === active,
      batchCount,
      storedBytes,
    };
  }
}

export function logDatabaseError(cause: unknown, id: string): Error {
  if (isDomainError(cause)) return cause;
  return Object.assign(
    new DomainError(
      "PLATFORM_LOG_DATABASE_UNAVAILABLE",
      `日志数据库 ${id} 暂不可用，请检查该库连接、身份及服务状态；日志不会自动改写到其他库。`,
      { cause },
    ),
    {
      runtimeContext: { operation: "log-database.io", database: "attempt-logs", logDatabaseId: id },
    },
  );
}

function logDatabaseAddress(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}
