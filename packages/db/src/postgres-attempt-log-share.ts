import type { AttemptLogShareRecord, AttemptLogShareRepository } from "@autoforge/application";
import { and, desc, eq, gt } from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import { pgAttemptLogShares } from "./postgres-schema";

export class PostgresAttemptLogShareRepository implements AttemptLogShareRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async create(record: AttemptLogShareRecord): Promise<void> {
    await this.handle.db.insert(pgAttemptLogShares).values(record);
  }

  async findActiveByAttemptId(
    attemptId: string,
    now: string,
  ): Promise<AttemptLogShareRecord | null> {
    const rows = await this.handle.db
      .select()
      .from(pgAttemptLogShares)
      .where(
        and(eq(pgAttemptLogShares.attemptId, attemptId), gt(pgAttemptLogShares.expiresAt, now)),
      )
      .orderBy(desc(pgAttemptLogShares.createdAt), desc(pgAttemptLogShares.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findActiveByTokenHash(
    tokenHash: string,
    now: string,
  ): Promise<AttemptLogShareRecord | null> {
    const rows = await this.handle.db
      .select()
      .from(pgAttemptLogShares)
      .where(
        and(eq(pgAttemptLogShares.tokenHash, tokenHash), gt(pgAttemptLogShares.expiresAt, now)),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
