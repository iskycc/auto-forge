/**
 * Keep generated SQL below SQLite's host-parameter ceiling while also avoiding
 * oversized PostgreSQL statements. A batch is an implementation detail, not a
 * product limit; callers may pass the complete 100k task membership.
 */
export const RELATIONAL_ID_QUERY_BATCH_SIZE = 5_000;
export const RELATIONAL_WRITE_BATCH_SIZE = 500;
// 3,000 keeps the widest current PostgreSQL multi-row insert below the 65,535
// bind-parameter ceiling while reducing network round trips at 100k.
export const POSTGRES_WRITE_BATCH_SIZE = 3_000;

export function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}
