import { sql, type AnyColumn } from "drizzle-orm";

/** Apply personal pin priority before the list limit, including older tasks outside that window. */
export function caseSuitePinPriority(userId: string, suiteId: AnyColumn) {
  return sql`EXISTS (
    SELECT 1 FROM case_suite_pins
    WHERE case_suite_pins.user_id = ${userId} AND case_suite_pins.suite_id = ${suiteId}
  )`;
}
