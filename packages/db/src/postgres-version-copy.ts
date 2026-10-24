import { Pool, type PoolClient } from "pg";
import type { VersionCopyRow } from "@autoforge/application";
import type { PostgresDatabaseHandle } from "./postgres-database";
import type { VersionCopyQuery, VersionCopySql } from "./version-copy-sql";
import { VERSION_COPY_TEMP_KEYS_SQL } from "./version-copy-sql";
import { SqlProjectVersionCopyRepository } from "./version-copy-repository";

class PostgresVersionCopySql implements VersionCopySql {
  readonly dialect = "postgres" as const;
  private readonly snapshotPool: Pool;
  constructor(private readonly handle: PostgresDatabaseHandle) {
    // A long read snapshot must not occupy the worker's only request connection:
    // job heartbeats and permission revocation checks still need to make progress.
    this.snapshotPool = new Pool({ ...handle.pool.options, max: 1 });
  }
  async rows(
    sql: string,
    parameters: readonly (string | number | boolean | null)[] = [],
  ): Promise<VersionCopyRow[]> {
    return (await this.handle.pool.query(bindSql(sql), [...parameters])).rows as VersionCopyRow[];
  }
  transaction<T>(operation: (query: VersionCopyQuery) => Promise<T>): Promise<T> {
    return this.withTransaction("BEGIN", operation);
  }
  snapshot<T>(operation: (query: VersionCopyQuery) => Promise<T>): Promise<T> {
    return this.withTransaction("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", operation);
  }
  private async withTransaction<T>(
    begin: string,
    operation: (query: VersionCopyQuery) => Promise<T>,
  ): Promise<T> {
    const client = await (
      begin.includes("READ ONLY") ? this.snapshotPool : this.handle.pool
    ).connect();
    try {
      if (begin.includes("READ ONLY")) await client.query(VERSION_COPY_TEMP_KEYS_SQL);
      await client.query(begin);
      await client.query("SET LOCAL lock_timeout='25ms'; SET LOCAL statement_timeout='5s'");
      const result = await operation({ rows: (sql, values = []) => rows(client, sql, values) });
      await client.query("COMMIT");
      return result;
    } catch (cause) {
      try {
        await client.query("ROLLBACK");
      } catch (rollback) {
        throw new AggregateError([cause, rollback], "版本复制事务及回滚失败。");
      }
      throw cause;
    } finally {
      client.release();
    }
  }
  async columns(connection: VersionCopyQuery, table: string): Promise<string[]> {
    return (
      await connection.rows(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position",
        [table],
      )
    ).map((row) => String(row.column_name));
  }
  async close(): Promise<void> {
    await this.snapshotPool.end();
  }
}
function bindSql(sql: string): string {
  let index = 0;
  return sql.replace(/\?/gu, () => `$${++index}`);
}
async function rows(
  client: PoolClient,
  sql: string,
  values: readonly (string | number | boolean | null)[],
): Promise<VersionCopyRow[]> {
  return (await client.query(bindSql(sql), [...values])).rows as VersionCopyRow[];
}
export class PostgresProjectVersionCopyRepository extends SqlProjectVersionCopyRepository {
  constructor(handle: PostgresDatabaseHandle) {
    super(new PostgresVersionCopySql(handle));
  }
}
