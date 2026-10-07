import type { FailureCaseSuiteNameRequest } from "@autoforge/application";
import { sql, type SQL } from "drizzle-orm";

export const FAILURE_CASE_SUITE_NAME_PAGE_SIZE = 500;
export type FailureCaseSuiteNameRow = { id: string; name: string };

export function failureCaseSuiteNamePageQuery(
  input: FailureCaseSuiteNameRequest,
  projectVersion: SQL,
  afterId?: string,
) {
  return sql`SELECT id, name FROM case_suites
    WHERE project_id = ${input.projectId} AND ${projectVersion} = ${input.projectVersionId}
      AND name LIKE ${`% Rerun-${input.date}%`}
      ${afterId ? sql`AND id > ${afterId}` : sql``}
    ORDER BY id LIMIT ${FAILURE_CASE_SUITE_NAME_PAGE_SIZE}`;
}
