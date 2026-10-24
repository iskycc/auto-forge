import Database from "better-sqlite3";
import type { VersionCopyRow } from "@autoforge/application";
import type { SqliteDatabaseHandle } from "./database";
import { retrySqliteLockContention } from "./database";
import type { VersionCopyQuery, VersionCopySql } from "./version-copy-sql";
import { VERSION_COPY_TEMP_KEYS_SQL } from "./version-copy-sql";
import { SqlProjectVersionCopyRepository } from "./version-copy-repository";

/** A dedicated connection prevents async copy transactions from capturing unrelated Web writes. */
class SqliteVersionCopySql implements VersionCopySql {
  readonly dialect = "sqlite" as const;
  private client: Database.Database | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly databasePath: string) {}
  private connection(): Database.Database {
    if (!this.client) {
      this.client = new Database(this.databasePath, { fileMustExist: true });
      this.client.pragma("foreign_keys=ON");
      this.client.pragma("busy_timeout=25");
    }
    return this.client;
  }
  async rows(
    sql: string,
    parameters: readonly (string | number | boolean | null)[] = [],
  ): Promise<VersionCopyRow[]> {
    return query(this.connection(), sql, parameters);
  }
  transaction<T>(operation: (query: VersionCopyQuery) => Promise<T>): Promise<T> {
    const task = this.writes.then(() =>
      retrySqliteLockContention(async () => {
        const client = this.connection();
        client.exec("BEGIN IMMEDIATE");
        try {
          const result = await operation({
            rows: async (sql, parameters = []) => query(client, sql, parameters),
          });
          client.exec("COMMIT");
          return result;
        } catch (cause) {
          try {
            client.exec("ROLLBACK");
          } catch (rollback) {
            throw new AggregateError([cause, rollback], "版本复制事务及回滚失败。");
          }
          throw cause;
        }
      }),
    );
    // Preserve rejection for the caller, while allowing the next short transaction to proceed.
    this.writes = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  async snapshot<T>(operation: (query: VersionCopyQuery) => Promise<T>): Promise<T> {
    const reader = new Database(this.databasePath, { readonly: true, fileMustExist: true });
    // The main file is opened read-only; private TEMP key indexes are still writable.
    reader.pragma("temp_store=FILE");
    reader.pragma("busy_timeout=25");
    try {
      reader.exec(VERSION_COPY_TEMP_KEYS_SQL);
      reader.exec("BEGIN");
      return await operation({
        rows: async (sql, parameters = []) => query(reader, sql, parameters),
      });
    } finally {
      if (reader.inTransaction) reader.exec("ROLLBACK");
      reader.close();
    }
  }
  async columns(connection: VersionCopyQuery, table: string): Promise<string[]> {
    return (await connection.rows(`PRAGMA table_info("${table}")`)).map((row) => String(row.name));
  }
  async close(): Promise<void> {
    await this.writes;
    this.client?.close();
    this.client = undefined;
  }
}

function query(
  client: Database.Database,
  sql: string,
  parameters: readonly (string | number | boolean | null)[],
): VersionCopyRow[] {
  const statement = client.prepare(sql);
  const values = parameters.map((value) => (typeof value === "boolean" ? Number(value) : value));
  if (statement.reader) return statement.all(...values) as VersionCopyRow[];
  statement.run(...values);
  return [];
}

export class SqliteProjectVersionCopyRepository extends SqlProjectVersionCopyRepository {
  constructor(handle: SqliteDatabaseHandle) {
    super(new SqliteVersionCopySql(handle.client.name));
  }
}
