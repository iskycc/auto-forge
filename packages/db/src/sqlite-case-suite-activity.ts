import type { CaseSuiteActivityRepository, CaseSuiteStatisticsQuery } from "@autoforge/application";
import { sql } from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import {
  caseSuiteStatisticsFromRow,
  caseSuiteStatisticsQuery,
  type CaseSuiteStatisticsRow,
} from "./case-suite-activity-query";

export class SqliteCaseSuiteActivityRepository implements CaseSuiteActivityRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async readStatistics(input: CaseSuiteStatisticsQuery) {
    if (input.suiteIds.length === 0) return [];
    const rows = this.handle.db.all<CaseSuiteStatisticsRow>(
      caseSuiteStatisticsQuery(input, sql`json_extract(batch.policy_json, '$.projectVersionId')`),
    );
    return rows.map(caseSuiteStatisticsFromRow);
  }
}
