import type {
  PublicExecutionAccessRepository,
  PublicBatchAccessRecord,
  PublicAttemptAccessRecord,
} from "@autoforge/application";
import { eq } from "drizzle-orm";

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
    const rows = await this.handle.db
      .select({ id: pgPublicBatchAccess.batchId })
      .from(pgPublicBatchAccess)
      .where(eq(pgPublicBatchAccess.batchId, batchId))
      .limit(1);
    return rows.length > 0;
  }

  async isAttemptPublic(attemptId: string): Promise<boolean> {
    const rows = await this.handle.db
      .select({ id: pgPublicAttemptAccess.attemptId })
      .from(pgPublicAttemptAccess)
      .where(eq(pgPublicAttemptAccess.attemptId, attemptId))
      .limit(1);
    return rows.length > 0;
  }
}
