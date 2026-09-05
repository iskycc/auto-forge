import type { CaseSuiteActivityRepository, CaseSuiteStatisticsQuery } from "@autoforge/application";
import { sql } from "drizzle-orm";

import type { PostgresDatabaseHandle } from "./postgres-database";
import {
  caseSuiteStatisticsFromRow,
  caseSuiteStatisticsQuery,
  type CaseSuiteStatisticsRow,
} from "./case-suite-activity-query";

export class PostgresCaseSuiteActivityRepository implements CaseSuiteActivityRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async readStatistics(input: CaseSuiteStatisticsQuery) {
    if (input.suiteIds.length === 0) return [];
    await this.handle.ready;
    const result = await this.handle.db.execute<CaseSuiteStatisticsRow>(
      caseSuiteStatisticsQuery(input, sql`batch.policy_json::jsonb ->> 'projectVersionId'`),
    );
    return result.rows.map(caseSuiteStatisticsFromRow);
  }
}
