import type { PoolClient } from "pg";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { isPostgresLockContentionError } from "./lock-contention";

const MAXIMUM_ATTEMPTS = 6;

/** Retry only an atomic statement or a completely rolled-back transaction, never external I/O. */
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
  return retryPostgresLockContention(async () => {
    const client = await handle.pool.connect();
    let discardClient = false;
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
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
