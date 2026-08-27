import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { postgresSchema } from "./postgres-schema";

export type PostgresDatabaseHandle = {
  pool: Pool;
  db: NodePgDatabase<typeof postgresSchema>;
  ready: Promise<void>;
  close(): Promise<void>;
};

export function createPostgresDatabase(options: {
  connectionString: string;
  migrationsFolder: string;
  poolMax?: number;
}): PostgresDatabaseHandle {
  const poolMax = options.poolMax ?? 10;
  const pool = new Pool({
    connectionString: options.connectionString,
    // 默认 10 与历史行为一致；高并发部署可通过平台配置调大，避免完成上报
    // 事务排队等待连接时拖慢同进程的只读探针。
    max: poolMax,
    connectionTimeoutMillis: 5_000,
    // 预热连接在突发到来前保持可用：空闲 2 分钟内不回收，覆盖执行批次
    // “导入-创建-领取-完成”各阶段之间的短暂间歇。
    idleTimeoutMillis: 120_000,
  });
  return {
    pool,
    db: drizzle(pool, { schema: postgresSchema }),
    ready: runPostgresMigrations(pool, options.migrationsFolder).then(() =>
      warmPoolConnections(pool, poolMax),
    ),
    close: () => pool.end(),
  };
}

/**
 * 启动时预热连接池：Postgres 按需建连在高并发突发下每次要付出 fork 后端与
 * 认证握手的成本（实测突发中 connect 等待可达数百毫秒），读探针与完成上报
 * 会一并被拖慢。预先建立“池上限与 40 中较小者”数量的空闲连接，突发到达时
 * 直接复用；预热失败不阻断启动，退回按需建连。
 */
async function warmPoolConnections(pool: Pool, poolMax: number): Promise<void> {
  const warmTarget = Math.min(poolMax, 40);
  try {
    const clients = await Promise.all(Array.from({ length: warmTarget }, () => pool.connect()));
    for (const client of clients) client.release();
  } catch (error) {
    console.warn(
      `[postgres] connection pool warm-up failed (${(error as Error).message}); falling back to on-demand connections`,
    );
  }
}

async function runPostgresMigrations(pool: Pool, migrationsFolder: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('autoforge_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS _autoforge_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const appliedResult = await client.query<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM _autoforge_migrations",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.sha256]));
    const files = readdirSync(migrationsFolder)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    for (const fileName of files) {
      const migration = readFileSync(join(migrationsFolder, fileName), "utf8");
      const sha256 = createHash("sha256").update(migration).digest("hex");
      const existing = applied.get(fileName);
      if (existing && existing !== sha256)
        throw new Error(`Applied migration ${fileName} was modified.`);
      if (existing) continue;
      await client.query(migration);
      await client.query(
        "INSERT INTO _autoforge_migrations (name, sha256, applied_at) VALUES ($1, $2, $3)",
        [fileName, sha256, new Date().toISOString()],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
