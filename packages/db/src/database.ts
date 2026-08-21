import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { runSqliteMigrations } from "./migrations";
import { schema } from "./schema";

export type AutoForgeDatabase = BetterSQLite3Database<typeof schema>;

export type SqliteDatabaseHandle = {
  client: Database.Database;
  db: AutoForgeDatabase;
  close(): void;
};

export type CreateSqliteDatabaseOptions = {
  databasePath: string;
  migrationsFolder: string;
};

export function createSqliteDatabase(options: CreateSqliteDatabaseOptions): SqliteDatabaseHandle {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const client = new Database(options.databasePath);
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("journal_mode = WAL");
  client.pragma("synchronous = NORMAL");
  runSqliteMigrations(client, options.migrationsFolder);

  return {
    client,
    db: drizzle(client, { schema }),
    close: () => client.close(),
  };
}

/**
 * 多连接 WAL 下，延迟事务在读后升级写锁可能直接返回 SQLITE_BUSY。
 * 控制面写用例从事务入口取得保留写锁，busy_timeout 才能有序等待单写者。
 */
export function runSqliteWriteTransaction<Result>(
  handle: SqliteDatabaseHandle,
  operation: () => Result,
): Result {
  return handle.client.transaction(operation).immediate();
}
