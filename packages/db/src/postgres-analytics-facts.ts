import type { AnalyticsFactRefreshResult } from "@autoforge/application";
import type { PoolClient } from "pg";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { runPostgresTransaction } from "./postgres-transaction";
import {
  ANALYTICS_FACT_SCHEMA_VERSION,
  failureSignature,
  resultCounts,
} from "./platform-operations-shared";

const ANALYTICS_FACT_LOCK_EXPRESSION =
  "hashtextextended('autoforge:analytics-facts:v4:' || 'analytics_facts'::regclass::oid::text,0)";
const BACKFILL_SCAN_LIMIT = 2_000;

type BackfillProgress = {
  after_attempt_id: string | null;
  through_attempt_id: string | null;
  finished: boolean;
};

type PendingFact = { attempt_id: string; revision: string };

type Completion = {
  attempt_id: string;
  project_id: string;
  batch_id: string;
  run_id: string;
  suite_id: string;
  case_definition_id: string;
  case_version: number;
  runner_id: string;
  environment_version_id: string | null;
  outcome: string;
  result_code: string | null;
  result_summary: string | null;
  duration_ms: number | null;
  testng_result_json: string | null;
  finished_at: string;
};

const COMPLETION_COLUMNS = `a.id AS attempt_id,b.project_id,b.id AS batch_id,r.id AS run_id,b.suite_id,
  r.case_definition_id,r.case_version,a.runner_id,b.environment_version_id,
  a.outcome,a.result_code,a.result_summary,a.duration_ms,a.testng_result_json,a.finished_at`;

/** Accurate readers retain the existing bounded wait and never treat a busy owner as an empty scan. */
export async function rebuildPostgresAnalyticsFacts(
  handle: PostgresDatabaseHandle,
  limit: number,
): Promise<number> {
  await handle.ready;
  return runPostgresTransaction(handle, async (client) => {
    await duringFactPublication("wait-owner", () =>
      client.query(`SELECT pg_advisory_xact_lock(${ANALYTICS_FACT_LOCK_EXPRESSION})`),
    );
    const progress = await readBackfillProgress(client);
    if (!progress?.finished) {
      // During an upgrade an explicit summary or export may need older facts that
      // the background cursor has yet to visit. Keep its existing completeness.
      return publishFacts(client, await readLegacyCompletions(client, limit));
    }
    const pending = await readPendingFacts(client, limit);
    return publishPendingFacts(client, pending);
  });
}

/** Background peers yield without queuing a waiting transaction behind another generator. */
export async function tryRebuildPostgresAnalyticsFacts(
  handle: PostgresDatabaseHandle,
  limit: number,
): Promise<AnalyticsFactRefreshResult> {
  await handle.ready;
  return runPostgresTransaction(handle, async (client) => {
    const ownership = await duringFactPublication("try-owner", () =>
      client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(${ANALYTICS_FACT_LOCK_EXPRESSION}) AS acquired`,
      ),
    );
    const row = ownership.rows[0];
    if (!row) throw new Error("Analytics fact ownership probe returned no row.");
    if (!row.acquired) return { status: "deferred" };
    if (limit === 0) return { status: "updated", count: 0 };
    return refreshFactPages(client, limit);
  });
}

async function refreshFactPages(
  client: PoolClient,
  limit: number,
): Promise<AnalyticsFactRefreshResult> {
  const progress = (await readBackfillProgress(client)) ?? (await initializeBackfill(client));
  const queued = await readPendingFacts(client, limit);
  const queueFull = queued.length === limit;
  // A continuously busy queue must still let the upgrade cursor make progress.
  const pending = queueFull && !progress.finished && limit > 1 ? queued.slice(0, -1) : queued;
  const count = await publishPendingFacts(client, pending);
  if (progress.finished || pending.length === limit) {
    return { status: "updated", count, ...(queueFull ? { moreWork: true } : {}) };
  }

  const historical = await backfillFactPage(client, progress, limit - pending.length);
  return {
    status: "updated",
    count: count + historical.count,
    ...(!historical.finished || queueFull ? { moreWork: true } : {}),
  };
}

async function readBackfillProgress(client: PoolClient): Promise<BackfillProgress | undefined> {
  const result = await duringFactPublication("read-completions", () =>
    client.query<BackfillProgress>(
      `SELECT after_attempt_id, through_attempt_id, finished FROM analytics_fact_backfill
       WHERE schema_version=$1`,
      [ANALYTICS_FACT_SCHEMA_VERSION],
    ),
  );
  return result.rows[0];
}

async function initializeBackfill(client: PoolClient): Promise<BackfillProgress> {
  const result = await duringFactPublication("read-completions", () =>
    client.query<BackfillProgress>(
      `INSERT INTO analytics_fact_backfill (schema_version,through_attempt_id,finished)
       SELECT $1, last_id, last_id IS NULL
       FROM (SELECT (SELECT id FROM run_attempts ORDER BY id DESC LIMIT 1) AS last_id) boundary
       RETURNING after_attempt_id, through_attempt_id, finished`,
      [ANALYTICS_FACT_SCHEMA_VERSION],
    ),
  );
  return result.rows[0]!;
}

async function readPendingFacts(client: PoolClient, limit: number): Promise<PendingFact[]> {
  const result = await duringFactPublication("read-completions", () =>
    client.query<PendingFact>(
      `SELECT attempt_id,revision FROM analytics_fact_pending ORDER BY completed_at,attempt_id LIMIT $1`,
      [limit],
    ),
  );
  return result.rows;
}

async function publishPendingFacts(
  client: PoolClient,
  pending: readonly PendingFact[],
): Promise<number> {
  if (pending.length === 0) return 0;
  const ids = pending.map((entry) => entry.attempt_id);
  const count = await publishFacts(client, await readSelectedCompletions(client, ids));
  // Fact deletion can enqueue an attempt again while we read it. Acknowledge
  // only the revision we saw so that this later request isn't lost.
  await duringFactPublication("write-facts", () =>
    client.query(
      `DELETE FROM analytics_fact_pending pending
       USING unnest($1::text[], $2::bigint[]) AS read_page(attempt_id, revision)
       WHERE pending.attempt_id=read_page.attempt_id AND pending.revision=read_page.revision`,
      [ids, pending.map((entry) => entry.revision)],
    ),
  );
  return count;
}

async function backfillFactPage(client: PoolClient, progress: BackfillProgress, limit: number) {
  // Materialize a fixed primary-key range before checking whether facts exist.
  // Even a completely indexed history needs at most this many probes per tick.
  const result = await duringFactPublication("read-completions", () =>
    client.query<{ last_id: string | null; candidate_ids: string[]; scanned: number }>(
      `WITH history_window AS MATERIALIZED (
         SELECT id,outcome,finished_at FROM run_attempts
         WHERE ($1::text IS NULL OR id > $1) AND id <= $2
         ORDER BY id LIMIT $3
       )
       SELECT (SELECT id FROM history_window ORDER BY id DESC LIMIT 1) AS last_id,
         (SELECT count(*)::integer FROM history_window) AS scanned,
         ARRAY(SELECT w.id FROM history_window w
           WHERE w.finished_at IS NOT NULL AND w.outcome IS NOT NULL
             AND COALESCE((SELECT f.schema_version FROM analytics_facts f WHERE f.attempt_id=w.id),0)<$4
           ORDER BY w.id LIMIT $5) AS candidate_ids`,
      [
        progress.after_attempt_id,
        progress.through_attempt_id,
        BACKFILL_SCAN_LIMIT,
        ANALYTICS_FACT_SCHEMA_VERSION,
        limit,
      ],
    ),
  );
  const { last_id: lastId, scanned, candidate_ids: ids } = result.rows[0]!;
  const after = ids.length === limit ? ids[ids.length - 1] : lastId;
  const finished =
    !after ||
    after === progress.through_attempt_id ||
    (scanned < BACKFILL_SCAN_LIMIT && ids.length < limit);
  const count = await publishFacts(client, await readSelectedCompletions(client, ids));
  await duringFactPublication("write-facts", () =>
    client.query(
      `UPDATE analytics_fact_backfill SET after_attempt_id=$2,finished=$3 WHERE schema_version=$1`,
      [ANALYTICS_FACT_SCHEMA_VERSION, after ?? progress.after_attempt_id, finished],
    ),
  );
  return { count, finished };
}

async function readSelectedCompletions(
  client: PoolClient,
  ids: readonly string[],
): Promise<Completion[]> {
  if (ids.length === 0) return [];
  const result = await duringFactPublication("read-completions", () =>
    client.query<Completion>(
      `SELECT ${COMPLETION_COLUMNS}
       FROM unnest($1::text[]) AS selected(id)
       JOIN run_attempts a ON a.id=selected.id
       JOIN execution_runs r ON r.id=a.execution_run_id
       JOIN run_batches b ON b.id=r.batch_id
       WHERE a.finished_at IS NOT NULL AND a.outcome IS NOT NULL AND b.batch_kind <> 'case_log_rerun'
         AND COALESCE((SELECT f.schema_version FROM analytics_facts f WHERE f.attempt_id=a.id),0)<$2
       ORDER BY a.id FOR KEY SHARE OF a`,
      [ids, ANALYTICS_FACT_SCHEMA_VERSION],
    ),
  );
  return result.rows;
}

async function readLegacyCompletions(client: PoolClient, limit: number): Promise<Completion[]> {
  // Choose compact keys before reading reports. Protect selected completions against
  // concurrent retention; KEY SHARE remains compatible with non-key maintenance locks.
  // An anti-join preserves estimates for missing facts; a nullable join with OR can
  // underestimate them as one row and turn the remaining history into nested lookups.
  const result = await duringFactPublication("read-completions", () =>
    client.query<Completion>(
      `WITH pending_attempts AS MATERIALIZED (
       SELECT a.id FROM run_attempts a
       JOIN execution_runs r ON r.id=a.execution_run_id
       JOIN run_batches b ON b.id=r.batch_id
       WHERE NOT EXISTS (
         SELECT 1 FROM analytics_facts f
         WHERE f.attempt_id=a.id AND f.schema_version >= $1
       )
         AND b.batch_kind <> 'case_log_rerun'
         AND a.finished_at IS NOT NULL AND a.outcome IS NOT NULL
       ORDER BY a.finished_at,a.id LIMIT $2
     )
     SELECT ${COMPLETION_COLUMNS}
     FROM pending_attempts pending JOIN run_attempts a ON a.id=pending.id
     JOIN execution_runs r ON r.id=a.execution_run_id
     JOIN run_batches b ON b.id=r.batch_id
     ORDER BY a.finished_at,a.id FOR KEY SHARE OF a`,
      [ANALYTICS_FACT_SCHEMA_VERSION, limit],
    ),
  );
  return result.rows;
}

async function publishFacts(
  client: PoolClient,
  completions: readonly Completion[],
): Promise<number> {
  if (completions.length === 0) return 0;
  const facts = completions.map((row) => {
    const counts = resultCounts(row.testng_result_json);
    return {
      attempt_id: row.attempt_id,
      project_id: row.project_id,
      batch_id: row.batch_id,
      run_id: row.run_id,
      suite_id: row.suite_id,
      case_definition_id: row.case_definition_id,
      case_version: row.case_version,
      runner_id: row.runner_id,
      environment_version_id: row.environment_version_id,
      outcome: row.outcome,
      result_code: row.result_code,
      failure_signature: failureSignature(row.outcome, row.result_code, row.result_summary),
      duration_ms: row.duration_ms,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      completed_at: row.finished_at,
      schema_version: ANALYTICS_FACT_SCHEMA_VERSION,
    };
  });
  const write = await duringFactPublication("write-facts", () =>
    client.query(
      `INSERT INTO analytics_facts
     (attempt_id,project_id,batch_id,run_id,suite_id,case_definition_id,case_version,
      runner_id,environment_version_id,outcome,result_code,failure_signature,duration_ms,
      passed,failed,skipped,completed_at,schema_version)
     SELECT fact.* FROM jsonb_to_recordset($1::jsonb) AS fact(
       attempt_id text,project_id text,batch_id text,run_id text,suite_id text,
       case_definition_id text,case_version integer,runner_id text,environment_version_id text,
       outcome text,result_code text,failure_signature text,duration_ms bigint,
       passed integer,failed integer,skipped integer,completed_at text,schema_version integer
     ) ORDER BY fact.attempt_id
     ON CONFLICT (attempt_id) DO UPDATE SET
       project_id=EXCLUDED.project_id,
       batch_id=EXCLUDED.batch_id,
       run_id=EXCLUDED.run_id,
       suite_id=EXCLUDED.suite_id,
       case_definition_id=EXCLUDED.case_definition_id,
       case_version=EXCLUDED.case_version,
       runner_id=EXCLUDED.runner_id,
       environment_version_id=EXCLUDED.environment_version_id,
       outcome=EXCLUDED.outcome,
       result_code=EXCLUDED.result_code,
       failure_signature=EXCLUDED.failure_signature,
       duration_ms=EXCLUDED.duration_ms,
       passed=EXCLUDED.passed,
       failed=EXCLUDED.failed,
       skipped=EXCLUDED.skipped,
       completed_at=EXCLUDED.completed_at,
       schema_version=EXCLUDED.schema_version
     WHERE analytics_facts.schema_version < EXCLUDED.schema_version`,
      [JSON.stringify(facts)],
    ),
  );
  return write.rowCount ?? 0;
}

type PublicationPhase = "wait-owner" | "try-owner" | "read-completions" | "write-facts";

/** Preserve PostgreSQL cause/code while identifying the failed stage without exposing SQL. */
async function duringFactPublication<Result>(
  phase: PublicationPhase,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    throw Object.assign(
      new Error(
        cause instanceof Error ? cause.message : "Analytics fact database operation failed.",
        { cause },
      ),
      {
        ...(typeof code === "string" ? { code } : {}),
        runtimeContext: { operation: `analytics.facts.${phase}`, database: "postgresql" },
      },
    );
  }
}
