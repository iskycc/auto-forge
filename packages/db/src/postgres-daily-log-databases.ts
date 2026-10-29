import { Pool } from "pg";
import { DomainError } from "@autoforge/domain";
import { dailyLogDatabaseName, type RegisterDailyLogServerInput } from "@autoforge/contracts";
import type { SecretCipherPort } from "@autoforge/application";
import { runPostgresMigrations, type PostgresDatabaseHandle } from "./postgres-database";
import { logDatabaseError } from "./postgres-log-database-errors";

export type LogDatabaseRecord = {
  id: string;
  name: string;
  address: string;
  connection_encrypted: string;
  created_at: string;
  storage_mode: "legacy" | "daily" | "day";
  parent_database_id: string | null;
  storage_day: string | null;
  database_prefix: string | null;
  physical_name: string | null;
  provisioning_state: "provisioning" | "ready" | "dropped";
};

export class PostgresDailyLogDatabases {
  private readonly provisioning = new Map<string, Promise<string>>();
  constructor(
    private readonly dependencies: {
      database: PostgresDatabaseHandle;
      cipher: SecretCipherPort;
      platformId: string;
      migrationsFolder: string;
      createPool(url: string, maximum: number): Pool;
    },
  ) {}

  async register(
    id: string,
    input: RegisterDailyLogServerInput,
    now: string,
  ): Promise<LogDatabaseRecord> {
    const url = dailyServerConnectionUrl(input);
    await this.withConnection(url, id, (pool) => this.requireCreateDatabase(pool));
    const address = `${new URL(url).hostname}:${input.port}/${input.databasePrefix}_YYYYMMDD`;
    await this.dependencies.database.pool.query(
      `INSERT INTO log_databases(id,name,address,connection_encrypted,created_at,storage_mode,database_prefix)
       VALUES($1,$2,$3,$4,$5,'daily',$6) ON CONFLICT(address) WHERE storage_mode='daily' DO NOTHING`,
      [
        id,
        input.name,
        address,
        this.dependencies.cipher.encrypt(url, `log-database:${id}`),
        now,
        input.databasePrefix,
      ],
    );
    const selected = await this.dependencies.database.pool.query<LogDatabaseRecord>(
      "SELECT * FROM log_databases WHERE address=$1 AND storage_mode='daily'",
      [address],
    );
    return selected.rows[0]!;
  }

  async requiredServer(id: string): Promise<LogDatabaseRecord> {
    const result = await this.dependencies.database.pool.query<LogDatabaseRecord>(
      "SELECT * FROM log_databases WHERE id=$1",
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("LOG_DATABASE_NOT_FOUND", "日志服务器未登记。");
    if (row.storage_mode !== "daily")
      throw new DomainError(
        "LOG_DAILY_SERVER_REQUIRED",
        "新日志必须按日分库，请添加有建库权限的日志服务器管理员连接。",
      );
    return row;
  }

  async check(id: string): Promise<void> {
    const row = await this.requiredServer(id);
    await this.withConnection(this.decrypt(row), id, (pool) => this.requireCreateDatabase(pool));
  }

  async updateConnection(
    id: string,
    input: RegisterDailyLogServerInput,
  ): Promise<LogDatabaseRecord> {
    const existing = await this.requiredServer(id);
    if (input.databasePrefix !== existing.database_prefix)
      throw new DomainError(
        "LOG_DATABASE_PREFIX_IMMUTABLE",
        "已登记的库名前缀不能修改，请新增另一组日志服务器配置。",
      );
    const url = dailyServerConnectionUrl(input);
    await this.withConnection(url, id, (pool) => this.requireCreateDatabase(pool));
    let cursor = "";
    const deadline = Date.now() + 30000;
    for (;;) {
      const children = await this.dependencies.database.pool.query<LogDatabaseRecord>(
        "SELECT * FROM log_databases WHERE parent_database_id=$1 AND provisioning_state='ready' AND id>$2 ORDER BY id LIMIT 25",
        [id, cursor],
      );
      for (const child of children.rows) {
        if (Date.now() > deadline)
          throw new DomainError(
            "LOG_DATABASE_CHECK_TIMEOUT",
            "日期库较多，连接校验未在期限内完成；原配置未修改，请稍后重试。",
          );
        const payload = new URL(url);
        payload.pathname = `/${child.physical_name!}`;
        await this.withConnection(payload.toString(), child.id, (pool) =>
          this.verifyIdentity(pool, child.id),
        );
        cursor = child.id;
      }
      if (children.rows.length < 25) break;
    }
    const address = `${new URL(url).hostname}:${input.port}/${input.databasePrefix}_YYYYMMDD`;
    const updated = await this.dependencies.database.pool.query<LogDatabaseRecord>(
      "UPDATE log_databases SET name=$2,address=$3,connection_encrypted=$4 WHERE id=$1 AND connection_encrypted=$5 RETURNING *",
      [
        id,
        input.name,
        address,
        this.dependencies.cipher.encrypt(url, `log-database:${id}`),
        existing.connection_encrypted,
      ],
    );
    if (!updated.rows[0])
      throw new DomainError("LOG_DATABASE_CONFLICT", "日志连接已被其他操作人修改，请刷新后重试。");
    return updated.rows[0];
  }

  ensureDay(id: string, day: string): Promise<string> {
    const key = `${id}:${day}`;
    const existing = this.provisioning.get(key);
    if (existing) return existing;
    const pending = this.provisionDay(id, day);
    this.provisioning.set(key, pending);
    void pending.then(
      () => this.provisioning.delete(key),
      () => this.provisioning.delete(key),
    );
    return pending;
  }
  private async provisionDay(id: string, day: string): Promise<string> {
    const server = await this.requiredServer(id);
    const childId = `${id}.${day.replaceAll("-", "")}`;
    const existing = await this.dependencies.database.pool.query<LogDatabaseRecord>(
      "SELECT * FROM log_databases WHERE id=$1",
      [childId],
    );
    if (existing.rows[0]?.provisioning_state === "ready") return childId;
    const databaseName = dailyLogDatabaseName(
      server.database_prefix!,
      id.replaceAll("-", "").slice(-8),
      day,
    );
    const adminUrl = this.decrypt(server);
    await this.withConnection(adminUrl, id, async (pool) => {
      const client = await pool.connect();
      let locked = false;
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
          `autoforge.daily.${databaseName}`,
        ]);
        locked = true;
        const current = await this.dependencies.database.pool.query<LogDatabaseRecord>(
          "SELECT * FROM log_databases WHERE id=$1",
          [childId],
        );
        if (current.rows[0]?.provisioning_state === "ready") return;
        const present = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [
          databaseName,
        ]);
        // Persist intent before non-transactional CREATE DATABASE. Names include the
        // immutable server namespace; an interrupted empty database is adoptable only
        // when this platform already recorded its exact provisioning intent.
        if (present.rowCount && !current.rows[0])
          throw new DomainError(
            "LOG_DATABASE_IDENTITY_CONFLICT",
            `日期库 ${databaseName} 已存在但不属于此配置，拒绝覆盖。`,
          );
        await this.dependencies.database.pool.query(
          `INSERT INTO log_databases(id,name,address,connection_encrypted,created_at,storage_mode,parent_database_id,storage_day,physical_name,provisioning_state)
           VALUES($1,$2,$3,'',$4,'day',$5,$6,$2,'provisioning') ON CONFLICT(id) DO UPDATE SET provisioning_state='provisioning'`,
          [
            childId,
            databaseName,
            `${new URL(adminUrl).hostname}:${new URL(adminUrl).port || "5432"}/${databaseName}`,
            `${day}T00:00:00+08:00`,
            id,
            day,
          ],
        );
        if (!present.rowCount)
          await client.query(
            `CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8'`,
          );
        const url = new URL(adminUrl);
        url.pathname = `/${databaseName}`;
        await this.withConnection(url.toString(), childId, async (payload) => {
          const identityExists = await payload.query(
            "SELECT to_regclass('public.log_storage_identity') AS identity",
          );
          if (identityExists.rows[0].identity) {
            await this.verifyIdentity(payload, childId);
          } else {
            const tables = await payload.query(
              "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' LIMIT 1",
            );
            if (tables.rowCount)
              throw new DomainError(
                "LOG_DATABASE_IDENTITY_CONFLICT",
                `日期库 ${databaseName} 包含未识别的数据，拒绝写入。`,
              );
          }
          await runPostgresMigrations(payload, this.dependencies.migrationsFolder, {
            statementTimeoutMs: 10000,
            lockTimeoutMs: 1000,
          });
          await payload.query(
            "INSERT INTO log_storage_identity(id,database_id,platform_id) VALUES(1,$1,$2) ON CONFLICT(id) DO NOTHING",
            [childId, this.dependencies.platformId],
          );
          await this.verifyIdentity(payload, childId);
        });
        await this.dependencies.database.pool.query(
          "UPDATE log_databases SET provisioning_state='ready' WHERE id=$1",
          [childId],
        );
      } finally {
        try {
          if (locked)
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
              `autoforge.daily.${databaseName}`,
            ]);
        } finally {
          client.release();
        }
      }
    });
    return childId;
  }

  async resolveConnection(row: LogDatabaseRecord): Promise<{ url: string; cacheKey: string }> {
    if (row.storage_mode === "daily")
      throw new DomainError(
        "LOG_DAILY_DATABASE_REQUIRED",
        "日志服务器配置不是正文数据库，请使用对应日期库。",
      );
    if (row.storage_mode === "legacy")
      return { url: this.decrypt(row), cacheKey: row.connection_encrypted };
    if (row.provisioning_state !== "ready")
      throw new DomainError(
        "PLATFORM_LOG_DATABASE_UNAVAILABLE",
        `日志日期库 ${row.physical_name} 尚未就绪或已回收。`,
      );
    const parent = await this.requiredServer(row.parent_database_id!);
    const url = new URL(this.decrypt(parent));
    url.pathname = `/${row.physical_name!}`;
    return { url: url.toString(), cacheKey: `${parent.connection_encrypted}:${row.physical_name}` };
  }

  async dropEmptyDay(row: LogDatabaseRecord): Promise<number> {
    if (row.storage_mode !== "day") return 0;
    if (!row.physical_name || !/^[a-z][a-z0-9_]{0,62}$/.test(row.physical_name))
      throw new DomainError("LOG_DATABASE_INVALID", "日期库名称不符合自动回收规则，拒绝删除。");
    const parent = await this.requiredServer(row.parent_database_id!);
    return this.withConnection(this.decrypt(parent), parent.id, async (pool) => {
      const client = await pool.connect();
      let locked = false;
      try {
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [`autoforge.daily.${row.physical_name}`],
        );
        if (!lock.rows[0]?.locked) return 0;
        locked = true;
        const references = await this.dependencies.database.pool.query(
          `SELECT 1 FROM attempt_log_database_locations WHERE database_id=$1
          UNION ALL SELECT 1 FROM attempt_log_database_routes WHERE anchor_database_id=$1
          UNION ALL SELECT 1 FROM run_batch_log_storage s JOIN run_batches b ON b.id=s.batch_id WHERE s.database_id=$2 AND b.status NOT IN ('succeeded','failed','cancelled') AND b.created_at<$3 LIMIT 1`,
          [
            row.id,
            parent.id,
            new Date(Date.parse(`${row.storage_day}T00:00:00+08:00`) + 2 * 86400000).toISOString(),
          ],
        );
        if (references.rowCount) return 0;
        const found = await client.query<{ bytes: string }>(
          "SELECT pg_database_size(oid) AS bytes FROM pg_database WHERE datname=$1",
          [row.physical_name],
        );
        if (found.rowCount) {
          const target = new URL(this.decrypt(parent));
          target.pathname = `/${row.physical_name!}`;
          const empty = await this.withConnection(target.toString(), row.id, async (payload) => {
            await this.verifyIdentity(payload, row.id);
            return !(await payload.query("SELECT 1 FROM log_batches LIMIT 1")).rowCount;
          });
          if (!empty) return 0;
          // Do not force-disconnect readers or other platform nodes. Idle pools expire;
          // a busy database is retried by maintenance after their connections close.
          if (
            (
              await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1", [
                row.physical_name,
              ])
            ).rowCount
          )
            return 0;
          try {
            await client.query(`DROP DATABASE "${row.physical_name!}"`);
          } catch (cause) {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              (cause.code === "55006" || cause.code === "57014")
            )
              return 0;
            throw cause;
          }
        }
        await this.dependencies.database.pool.query(
          "UPDATE log_databases SET provisioning_state='dropped' WHERE id=$1",
          [row.id],
        );
        return Number(found.rows[0]?.bytes ?? 0);
      } finally {
        try {
          if (locked)
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
              `autoforge.daily.${row.physical_name}`,
            ]);
        } finally {
          client.release();
        }
      }
    });
  }

  describe(row: LogDatabaseRecord) {
    const url = new URL(this.decrypt(row));
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      username: decodeURIComponent(url.username),
      maintenanceDatabase: decodeURIComponent(url.pathname.slice(1)),
      databasePrefix: row.database_prefix!,
      sslMode: (url.searchParams.get("sslmode") ??
        "disable") as RegisterDailyLogServerInput["sslMode"],
    };
  }

  private decrypt(row: LogDatabaseRecord): string {
    return this.dependencies.cipher.decrypt(row.connection_encrypted, `log-database:${row.id}`);
  }

  private async requireCreateDatabase(pool: Pool): Promise<void> {
    const result = await pool.query<{ can_create: boolean }>(
      "SELECT (rolsuper OR rolcreatedb) AS can_create FROM pg_roles WHERE rolname=current_user",
    );
    if (!result.rows[0]?.can_create)
      throw new DomainError(
        "LOG_DATABASE_CREATE_PERMISSION_REQUIRED",
        "日志管理员需要 CREATEDB 或超级用户权限，才能自动创建每日数据库。",
      );
    const business = await pool.query("SELECT to_regclass('public.run_batches') AS business");
    if (business.rows[0].business)
      throw new DomainError(
        "LOG_DATABASE_INVALID",
        "维护连接不能指向平台业务数据库，请使用独立日志服务的 postgres 数据库。",
      );
  }

  private async verifyIdentity(pool: Pool, id: string): Promise<void> {
    const identity = await pool.query<{ database_id: string; platform_id: string }>(
      "SELECT database_id,platform_id FROM log_storage_identity WHERE id=1",
    );
    if (
      identity.rows[0]?.database_id !== id ||
      identity.rows[0]?.platform_id !== this.dependencies.platformId
    )
      throw new DomainError(
        "LOG_DATABASE_IDENTITY_CONFLICT",
        "日期日志库身份不匹配，拒绝覆盖或读取其他平台的数据。",
      );
  }

  private async withConnection<T>(
    url: string,
    id: string,
    operation: (pool: Pool) => Promise<T>,
  ): Promise<T> {
    const pool = this.dependencies.createPool(url, 1);
    try {
      return await operation(pool);
    } catch (cause) {
      throw logDatabaseError(cause, id);
    } finally {
      await pool.end();
    }
  }
}

export function dailyServerConnectionUrl(input: RegisterDailyLogServerInput): string {
  const url = new URL("postgresql://localhost");
  url.hostname =
    input.host.includes(":") && !input.host.startsWith("[") ? `[${input.host}]` : input.host;
  url.port = String(input.port);
  url.username = input.username;
  url.password = input.password;
  url.pathname = `/${input.maintenanceDatabase}`;
  url.searchParams.set("sslmode", input.sslMode);
  return url.toString();
}
