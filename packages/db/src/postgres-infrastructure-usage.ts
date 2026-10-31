import type { Pool } from "pg";
import type { InfrastructureUsageSample } from "@autoforge/application";
import { readPostgresStorageCapacity } from "./postgres-storage-capacity";

export async function readPostgresInfrastructureUsage(
  pool: Pool,
  now: Date,
): Promise<InfrastructureUsageSample> {
  const result = await pool.query<{
    database_name: string;
    version: string;
    database_bytes: string;
    max_connections: number;
    connections: number;
    active_connections: number;
    idle_connections: number;
    commits: string;
    rollbacks: string;
    blocks_read: string;
    blocks_hit: string;
    returned_rows: string;
    deadlocks: string;
  }>(`SELECT current_database() AS database_name,current_setting('server_version') AS version,
    pg_database_size(current_database())::text AS database_bytes,
    current_setting('max_connections')::int AS max_connections,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid()) AS active_connections,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND state='idle') AS idle_connections,
    xact_commit::text AS commits,xact_rollback::text AS rollbacks,blks_read::text AS blocks_read,
    blks_hit::text AS blocks_hit,tup_returned::text AS returned_rows,deadlocks::text AS deadlocks
    FROM pg_stat_database WHERE datname=current_database()`);
  const row = result.rows[0];
  if (!row) throw new Error("Database statistics are unavailable.");
  const hit = Number(row.blocks_hit),
    read = Number(row.blocks_read);
  return {
    metrics: [
      { key: "database", label: "当前主库", value: row.database_name, unit: "text" },
      { key: "version", label: "PostgreSQL 版本", value: row.version, unit: "text" },
      {
        key: "database_bytes",
        label: "主库实际占用",
        value: Number(row.database_bytes),
        unit: "bytes",
      },
      {
        key: "max_connections",
        label: "实例最大连接数",
        value: row.max_connections,
        unit: "count",
      },
      { key: "connections", label: "本库连接数", value: row.connections, unit: "count" },
      { key: "active", label: "本库活动连接", value: row.active_connections, unit: "count" },
      { key: "idle", label: "本库空闲连接", value: row.idle_connections, unit: "count" },
      { key: "pool_total", label: "当前 Web 主池连接", value: pool.totalCount, unit: "count" },
      { key: "pool_idle", label: "当前 Web 主池空闲", value: pool.idleCount, unit: "count" },
      { key: "pool_waiting", label: "当前 Web 主池等待", value: pool.waitingCount, unit: "count" },
      { key: "commits", label: "累计提交事务", value: Number(row.commits), unit: "count" },
      { key: "rollbacks", label: "累计回滚事务", value: Number(row.rollbacks), unit: "count" },
      {
        key: "cache_hit",
        label: "数据库缓冲命中率",
        value: hit + read > 0 ? (hit / (hit + read)) * 100 : null,
        unit: "percent",
      },
      { key: "returned", label: "累计读取行数", value: Number(row.returned_rows), unit: "count" },
      { key: "deadlocks", label: "累计数据库死锁", value: Number(row.deadlocks), unit: "count" },
    ],
    storage: await readPostgresStorageCapacity(pool, now),
    notes: [
      "数据库统计来自 PostgreSQL 原生统计视图，累计计数自最近统计重置开始。连接池数字仅属于当前 Web 主池，不等于所有 worker 的连接总数。",
      "主库保存业务事实、执行状态、快照和 outbox；日志正文使用独立日志服务器。仅查询统计信息，不读取业务正文或执行语句。",
    ],
  };
}
