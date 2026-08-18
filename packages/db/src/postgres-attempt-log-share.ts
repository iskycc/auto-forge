import type { AttemptLogShareRecord, AttemptLogShareRepository } from "@autoforge/application";
import { and, desc, eq, gt, inArray } from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import { pgAttemptLogShares } from "./postgres-schema";
import { QUERY_IN_CHUNK_SIZE, splitIntoChunks } from "./query-chunks";

export class PostgresAttemptLogShareRepository implements AttemptLogShareRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async create(record: AttemptLogShareRecord): Promise<void> {
    await this.handle.db.insert(pgAttemptLogShares).values(record);
  }

  async createMany(records: readonly AttemptLogShareRecord[]): Promise<void> {
    if (records.length === 0) return;
    // 单个事务批量写入，与 SQLite 适配保持同一原子性语义。
    await this.handle.db.transaction(async (transaction) => {
      for (const chunk of splitIntoChunks(records, QUERY_IN_CHUNK_SIZE)) {
        await transaction.insert(pgAttemptLogShares).values(chunk);
      }
    });
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

  async findActiveByAttemptIds(
    attemptIds: readonly string[],
    now: string,
  ): Promise<AttemptLogShareRecord[]> {
    const latestByAttempt = new Map<string, AttemptLogShareRecord>();
    for (const chunk of splitIntoChunks(attemptIds, QUERY_IN_CHUNK_SIZE)) {
      const rows = await this.handle.db
        .select()
        .from(pgAttemptLogShares)
        .where(
          and(inArray(pgAttemptLogShares.attemptId, chunk), gt(pgAttemptLogShares.expiresAt, now)),
        );
      for (const row of rows) {
        const current = latestByAttempt.get(row.attemptId);
        // 与单条查询的排序一致：取最新创建的有效记录。
        if (!current || shareCreatedLater(row, current)) latestByAttempt.set(row.attemptId, row);
      }
    }
    return [...latestByAttempt.values()];
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

function shareCreatedLater(
  candidate: AttemptLogShareRecord,
  current: AttemptLogShareRecord,
): boolean {
  const byTime = candidate.createdAt.localeCompare(current.createdAt);
  return byTime !== 0 ? byTime > 0 : candidate.id.localeCompare(current.id) > 0;
}
