import type { WebhookDispatchClaim } from "@autoforge/domain";
import { describe, expect, it, vi } from "vitest";

import { WebhookNotificationService, webhookRequest } from "../src/manage-webhooks";
import type { WebhookRepository } from "../src/ports";

const NOW = new Date("2026-08-23T08:00:00.000Z");

describe("WebhookNotificationService", () => {
  it("normalizes configuration names and snapshots POST JSON templates", async () => {
    const createConfiguration = vi.fn(async (input) => ({
      ...input,
      revision: 1,
      createdAt: input.recordedAt,
      updatedAt: input.recordedAt,
    }));
    const service = createService({ createConfiguration });

    await service.createConfiguration({
      projectId: "project-1",
      name: "  Quality Bot  ",
      description: "构建群通知",
      targetUrl: "https://hooks.example.test/autoforge",
      method: "POST",
      bodyTemplate: '{"batch":"{{batch.id}}"}',
      enabled: true,
    });

    expect(createConfiguration).toHaveBeenCalledWith({
      id: "webhook-1",
      projectId: "project-1",
      name: "Quality Bot",
      normalizedName: "quality bot",
      description: "构建群通知",
      targetUrl: "https://hooks.example.test/autoforge",
      method: "POST",
      bodyTemplate: '{"batch":"{{batch.id}}"}',
      enabled: true,
      recordedAt: NOW.toISOString(),
    });
  });

  it("renders escaped POST variables and deterministic GET query parameters", () => {
    const postClaim = claim({
      method: "POST",
      bodyTemplate: '{"suite":"{{batch.suiteName}}","failed":"{{summary.failed}}"}',
      batch: { ...claim().batch, suiteName: '冒烟 "核心"', failedRuns: 3 },
    });
    expect(webhookRequest(postClaim)).toEqual({
      method: "POST",
      url: "https://hooks.example.test/notify?source=autoforge",
      body: '{"suite":"冒烟 \\"核心\\"","failed":"3"}',
    });

    const getRequest = webhookRequest(claim({ method: "GET" }));
    const url = new URL(getRequest.url);
    expect(getRequest.method).toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      source: "autoforge",
      event: "run_batch.completed",
      batchId: "batch-1",
      suiteId: "suite-1",
      status: "succeeded",
      completedAt: "2026-08-23T07:59:00.000Z",
      passRate: "75.0",
    });
  });

  it("sends a configuration test with an explicit preset pass rate", async () => {
    const transport = { send: vi.fn().mockResolvedValue({ statusCode: 202 }) };
    const service = createService(
      {
        getConfiguration: vi.fn().mockResolvedValue({
          id: "webhook-1",
          projectId: "project-1",
          name: "Quality Bot",
          description: "",
          targetUrl: "https://hooks.example.test/notify",
          method: "POST",
          bodyTemplate: '{"passRate":"{{summary.passRate}}","total":"{{summary.total}}"}',
          enabled: false,
          revision: 1,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        }),
      },
      transport,
    );

    await expect(service.testConfiguration("webhook-1", ["project-1"])).resolves.toEqual({
      method: "POST",
      presetPassRate: 80,
      statusCode: 202,
    });
    expect(transport.send).toHaveBeenCalledWith({
      method: "POST",
      url: "https://hooks.example.test/notify",
      body: '{"passRate":"80.0","total":"100"}',
    });
  });

  it("marks 2xx deliveries complete without changing execution state", async () => {
    const completeDelivery = vi.fn();
    const failDelivery = vi.fn();
    const transport = { send: vi.fn().mockResolvedValue({ statusCode: 204 }) };
    const service = createService(
      {
        materializeDeliveries: vi.fn().mockResolvedValue(1),
        claimDueDeliveries: vi.fn().mockResolvedValue([claim()]),
        completeDelivery,
        failDelivery,
      },
      transport,
    );

    await expect(service.dispatchDue("worker-webhooks")).resolves.toEqual({
      materialized: 1,
      delivered: 1,
      retrying: 0,
      failed: 0,
    });
    expect(completeDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      owner: "worker-webhooks",
      responseStatus: 204,
      completedAt: NOW.toISOString(),
    });
    expect(failDelivery).not.toHaveBeenCalled();
  });

  it("schedules bounded retries for non-2xx responses", async () => {
    const failDelivery = vi.fn();
    const service = createService(
      {
        materializeDeliveries: vi.fn().mockResolvedValue(0),
        claimDueDeliveries: vi.fn().mockResolvedValue([claim({ attemptNumber: 1 })]),
        failDelivery,
      },
      { send: vi.fn().mockResolvedValue({ statusCode: 503 }) },
    );

    await expect(service.dispatchDue("worker-webhooks")).resolves.toMatchObject({ retrying: 1 });
    expect(failDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      owner: "worker-webhooks",
      errorMessage: "Webhook 返回 HTTP 503。",
      responseStatus: 503,
      retryAt: "2026-08-23T08:00:30.000Z",
      failedAt: NOW.toISOString(),
    });
  });
});

function createService(repository: Partial<WebhookRepository>, transport = { send: vi.fn() }) {
  return new WebhookNotificationService(
    repository as WebhookRepository,
    transport,
    { now: () => new Date(NOW.getTime()) },
    { next: () => "webhook-1" },
  );
}

function claim(overrides: Partial<WebhookDispatchClaim> = {}): WebhookDispatchClaim {
  return {
    deliveryId: "delivery-1",
    webhookId: "webhook-1",
    webhookName: "Quality Bot",
    targetUrl: "https://hooks.example.test/notify?source=autoforge",
    method: "POST",
    bodyTemplate: '{"batch":"{{batch.id}}"}',
    attemptNumber: 1,
    leaseOwner: "worker-webhooks",
    batch: {
      id: "batch-1",
      sequenceNumber: 42,
      projectId: "project-1",
      suiteId: "suite-1",
      suiteName: "回归任务",
      status: "succeeded",
      totalRuns: 4,
      succeededRuns: 3,
      failedRuns: 1,
      cancelledRuns: 0,
      createdAt: "2026-08-23T07:50:00.000Z",
      completedAt: "2026-08-23T07:59:00.000Z",
    },
    ...overrides,
  };
}
