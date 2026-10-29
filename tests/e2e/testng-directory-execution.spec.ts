import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync } from "fflate";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { expectUiIntegrity } from "./support/ui-guard";

test("TestNG directories remain browsable during a running task and a deferred refresh", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const prefetchedDetails: string[] = [];
  page.on("request", (request) => {
    if (/^\/cases\/[a-f0-9-]{36}$/i.test(new URL(request.url()).pathname))
      prefetchedDetails.push(request.url());
  });
  const name = uniqueName("directory-pressure");
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name, slug: name },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions`,
    { method: "POST", body: { name: "执行期间目录验证" } },
  );
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "回归测试" } },
  );
  const scope = {
    projectId: project.body.id,
    projectVersionId: version.body.id,
    testStageId: stage.body.id,
  };
  await selectProjectContext(page, scope.projectId, scope.projectVersionId, scope.testStageId);
  const archive = zipSync(
    Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => {
        const className = `pressure.Directory${String(index).padStart(3, "0")}Test`;
        return [
          `${className.replaceAll(".", "/")}.class`,
          buildClassFile({
            className,
            methods: [{ name: "verify", annotations: [{ type: "Test", values: {} }] }],
          }),
        ];
      }),
    ),
  );
  const imported = await page.request.post(
    `/api/v1/case-sources/jar/import?${new URLSearchParams(scope)}`,
    {
      headers: { origin: new URL(page.url()).origin },
      multipart: {
        file: {
          name: "directory-pressure.jar",
          mimeType: "application/java-archive",
          buffer: Buffer.from(archive),
        },
      },
    },
  );
  expect(imported.status()).toBe(202);
  const job = (await imported.json()) as { id: string };
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/v1/case-sources/jar/imports/${job.id}`)).json()) as {
            status: string;
          }
        ).status,
      { timeout: 60000 },
    )
    .toBe("succeeded");
  await page.goto("/cases");
  await expect(page.locator(".case-browser-summary")).toContainText("120 个用例", {
    timeout: 30000,
  });
  const caseIds: string[] = [];
  let cursor = "";
  do {
    const cases = await browserJson<{ items: Array<{ id: string }>; nextCursor?: string }>(
      page,
      `/api/v1/case-definitions?${new URLSearchParams({ ...scope, limit: "100", ...(cursor ? { cursor } : {}) })}`,
    );
    expect(cases.status).toBe(200);
    caseIds.push(...cases.body.items.map((item) => item.id));
    cursor = cases.body.nextCursor ?? "";
  } while (cursor);
  expect(caseIds).toHaveLength(120);
  const capabilities = [
    "executor:testng-v1",
    "isolation:cgroup-v2",
    "java:21.0.8",
    "testng:7.11.0",
  ];
  const labels = ["linux", "java", "testng"];
  const registered = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: uniqueName("directory-runner"),
      labels,
      capabilities,
      maxConcurrency: 4,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.2.0",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registered.status()).toBe(201);
  const runner = (await registered.json()) as { runnerId: string; credential: string };
  const headers = {
    authorization: `Bearer ${runner.credential}`,
    "x-autoforge-runner-id": runner.runnerId,
  };
  let busySlots = 0;
  const heartbeat = async () => {
    const response = await page.request.post(`/api/v1/runner-agents/${runner.runnerId}/heartbeat`, {
      headers,
      data: {
        schemaVersion: 1,
        busySlots,
        labels,
        capabilities,
        maxConcurrency: 4,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 10,
          memoryUtilizationPercent: 20,
          loadAverage1m: 0.1,
          logicalCpuCount: 16,
          observedAt: new Date().toISOString(),
        },
      },
    });
    expect(response.status()).toBe(200);
  };
  // Registration starts with free slots; the first heartbeat supplies resource observations.
  await heartbeat();
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      name: "执行中目录验收任务",
    },
  });
  expect(suite.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
        method: "POST",
        body: { caseDefinitionIds: caseIds },
      })
    ).status,
  ).toBe(200);
  const saved = await browserJson<{ revision: number; policy: Record<string, unknown> }>(
    page,
    `/api/v1/case-suites/${suite.body.id}`,
  );
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suite.body.id}`, {
        method: "PATCH",
        body: {
          expectedRevision: saved.body.revision,
          policy: {
            ...saved.body.policy,
            concurrency: 4,
            retryLimit: 0,
            runnerIds: [runner.runnerId],
            runnerGroupId: "",
            adapter: { ...(saved.body.policy.adapter as Record<string, unknown>), enabled: false },
          },
        },
      })
    ).status,
  ).toBe(200);
  const batch = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
    method: "POST",
    body: { suiteId: suite.body.id },
  });
  expect(batch.status).toBe(201);
  const claims: Array<{
    assignment: { attemptId: string };
    lease: { leaseId: string; token: string; version: number };
  }> = [];
  const stop = new AbortController();
  let protocolFailure: unknown;
  let maintenance: Promise<void> | undefined;
  let renewals = 0;
  try {
    await expect
      .poll(
        async () => {
          const response = await page.request.post(
            `/api/v1/runner-agents/${runner.runnerId}/claims`,
            {
              headers,
              data: {
                schemaVersion: 1,
                requestId: randomUUID(),
                availableSlots: 4 - claims.length,
                labels,
                capabilities,
                waitSeconds: 0,
              },
            },
          );
          expect(response.status()).toBe(200);
          claims.push(...((await response.json()) as { assignments: typeof claims }).assignments);
          return claims.length;
        },
        { timeout: 20000 },
      )
      .toBe(4);
    busySlots = claims.length;
    maintenance = (async () => {
      let sequence = 0;
      while (!stop.signal.aborted) {
        await heartbeat();
        for (const claim of claims) {
          const renewed = await page.request.post(
            `/api/v1/runner-agents/${runner.runnerId}/leases/${claim.lease.leaseId}/renew`,
            {
              headers,
              data: {
                schemaVersion: 1,
                requestId: randomUUID(),
                leaseToken: claim.lease.token,
                leaseVersion: claim.lease.version,
              },
            },
          );
          expect(renewed.status()).toBe(200);
          const result = (await renewed.json()) as { instruction: string; leaseVersion: number };
          expect(result.instruction).toBe("continue");
          claim.lease.version = result.leaseVersion;
          renewals++;
          const logged = await page.request.post(
            `/api/v1/run-attempts/${claim.assignment.attemptId}/logs`,
            {
              headers,
              data: {
                schemaVersion: 1,
                requestId: randomUUID(),
                leaseToken: claim.lease.token,
                chunks: [
                  {
                    stream: "stdout",
                    sequence,
                    content: `目录浏览期间日志 ${sequence}\n`,
                    recordedAt: new Date().toISOString(),
                  },
                ],
              },
            },
          );
          expect(logged.status()).toBe(200);
        }
        sequence++;
        await delay(3000, undefined, { signal: stop.signal }).catch((error) => {
          if (!stop.signal.aborted) throw error;
        });
      }
    })().catch((error) => {
      protocolFailure = error;
    });
    // Deterministically keep a real published projection stale; actual worker budget
    // admission is covered by the worker-thread and both database integration tests.
    await page.route("**/api/v1/read-models/*/directory?*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      await route.fulfill({
        response,
        json: { ...payload, synchronized: false, status: { ...payload.status, state: "stale" } },
      });
    });
    await page.reload();
    await expect(page.getByText("当前显示上次完整目录", { exact: false })).toBeVisible({
      timeout: 15000,
    });
    const folder = page.locator(".case-directory-tree > .case-tree-children > .ui-disclosure");
    await expect(folder).toBeVisible();
    if ((await folder.getAttribute("data-open")) !== "true")
      await folder
        .locator(
          ":scope > .ant-collapse > .ant-collapse-item > .ant-collapse-header .ui-disclosure-label",
        )
        .click();
    await expect(page.locator(".case-tree-case")).toHaveCount(100);
    expect(prefetchedDetails).toEqual([]);
    await expect(
      page.getByRole("checkbox", { name: "选择当前搜索结果中的全部用例", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "快速预览 Directory000Test", exact: true }).click();
    const preview = page.getByLabel("用例详情与操作", { exact: true });
    await expect(preview).toContainText("pressure.Directory000Test", { timeout: 15000 });
    await expect(preview.getByText("正在加载用例详情", { exact: false })).toHaveCount(0);
    for (const appearance of ["light", "dark"] as const) {
      if (appearance === "dark")
        await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`running-directory-${appearance}-${width}.png`),
          fullPage: true,
        });
      }
    }
    await page.unroute("**/api/v1/read-models/*/directory?*");
    await page.reload();
    await expect(page.locator(".case-browser-summary")).toContainText("120 个用例");
    await expect(page.getByText("当前显示上次完整目录", { exact: false })).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: "选择当前搜索结果中的全部用例", exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    await page.getByLabel("页内搜索用例", { exact: true }).fill("Directory000Test");
    await expect(page.locator(".case-tree-case")).toHaveCount(1, { timeout: 15000 });
    await page.getByRole("link", { name: "查看 Directory000Test 详情", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Directory000Test", exact: true }),
    ).toBeVisible();
    await expect.poll(() => renewals, { timeout: 10000 }).toBeGreaterThanOrEqual(8);
    expect(protocolFailure).toBeUndefined();
    const active = await browserJson<{ status: string }>(
      page,
      `/api/v1/run-batches/${batch.body.id}?view=summary`,
    );
    expect(active.body.status).toBe("running");
  } finally {
    stop.abort();
    await maintenance;
    await page.unroute("**/api/v1/read-models/*/directory?*");
    expect(
      (
        await browserJson(page, `/api/v1/run-batches/${batch.body.id}/terminate`, {
          method: "POST",
          body: { reason: "目录并行浏览验证结束" },
        })
      ).status,
    ).toBe(200);
    expect(protocolFailure).toBeUndefined();
  }
});
