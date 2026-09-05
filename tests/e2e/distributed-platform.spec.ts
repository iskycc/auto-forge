import { expect, test } from "@playwright/test";
import type { PlatformNode } from "@autoforge/contracts";
import { signNodeLogRequest, NODE_LOG_PATH } from "@autoforge/db/postgres";
import { ensureAdministrator } from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";
import { distributedLogFixture } from "./support/distributed-log-fixture";
import { distributedFault } from "./support/distributed-faults";
import { openDistributedLogStream } from "./support/distributed-log-stream";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("manages node addresses behind Nginx and reads owner-local logs through either platform", async ({
  page,
}, testInfo) => {
  const primary = process.env.E2E_PRIMARY_BASE_URL;
  const secondary = process.env.E2E_SECONDARY_BASE_URL;
  test.skip(
    !primary || !secondary || !process.env.E2E_PLATFORM_MASTER_KEY,
    "requires the isolated distributed deployment fixture",
  );
  await ensureAdministrator(page);
  const readiness = await Promise.all([
    page.request.get(`${primary}/api/v1/health/ready`),
    page.request.get(`${secondary}/api/v1/health/ready`),
  ]);
  const ids = readiness.map((response) => response.headers()["x-autoforge-node"]!) as [
    string,
    string,
  ];
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).not.toBe(ids[0]);
  const nodes = (await (await page.request.get("/api/v1/settings/platform-nodes")).json()) as {
    enabled: boolean;
    items: PlatformNode[];
  };
  expect(nodes.enabled).toBe(true);
  await page.goto("/settings/platform?section=nodes");
  for (const [index, id] of ids.entries()) {
    const node = nodes.items.find((candidate) => candidate.id === id)!;
    const form = page.getByRole("form", { name: `平台节点 ${node.name}`, exact: true });
    await form.getByLabel("节点名称", { exact: true }).fill(`平台节点 ${index + 1}`);
    await form
      .getByLabel("节点 IP 和端口", { exact: true })
      .fill(index === 0 ? primary! : secondary!);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/platform-nodes/${id}`) && response.request().method() === "PATCH",
    );
    await form.getByRole("button", { name: "保存节点地址" }).click();
    expect((await saved).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: `平台节点 ${index + 1}`, exact: true }),
    ).toBeVisible();
  }
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 1024 });
    await expectUiIntegrity(page);
    await page.screenshot({
      path: testInfo.outputPath(`platform-nodes-${width}.png`),
      fullPage: true,
    });
  }
  const servedBy = new Set<string>();
  for (let index = 0; index < 12; index++) {
    const response = await page.request.get("/api/v1/auth/session");
    expect(response.status()).toBe(200);
    servedBy.add(response.headers()["x-autoforge-node"]!);
  }
  expect([...servedBy].sort()).toEqual([...ids].sort());
  expect((await page.request.post("/api/v1/internal/platform-logs", { data: {} })).status()).toBe(
    404,
  );
  expect(
    (await page.request.post(`${primary}/api/v1/internal/platform-logs`, { data: {} })).status(),
  ).toBe(401);
  const fixture = await distributedLogFixture(ids);
  try {
    const input = {
      batchId: fixture.batchId,
      attemptId: fixture.attemptId,
      receivedAt: "2026-09-05T00:00:00.000Z",
      chunks: [
        {
          stream: "stdout" as const,
          sequence: 0,
          content: "跨节点日志正文，仅保存在节点 1",
          recordedAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    };
    expect((await fixture.logStore.appendChunks(input)).stdout).toBe(0);
    expect((await fixture.logStore.appendChunks(input)).stdout).toBe(0);
    const peerBody = JSON.stringify({
      operation: "list",
      batchId: fixture.batchId,
      attemptId: fixture.attemptId,
      stream: "stdout",
      afterSequence: -1,
      limit: 10,
    });
    const peerHeaders = signNodeLogRequest(
      process.env.E2E_PLATFORM_MASTER_KEY!,
      ids[1],
      ids[0],
      peerBody,
    );
    const peerUrl = `${primary}${NODE_LOG_PATH}`;
    expect(
      (await page.request.post(peerUrl, { headers: peerHeaders, data: peerBody })).status(),
    ).toBe(200);
    expect(
      (await page.request.post(peerUrl, { headers: peerHeaders, data: peerBody })).status(),
    ).toBe(401);
    const freshHeaders = signNodeLogRequest(
      process.env.E2E_PLATFORM_MASTER_KEY!,
      ids[1],
      ids[0],
      peerBody,
    );
    expect(
      (
        await page.request.post(peerUrl, {
          headers: freshHeaders,
          data: peerBody.replace('"limit":10', '"limit":11'),
        })
      ).status(),
    ).toBe(401);
    for (const endpoint of [primary, secondary]) {
      const response = await page.request.get(
        `${endpoint}/api/v1/run-attempts/${fixture.attemptId}/logs?stream=stdout`,
      );
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({
        items: [{ content: input.chunks[0]!.content }],
        acknowledgedSequence: 0,
      });
    }
    const streams = [
      await openDistributedLogStream(page.request, primary!, fixture.attemptId),
      await openDistributedLogStream(page.request, secondary!, fixture.attemptId),
    ];
    const upload = async (sequence: number, content: string) => {
      const response = await page.request.post(
        `${secondary}/api/v1/run-attempts/${fixture.attemptId}/logs`,
        {
          headers: {
            authorization: `Bearer ${fixture.credential}`,
            "x-autoforge-runner-id": fixture.runnerId,
          },
          data: {
            schemaVersion: 1,
            requestId: randomUUID(),
            leaseToken: fixture.leaseToken,
            chunks: [{ stream: "stdout", sequence, content, recordedAt: new Date().toISOString() }],
          },
        },
      );
      expect(response.status(), await response.text()).toBe(200);
    };
    try {
      await upload(1, "live-on-b password=do-not-cache-this");
      for (const stream of streams) await stream.expectContent(1, "live-on-b [REDACTED]");
      const replay = await openDistributedLogStream(page.request, secondary!, fixture.attemptId);
      try {
        await replay.expectContent(1, "live-on-b [REDACTED]");
      } finally {
        replay.close();
      }

      await distributedFault("redis.restart");
      for (const endpoint of [primary, secondary]) {
        await expect
          .poll(async () => (await page.request.get(`${endpoint}/api/v1/health/ready`)).status(), {
            timeout: 30_000,
          })
          .toBe(200);
      }
      const restored = await page.request.get(
        `${secondary}/api/v1/run-attempts/${fixture.attemptId}/logs?stream=stdout`,
      );
      expect(restored.status()).toBe(200);
      expect((await restored.json()).items).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "live-on-b [REDACTED]" })]),
      );
      await upload(2, "live-after-redis-restart");
      for (const stream of streams) await stream.expectContent(2, "live-after-redis-restart");
    } finally {
      for (const stream of streams) stream.close();
    }

    try {
      await distributedFault("primary.stop");
      const session = await page.request.get("/api/v1/auth/session");
      expect(session.status()).toBe(200);
      expect(session.headers()["x-autoforge-node"]).toBe(ids[1]);
      const unavailable = await page.request.get(
        `${secondary}/api/v1/run-attempts/${fixture.attemptId}/logs?stream=stdout`,
      );
      expect(unavailable.status()).toBe(503);
      expect((await unavailable.json()).error.code).toBe("PLATFORM_LOG_NODE_UNAVAILABLE");
      expect(await fixture.owner()).toBe(ids[0]);
      const directories = JSON.parse(process.env.E2E_DISTRIBUTED_LOG_DIRECTORIES!) as [
        string,
        string,
      ];
      expect(existsSync(join(directories[0], `${fixture.batchId}.sqlite`))).toBe(true);
      expect(existsSync(join(directories[1], `${fixture.batchId}.sqlite`))).toBe(false);
    } finally {
      await distributedFault("primary.start");
    }
    const recovered = await page.request.get(
      `${secondary}/api/v1/run-attempts/${fixture.attemptId}/logs?stream=stdout`,
    );
    expect(recovered.status()).toBe(200);
    expect(
      (await recovered.json()).items.map((chunk: { sequence: number }) => chunk.sequence),
    ).toEqual([0, 1, 2]);
    await page.goto("/settings/platform?section=configuration");
    await expect(page.getByRole("button", { name: "保存平台配置" })).toBeDisabled();
  } finally {
    await fixture.dispose();
  }
});
