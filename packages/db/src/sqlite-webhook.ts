import type { WebhookRepository } from "@autoforge/application";
import {
  DomainError,
  type WebhookConfiguration,
  type WebhookDelivery,
  type WebhookDispatchClaim,
} from "@autoforge/domain";

import { runSqliteWriteTransaction, type SqliteDatabaseHandle } from "./database";

type ConfigurationRow = {
  id: string;
  project_id: string;
  name: string;
  normalized_name: string;
  description: string;
  target_url: string;
  method: "GET" | "POST";
  body_template: string | null;
  enabled: number;
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
  succeeded_runs: number;
  failed_runs: number;
  cancelled_runs: number;
  batch_created_at: string;
  completed_at: string;
};

export class SqliteWebhookRepository implements WebhookRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async listConfigurations(projectId: string): Promise<WebhookConfiguration[]> {
    return this.handle.client
      .prepare(
        `${configurationSelect()} WHERE project_id = ? AND deleted_at IS NULL ORDER BY name, id`,
      )
      .all(projectId)
      .map((row) => mapConfiguration(row as ConfigurationRow));
  }

  async getConfiguration(
    webhookId: string,
    projectIds?: readonly string[],
  ): Promise<WebhookConfiguration | null> {
    const row = this.findConfigurationRow(webhookId, projectIds);
    return row ? mapConfiguration(row) : null;
  }

  async createConfiguration(input: Parameters<WebhookRepository["createConfiguration"]>[0]) {
    try {
      this.handle.client
        .prepare(
          `INSERT INTO webhook_configurations
            (id, project_id, name, normalized_name, description, target_url, method,
             body_template, enabled, enabled_at, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.name,
          input.normalizedName,
          input.description,
          input.targetUrl,
          input.method,
          input.bodyTemplate ?? null,
          input.enabled ? 1 : 0,
          input.enabled ? input.recordedAt : null,
          input.recordedAt,
          input.recordedAt,
        );
    } catch (error) {
      throw mapConfigurationWriteError(error);
    }
    return mapConfiguration(this.requireConfigurationRow(input.id));
  }

  async updateConfiguration(input: Parameters<WebhookRepository["updateConfiguration"]>[0]) {
    return runSqliteWriteTransaction(this.handle, () => {
      const current = this.findConfigurationRow(input.webhookId, input.projectIds);
      if (!current || current.revision !== input.expectedRevision) return null;
      const enabled = input.enabled ?? current.enabled === 1;
      const enabledAt = enabled
        ? current.enabled === 1
          ? current.enabled_at
          : input.updatedAt
        : null;
      try {
        const result = this.handle.client
          .prepare(
            `UPDATE webhook_configurations SET
               name = ?, normalized_name = ?, description = ?, target_url = ?, method = ?,
               body_template = ?, enabled = ?, enabled_at = ?, revision = revision + 1,
               updated_at = ?
             WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
          )
          .run(
            input.name ?? current.name,
            input.normalizedName ?? current.normalized_name,
            input.description ?? current.description,
            input.targetUrl ?? current.target_url,
            input.method ?? current.method,
            input.bodyTemplate === undefined ? current.body_template : input.bodyTemplate,
            enabled ? 1 : 0,
            enabledAt,
            input.updatedAt,
            input.webhookId,
            input.expectedRevision,
          );
        if (result.changes === 0) return null;
      } catch (error) {
        throw mapConfigurationWriteError(error);
      }
      return mapConfiguration(this.requireConfigurationRow(input.webhookId));
    });
  }

  async deleteConfiguration(input: Parameters<WebhookRepository["deleteConfiguration"]>[0]) {
    return runSqliteWriteTransaction(this.handle, () => {
      if (!this.findConfigurationRow(input.webhookId, input.projectIds)) return false;
      this.handle.client
        .prepare("DELETE FROM case_suite_webhook_bindings WHERE webhook_id = ?")
        .run(input.webhookId);
      return (
        this.handle.client
          .prepare(
            `UPDATE webhook_configurations
             SET enabled = 0, enabled_at = NULL, deleted_at = ?, updated_at = ?, revision = revision + 1
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(input.deletedAt, input.deletedAt, input.webhookId).changes > 0
      );
    });
  }

  async listSuiteBindings(suiteId: string, projectIds?: readonly string[]): Promise<string[]> {
    const projectClause = sqliteProjectClause(projectIds, "s.project_id");
    if (projectClause.denied) return [];
    return this.handle.client
      .prepare(
        `SELECT b.webhook_id
         FROM case_suite_webhook_bindings b
         JOIN case_suites s ON s.id = b.suite_id
         JOIN webhook_configurations w ON w.id = b.webhook_id AND w.deleted_at IS NULL
         WHERE b.suite_id = ?${projectClause.sql}
         ORDER BY w.name, w.id`,
      )
      .all(suiteId, ...projectClause.parameters)
      .map((row) => (row as { webhook_id: string }).webhook_id);
  }

  async replaceSuiteBindings(input: Parameters<WebhookRepository["replaceSuiteBindings"]>[0]) {
    return runSqliteWriteTransaction(this.handle, () => {
      const projectClause = sqliteProjectClause(input.projectIds, "project_id");
      if (projectClause.denied) throw new DomainError("CASE_SUITE_NOT_FOUND", "任务不存在。");
      const suite = this.handle.client
        .prepare(`SELECT project_id FROM case_suites WHERE id = ?${projectClause.sql}`)
        .get(input.suiteId, ...projectClause.parameters) as { project_id: string } | undefined;
      if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "任务不存在。");
      const uniqueWebhookIds = [...new Set(input.webhookIds)];
      if (uniqueWebhookIds.length > 0) {
        const placeholders = uniqueWebhookIds.map(() => "?").join(", ");
        const count = this.handle.client
          .prepare(
            `SELECT COUNT(*) AS count FROM webhook_configurations
             WHERE id IN (${placeholders}) AND project_id = ? AND deleted_at IS NULL`,
          )
          .get(...uniqueWebhookIds, suite.project_id) as { count: number };
        if (count.count !== uniqueWebhookIds.length) {
          throw new DomainError("WEBHOOK_BINDING_INVALID", "只能绑定当前项目中存在的 Webhook。");
        }
      }
      const existingBindings = new Map(
        (
          this.handle.client
            .prepare(
              "SELECT webhook_id, created_at FROM case_suite_webhook_bindings WHERE suite_id = ?",
            )
            .all(input.suiteId) as Array<{ webhook_id: string; created_at: string }>
        ).map((binding) => [binding.webhook_id, binding.created_at]),
      );
      this.handle.client
        .prepare("DELETE FROM case_suite_webhook_bindings WHERE suite_id = ?")
        .run(input.suiteId);
      const insert = this.handle.client.prepare(
        "INSERT INTO case_suite_webhook_bindings (suite_id, webhook_id, created_at) VALUES (?, ?, ?)",
      );
      for (const webhookId of uniqueWebhookIds) {
        insert.run(input.suiteId, webhookId, existingBindings.get(webhookId) ?? input.recordedAt);
      }
      return uniqueWebhookIds;
    });
  }

  async listDeliveries(projectId: string, limit: number): Promise<WebhookDelivery[]> {
    return this.handle.client
      .prepare(
        `SELECT d.id, d.webhook_id, d.webhook_name, d.batch_id, b.suite_name, d.status,
                d.attempts, d.response_status, d.error_message, d.created_at,
                d.delivered_at, d.updated_at
         FROM webhook_deliveries d
         JOIN run_batches b ON b.id = d.batch_id
         WHERE b.project_id = ?
         ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
      )
      .all(projectId, limit)
      .map((row) => mapDelivery(row as DeliveryRow));
  }

  async materializeDeliveries(input: Parameters<WebhookRepository["materializeDeliveries"]>[0]) {
    return this.handle.client
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries
          (id, webhook_id, batch_id, webhook_name, request_url, request_method,
           request_body_template, status, attempts, available_at, created_at, updated_at)
         SELECT 'webhook-delivery-' || w.id || '-' || b.id, w.id, b.id, w.name, w.target_url,
                w.method, w.body_template, 'pending', 0, e.recorded_at, e.recorded_at, ?
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
           AND w.enabled = 1 AND w.deleted_at IS NULL
           AND w.enabled_at IS NOT NULL AND w.enabled_at <= e.recorded_at
         ORDER BY e.recorded_at, e.id, w.id
         LIMIT ?`,
      )
      .run(input.now, input.limit).changes;
  }

  async claimDueDeliveries(input: Parameters<WebhookRepository["claimDueDeliveries"]>[0]) {
    return runSqliteWriteTransaction(this.handle, () => {
      const candidates = this.handle.client
        .prepare(
          `SELECT id FROM webhook_deliveries
           WHERE (status = 'pending' AND available_at <= ?)
              OR (status = 'delivering' AND lease_expires_at <= ?)
           ORDER BY available_at, created_at, id LIMIT ?`,
        )
        .all(input.now, input.now, input.limit) as Array<{ id: string }>;
      const claim = this.handle.client.prepare(
        `UPDATE webhook_deliveries
         SET status = 'delivering', attempts = attempts + 1, lease_owner = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND ((status = 'pending' AND available_at <= ?)
                    OR (status = 'delivering' AND lease_expires_at <= ?))`,
      );
      const claimedIds: string[] = [];
      for (const candidate of candidates) {
        if (
          claim.run(
            input.owner,
            input.leaseExpiresAt,
            input.now,
            candidate.id,
            input.now,
            input.now,
          ).changes > 0
        ) {
          claimedIds.push(candidate.id);
        }
      }
      return claimedIds.map((deliveryId) =>
        mapClaim(this.requireClaimRow(deliveryId), input.owner),
      );
    });
  }

  async completeDelivery(input: Parameters<WebhookRepository["completeDelivery"]>[0]) {
    this.handle.client
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'succeeded', response_status = ?, error_message = NULL,
             lease_owner = NULL, lease_expires_at = NULL, delivered_at = ?, updated_at = ?
         WHERE id = ? AND status = 'delivering' AND lease_owner = ?`,
      )
      .run(
        input.responseStatus,
        input.completedAt,
        input.completedAt,
        input.deliveryId,
        input.owner,
      );
  }

  async failDelivery(input: Parameters<WebhookRepository["failDelivery"]>[0]) {
    this.handle.client
      .prepare(
        `UPDATE webhook_deliveries
         SET status = ?, available_at = ?, response_status = ?, error_message = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'delivering' AND lease_owner = ?`,
      )
      .run(
        input.retryAt ? "pending" : "failed",
        input.retryAt ?? input.failedAt,
        input.responseStatus ?? null,
        input.errorMessage,
        input.failedAt,
        input.deliveryId,
        input.owner,
      );
  }

  private findConfigurationRow(webhookId: string, projectIds?: readonly string[]) {
    const projectClause = sqliteProjectClause(projectIds, "project_id");
    if (projectClause.denied) return undefined;
    return this.handle.client
      .prepare(`${configurationSelect()} WHERE id = ? AND deleted_at IS NULL${projectClause.sql}`)
      .get(webhookId, ...projectClause.parameters) as ConfigurationRow | undefined;
  }

  private requireConfigurationRow(webhookId: string): ConfigurationRow {
    const row = this.findConfigurationRow(webhookId);
    if (!row) throw new Error(`Webhook configuration ${webhookId} was not found after write.`);
    return row;
  }

  private requireClaimRow(deliveryId: string): ClaimRow {
    const row = this.handle.client.prepare(claimSelect()).get(deliveryId) as ClaimRow | undefined;
    if (!row) throw new Error(`Webhook delivery ${deliveryId} could not be loaded after claim.`);
    return row;
  }
}

function configurationSelect(): string {
  return `SELECT id, project_id, name, normalized_name, description, target_url, method,
                 body_template, enabled, enabled_at, revision, created_at, updated_at
          FROM webhook_configurations`;
}

function claimSelect(): string {
  return `SELECT d.id AS delivery_id, d.webhook_id, d.webhook_name, d.request_url,
                 d.request_method, d.request_body_template, d.attempts,
                 b.id AS batch_id, b.sequence_number, b.project_id, b.suite_id, b.suite_name,
                 b.status AS batch_status, b.total_runs,
                 SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_runs,
                 SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
                 SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_runs,
                 b.created_at AS batch_created_at, d.created_at AS completed_at
          FROM webhook_deliveries d
          JOIN run_batches b ON b.id = d.batch_id
          LEFT JOIN execution_runs r ON r.batch_id = b.id
          WHERE d.id = ?
          GROUP BY d.id, d.webhook_id, d.webhook_name, d.request_url, d.request_method,
                   d.request_body_template, d.attempts, b.id, b.sequence_number, b.project_id,
                   b.suite_id, b.suite_name, b.status, b.total_runs, b.created_at, d.created_at`;
}

function sqliteProjectClause(projectIds: readonly string[] | undefined, column: string) {
  if (projectIds === undefined) return { denied: false, sql: "", parameters: [] as string[] };
  if (projectIds.length === 0) return { denied: true, sql: "", parameters: [] as string[] };
  return {
    denied: false,
    sql: ` AND ${column} IN (${projectIds.map(() => "?").join(", ")})`,
    parameters: [...projectIds],
  };
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
    enabled: row.enabled === 1,
    revision: row.revision,
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
    attempts: row.attempts,
    ...(row.response_status !== null ? { responseStatus: row.response_status } : {}),
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
    attemptNumber: row.attempts,
    leaseOwner,
    batch: {
      id: row.batch_id,
      sequenceNumber: row.sequence_number,
      projectId: row.project_id,
      suiteId: row.suite_id,
      suiteName: row.suite_name,
      status: row.batch_status,
      totalRuns: row.total_runs,
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
    (error.message.includes("webhook_configurations_project_name_uq") ||
      error.message.includes(
        "webhook_configurations.project_id, webhook_configurations.normalized_name",
      ))
  ) {
    return new DomainError("WEBHOOK_NAME_CONFLICT", "当前项目中已存在同名 Webhook。");
  }
  return error instanceof Error ? error : new Error("Webhook 配置写入失败。", { cause: error });
}
