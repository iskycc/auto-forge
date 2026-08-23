import {
  createWebhookConfigurationInputSchema,
  updateWebhookConfigurationInputSchema,
  type CreateWebhookConfigurationInput,
  type UpdateWebhookConfigurationInput,
} from "@autoforge/contracts";
import { DomainError, type WebhookDispatchClaim } from "@autoforge/domain";

import type { Clock, IdGenerator, WebhookRepository, WebhookTransport } from "./ports";

const DELIVERY_LEASE_MS = 30_000;
const MATERIALIZATION_LIMIT = 500;
const MAXIMUM_DELIVERY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const;

export class WebhookNotificationService {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly transport: WebhookTransport,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  listConfigurations(projectId: string) {
    return this.repository.listConfigurations(projectId);
  }

  getConfiguration(webhookId: string, projectIds?: readonly string[]) {
    return this.repository.getConfiguration(webhookId, projectIds);
  }

  async createConfiguration(input: CreateWebhookConfigurationInput) {
    const validated = createWebhookConfigurationInputSchema.parse(input);
    return this.repository.createConfiguration({
      id: this.ids.next(),
      projectId: validated.projectId,
      name: validated.name,
      normalizedName: normalizeWebhookName(validated.name),
      description: validated.description,
      targetUrl: validated.targetUrl,
      method: validated.method,
      ...(validated.method === "POST" && validated.bodyTemplate
        ? { bodyTemplate: validated.bodyTemplate }
        : {}),
      enabled: validated.enabled,
      recordedAt: this.clock.now().toISOString(),
    });
  }

  async updateConfiguration(
    webhookId: string,
    input: UpdateWebhookConfigurationInput,
    projectIds?: readonly string[],
  ) {
    const validated = updateWebhookConfigurationInputSchema.parse(input);
    const current = await this.repository.getConfiguration(webhookId, projectIds);
    if (!current) throw new DomainError("WEBHOOK_NOT_FOUND", "Webhook 配置不存在。");
    if (current.revision !== validated.expectedRevision) {
      throw new DomainError("WEBHOOK_REVISION_CONFLICT", "Webhook 配置已被修改，请刷新后重试。");
    }
    const nextMethod = validated.method ?? current.method;
    const nextBodyTemplate =
      validated.bodyTemplate === undefined ? current.bodyTemplate : validated.bodyTemplate;
    if (nextMethod === "POST" && !nextBodyTemplate) {
      throw new DomainError("WEBHOOK_BODY_REQUIRED", "POST Webhook 必须配置 JSON 请求体。");
    }
    const updated = await this.repository.updateConfiguration({
      webhookId,
      expectedRevision: validated.expectedRevision,
      ...(validated.name !== undefined ? { name: validated.name } : {}),
      ...(validated.name !== undefined
        ? { normalizedName: normalizeWebhookName(validated.name) }
        : {}),
      ...(validated.description !== undefined ? { description: validated.description } : {}),
      ...(validated.targetUrl !== undefined ? { targetUrl: validated.targetUrl } : {}),
      ...(validated.method !== undefined ? { method: validated.method } : {}),
      ...(nextMethod === "GET"
        ? { bodyTemplate: null }
        : validated.bodyTemplate !== undefined
          ? { bodyTemplate: validated.bodyTemplate }
          : {}),
      ...(validated.enabled !== undefined ? { enabled: validated.enabled } : {}),
      updatedAt: this.clock.now().toISOString(),
      ...(projectIds ? { projectIds } : {}),
    });
    if (!updated) {
      throw new DomainError("WEBHOOK_REVISION_CONFLICT", "Webhook 配置已被修改，请刷新后重试。");
    }
    return updated;
  }

  async deleteConfiguration(webhookId: string, projectIds?: readonly string[]) {
    const deleted = await this.repository.deleteConfiguration({
      webhookId,
      deletedAt: this.clock.now().toISOString(),
      ...(projectIds ? { projectIds } : {}),
    });
    if (!deleted) throw new DomainError("WEBHOOK_NOT_FOUND", "Webhook 配置不存在。");
  }

  listSuiteBindings(suiteId: string, projectIds?: readonly string[]) {
    return this.repository.listSuiteBindings(suiteId, projectIds);
  }

  replaceSuiteBindings(
    suiteId: string,
    webhookIds: readonly string[],
    projectIds?: readonly string[],
  ) {
    return this.repository.replaceSuiteBindings({
      suiteId,
      webhookIds: [...new Set(webhookIds)],
      recordedAt: this.clock.now().toISOString(),
      ...(projectIds ? { projectIds } : {}),
    });
  }

  listDeliveries(projectId: string, limit = 30) {
    return this.repository.listDeliveries(projectId, Math.min(100, Math.max(1, limit)));
  }

  async dispatchDue(
    owner: string,
    limit = 20,
  ): Promise<{
    materialized: number;
    delivered: number;
    retrying: number;
    failed: number;
  }> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const materialized = await this.repository.materializeDeliveries({
      now: nowIso,
      limit: MATERIALIZATION_LIMIT,
    });
    const claims = await this.repository.claimDueDeliveries({
      owner,
      now: nowIso,
      leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString(),
      limit: Math.min(100, Math.max(1, limit)),
    });
    const results = await Promise.all(claims.map((claim) => this.deliver(claim)));
    return {
      materialized,
      delivered: results.filter((result) => result === "delivered").length,
      retrying: results.filter((result) => result === "retrying").length,
      failed: results.filter((result) => result === "failed").length,
    };
  }

  private async deliver(claim: WebhookDispatchClaim): Promise<"delivered" | "retrying" | "failed"> {
    try {
      const request = webhookRequest(claim);
      const response = await this.transport.send(request);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return this.recordFailure(
          claim,
          `Webhook 返回 HTTP ${response.statusCode}。`,
          response.statusCode,
        );
      }
      await this.repository.completeDelivery({
        deliveryId: claim.deliveryId,
        owner: claim.leaseOwner,
        responseStatus: response.statusCode,
        completedAt: this.clock.now().toISOString(),
      });
      return "delivered";
    } catch (error) {
      return this.recordFailure(claim, boundedErrorMessage(error));
    }
  }

  private async recordFailure(
    claim: WebhookDispatchClaim,
    errorMessage: string,
    responseStatus?: number,
  ): Promise<"retrying" | "failed"> {
    const failedAt = this.clock.now();
    const retryDelay = RETRY_DELAYS_MS[claim.attemptNumber - 1];
    const retrying = claim.attemptNumber < MAXIMUM_DELIVERY_ATTEMPTS && retryDelay !== undefined;
    await this.repository.failDelivery({
      deliveryId: claim.deliveryId,
      owner: claim.leaseOwner,
      errorMessage,
      ...(responseStatus !== undefined ? { responseStatus } : {}),
      ...(retrying ? { retryAt: new Date(failedAt.getTime() + retryDelay).toISOString() } : {}),
      failedAt: failedAt.toISOString(),
    });
    return retrying ? "retrying" : "failed";
  }
}

export function webhookRequest(claim: WebhookDispatchClaim): {
  method: "GET" | "POST";
  url: string;
  body?: string;
} {
  const variables = webhookVariables(claim);
  if (claim.method === "GET") {
    const url = new URL(claim.targetUrl);
    url.searchParams.set("event", "run_batch.completed");
    url.searchParams.set("batchId", claim.batch.id);
    url.searchParams.set("suiteId", claim.batch.suiteId);
    url.searchParams.set("status", claim.batch.status);
    url.searchParams.set("completedAt", claim.batch.completedAt);
    return { method: "GET", url: url.toString() };
  }
  if (!claim.bodyTemplate) throw new Error("POST Webhook 没有请求体模板。");
  const body = claim.bodyTemplate.replace(/\{\{([^{}]+)\}\}/gu, (token, name: string) => {
    const value = variables[name];
    return value === undefined ? token : escapeJsonString(value);
  });
  JSON.parse(body);
  return { method: "POST", url: claim.targetUrl, body };
}

function webhookVariables(claim: WebhookDispatchClaim): Record<string, string> {
  return {
    "batch.id": claim.batch.id,
    "batch.sequenceNumber": String(claim.batch.sequenceNumber),
    "batch.projectId": claim.batch.projectId,
    "batch.suiteId": claim.batch.suiteId,
    "batch.suiteName": claim.batch.suiteName,
    "batch.status": claim.batch.status,
    "batch.displayStatus": batchDisplayStatus(claim.batch.status),
    "batch.createdAt": claim.batch.createdAt,
    "batch.completedAt": claim.batch.completedAt,
    "summary.total": String(claim.batch.totalRuns),
    "summary.succeeded": String(claim.batch.succeededRuns),
    "summary.failed": String(claim.batch.failedRuns),
    "summary.cancelled": String(claim.batch.cancelledRuns),
  };
}

function batchDisplayStatus(status: WebhookDispatchClaim["batch"]["status"]): string {
  if (status === "succeeded") return "执行完成";
  if (status === "cancelled") return "已取消";
  return "执行异常";
}

function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Webhook 请求失败。";
  return message.slice(0, 1_000);
}

function normalizeWebhookName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
