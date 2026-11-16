import type { PoolClient } from "pg";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { isPostgresLockContentionError } from "./lock-contention";

const MAXIMUM_ATTEMPTS = 6;

/** Retry database writes protected by rollback or durable receipts, never external I/O. */
async function retryPostgresLockContention<Result>(
  operation: () => PromiseLike<Result>,
): Promise<Result> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof PostgresRollbackFailure ||
        !isPostgresLockContentionError(error) ||
        attempt >= MAXIMUM_ATTEMPTS
      )
        throw error;
      // Transaction clients are released before sleeping, so readers can still use the pool.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(500, 25 * 2 ** (attempt - 1))),
      );
    }
  }
}

/** Pool-backed/autocommit statements only. An aborted explicit transaction must be retried in full. */
export function retryPostgresWrite<Result>(operation: () => PromiseLike<Result>): Promise<Result> {
  return retryPostgresLockContention(operation);
}

type DrizzleTransaction = Parameters<Parameters<PostgresDatabaseHandle["db"]["transaction"]>[0]>[0];

export function runPostgresDrizzleTransaction<Result>(
  handle: PostgresDatabaseHandle,
  operation: (transaction: DrizzleTransaction) => Promise<Result>,
): Promise<Result> {
  return retryPostgresLockContention(() => handle.db.transaction(operation));
}

export function runPostgresTransaction<Result>(
  handle: PostgresDatabaseHandle,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  return runPostgresIdempotentSession(handle, async (client) => {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  });
}

/**
 * Supports command bundles with their own BEGIN/COMMIT boundaries. A caller
 * committing more than one phase must persist an idempotency receipt before
 * its first commit, so replay recovers that result instead of applying it twice.
 * The callback may only write database state; external I/O must stay outside.
 */
export function runPostgresIdempotentSession<Result>(
  handle: PostgresDatabaseHandle,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  return retryPostgresLockContention(async () => {
    const client = await handle.pool.connect();
    let discardClient = false;
    try {
      return await operation(client);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discardClient = true;
        throw new PostgresRollbackFailure(
          [error, rollbackError],
          "Database transaction rollback failed.",
        );
      }
      throw error;
    } finally {
      client.release(discardClient);
    }
  });
}

class PostgresRollbackFailure extends AggregateError {}
