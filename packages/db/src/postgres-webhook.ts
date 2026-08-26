import type { WebhookRepository } from "@autoforge/application";
import {
  DomainError,
  type WebhookConfiguration,
  type WebhookDelivery,
  type WebhookDispatchClaim,
} from "@autoforge/domain";
import type { PoolClient } from "pg";

import type { PostgresDatabaseHandle } from "./postgres-database";

type ConfigurationRow = {
  id: string;
  project_id: string;
  name: string;
  normalized_name: string;
  description: string;
  target_url: string;
  method: "GET" | "POST";
  body_template: string | null;
  enabled: boolean;
  enabled_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

type DeliveryRow = {
  id: string;
  webhook_id: string;
  webhook_name: string;
  batch_id: string;
  suite_name: string;
  status: "pending" | "delivering" | "succeeded" | "failed";
  attempts: number;
  response_status: number | null;
  error_message: string | null;
  created_at: string;
  delivered_at: string | null;
  updated_at: string;
};

type ClaimRow = {
  delivery_id: string;
  webhook_id: string;
  webhook_name: string;
  request_url: string;
  request_method: "GET" | "POST";
  request_body_template: string | null;
  attempts: number;
  batch_id: string;
  sequence_number: number;
  project_id: string;
  suite_id: string;
  suite_name: string;
  batch_status: "succeeded" | "failed" | "cancelled";
  total_runs: number;
  succeeded_runs: string;
  failed_runs: string;
  cancelled_runs: string;
  batch_created_at: string;
  completed_at: string;
};

export class PostgresWebhookRepository implements WebhookRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async listConfigurations(projectId: string): Promise<WebhookConfiguration[]> {
    await this.handle.ready;
    const result = await this.handle.pool.query<ConfigurationRow>(
      `${configurationSelect()} WHERE project_id = $1 AND deleted_at IS NULL ORDER BY name, id`,
      [projectId],
    );
    return result.rows.map(mapConfiguration);
  }

  async getConfiguration(webhookId: string, projectIds?: readonly string[]) {
    await this.handle.ready;
    const row = await findConfiguration(this.handle.pool, webhookId, projectIds);
    return row ? mapConfiguration(row) : null;
  }

  async createConfiguration(input: Parameters<WebhookRepository["createConfiguration"]>[0]) {
    await this.handle.ready;
    try {
      await this.handle.pool.query(
        `INSERT INTO webhook_configurations
          (id, project_id, name, normalized_name, description, target_url, method,
           body_template, enabled, enabled_at, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11)`,
        [
          input.id,
          input.projectId,
          input.name,
          input.normalizedName,
          input.description,
          input.targetUrl,
          input.method,
          input.bodyTemplate ?? null,
          input.enabled,
          input.enabled ? input.recordedAt : null,
          input.recordedAt,
        ],
      );
    } catch (error) {
      throw mapConfigurationWriteError(error);
    }
    const row = await findConfiguration(this.handle.pool, input.id);
    if (!row) throw new Error(`Webhook configuration ${input.id} was not found after write.`);
    return mapConfiguration(row);
  }

  async updateConfiguration(input: Parameters<WebhookRepository["updateConfiguration"]>[0]) {
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await findConfiguration(client, input.webhookId, input.projectIds, true);
      if (!current || current.revision !== input.expectedRevision) {
        await client.query("ROLLBACK");
        return null;
      }
      const enabled = input.enabled ?? current.enabled;
      const enabledAt = enabled ? (current.enabled ? current.enabled_at : input.updatedAt) : null;
      try {
        await client.query(
          `UPDATE webhook_configurations SET
             name = $1, normalized_name = $2, description = $3, target_url = $4, method = $5,
             body_template = $6, enabled = $7, enabled_at = $8, revision = revision + 1,
             updated_at = $9
           WHERE id = $10 AND revision = $11 AND deleted_at IS NULL`,
          [
            input.name ?? current.name,
            input.normalizedName ?? current.normalized_name,
            input.description ?? current.description,
            input.targetUrl ?? current.target_url,
            input.method ?? current.method,
            input.bodyTemplate === undefined ? current.body_template : input.bodyTemplate,
            enabled,
            enabledAt,
            input.updatedAt,
            input.webhookId,
            input.expectedRevision,
          ],
        );
      } catch (error) {
        throw mapConfigurationWriteError(error);
      }
      const row = await findConfiguration(client, input.webhookId);
      await client.query("COMMIT");
      return row ? mapConfiguration(row) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteConfiguration(input: Parameters<WebhookRepository["deleteConfiguration"]>[0]) {
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await findConfiguration(client, input.webhookId, input.projectIds, true);
      if (!current) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("DELETE FROM case_suite_webhook_bindings WHERE webhook_id = $1", [
        input.webhookId,
      ]);
      const result = await client.query(
        `UPDATE webhook_configurations
         SET enabled = FALSE, enabled_at = NULL, deleted_at = $1, updated_at = $1,
             revision = revision + 1
         WHERE id = $2 AND deleted_at IS NULL`,
        [input.deletedAt, input.webhookId],
      );
      await client.query("COMMIT");
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listSuiteBindings(suiteId: string, projectIds?: readonly string[]): Promise<string[]> {
    await this.handle.ready;
    if (projectIds?.length === 0) return [];
    const parameters: unknown[] = [suiteId];
    const projectClause = projectIds
      ? ` AND s.project_id = ANY($${parameters.push(projectIds)}::text[])`
      : "";
    const result = await this.handle.pool.query<{ webhook_id: string }>(
      `SELECT b.webhook_id
       FROM case_suite_webhook_bindings b
       JOIN case_suites s ON s.id = b.suite_id
       JOIN webhook_configurations w ON w.id = b.webhook_id AND w.deleted_at IS NULL
       WHERE b.suite_id = $1${projectClause}
       ORDER BY w.name, w.id`,
      parameters,
    );
    return result.rows.map((row) => row.webhook_id);
  }

  async replaceSuiteBindings(input: Parameters<WebhookRepository["replaceSuiteBindings"]>[0]) {
    await this.handle.ready;
    if (input.projectIds?.length === 0)
      throw new DomainError("CASE_SUITE_NOT_FOUND", "任务不存在。");
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const parameters: unknown[] = [input.suiteId];
      const projectClause = input.projectIds
        ? ` AND project_id = ANY($${parameters.push(input.projectIds)}::text[])`
        : "";
      const suiteResult = await client.query<{ project_id: string }>(
        `SELECT project_id FROM case_suites WHERE id = $1${projectClause} FOR UPDATE`,
        parameters,
      );
      const suite = suiteResult.rows[0];
      if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "任务不存在。");
      const webhookIds = [...new Set(input.webhookIds)];
      if (webhookIds.length > 0) {
        const countResult = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM webhook_configurations
           WHERE id = ANY($1::text[]) AND project_id = $2 AND deleted_at IS NULL`,
          [webhookIds, suite.project_id],
        );
        if (Number(countResult.rows[0]?.count ?? 0) !== webhookIds.length) {
          throw new DomainError("WEBHOOK_BINDING_INVALID", "只能绑定当前项目中存在的 Webhook。");
        }
      }
      const existingResult = await client.query<{ webhook_id: string; created_at: string }>(
        "SELECT webhook_id, created_at FROM case_suite_webhook_bindings WHERE suite_id = $1",
        [input.suiteId],
      );
      const existingBindings = new Map(
        existingResult.rows.map((binding) => [binding.webhook_id, binding.created_at]),
      );
      await client.query("DELETE FROM case_suite_webhook_bindings WHERE suite_id = $1", [
        input.suiteId,
      ]);
      if (webhookIds.length > 0) {
        for (const webhookId of webhookIds) {
          await client.query(
            `INSERT INTO case_suite_webhook_bindings (suite_id, webhook_id, created_at)
             VALUES ($1, $2, $3)`,
            [input.suiteId, webhookId, existingBindings.get(webhookId) ?? input.recordedAt],
          );
        }
      }
      await client.query("COMMIT");
      return webhookIds;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listDeliveries(projectId: string, limit: number): Promise<WebhookDelivery[]> {
    await this.handle.ready;
    const result = await this.handle.pool.query<DeliveryRow>(
      `SELECT d.id, d.webhook_id, d.webhook_name, d.batch_id, b.suite_name, d.status,
              d.attempts, d.response_status, d.error_message, d.created_at,
              d.delivered_at, d.updated_at
       FROM webhook_deliveries d
       JOIN run_batches b ON b.id = d.batch_id
       WHERE b.project_id = $1
       ORDER BY d.created_at DESC, d.id DESC LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(mapDelivery);
  }

  async materializeDeliveries(input: Parameters<WebhookRepository["materializeDeliveries"]>[0]) {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `INSERT INTO webhook_deliveries
        (id, webhook_id, batch_id, webhook_name, request_url, request_method,
         request_body_template, status, attempts, available_at, created_at, updated_at)
       SELECT 'webhook-delivery-' || w.id || '-' || b.id, w.id, b.id, w.name, w.target_url,
              w.method, w.body_template, 'pending', 0, e.recorded_at, e.recorded_at, $1
       FROM run_batch_status_events e
       JOIN run_batches b ON b.id = e.batch_id
       JOIN case_suite_webhook_bindings binding ON binding.suite_id = b.suite_id
       JOIN webhook_configurations w ON w.id = binding.webhook_id
       WHERE e.to_status IN ('succeeded', 'failed', 'cancelled')
         AND b.batch_kind <> 'case_log_rerun'
         AND NOT EXISTS (
           SELECT 1 FROM webhook_deliveries existing
           WHERE existing.webhook_id = w.id AND existing.batch_id = b.id
         )
         AND binding.created_at <= e.recorded_at
         AND w.enabled = TRUE AND w.deleted_at IS NULL
         AND w.enabled_at IS NOT NULL AND w.enabled_at <= e.recorded_at
       ORDER BY e.recorded_at, e.id, w.id LIMIT $2
       ON CONFLICT (webhook_id, batch_id) DO NOTHING`,
      [input.now, input.limit],
    );
    return result.rowCount ?? 0;
  }

  async claimDueDeliveries(input: Parameters<WebhookRepository["claimDueDeliveries"]>[0]) {
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `WITH candidates AS (
           SELECT id FROM webhook_deliveries
           WHERE (status = 'pending' AND available_at <= $1)
              OR (status = 'delivering' AND lease_expires_at <= $1)
           ORDER BY available_at, created_at, id
           FOR UPDATE SKIP LOCKED LIMIT $4
         )
         UPDATE webhook_deliveries d SET
           status = 'delivering', attempts = d.attempts + 1, lease_owner = $2,
           lease_expires_at = $3, updated_at = $1
         FROM candidates c WHERE d.id = c.id RETURNING d.id`,
        [input.now, input.owner, input.leaseExpiresAt, input.limit],
      );
      const claims: WebhookDispatchClaim[] = [];
      for (const row of result.rows) {
        const claim = await loadClaim(client, row.id);
        if (!claim) throw new Error(`Webhook delivery ${row.id} could not be loaded after claim.`);
        claims.push(mapClaim(claim, input.owner));
      }
      await client.query("COMMIT");
      return claims;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeDelivery(input: Parameters<WebhookRepository["completeDelivery"]>[0]) {
    await this.handle.ready;
    await this.handle.pool.query(
      `UPDATE webhook_deliveries
       SET status = 'succeeded', response_status = $1, error_message = NULL,
           lease_owner = NULL, lease_expires_at = NULL, delivered_at = $2, updated_at = $2
       WHERE id = $3 AND status = 'delivering' AND lease_owner = $4`,
      [input.responseStatus, input.completedAt, input.deliveryId, input.owner],
    );
  }

  async failDelivery(input: Parameters<WebhookRepository["failDelivery"]>[0]) {
    await this.handle.ready;
    await this.handle.pool.query(
      `UPDATE webhook_deliveries
       SET status = $1, available_at = $2, response_status = $3, error_message = $4,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = $5
       WHERE id = $6 AND status = 'delivering' AND lease_owner = $7`,
      [
        input.retryAt ? "pending" : "failed",
        input.retryAt ?? input.failedAt,
        input.responseStatus ?? null,
        input.errorMessage,
        input.failedAt,
        input.deliveryId,
        input.owner,
      ],
    );
  }
}

function configurationSelect(): string {
  return `SELECT id, project_id, name, normalized_name, description, target_url, method,
                 body_template, enabled, enabled_at, revision, created_at, updated_at
          FROM webhook_configurations`;
}

async function findConfiguration(
  client: Pick<PoolClient, "query">,
  webhookId: string,
  projectIds?: readonly string[],
  lock = false,
): Promise<ConfigurationRow | undefined> {
  if (projectIds?.length === 0) return undefined;
  const parameters: unknown[] = [webhookId];
  const projectClause = projectIds
    ? ` AND project_id = ANY($${parameters.push(projectIds)}::text[])`
    : "";
  const result = await client.query<ConfigurationRow>(
    `${configurationSelect()} WHERE id = $1 AND deleted_at IS NULL${projectClause}${lock ? " FOR UPDATE" : ""}`,
    parameters,
  );
  return result.rows[0];
}

async function loadClaim(client: PoolClient, deliveryId: string): Promise<ClaimRow | undefined> {
  const result = await client.query<ClaimRow>(
    `SELECT d.id AS delivery_id, d.webhook_id, d.webhook_name, d.request_url,
            d.request_method, d.request_body_template, d.attempts,
            b.id AS batch_id, b.sequence_number, b.project_id, b.suite_id, b.suite_name,
            b.status AS batch_status, b.total_runs,
            COUNT(*) FILTER (WHERE r.status = 'succeeded') AS succeeded_runs,
            COUNT(*) FILTER (WHERE r.status = 'failed') AS failed_runs,
            COUNT(*) FILTER (WHERE r.status = 'cancelled') AS cancelled_runs,
            b.created_at AS batch_created_at, d.created_at AS completed_at
     FROM webhook_deliveries d
     JOIN run_batches b ON b.id = d.batch_id
     LEFT JOIN execution_runs r ON r.batch_id = b.id
     WHERE d.id = $1
     GROUP BY d.id, d.webhook_id, d.webhook_name, d.request_url, d.request_method,
              d.request_body_template, d.attempts, b.id, b.sequence_number, b.project_id,
              b.suite_id, b.suite_name, b.status, b.total_runs, b.created_at, d.created_at`,
    [deliveryId],
  );
  return result.rows[0];
}

function mapConfiguration(row: ConfigurationRow): WebhookConfiguration {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    targetUrl: row.target_url,
    method: row.method,
    ...(row.body_template ? { bodyTemplate: row.body_template } : {}),
    enabled: row.enabled,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    webhookName: row.webhook_name,
    batchId: row.batch_id,
    suiteName: row.suite_name,
    status: row.status,
    attempts: Number(row.attempts),
    ...(row.response_status !== null ? { responseStatus: Number(row.response_status) } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    updatedAt: row.updated_at,
  };
}

function mapClaim(row: ClaimRow, leaseOwner: string): WebhookDispatchClaim {
  return {
    deliveryId: row.delivery_id,
    webhookId: row.webhook_id,
    webhookName: row.webhook_name,
    targetUrl: row.request_url,
    method: row.request_method,
    ...(row.request_body_template ? { bodyTemplate: row.request_body_template } : {}),
    attemptNumber: Number(row.attempts),
    leaseOwner,
    batch: {
      id: row.batch_id,
      sequenceNumber: Number(row.sequence_number),
      projectId: row.project_id,
      suiteId: row.suite_id,
      suiteName: row.suite_name,
      status: row.batch_status,
      totalRuns: Number(row.total_runs),
      succeededRuns: Number(row.succeeded_runs),
      failedRuns: Number(row.failed_runs),
      cancelledRuns: Number(row.cancelled_runs),
      createdAt: row.batch_created_at,
      completedAt: row.completed_at,
    },
  };
}

function mapConfigurationWriteError(error: unknown): Error {
  if (
    error instanceof Error &&
    ("constraint" in error
      ? (error as Error & { constraint?: string }).constraint ===
        "webhook_configurations_project_name_uq"
      : error.message.includes("webhook_configurations_project_name_uq"))
  ) {
    return new DomainError("WEBHOOK_NAME_CONFLICT", "当前项目中已存在同名 Webhook。");
  }
  return error instanceof Error ? error : new Error("Webhook 配置写入失败。", { cause: error });
}
