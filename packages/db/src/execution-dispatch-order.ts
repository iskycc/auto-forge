import { randomBytes } from "node:crypto";
import { sql, type AnyColumn } from "drizzle-orm";

/** Persist a permutation across bounded scheduling windows and process restarts. */
export function createExecutionDispatchOrderKey(): string {
  return randomBytes(16).toString("hex");
}

/** Legacy UUIDv7 executions already contain random entropy after the timestamp. */
export function executionDispatchOrderExpression(columns: {
  dispatchOrderKey: AnyColumn;
  id: AnyColumn;
}) {
  return sql<string>`coalesce(${columns.dispatchOrderKey}, substr(${columns.id}, 20))`;
}
