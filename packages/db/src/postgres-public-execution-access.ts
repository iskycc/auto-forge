import type {
  PublicExecutionAccessRepository,
  PublicBatchAccessRecord,
  PublicAttemptAccessRecord,
} from "@autoforge/application";

import type { PostgresDatabaseHandle } from "./postgres-database";
import { retryPostgresWrite, runPostgresDrizzleTransaction } from "./postgres-transaction";
import { pgPublicAttemptAccess, pgPublicBatchAccess } from "./postgres-schema";
import { QUERY_IN_CHUNK_SIZE, splitIntoChunks } from "./query-chunks";

export class PostgresPublicExecutionAccessRepository implements PublicExecutionAccessRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async publishBatch(record: PublicBatchAccessRecord): Promise<void> {
    await retryPostgresWrite(() =>
      this.handle.db.insert(pgPublicBatchAccess).values(record).onConflictDoNothing(),
    );
  }

  async publishAttempts(records: readonly PublicAttemptAccessRecord[]): Promise<void> {
    if (records.length === 0) return;
    await runPostgresDrizzleTransaction(this.handle, async (transaction) => {
      for (const chunk of splitIntoChunks(records, QUERY_IN_CHUNK_SIZE)) {
        await transaction.insert(pgPublicAttemptAccess).values(chunk).onConflictDoNothing();
      }
    });
  }

  async isBatchPublic(batchId: string): Promise<boolean> {
    return (
      (
        await this.handle.pool.query(
          `SELECT g.batch_id FROM public_batch_access g JOIN run_batches b ON b.id=g.batch_id
      WHERE g.batch_id=$1 AND NOT EXISTS (SELECT 1 FROM project_version_copies c WHERE c.target_version_id=(b.policy_json::jsonb->>'projectVersionId') AND c.status NOT IN ('completed','cancelled'))`,
          [batchId],
        )
      ).rowCount !== 0
    );
  }

  async isAttemptPublic(attemptId: string): Promise<boolean> {
    return (
      (
        await this.handle.pool.query(
          `SELECT g.attempt_id FROM public_attempt_access g JOIN run_attempts a ON a.id=g.attempt_id JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id
      WHERE g.attempt_id=$1 AND NOT EXISTS (SELECT 1 FROM project_version_copies c WHERE c.target_version_id=(b.policy_json::jsonb->>'projectVersionId') AND c.status NOT IN ('completed','cancelled'))`,
          [attemptId],
        )
      ).rowCount !== 0
    );
  }
}
