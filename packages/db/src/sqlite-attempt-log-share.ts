import type { AttemptLogShareRecord, AttemptLogShareRepository } from "@autoforge/application";
import { and, desc, eq, gt } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { attemptLogShares } from "./schema";

export class SqliteAttemptLogShareRepository implements AttemptLogShareRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async create(record: AttemptLogShareRecord): Promise<void> {
    this.handle.db.insert(attemptLogShares).values(record).run();
  }

  async findActiveByAttemptId(
    attemptId: string,
    now: string,
  ): Promise<AttemptLogShareRecord | null> {
    const row = this.handle.db
      .select()
      .from(attemptLogShares)
      .where(and(eq(attemptLogShares.attemptId, attemptId), gt(attemptLogShares.expiresAt, now)))
      .orderBy(desc(attemptLogShares.createdAt), desc(attemptLogShares.id))
      .limit(1)
      .get();
    return row ?? null;
  }

  async findActiveByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<AttemptLogShareRecord | null> {
    const row = this.handle.db
      .select()
      .from(attemptLogShares)
      .where(and(eq(attemptLogShares.tokenHash, tokenHash), gt(attemptLogShares.expiresAt, now)))
      .get();
    return row ?? null;
  }
}
