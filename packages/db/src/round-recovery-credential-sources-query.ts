import type { RoundRecoveryCredentialSourceQuery } from "@autoforge/application";
import { sql, type SQL } from "drizzle-orm";

export function roundRecoveryCredentialSourcesQuery(
  input: RoundRecoveryCredentialSourceQuery,
  ruleTable: SQL,
  ruleId: SQL,
  afterRound: SQL,
  jobUrl: SQL,
) {
  const query = input.query ? `%${input.query.replace(/[\\%_]/g, "\\$&")}%` : undefined;
  return sql`SELECT s.id AS "suiteId", s.name AS "suiteName", s.project_id AS "projectId",
    c.rule_id AS "ruleId", ${afterRound} AS "afterRound", ${jobUrl} AS "jenkinsJobUrl"
    FROM case_suites s
    JOIN case_suite_round_recovery_credentials c ON c.suite_id = s.id
    JOIN ${ruleTable} ON ${ruleId} = c.rule_id
    WHERE s.id <> ${input.excludeSuiteId}
    ${
      input.projectIds
        ? sql`AND s.project_id IN (${sql.join(
            input.projectIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``
    }
    ${input.after ? sql`AND (s.id > ${input.after.suiteId} OR (s.id = ${input.after.suiteId} AND c.rule_id > ${input.after.ruleId}))` : sql``}
    ${query ? sql`AND (lower(s.name) LIKE lower(${query}) ESCAPE ${"\\"} OR lower(${jobUrl}) LIKE lower(${query}) ESCAPE ${"\\"})` : sql``}
    ORDER BY s.id, c.rule_id LIMIT ${input.limit}`;
}
