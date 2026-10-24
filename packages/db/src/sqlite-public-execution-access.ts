import type {
  PublicExecutionAccessRepository,
  PublicBatchAccessRecord,
  PublicAttemptAccessRecord,
} from "@autoforge/application";

import {
  retrySqliteLockContention,
  retrySqliteWriteTransaction,
  type SqliteDatabaseHandle,
} from "./database";
import { QUERY_IN_CHUNK_SIZE, splitIntoChunks } from "./query-chunks";
import { publicAttemptAccess, publicBatchAccess } from "./schema";

export class SqlitePublicExecutionAccessRepository implements PublicExecutionAccessRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async publishBatch(record: PublicBatchAccessRecord): Promise<void> {
    await retrySqliteLockContention(() =>
      this.handle.db.insert(publicBatchAccess).values(record).onConflictDoNothing().run(),
    );
  }

  async publishAttempts(records: readonly PublicAttemptAccessRecord[]): Promise<void> {
    if (records.length === 0) return;
    await retrySqliteWriteTransaction(this.handle, () => {
      for (const chunk of splitIntoChunks(records, QUERY_IN_CHUNK_SIZE)) {
        this.handle.db.insert(publicAttemptAccess).values(chunk).onConflictDoNothing().run();
      }
    });
  }

  async isBatchPublic(batchId: string): Promise<boolean> {
    return !!this.handle.client
      .prepare(
        `SELECT g.batch_id FROM public_batch_access g JOIN run_batches b ON b.id=g.batch_id
      WHERE g.batch_id=? AND NOT EXISTS (SELECT 1 FROM project_version_copies c WHERE c.target_version_id=json_extract(b.policy_json,'$.projectVersionId') AND c.status NOT IN ('completed','cancelled'))`,
      )
      .get(batchId);
  }

  async isAttemptPublic(attemptId: string): Promise<boolean> {
    return !!this.handle.client
      .prepare(
        `SELECT g.attempt_id FROM public_attempt_access g JOIN run_attempts a ON a.id=g.attempt_id JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id
      WHERE g.attempt_id=? AND NOT EXISTS (SELECT 1 FROM project_version_copies c WHERE c.target_version_id=json_extract(b.policy_json,'$.projectVersionId') AND c.status NOT IN ('completed','cancelled'))`,
      )
      .get(attemptId);
  }
}
