import { SqlAiAnalysisRepository, type AiSqlStatement } from "./ai-analysis-repository";
import { runPostgresTransaction } from "./postgres-transaction";
import type { PostgresDatabaseHandle } from "./postgres-database";

export class PostgresAiAnalysisRepository extends SqlAiAnalysisRepository {
  constructor(handle: PostgresDatabaseHandle) {
    const bind = (statement: AiSqlStatement) => {
      let index = 0;
      return {
        text: statement.text.replaceAll("?", () => `$${++index}`),
        values: statement.values,
      };
    };
    super(
      async (statement) => {
        await handle.ready;
        return (await handle.pool.query(bind(statement))).rows;
      },
      async (statements) => {
        await handle.ready;
        return runPostgresTransaction(handle, async (client) => {
          // Only AI writers share this short transaction lock; core execution is never locked.
          await client.query("SELECT pg_advisory_xact_lock(hashtext('autoforge_ai_writes_v1'))");
          const results: Record<string, unknown>[][] = [];
          for (const statement of statements)
            results.push((await client.query(bind(statement))).rows);
          return results;
        });
      },
      (job) => ({
        text: `INSERT INTO transactional_outbox(message_id,run_id,attempt,schema_version,subject,payload_json,deduplication_key,created_at,available_at)
        SELECT ?,?,1,1,'autoforge.jobs.v1.ready',CAST(? AS jsonb),?,?,? WHERE EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE id=?) ON CONFLICT(deduplication_key) DO NOTHING RETURNING message_id`,
        values: [
          job.id,
          job.id,
          JSON.stringify({
            schemaVersion: 1,
            messageId: job.id,
            runId: job.id,
            attempt: 1,
            createdAt: job.createdAt,
            priority: -100,
            deduplicationKey: `ai:${job.id}`,
            kind: "ai-analysis-wakeup",
            payload: { analysisJobId: job.id },
          }),
          `ai:${job.id}`,
          job.createdAt,
          job.createdAt,
          job.id,
        ],
      }),
    );
  }
}
