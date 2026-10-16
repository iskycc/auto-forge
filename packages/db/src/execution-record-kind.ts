import { sql, type SQLWrapper } from "drizzle-orm";

/** The persisted single: identity also classifies historical manual executions. */
export function executionRecordKindCondition(
  kind: "task" | "single" | undefined,
  suiteId: SQLWrapper,
  batchKind: SQLWrapper,
) {
  const single = sql`(${batchKind} = 'standard' AND substr(${suiteId}, 1, 7) = 'single:')`;
  return kind === "single" ? single : kind === "task" ? sql`NOT ${single}` : undefined;
}
