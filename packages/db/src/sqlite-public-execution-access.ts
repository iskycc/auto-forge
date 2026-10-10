import type {
  PublicExecutionAccessRepository,
  PublicBatchAccessRecord,
  PublicAttemptAccessRecord,
} from "@autoforge/application";
import { eq } from "drizzle-orm";

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
    return !!this.handle.db
      .select({ id: publicBatchAccess.batchId })
      .from(publicBatchAccess)
      .where(eq(publicBatchAccess.batchId, batchId))
      .get();
  }

  async isAttemptPublic(attemptId: string): Promise<boolean> {
    return !!this.handle.db
      .select({ id: publicAttemptAccess.attemptId })
      .from(publicAttemptAccess)
      .where(eq(publicAttemptAccess.attemptId, attemptId))
      .get();
  }
}
