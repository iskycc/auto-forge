import type {
  FailureAnalysisPublicationRepository,
  FailureAnalysisSheetScope,
} from "@autoforge/application";
import type { SqliteDatabaseHandle } from "./database";
import { retrySqliteLockContention } from "./database";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { retryPostgresWrite } from "./postgres-transaction";

type Query = (sql: string, parameters: readonly string[]) => Promise<Record<string, unknown>[]>;

class FailureAnalysisPublicationQueries implements FailureAnalysisPublicationRepository {
  constructor(
    private readonly query: Query,
    private readonly parameter: (index: number) => string,
    private readonly versionExpression: string,
  ) {}

  private scopeQuery(published: boolean) {
    return `SELECT b.id,b.project_id,${this.versionExpression} AS project_version_id,
      b.suite_name,b.sequence_number,a.archived_at${published ? ",l.publisher_id,l.published_at,u.username" : ""}
      FROM run_batches b JOIN failure_analysis_batches a ON a.batch_id=b.id
      ${published ? "JOIN public_failure_analysis_links l ON l.batch_id=b.id JOIN users u ON u.id=l.publisher_id" : ""}
      WHERE b.id=${this.parameter(1)} AND b.status IN ('succeeded','failed','cancelled') AND b.batch_kind='standard'
      ${published ? "AND l.revoked_at IS NULL AND u.status='active'" : ""}
      AND NOT EXISTS (SELECT 1 FROM project_version_copies c WHERE c.target_version_id=${this.versionExpression} AND c.status NOT IN ('completed','cancelled'))`;
  }
  async batch(batchId: string) {
    return this.readScope(batchId, false);
  }
  async read(batchId: string) {
    return this.readScope(batchId, true);
  }
  private async readScope(
    batchId: string,
    published: boolean,
  ): Promise<FailureAnalysisSheetScope | null> {
    const [row] = await this.query(this.scopeQuery(published), [batchId]);
    if (!row || !row.project_version_id) return null;
    return {
      batchId: String(row.id),
      projectId: String(row.project_id),
      projectVersionId: String(row.project_version_id),
      suiteName: String(row.suite_name),
      sequenceNumber: Number(row.sequence_number),
      ...(row.archived_at ? { archivedAt: String(row.archived_at) } : {}),
      ...(published
        ? {
            publisher: {
              id: String(row.publisher_id),
              username: String(row.username),
              publishedAt: String(row.published_at),
            },
          }
        : {}),
    };
  }
  async publish(batchId: string, publisherId: string, publishedAt: string) {
    await this.query(
      `INSERT INTO public_failure_analysis_links(batch_id,publisher_id,published_at)
      VALUES (${this.parameter(1)},${this.parameter(2)},${this.parameter(3)})
      ON CONFLICT(batch_id) DO UPDATE SET publisher_id=excluded.publisher_id,published_at=excluded.published_at,revoked_at=NULL`,
      [batchId, publisherId, publishedAt],
    );
  }
  async revoke(batchId: string, revokedAt: string) {
    await this.query(
      `UPDATE public_failure_analysis_links SET revoked_at=${this.parameter(1)} WHERE batch_id=${this.parameter(2)}`,
      [revokedAt, batchId],
    );
  }
  async failureAttempt(batchId: string, executionRunId: string) {
    const [row] = await this.query(
      `SELECT a.id FROM execution_runs r
      JOIN run_batches b ON b.id=r.batch_id JOIN run_attempts a ON a.execution_run_id=r.id
      WHERE r.batch_id=${this.parameter(1)} AND r.id=${this.parameter(2)}
        AND r.terminal_outcome='failed' AND a.execution_round=b.current_round
        AND a.attempt_number=(SELECT MAX(latest.attempt_number) FROM run_attempts latest
          WHERE latest.execution_run_id=r.id AND latest.execution_round=b.current_round)
        AND COALESCE(a.outcome,a.status)='failed'`,
      [batchId, executionRunId],
    );
    return row ? String(row.id) : null;
  }
}

export class SqliteFailureAnalysisPublicationRepository extends FailureAnalysisPublicationQueries {
  constructor(handle: SqliteDatabaseHandle) {
    super(
      async (sql, parameters) => {
        const statement = handle.client.prepare(sql);
        if (statement.reader) return statement.all(...parameters) as Record<string, unknown>[];
        return retrySqliteLockContention(() => {
          statement.run(...parameters);
          return [];
        });
      },
      () => "?",
      "json_extract(b.policy_json,'$.projectVersionId')",
    );
  }
}

export class PostgresFailureAnalysisPublicationRepository extends FailureAnalysisPublicationQueries {
  constructor(handle: PostgresDatabaseHandle) {
    super(
      async (sql, parameters) => {
        await handle.ready;
        return retryPostgresWrite(async () => (await handle.pool.query(sql, [...parameters])).rows);
      },
      (index) => `$${index}`,
      "(b.policy_json::jsonb->>'projectVersionId')",
    );
  }
}
