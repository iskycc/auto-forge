import { SqlAiAnalysisRepository, type AiSqlStatement } from "./ai-analysis-repository";
import {
  retrySqliteLockContention,
  runSqliteWriteTransaction,
  type SqliteDatabaseHandle,
} from "./database";

export class SqliteAiAnalysisRepository extends SqlAiAnalysisRepository {
  constructor(handle: SqliteDatabaseHandle) {
    const execute = (statement: AiSqlStatement) =>
      handle.client.prepare(statement.text).all(...statement.values) as Record<string, unknown>[];
    super(
      (statement) => retrySqliteLockContention(() => execute(statement)),
      (statements) =>
        retrySqliteLockContention(() =>
          runSqliteWriteTransaction(handle, () => statements.map(execute)),
        ),
      (job) => ({
        text: `INSERT INTO queue_jobs(message_id,run_id,attempt,schema_version,kind,payload_json,priority,deduplication_key,status,available_at,created_at,updated_at)
        SELECT ?,?,1,1,'ai-analysis-wakeup',?,-100,?,'available',?,?,? WHERE EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE id=?) ON CONFLICT(deduplication_key) DO NOTHING RETURNING message_id`,
        values: [
          job.id,
          job.id,
          JSON.stringify({ analysisJobId: job.id }),
          `ai:${job.id}`,
          job.createdAt,
          job.createdAt,
          job.createdAt,
          job.id,
        ],
      }),
    );
  }
}
