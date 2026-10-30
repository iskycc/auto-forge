import { batchEnvironmentAddresses } from "./run-batch-environment-addresses";
import { storedActor } from "./run-batch-actors";
import type { PublicSuiteExecutionRepository } from "@autoforge/application";
import {
  executionActorSchema,
  publicExecutionPath,
  publicSuiteBatchSchema,
  publicSuiteExecutionContextSchema,
} from "@autoforge/contracts";
import type { SqliteDatabaseHandle } from "./database";
import { retrySqliteLockContention } from "./database";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { retryPostgresWrite } from "./postgres-transaction";

const BATCH_COLUMNS =
  "id,sequence_number,status,total_runs,current_round,requested_by_username,public_execution_json,terminated_by_json,cancel_requested_at,pause_requested_at,scheduled_for,created_at";

type Query = (
  statement: string,
  parameters: readonly string[],
) => Promise<Record<string, unknown>[]>;

class PublicSuiteExecutionQueries implements PublicSuiteExecutionRepository {
  constructor(
    private readonly query: Query,
    private readonly parameter: (index: number) => string,
    private readonly environmentProjection: string,
  ) {}

  async publish(suiteId: string, publisherId: string, createdAt: string) {
    await this.query(
      `INSERT INTO public_suite_execution_links (suite_id,publisher_id,created_at) VALUES (${this.parameters(3)}) ON CONFLICT(suite_id,publisher_id) DO UPDATE SET revoked_at=NULL,created_at=excluded.created_at`,
      [suiteId, publisherId, createdAt],
    );
  }
  async revoke(suiteId: string, publisherId: string, revokedAt: string) {
    await this.query(
      `UPDATE public_suite_execution_links SET revoked_at=${this.parameter(1)} WHERE suite_id=${this.parameter(2)} AND publisher_id=${this.parameter(3)}`,
      [revokedAt, suiteId, publisherId],
    );
  }
  async publisher(suiteId: string, publisherId: string) {
    const [row] = await this.query(
      `SELECT u.id,u.username,u.source FROM public_suite_execution_links l JOIN users u ON u.id=l.publisher_id WHERE l.suite_id=${this.parameter(1)} AND l.publisher_id=${this.parameter(2)} AND l.revoked_at IS NULL AND u.status='active'`,
      [suiteId, publisherId],
    );
    return row ? executionActorSchema.parse(row) : null;
  }
  async executions(suiteId: string) {
    const active = await this.query(
      `SELECT ${BATCH_COLUMNS}, ${this.environmentProjection} AS environment_addresses_json FROM run_batches WHERE suite_id=${this.parameter(1)} AND status IN ('queued','dispatching','scheduled','running') AND batch_kind<>'case_log_rerun' ORDER BY created_at DESC,id DESC LIMIT 10`,
      [suiteId],
    );
    const recent = await this.query(
      `SELECT ${BATCH_COLUMNS}, ${this.environmentProjection} AS environment_addresses_json FROM run_batches WHERE suite_id=${this.parameter(1)} AND public_execution_json IS NOT NULL AND status IN ('succeeded','failed','cancelled') ORDER BY created_at DESC,id DESC LIMIT 5`,
      [suiteId],
    );
    return { active: active.map(publicBatch), recent: recent.map(publicBatch) };
  }
  async batch(suiteId: string, batchId: string) {
    const [row] = await this.query(
      `SELECT ${BATCH_COLUMNS}, ${this.environmentProjection} AS environment_addresses_json FROM run_batches WHERE suite_id=${this.parameter(1)} AND id=${this.parameter(2)}`,
      [suiteId, batchId],
    );
    return row ? publicBatch(row) : null;
  }
  async replay(suiteId: string, publisherId: string, requestKey: string) {
    const [row] = await this.query(
      `SELECT id FROM run_batches WHERE public_request_key=${this.parameter(1)}`,
      [publicRequestKey(suiteId, publisherId, requestKey)],
    );
    return row ? String(row.id) : null;
  }
  private parameters(count: number) {
    return Array.from({ length: count }, (_, index) => this.parameter(index + 1)).join(",");
  }
}

export function publicRequestKey(suiteId: string, publisherId: string, requestKey: string): string {
  return JSON.stringify([suiteId, publisherId, requestKey]);
}

function publicBatch(row: Record<string, unknown>) {
  const context = row.public_execution_json
    ? publicSuiteExecutionContextSchema.parse(JSON.parse(String(row.public_execution_json)))
    : null;
  const terminatedBy = row.terminated_by_json ? storedActor(String(row.terminated_by_json)) : null;
  return publicSuiteBatchSchema.parse({
    environmentAddresses: batchEnvironmentAddresses(
      row.environment_addresses_json as string | null,
    ),
    id: row.id,
    sequenceNumber: row.sequence_number,
    status: row.status,
    totalRuns: row.total_runs,
    currentRound: row.current_round,
    requestedBy: row.requested_by_username ?? null,
    publisher: context?.publisher.username ?? null,
    terminatedBy: terminatedBy?.username ?? null,
    pauseRequestedAt: row.pause_requested_at ?? null,
    terminationRequestedAt: row.cancel_requested_at ?? null,
    scheduledFor: row.scheduled_for,
    createdAt: row.created_at,
    publicExecution: !!context,
    progressPath: context ? publicExecutionPath(String(row.id)) : null,
  });
}

export class SqlitePublicSuiteExecutionRepository extends PublicSuiteExecutionQueries {
  constructor(handle: SqliteDatabaseHandle) {
    super(
      async (statement, parameters) => {
        const prepared = handle.client.prepare(statement);
        return prepared.reader
          ? (prepared.all(...parameters) as Record<string, unknown>[])
          : retrySqliteLockContention(() => {
              prepared.run(...parameters);
              return [];
            });
      },
      () => "?",
      "coalesce(json_extract(policy_json, '$.environmentAddresses'), json_extract(adapter_runtime_json, '$.environmentAddresses'))",
    );
  }
}

export class PostgresPublicSuiteExecutionRepository extends PublicSuiteExecutionQueries {
  constructor(handle: PostgresDatabaseHandle) {
    super(
      async (statement, parameters) => {
        await handle.ready;
        return retryPostgresWrite(
          async () => (await handle.pool.query(statement, [...parameters])).rows,
        );
      },
      (index) => `$${index}`,
      "coalesce(policy_json::jsonb ->> 'environmentAddresses', adapter_runtime_json::jsonb ->> 'environmentAddresses')",
    );
  }
}
