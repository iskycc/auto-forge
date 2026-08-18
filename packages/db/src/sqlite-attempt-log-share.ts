import type { AttemptLogShareRecord, AttemptLogShareRepository } from "@autoforge/application";
import { and, desc, eq, gt, inArray } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { QUERY_IN_CHUNK_SIZE, splitIntoChunks } from "./query-chunks";
import { attemptLogShares } from "./schema";

/** 单条批量插入语句的最大行数：7 列 × 行数不得超过 SQLite 绑定变量上限（32766）。 */
const INSERT_ROWS_PER_STATEMENT = 4_000;

export class SqliteAttemptLogShareRepository implements AttemptLogShareRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async create(record: AttemptLogShareRecord): Promise<void> {
    this.handle.db.insert(attemptLogShares).values(record).run();
  }

  async createMany(records: readonly AttemptLogShareRecord[]): Promise<void> {
    if (records.length === 0) return;
    // 分批插入只为绕开绑定变量上限，整体仍在一个事务内：要么全部可见，要么整体回滚。
    this.handle.client.transaction(() => {
      for (const chunk of splitIntoChunks(records, INSERT_ROWS_PER_STATEMENT)) {
        this.handle.db.insert(attemptLogShares).values(chunk).run();
      }
    })();
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

  async findActiveByAttemptIds(
    attemptIds: readonly string[],
    now: string,
  ): Promise<AttemptLogShareRecord[]> {
    const latestByAttempt = new Map<string, AttemptLogShareRecord>();
    for (const chunk of splitIntoChunks(attemptIds, QUERY_IN_CHUNK_SIZE)) {
      const rows = this.handle.db
        .select()
        .from(attemptLogShares)
        .where(and(inArray(attemptLogShares.attemptId, chunk), gt(attemptLogShares.expiresAt, now)))
        .all();
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
    const row = this.handle.db
      .select()
      .from(attemptLogShares)
      .where(and(eq(attemptLogShares.tokenHash, tokenHash), gt(attemptLogShares.expiresAt, now)))
      .get();
    return row ?? null;
  }
}

function shareCreatedLater(
  candidate: AttemptLogShareRecord,
  current: AttemptLogShareRecord,
): boolean {
  const byTime = candidate.createdAt.localeCompare(current.createdAt);
  return byTime !== 0 ? byTime > 0 : candidate.id.localeCompare(current.id) > 0;
}
