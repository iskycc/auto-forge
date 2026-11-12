import { sql } from "drizzle-orm";
import type { RunnerRepository } from "@autoforge/application";

/** Identity and name come from a known tombstone, never the unauthenticated heartbeat. */
export function recordRejectedContactQuery(
  input: Parameters<RunnerRepository["recordRejectedContact"]>[0],
  dialect: "sqlite" | "postgres" = "sqlite",
) {
  const eligible = sql`SELECT id FROM runners
    WHERE id=${input.runnerId} AND purged_at IS NOT NULL AND deregistered_at IS NOT NULL
      AND purged_at <= ${input.recordedAt}
    ${dialect === "postgres" ? sql`FOR UPDATE` : sql``}`;
  return sql`WITH eligible AS (${eligible})
    INSERT INTO runner_rejected_contacts (runner_id, first_rejected_at, last_rejected_at)
    SELECT id, ${input.recordedAt}, ${input.recordedAt} FROM eligible WHERE TRUE
    ON CONFLICT (runner_id) DO UPDATE SET last_rejected_at=excluded.last_rejected_at
    WHERE runner_rejected_contacts.last_rejected_at <= ${input.previousWindowBefore}`;
}

export function listRejectedContactsQuery(
  query: Parameters<RunnerRepository["listRejectedContacts"]>[0],
) {
  return sql`SELECT runner.id AS "runnerId", runner.name, runner.agent_version AS "agentVersion",
    runner.purged_at AS "purgedAt", contact.first_rejected_at AS "firstRejectedAt", contact.last_rejected_at AS "lastRejectedAt"
    FROM runner_rejected_contacts contact JOIN runners runner ON runner.id=contact.runner_id
    WHERE runner.purged_at IS NOT NULL AND runner.deregistered_at IS NOT NULL
    ${query.afterId ? sql`AND contact.runner_id > ${query.afterId}` : sql``}
    ORDER BY contact.runner_id LIMIT ${query.limit + 1}`;
}
