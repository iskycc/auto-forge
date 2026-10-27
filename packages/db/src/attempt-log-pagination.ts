import { DomainError } from "@autoforge/domain";
import type { AttemptLogItem, AttemptLogStore } from "./attempt-log-store";

const READ_ROWS = 32;
const PAGE_BYTES = 1024 * 1024;
const SEARCH_ROWS = 4096;

/** Shared read/search budgets for SQLite files and independent PostgreSQL payload databases. */
export async function readAttemptLogPage(
  input: Parameters<AttemptLogStore["listChunks"]>[0],
  readRows: (afterSequence: number, limit: number) => Promise<AttemptLogItem[]>,
): Promise<{ items: AttemptLogItem[]; hasMore: boolean }> {
  const items: AttemptLogItem[] = [];
  let after = input.afterSequence;
  let bytes = 0;
  let scanned = 0;
  const limit = Math.max(1, Math.min(input.limit, 500));
  for (;;) {
    const count = Math.min(READ_ROWS, input.query ? READ_ROWS : limit + 1 - items.length);
    const rows = await readRows(after, count);
    for (const item of rows) {
      after = item.sequence;
      scanned++;
      if (input.query && !item.content.includes(input.query)) continue;
      const size = Buffer.byteLength(item.content, "utf8");
      if (items.length === limit || (items.length > 0 && bytes + size > PAGE_BYTES))
        return { items, hasMore: true };
      items.push(item);
      bytes += size;
    }
    if (rows.length < count) return { items, hasMore: false };
    if (input.query && scanned >= SEARCH_ROWS)
      throw new DomainError(
        "PLATFORM_LOG_QUERY_TOO_BROAD",
        "日志搜索范围过大，请缩小时间范围后重试。",
      );
  }
}
