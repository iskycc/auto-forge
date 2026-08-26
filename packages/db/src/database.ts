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

export type SqliteLockRetryOptions = {
  maximumAttempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
};

const DEFAULT_SQLITE_LOCK_RETRY = {
  maximumAttempts: 6,
  initialDelayMs: 25,
  maximumDelayMs: 500,
} as const;

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

/**
 * busy_timeout cannot recover a WAL transaction that loses a read-to-write upgrade race, and a
 * writer may also legitimately hold the database beyond that timeout. Retry the whole idempotent
 * adapter operation so the next attempt starts from a fresh SQLite transaction snapshot.
 */
export async function retrySqliteLockContention<Result>(
  operation: () => Result | Promise<Result>,
  options: SqliteLockRetryOptions = {},
): Promise<Result> {
  const maximumAttempts = options.maximumAttempts ?? DEFAULT_SQLITE_LOCK_RETRY.maximumAttempts;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_SQLITE_LOCK_RETRY.initialDelayMs;
  const maximumDelayMs = options.maximumDelayMs ?? DEFAULT_SQLITE_LOCK_RETRY.maximumDelayMs;
  validateSqliteLockRetryOptions(maximumAttempts, initialDelayMs, maximumDelayMs);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteLockContentionError(error) || attempt >= maximumAttempts) throw error;
      const retryDelayMs = Math.min(maximumDelayMs, initialDelayMs * 2 ** (attempt - 1));
      await delay(retryDelayMs);
    }
  }
}

export function isSqliteLockContentionError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0 && visited.size < 16) {
    const candidate = pending.shift();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
    visited.add(candidate);
    const code = "code" in candidate ? candidate.code : undefined;
    if (typeof code === "string" && /^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/u.test(code)) {
      return true;
    }
    if ("cause" in candidate) pending.push(candidate.cause);
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
  }
  return false;
}

function validateSqliteLockRetryOptions(
  maximumAttempts: number,
  initialDelayMs: number,
  maximumDelayMs: number,
): void {
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1) {
    throw new Error("SQLite lock retry attempts must be a positive integer.");
  }
  if (
    !Number.isInteger(initialDelayMs) ||
    initialDelayMs < 1 ||
    !Number.isInteger(maximumDelayMs) ||
    maximumDelayMs < initialDelayMs
  ) {
    throw new Error("SQLite lock retry timing options are invalid.");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
