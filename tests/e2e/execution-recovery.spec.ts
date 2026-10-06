import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ExecutionExceptionPage } from "@autoforge/contracts";
import { zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expectUiIntegrity } from "./support/ui-guard";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import {
  browserJson,
  ensureAdministrator,
  login,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { configureTaskExecution, createTaskRun } from "./support/task-execution";

const runnerCapabilities = [
  "executor:testng-v1",
  "isolation:cgroup-v2",
  "java:21.0.8",
  "testng:7.11.0",
];

test("execution exceptions reveal unstarted timeouts and distinguish normal test failures", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const fixture = await createExecutableFixture(page);
  const runner = await registerRunner(page, "Exception diagnostics Runner", runnerCapabilities);
  const capacityBatch = await createBatch(page, fixture, runner.runnerId, {});
  const capacityClaim = await claimAssignment(page, runner);
  await heartbeatRunner(page, runner, runnerCapabilities, { busySlots: 2 });
  const queueBatch = await createBatch(page, fixture, runner.runnerId, { queueTimeoutMs: 1_000 });
  await expect
    .poll(
      async () => {
        await triggerRecovery(page, runner);
        const response = await browserJson<{ status: string }>(
          page,
          `/api/v1/run-batches/${queueBatch}`,
        );
        return response.body.status;
      },
      { timeout: 15_000 },
    )
    .toBe("failed");
  await expectBatchReason(page, queueBatch, "QUEUE_TIMEOUT");
  const endpoint = `/api/v1/run-batches/${queueBatch}/exceptions`;
  await page.goto("/execution-records");
  const recordRow = page.getByRole("row").filter({
    has: page.locator(`a[href="/run-batches/${queueBatch}"]`),
  });
  const abnormalStatus = recordRow.getByText("执行异常", { exact: true });
  await expect(abnormalStatus).toBeVisible();
  let previewRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === endpoint && url.searchParams.get("scope") === "terminal")
      previewRequests++;
  });
  expect(previewRequests).toBe(0);
  await page.route(
    `**${endpoint}?scope=terminal*`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "PLATFORM_BUSY", message: "悬浮原因暂时不可用，请重试。" } },
      }),
    { times: 1 },
  );
  await abnormalStatus.hover();
  const preview = page.getByRole("tooltip").filter({ hasText: "执行异常原因" });
  await expect(preview.getByRole("alert")).toContainText("悬浮原因暂时不可用");
  await preview.getByRole("button", { name: "重试", exact: true }).click();
  await expect(preview).toContainText("QUEUE_TIMEOUT");
  await expect(preview).toContainText("第 1 轮");
  await expect(preview).toContainText("1 秒时限");
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await abnormalStatus.hover();
      await expect(preview).toContainText("QUEUE_TIMEOUT");
      // Popover's enter animation scales controls; inspect their settled hit targets.
      await expect
        .poll(() =>
          preview
            .getByRole("button", { name: "查看全部异常原因", exact: true })
            .evaluate((element) => Math.round(element.getBoundingClientRect().height)),
        )
        .toBeGreaterThanOrEqual(32);
      await preview.getByRole("button", { name: "查看全部异常原因", exact: true }).hover();
      await expectUiIntegrity(page);
      await captureExceptionUi(page, `execution-exceptions-hover-${theme}-${width}`);
    }
  }
  expect(previewRequests).toBe(2);
  await page.mouse.move(0, 0);
  await expect(preview).not.toBeVisible();
  await abnormalStatus.focus();
  await expect(preview).toContainText("QUEUE_TIMEOUT");
  expect(previewRequests).toBe(2);
  await abnormalStatus.press("Escape");
  await expect(preview).not.toBeVisible();
  await abnormalStatus.press("Tab");
  await abnormalStatus.focus();
  await expect(preview).toContainText("QUEUE_TIMEOUT");
  await preview.getByRole("button", { name: "查看全部异常原因", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "执行异常原因" })).toContainText("QUEUE_TIMEOUT");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "切换到浅色模式", exact: true }).click();
  await page.goto(`/run-batches/${queueBatch}`);
  await expect(page.getByText("排队超时", { exact: true })).toBeVisible();
  const rounds = page.getByRole("region", { name: "轮次列表", exact: true });
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      for (const label of ["总结", "全部轮次", "初始轮次"]) {
        const selection = rounds.getByRole("button", { name: label, exact: true });
        await selection.click();
        await expect(selection).toHaveAttribute("aria-current", "true");
        await expect(rounds.locator("button[aria-current=true]")).toHaveCount(1);
        await expect(rounds.locator(".selected-row")).toHaveCount(1);
        await expect(rounds).toContainText(`当前查看：${label}`);
        await expect(selection.locator("svg")).toBeVisible();
        await expectUiIntegrity(page);
        await captureExceptionUi(page, `execution-round-selected-${label}-${theme}-${width}`);
      }
    }
  }
  await page.reload();
  await expect(rounds.getByRole("button", { name: "初始轮次", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.getByRole("button", { name: "切换到浅色模式", exact: true }).click();
  await page.route(
    `**${endpoint}?*`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "PLATFORM_BUSY", message: "异常原因暂时不可用，请重试。" } },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "查看异常原因", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "执行异常原因", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("异常原因暂时不可用");
  await dialog.getByRole("button", { name: "重试", exact: true }).click();
  await expect(dialog).toContainText("判定核对一致：1 个用例非正常结束");
  await expect(dialog.getByText("QUEUE_TIMEOUT", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("第 1 轮");
  await expect(dialog).toContainText("终态原因");
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") {
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
      await page.getByRole("button", { name: "查看异常原因", exact: true }).click();
      await expect(dialog.getByText("QUEUE_TIMEOUT", { exact: true })).toBeVisible();
    }
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      const time = dialog.locator("tbody time").first();
      await expect(time).toBeVisible();
      expect(
        await time.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(0);
      if (process.env.AUTOFORGE_UI_SCREENSHOT_DIR) {
        await mkdir(process.env.AUTOFORGE_UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: resolve(
            process.env.AUTOFORGE_UI_SCREENSHOT_DIR,
            `execution-exceptions-${theme}-${width}.png`,
          ),
        });
      }
    }
  }
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await test.step("diagnostic pages preserve every cause and recover after a next-page failure", () =>
    verifyExceptionDialogPaging(page, queueBatch));
  const share = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-batches/${queueBatch}/share`,
    { method: "POST" },
  );
  expect(share.status).toBe(200);
  const anonymous = await browser.newContext();
  try {
    const sharedPage = await anonymous.newPage();
    await sharedPage.goto(share.body.shareUrl);
    await sharedPage.getByRole("button", { name: "查看异常原因", exact: true }).click();
    await expect(sharedPage.getByRole("dialog", { name: "执行异常原因" })).toContainText(
      "QUEUE_TIMEOUT",
    );
    expect((await sharedPage.request.get(new URL(endpoint, page.url()).toString())).status()).toBe(
      401,
    );
    const token = decodeURIComponent(new URL(share.body.shareUrl).pathname.split("/").at(-1)!);
    expect(
      (
        await sharedPage.request.get(
          new URL(
            `/api/v1/run-batches/${capacityBatch}/exceptions?access_token=${encodeURIComponent(token)}`,
            page.url(),
          ).toString(),
        )
      ).status(),
    ).toBe(400);
  } finally {
    await anonymous.close();
  }
  await test.step("read-only project members can diagnose only their own project's batch", () =>
    verifyExceptionProjectAccess(page, browser, fixture.projectId, queueBatch));
  await heartbeatRunner(page, runner, runnerCapabilities, { busySlots: 0 });
  await complete(page, runner, capacityClaim, randomUUID());
  for (const resultCode of ["TESTNG_ASSERTIONS_FAILED", "EXECUTION_TIMEOUT"]) {
    const batch = await createBatch(page, fixture, runner.runnerId, { retryLimit: 0 });
    await complete(page, runner, await claimAssignment(page, runner), randomUUID(), {
      status: resultCode === "EXECUTION_TIMEOUT" ? "timed_out" : "failed",
      resultCode,
    });
    await waitForBatchStatus(
      page,
      batch,
      resultCode === "EXECUTION_TIMEOUT" ? "failed" : "succeeded",
    );
    await page.goto(`/run-batches/${batch}`);
    if (resultCode === "EXECUTION_TIMEOUT") {
      await page.getByRole("button", { name: "查看异常原因", exact: true }).click();
      await expect(dialog).toContainText("EXECUTION_TIMEOUT");
      await expect(dialog).toContainText("尝试 1");
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    } else {
      await expect(page.getByRole("button", { name: "查看异常原因", exact: true })).toHaveCount(0);
      const causes = await browserJson<{ consistent: boolean; items: unknown[] }>(
        page,
        `/api/v1/run-batches/${batch}/exceptions`,
      );
      expect(causes.body).toMatchObject({ consistent: true, items: [] });
    }
  }
});

async function verifyExceptionDialogPaging(page: Page, batchId: string): Promise<void> {
  const endpoint = `/api/v1/run-batches/${batchId}/exceptions`;
  const original = await browserJson<ExecutionExceptionPage>(page, endpoint);
  expect(original.status).toBe(200);
  const cause = original.body.items[0]!;
  const items = Array.from({ length: 51 }, (_, index) => ({
    ...cause,
    id: `paging-cause-${index}`,
    caseName: `分页用例 ${index + 1}`,
  }));
  let secondPageAttempts = 0;
  const pattern = `**${endpoint}?*`;
  await page.route(pattern, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor && secondPageAttempts++ === 0) {
      await route.fulfill({
        status: 503,
        json: { error: { code: "PLATFORM_BUSY", message: "第二页暂时不可用，请重试。" } },
      });
      return;
    }
    await route.fulfill({
      json: {
        ...original.body,
        items: cursor ? items.slice(50) : items.slice(0, 50),
        nextCursor: cursor ? undefined : "diagnostic-page-two",
      },
    });
  });
  const dialog = page.getByRole("dialog", { name: "执行异常原因", exact: true });
  try {
    await page.getByRole("button", { name: "查看异常原因", exact: true }).click();
    await expect(dialog.locator("tbody tr")).toHaveCount(50);
    await expect(dialog.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("第二页暂时不可用");
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await expect(dialog.locator("tbody tr")).toHaveCount(1);
    await expect(dialog).toContainText("分页用例 51");
    await expect(dialog.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(dialog.locator("tbody tr")).toHaveCount(50);
    await expect(dialog.getByText("分页用例 1", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  } finally {
    await page.unroute(pattern);
  }
}

async function verifyExceptionProjectAccess(
  administrator: Page,
  browser: Browser,
  projectId: string,
  batchId: string,
): Promise<void> {
  const name = uniqueName("exception-access");
  const otherProject = await browserJson<{ id: string }>(administrator, "/api/v1/projects", {
    method: "POST",
    body: { name, slug: name },
  });
  expect(otherProject.status).toBe(201);
  const viewerRoleId = "00000000-0000-7000-8100-000000000005";
  const password = "ExceptionViewer!Password123";
  for (const scope of [projectId, otherProject.body.id]) {
    const username = uniqueName("exception-viewer");
    const user = await browserJson<{ id: string }>(administrator, "/api/v1/users", {
      method: "POST",
      body: { username, displayName: username, password, forcePasswordChange: false },
    });
    expect(user.status).toBe(201);
    expect(
      (
        await browserJson(administrator, `/api/v1/users/${user.body.id}/project-roles`, {
          method: "POST",
          body: { projectId: scope, roleId: viewerRoleId },
        })
      ).status,
    ).toBe(204);
    const context = await browser.newContext({ baseURL: new URL(administrator.url()).origin });
    try {
      const reader = await context.newPage();
      await login(reader, username, password);
      const diagnostics = await reader.request.get(`/api/v1/run-batches/${batchId}/exceptions`);
      expect(diagnostics.status()).toBe(scope === projectId ? 200 : 404);
      if (scope === projectId) {
        expect((await diagnostics.json()).items[0]).toMatchObject({ resultCode: "QUEUE_TIMEOUT" });
        await reader.goto(`/run-batches/${batchId}`);
        await reader.getByRole("button", { name: "查看异常原因", exact: true }).click();
        await expect(reader.getByRole("dialog", { name: "执行异常原因" })).toContainText(
          "QUEUE_TIMEOUT",
        );
        expect(
          (
            await reader.request.post(`/api/v1/run-batches/${batchId}/cancel`, {
              data: { reason: "Verify diagnostics do not grant execution control" },
            })
          ).status(),
        ).toBe(403);
      }
    } finally {
      await context.close();
    }
  }
}

async function captureExceptionUi(page: Page, name: string): Promise<void> {
  const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}

test("execution duration and countdown tolerate browser clock skew and wall clock steps", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const fixture = await createExecutableFixture(page);
  const runner = await registerRunner(page, "Clock tolerance Runner", runnerCapabilities);
  await heartbeatRunner(page, runner, runnerCapabilities);
  const timeResponse = await page.request.get("/api/v1/time");
  expect(timeResponse.status()).toBe(200);
  const { serverTime } = (await timeResponse.json()) as { serverTime: string };
  const baselineMs = Date.parse(serverTime);
  await page.clock.setFixedTime(new Date(baselineMs + 600_000));
  const batchId = await createBatch(page, fixture, runner.runnerId, {});
  await page.goto(`/run-batches/${batchId}`);
  const elapsed = page
    .locator(".batch-metric")
    .filter({ has: page.getByText("已运行时长", { exact: true }) })
    .locator("strong");
  await expect(elapsed).toHaveText(/^\d+s$/);
  await page.clock.setFixedTime(new Date(baselineMs - 600_000));
  await expect
    .poll(async () => Number((await elapsed.innerText()).replace("s", "")))
    .toBeGreaterThan(0);
  await expect(elapsed).toHaveText(/^\d+s$/);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("clock-skew-running-1024.png"),
    fullPage: true,
  });
  await complete(page, runner, await claimAssignment(page, runner), randomUUID());
  await waitForBatchStatus(page, batchId, "succeeded");

  const delayed = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
    method: "POST",
    body: { suiteId: fixture.suiteId, delaySeconds: 120 },
  });
  expect(delayed.status).toBe(201);
  await page.goto(`/run-batches/${delayed.body.id}`);
  const countdown = page
    .locator(".batch-metric")
    .filter({ has: page.getByText("距离开始", { exact: true }) })
    .locator("strong");
  await expect(countdown).toHaveText(/^1m \d+s$/);
  await page.clock.setFixedTime(new Date(baselineMs + 3_600_000));
  await expect(countdown).toHaveText(/^1m \d+s$/);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.screenshot({
    path: testInfo.outputPath("clock-skew-countdown-1536.png"),
    fullPage: true,
  });
  const cancelled = await browserJson(page, `/api/v1/run-batches/${delayed.body.id}/cancel`, {
    method: "POST",
    body: { reason: "Clock tolerance acceptance cleanup" },
  });
  expect(cancelled.status).toBe(200);
});

test("authoritative execution recovery handles every timeout and idempotent race", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureAdministrator(page);
  const fixture = await createExecutableFixture(page);
  const runner = await registerRunner(page, "Execution Recovery Runner", runnerCapabilities);
  await configureTaskExecution(page, fixture.suiteId, runner.runnerId, { retryLimit: 0 });
  await heartbeatRunner(page, runner, ["isolation:cgroup-v2"]);

  const preflight = await browserJson<{
    ready: boolean;
    blockers: Array<{ category: string; runnerId?: string }>;
  }>(page, "/api/v1/run-batches/preflight", {
    method: "POST",
    body: { suiteId: fixture.suiteId },
  });
  expect(preflight.status).toBe(200);
  expect(preflight.body.ready).toBe(false);
  expect(preflight.body.blockers).toContainEqual(
    expect.objectContaining({ category: "runner", runnerId: runner.runnerId }),
  );
  await heartbeatRunner(page, runner, runnerCapabilities);

  const claimTimeoutBatch = await createBatch(page, fixture, runner.runnerId, {
    claimTimeoutMs: 1_000,
  });
  await page.waitForTimeout(2_500);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, claimTimeoutBatch, "ASSIGNMENT_CLAIM_TIMEOUT");
  // 领取超时是基础设施故障：用户重试上限为 0 也必须自动重调度，
  // 完成重调度 attempt 后再继续下一个恢复场景，避免占用项目并发槽。
  await complete(page, runner, await claimAssignment(page, runner), randomUUID());
  await waitForBatchStatus(page, claimTimeoutBatch, "succeeded");

  const uploadTimeoutBatch = await createBatch(page, fixture, runner.runnerId, {
    uploadTimeoutMs: 1_000,
  });
  const uploadTimeoutClaim = await claimAssignment(page, runner);
  const declaration = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(uploadTimeoutClaim.assignment.attemptId)}/artifacts`,
    {
      headers: runnerHeaders(runner),
      data: {
        schemaVersion: 1,
        requestId: randomUUID(),
        leaseToken: uploadTimeoutClaim.lease.token,
        artifacts: [],
      },
    },
  );
  expect(declaration.status()).toBe(200);
  await page.waitForTimeout(2_500);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, uploadTimeoutBatch, "UPLOAD_TIMEOUT");
  await complete(page, runner, await claimAssignment(page, runner), randomUUID());
  await waitForBatchStatus(page, uploadTimeoutBatch, "succeeded");

  const capacityBatch = await createBatch(page, fixture, runner.runnerId, {});
  const capacityClaim = await claimAssignment(page, runner);
  // Occupy both slots so the queue-timeout batch cannot be assigned and must
  // hit its deadline instead of racing with the scheduler.
  await heartbeatRunner(page, runner, runnerCapabilities, { busySlots: 2 });
  const queueTimeoutBatch = await createBatch(page, fixture, runner.runnerId, {
    queueTimeoutMs: 1_000,
  });
  await page.waitForTimeout(2_500);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, queueTimeoutBatch, "QUEUE_TIMEOUT");
  // Release the artificial capacity lock; the remaining cases need assignments.
  await heartbeatRunner(page, runner, runnerCapabilities, { busySlots: 0 });
  expect(
    (await complete(page, runner, capacityClaim, "release-project-capacity")).disposition,
  ).toBe("accepted");
  await expectBatchReason(page, capacityBatch, "TESTNG_SUCCEEDED");

  const idempotentBatch = await createBatch(page, fixture, runner.runnerId, {});
  await waitForAttemptStatus(page, idempotentBatch, "assigned");
  const claimRequestId = randomUUID();
  const firstClaimResponse = await claimOnce(page, runner, claimRequestId);
  const duplicateClaimResponse = await claimOnce(page, runner, claimRequestId);
  const firstClaim = firstClaimResponse.assignments[0]!;
  expect(duplicateClaimResponse.assignments[0]?.assignment.attemptId).toBe(
    firstClaim.assignment.attemptId,
  );
  const completionId = randomUUID();
  expect((await complete(page, runner, firstClaim, completionId)).disposition).toBe("accepted");
  expect((await complete(page, runner, firstClaim, completionId)).disposition).toBe("duplicate");
  await expectBatchReason(page, idempotentBatch, "TESTNG_SUCCEEDED");

  const cancellationBatch = await createBatch(page, fixture, runner.runnerId, {});
  const cancellationClaim = await claimAssignment(page, runner);
  const cancellation = await browserJson(
    page,
    `/api/v1/execution-runs/${encodeURIComponent(cancellationClaim.assignment.executionSpec.executionRunId)}/cancel`,
    { method: "POST", body: { reason: "E2E completion/cancel race" } },
  );
  expect(cancellation.status).toBe(200);
  // A claimed attempt keeps its valid lease long enough to acknowledge
  // cancellation. Its completion is accepted, but the authoritative outcome
  // is forced to cancelled rather than trusting the Runner's success payload.
  expect((await complete(page, runner, cancellationClaim, randomUUID())).disposition).toBe(
    "accepted",
  );
  await expectBatchReason(page, cancellationBatch, "CANCELLED_BY_CONTROL_PLANE");

  const leaseExpiryBatch = await createBatch(page, fixture, runner.runnerId, {});
  await claimAssignment(page, runner);
  await page.waitForTimeout(46_000);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, leaseExpiryBatch, "LEASE_EXPIRED");
});

type RunnerIdentity = { runnerId: string; credential: string };
type Claim = {
  assignment: {
    attemptId: string;
    executionSpec: { executionRunId: string };
  };
  lease: { token: string };
};

type ExecutableFixture = { projectId: string; suiteId: string };

async function createExecutableFixture(page: Page): Promise<ExecutableFixture> {
  const fixtureName = uniqueName("execution-recovery");
  const project = await browserJson<{ id: string; name: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: `Execution recovery ${fixtureName}`, slug: fixtureName },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(project.body.id)}/versions`,
    { method: "POST", body: { name: "Execution recovery version" } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(project.body.id)}/versions/${encodeURIComponent(version.body.id)}/stages`,
    {
      method: "POST",
      body: { name: "Execution recovery stage", description: "Recovery acceptance hierarchy" },
    },
  );
  expect(stage.status).toBe(201);
  await selectProjectContext(page, project.body.id);
  const className = `com.example.ExecutionRecovery${Date.now()}Test`;
  const jar = zipSync({
    [`${className.replaceAll(".", "/")}.class`]: buildClassFile({
      className,
      methods: [{ name: "recovers", annotations: [{ type: "Test", values: {} }] }],
    }),
  });
  await page.goto(
    `/cases/import?${new URLSearchParams({
      projectId: project.body.id,
      projectVersionId: version.body.id,
      testStageId: stage.body.id,
    }).toString()}`,
  );
  await expect(page.locator(".global-project-switcher")).toContainText(project.body.name);
  const jarInput = page.locator('input[type="file"]');
  await expect(jarInput).toBeEnabled();
  await jarInput.setInputFiles({
    name: "execution-recovery.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText(className)).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText("已导入", { timeout: 60_000 });
  const cases = await browserJson<{ items: Array<{ id: string; className: string }> }>(
    page,
    `/api/v1/case-definitions?projectId=${encodeURIComponent(project.body.id)}&query=${encodeURIComponent(className)}`,
  );
  const caseDefinition = cases.body.items.find((item) => item.className === className);
  expect(caseDefinition).toBeTruthy();
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId: project.body.id, name: fixtureName },
  });
  expect(suite.status).toBe(201);
  const addition = await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
    method: "POST",
    body: { caseDefinitionIds: [caseDefinition!.id] },
  });
  expect(addition.status).toBe(200);
  return { projectId: project.body.id, suiteId: suite.body.id };
}

async function registerRunner(
  page: Page,
  name: string,
  capabilities: string[],
): Promise<RunnerIdentity> {
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name,
      labels: ["linux", "java", "testng"],
      capabilities,
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.3.4-e2e",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const runner = (await registration.json()) as RunnerIdentity;
  await heartbeatRunner(page, runner, capabilities);
  return runner;
}

async function heartbeatRunner(
  page: Page,
  runner: RunnerIdentity,
  capabilities: string[],
  options?: { busySlots?: number },
): Promise<void> {
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        busySlots: options?.busySlots ?? 0,
        labels: ["linux", "java", "testng"],
        capabilities,
        maxConcurrency: 2,
        agentVersion: "0.3.4-e2e",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 1,
          memoryUtilizationPercent: 1,
          loadAverage1m: 0,
          logicalCpuCount: 2,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(heartbeat.status()).toBe(200);
}

async function createBatch(
  page: Page,
  fixture: ExecutableFixture,
  runnerId: string,
  timeouts: Record<string, number>,
): Promise<string> {
  await configureTaskExecution(page, fixture.suiteId, runnerId, {
    retryLimit: 0,
    queueTimeoutMs: 86_400_000,
    claimTimeoutMs: 300_000,
    uploadTimeoutMs: 600_000,
    ...timeouts,
  });
  return (await createTaskRun(page, fixture.suiteId)).id;
}

async function claimAssignment(page: Page, runner: RunnerIdentity): Promise<Claim> {
  let observed: Claim | undefined;
  await expect
    .poll(
      async () => {
        const response = await claimOnce(page, runner, randomUUID());
        observed = response.assignments[0];
        return Boolean(observed);
      },
      { timeout: 20_000, intervals: [100, 250, 500] },
    )
    .toBe(true);
  return observed!;
}

async function triggerRecovery(page: Page, runner: RunnerIdentity): Promise<void> {
  // 只触发权威超时回收，不在同一个请求里领取刚生成的基础设施重试。
  // 补槽优化后 availableSlots=1 会立即调度并领取重试任务，旧的空响应假设不再成立。
  const response = await claimOnce(page, runner, randomUUID(), 0);
  expect(response.assignments).toHaveLength(0);
}

async function claimOnce(
  page: Page,
  runner: RunnerIdentity,
  requestId: string,
  availableSlots = 1,
) {
  const response = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/claims`,
    {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        requestId,
        availableSlots,
        labels: ["linux", "java", "testng"],
        capabilities: runnerCapabilities,
        waitSeconds: 0,
      },
    },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as { assignments: Claim[] };
}

async function complete(
  page: Page,
  runner: RunnerIdentity,
  claim: Claim,
  completionId: string,
  result?: { status: "failed" | "timed_out"; resultCode: string },
): Promise<{ disposition: string }> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(claim.assignment.attemptId)}/complete`,
    {
      headers: runnerHeaders(runner),
      data: {
        schemaVersion: 1,
        completionId,
        leaseToken: claim.lease.token,
        result: {
          status: "succeeded",
          resultCode: "TESTNG_SUCCEEDED",
          summary: "Execution recovery E2E completion",
          durationMs: 10,
          artifacts: [],
          ...result,
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as { disposition: string };
}

async function expectBatchReason(page: Page, batchId: string, reason: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
        );
        if (!response.ok()) return `HTTP ${response.status()}`;
        const body = (await response.json()) as {
          attempts: Array<{ resultCode?: string }>;
          runs: Array<{ terminalReasonCode?: string }>;
        };
        return (
          body.attempts.find((attempt) => attempt.resultCode)?.resultCode ??
          body.runs.find((run) => run.terminalReasonCode)?.terminalReasonCode ??
          "pending"
        );
      },
      { timeout: 20_000, intervals: [100, 250, 500] },
    )
    .toBe(reason);
}

async function waitForAttemptStatus(page: Page, batchId: string, status: string): Promise<void> {
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/run-batches/${encodeURIComponent(batchId)}`);
      return ((await response.json()) as { attempts: Array<{ status: string }> }).attempts[0]
        ?.status;
    })
    .toBe(status);
}

async function waitForBatchStatus(page: Page, batchId: string, status: string): Promise<void> {
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/run-batches/${encodeURIComponent(batchId)}`);
      return ((await response.json()) as { status: string }).status;
    })
    .toBe(status);
}

function runnerHeaders(runner: RunnerIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${runner.credential}`,
    "x-autoforge-runner-id": runner.runnerId,
  };
}
