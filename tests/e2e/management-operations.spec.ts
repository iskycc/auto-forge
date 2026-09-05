import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { expectUiIntegrity } from "./support/ui-guard";

import {
  acceptSystemDialog,
  browserJson,
  ensureAdministrator,
  login,
  selectProjectContext,
  uniqueName,
} from "./support/session";

const DEFAULT_PROJECT_ID = "00000000-0000-7000-8000-000000000001";

test("service account lifecycle immediately narrows token access and produces exportable audit", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const accountName = uniqueName("release-automation");
  await page.goto("/settings/platform?section=accounts");
  await page.getByRole("button", { name: "创建账号" }).click();
  const createForm = page.getByRole("dialog", { name: "创建服务账号" });
  await createForm.getByLabel("账号名称").fill(accountName);
  await createForm.getByLabel("用途说明").fill("E2E service account lifecycle");
  await createForm.locator('input[name="permissions"][value="case.read"]').check();
  await createForm.locator('input[name="permissions"][value="audit.read"]').check();
  const projectPermissionGroup = createForm.locator(".project-permission-group").first();
  if ((await projectPermissionGroup.count()) > 0) {
    await projectPermissionGroup.locator('input[value="run.read"]').check();
  }
  const accountResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/v1/service-accounts"),
  );
  await createForm.getByRole("button", { name: "创建服务账号", exact: true }).click();
  const account = (await (await accountResponse).json()) as { id: string };
  const accountCard = page.locator("article", { hasText: accountName });
  await expect(accountCard).toContainText("启用");
  await expect(accountCard).toContainText("查看用例");
  await expect(accountCard).toContainText("查看安全审计");
  await expect(accountCard).not.toContainText("case.read");
  await expect(accountCard).not.toContainText("audit.read");

  const tokenForm = accountCard.locator("form", {
    has: page.getByRole("button", { name: "签发" }),
  });
  await tokenForm.getByLabel("令牌名称").fill("e2e-token");
  await tokenForm
    .getByLabel("过期时间")
    .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  await tokenForm.locator('input[name="scopes"][value="case.read"]').check();
  await tokenForm.locator('input[name="scopes"][value="audit.read"]').check();
  await tokenForm.getByRole("button", { name: "签发" }).click();
  const token = await page.locator(".issued-token code").textContent();
  expect(token).toMatch(/^af_api_/);
  const authorized = await page.request.get("/api/v1/case-definitions", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(authorized.status()).toBe(200);

  await accountCard.getByText("编辑账号与权限").click();
  const editor = accountCard.locator("form", {
    has: page.getByRole("button", { name: "保存账号" }),
  });
  await editor.getByLabel("用途说明").fill("Permissions narrowed by E2E");
  for (const checkbox of await editor.locator('input[name="permissions"]').all()) {
    await checkbox.uncheck();
  }
  await editor.locator('input[name="permissions"][value="audit.read"]').check();
  for (const checkbox of await editor.locator('input[name^="projectPermissions:"]').all()) {
    await checkbox.uncheck();
  }
  await editor.getByRole("button", { name: "保存账号" }).click();
  await expect(page.getByText(/权限缩减.*立即生效/)).toBeVisible();
  const narrowed = await page.request.get("/api/v1/case-definitions", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(narrowed.status()).toBe(403);

  await accountCard.getByRole("button", { name: "禁用账号" }).click();
  await acceptSystemDialog(page, "禁用服务账号", "确认变更");
  await expect(page.getByText("服务账号已禁用。")).toBeVisible();
  const disabled = await page.request.get("/api/v1/audit-events", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(disabled.status()).toBe(401);

  let refreshedCard = page.locator("article", { hasText: accountName });
  const accountEditor = refreshedCard.locator("details.service-account-editor");
  if ((await accountEditor.getAttribute("open")) === null) {
    await refreshedCard.getByText("编辑账号与权限").click();
  }
  await refreshedCard.getByRole("button", { name: "启用账号" }).click();
  await acceptSystemDialog(page, "启用服务账号", "确认变更");
  await expect(page.getByText("服务账号已重新启用。")).toBeVisible();
  refreshedCard = page.locator("article", { hasText: accountName });
  await refreshedCard.getByRole("button", { name: "令牌" }).click();
  await refreshedCard.getByRole("button", { name: "撤销 e2e-token" }).click();
  await acceptSystemDialog(page, "撤销 API 令牌", "确认撤销");
  await expect(page.getByText("API 令牌已撤销。")).toBeVisible();
  const revoked = await page.request.get("/api/v1/audit-events", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(revoked.status()).toBe(401);

  refreshedCard = page.locator("article", { hasText: accountName });
  const replacementForm = refreshedCard.locator("form", {
    has: page.getByRole("button", { name: "签发" }),
  });
  await replacementForm.getByLabel("令牌名称").fill("replacement-token");
  await replacementForm
    .getByLabel("过期时间")
    .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  await replacementForm.locator('input[name="scopes"][value="audit.read"]').check();
  await replacementForm.getByRole("button", { name: "签发" }).click();
  await expect.poll(() => page.locator(".issued-token code").textContent()).not.toBe(token);
  const replacementToken = await page.locator(".issued-token code").textContent();
  expect(replacementToken).toMatch(/^af_api_/);
  const replacementAuthorized = await page.request.get("/api/v1/audit-events", {
    headers: { authorization: `Bearer ${replacementToken}` },
  });
  expect(replacementAuthorized.status()).toBe(200);
  await page.reload();
  await expect(page.locator(".issued-token")).toHaveCount(0);

  await page.goto("/audit?action=service_account.update");
  await expect(page.getByRole("heading", { name: "安全审计" })).toBeVisible();
  await expect(page.getByText("service_account.update", { exact: true }).first()).toBeVisible();
  const csv = await page.request.get(
    "/api/v1/audit-events/export?action=service_account.update&maximumEvents=100",
  );
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain("service_account.update");
  expect(account.id).toBeTruthy();
});

test("task details manage their own plan and show execution history in a dialog", async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await ensureAdministrator(page);
  const projectVersionId = await ensureDefaultProjectVersion(page);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, projectVersionId);
  const suiteName = uniqueName("scheduled-suite");
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId,
      name: suiteName,
      description: "Schedule operations E2E",
    },
  });
  expect(suite.status).toBe(201);
  await page.goto(`/case-suites/${suite.body.id}`);
  await expect(
    page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "运维计划" }),
  ).toHaveCount(0);
  const plan = page.getByRole("region", { name: "任务执行计划" });
  await plan.getByLabel("Cron（分 时 日 月 周）").fill("0 9 * * 1-5");
  await plan.getByLabel("IANA 时区").fill("Asia/Shanghai");
  await plan.getByLabel("错过触发").selectOption("run-once");
  await plan.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByText("计划触发已保存。", { exact: true })).toBeVisible();
  const openHistory = plan.getByRole("button", { name: "执行历史与计划", exact: true });
  await openHistory.click();
  const dialog = page.getByRole("dialog", { name: "执行历史与计划", exact: true });
  await expect(dialog).toContainText(suiteName);
  await expect(dialog).toContainText("恢复后补跑一次");
  await expect(dialog).toContainText("Asia/Shanghai");
  await expect(dialog).toContainText("下次执行");
  await expect(dialog).toContainText("尚未触发");
  await expect(dialog).toContainText("暂无执行记录");
  await dialog.getByRole("button", { name: "关闭执行历史与计划" }).click();
  await expect(openHistory).toBeFocused();

  await plan.getByRole("button", { name: "暂停计划" }).click();
  await expect(page.getByText("计划已暂停。")).toBeVisible();
  await openHistory.click();
  await expect(dialog).toContainText("计划已暂停，不会自动执行");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(openHistory).toBeFocused();
  await plan.getByRole("button", { name: "恢复计划" }).click();
  await expect(page.getByText("计划已启用。")).toBeVisible();
  await page.reload();
  await expect(plan.getByRole("button", { name: "暂停计划" })).toBeVisible();

  // Only the history transport is stubbed here; repository contracts verify scoped pagination.
  const historyUrl = `**/api/v1/case-suites/${suite.body.id}/executions?*`;
  let failHistory = true;
  await page.route(historyUrl, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("projectId")).toBe(DEFAULT_PROJECT_ID);
    expect(query.get("projectVersionId")).toBe(projectVersionId);
    if (failHistory) {
      failHistory = false;
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "TEST_UNAVAILABLE",
            message: "执行历史暂时不可用",
            requestId: "history-test",
          },
        },
      });
      return;
    }
    const cursor = query.get("cursor");
    const sequences = cursor ? [1] : [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
    if (cursor) expect(cursor).toBe("history-page-2");
    await route.fulfill({
      json: {
        items: sequences.map((sequenceNumber) => ({
          id: `history-${sequenceNumber}`,
          sequenceNumber,
          status: "succeeded",
          kind: "standard",
          totalRuns: 1,
          succeededRuns: 1,
          failedRuns: 0,
          timedOutRuns: 0,
          cancelledRuns: 0,
          currentRound: 1,
          retryLimit: 0,
          scheduledFor: "2026-09-05T00:00:00.000Z",
          createdAt: "2026-09-05T00:00:00.000Z",
          updatedAt: "2026-09-05T00:01:00.000Z",
        })),
        ...(!cursor ? { nextCursor: "history-page-2" } : {}),
      },
    });
  });
  await openHistory.click();
  const history = dialog.getByRole("region", { name: "任务执行历史" });
  await expect(history.getByRole("alert")).toContainText("执行历史暂时不可用");
  await history.getByRole("button", { name: "重试", exact: true }).click();
  await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(10);
  await history.getByRole("button", { name: "下一页" }).click();
  await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(1);
  await expect(history.getByRole("button", { name: "下一页" })).toBeDisabled();
  await history.getByRole("button", { name: "上一页" }).click();
  await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(10);
  await dialog.getByRole("button", { name: "刷新计划与历史" }).click();
  await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(10);
  await expect(history.getByRole("button", { name: "上一页" })).toBeDisabled();

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`schedule-history-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await expect(openHistory).toBeFocused();
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`schedule-detail-${viewport.width}.png`) });
    await openHistory.click();
    await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(10);
  }
  await page.keyboard.press("Escape");
  await page.unroute(historyUrl);

  await plan.getByRole("button", { name: "删除计划" }).click();
  await acceptSystemDialog(page, "删除执行计划", "确认删除");
  await expect(page.getByText("执行计划已删除。")).toBeVisible();
  await expect(plan.getByRole("button", { name: "删除计划" })).toHaveCount(0);
  await openHistory.click();
  await expect(dialog).toContainText("尚未配置自动执行计划");
  await expect(dialog).toContainText("暂无执行记录");
  expect(browserErrors).toEqual([]);
});

test("task schedule dialog keeps read permissions separate from execution history and management", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const projectVersionId = await ensureDefaultProjectVersion(page);
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId: DEFAULT_PROJECT_ID, projectVersionId, name: uniqueName("read-only-plan") },
  });
  expect(suite.status).toBe(201);
  for (const canReadExecutions of [false, true]) {
    const username = uniqueName(canReadExecutions ? "history-reader" : "plan-reader");
    const password = "ScheduleReader!Password123";
    const role = await browserJson<{ id: string }>(page, "/api/v1/roles", {
      method: "POST",
      body: {
        key: username,
        name: username,
        scope: "project",
        permissions: ["case_suite.read", ...(canReadExecutions ? ["run.read"] : [])],
      },
    });
    expect(role.status).toBe(201);
    const user = await browserJson<{ id: string }>(page, "/api/v1/users", {
      method: "POST",
      body: { username, displayName: username, password, forcePasswordChange: false },
    });
    expect(user.status).toBe(201);
    expect(
      (
        await browserJson(page, `/api/v1/users/${user.body.id}/project-roles`, {
          method: "POST",
          body: { projectId: DEFAULT_PROJECT_ID, roleId: role.body.id },
        })
      ).status,
    ).toBe(204);
    const readerContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { width: 1024, height: 768 },
    });
    try {
      const readerPage = await readerContext.newPage();
      await readerPage.goto("/login");
      await login(readerPage, username, password);
      // History readers pass through /run-batches before its client redirect completes.
      await expect(readerPage).toHaveURL(
        canReadExecutions ? /\/execution-records(?:\?|$)/u : /\/account\/security(?:\?|$)/u,
      );
      await expect(readerPage.getByRole("navigation", { name: "主导航" })).toBeVisible();
      await readerPage.goto(`/case-suites/${suite.body.id}`);
      const plan = readerPage.getByRole("region", { name: "任务执行计划" });
      await expect(plan.getByRole("button", { name: "保存计划" })).toHaveCount(0);
      await plan.getByRole("button", { name: "执行历史与计划", exact: true }).click();
      const dialog = readerPage.getByRole("dialog", { name: "执行历史与计划", exact: true });
      await expect(dialog).toContainText("尚未配置自动执行计划");
      if (canReadExecutions) await expect(dialog).toContainText("暂无执行记录");
      else {
        await expect(dialog).toContainText("当前账号无执行记录查看权限");
        await expect(dialog.getByRole("region", { name: "任务执行历史" })).toHaveCount(0);
      }
      await expectUiIntegrity(readerPage);
      await readerPage.screenshot({
        path: testInfo.outputPath(`schedule-reader-${canReadExecutions ? "history" : "plan"}.png`),
      });
      const endpoint = `/api/v1/case-suites/${suite.body.id}/schedule`;
      expect(
        (
          await browserJson(readerPage, endpoint, {
            method: "PUT",
            body: {
              cronExpression: "0 9 * * *",
              timeZone: "Asia/Shanghai",
              enabled: true,
              missedRunPolicy: "skip",
            },
          })
        ).status,
      ).toBe(403);
      expect((await browserJson(readerPage, endpoint, { method: "DELETE" })).status).toBe(403);
      const history = await browserJson(
        readerPage,
        `/api/v1/case-suites/${suite.body.id}/executions?projectId=${DEFAULT_PROJECT_ID}&projectVersionId=${projectVersionId}`,
      );
      expect(history.status).toBe(canReadExecutions ? 200 : 403);
    } finally {
      await readerContext.close();
    }
  }
});

test("project webhooks support custom POST bodies and task binding", async ({ page }) => {
  const receivedBodies: string[] = [];
  const callbackHost = process.env.E2E_WEBHOOK_CALLBACK_HOST ?? "127.0.0.1";
  const webhookServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    webhookServer.once("error", reject);
    webhookServer.listen(0, "0.0.0.0", resolve);
  });
  const address = webhookServer.address();
  if (!address || typeof address === "string") throw new Error("Webhook test server did not bind.");
  try {
    await ensureAdministrator(page);
    const projectVersionId = await ensureDefaultProjectVersion(page);
    const webhookName = uniqueName("quality-webhook");
    const suiteName = uniqueName("webhook-suite");
    const configuration = await browserJson<{ id: string; method: string }>(
      page,
      "/api/v1/webhooks",
      {
        method: "POST",
        body: {
          projectId: DEFAULT_PROJECT_ID,
          name: webhookName,
          description: "Webhook E2E",
          targetUrl: `http://${callbackHost}:${address.port}/autoforge-completed`,
          method: "POST",
          bodyTemplate:
            '{"batchId":"{{batch.id}}","suite":"{{batch.suiteName}}","status":"{{batch.displayStatus}}","passRate":"{{summary.passRate}}"}',
          enabled: true,
        },
      },
    );
    expect(configuration.status).toBe(201);
    expect(configuration.body.method).toBe("POST");
    const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
      method: "POST",
      body: {
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId,
        name: suiteName,
        description: "Webhook binding E2E",
      },
    });
    expect(suite.status).toBe(201);

    await page.goto("/settings/webhooks");
    const endpointCard = page.locator(".webhook-endpoint-card", { hasText: webhookName });
    await expect(endpointCard).toBeVisible();
    await expect(endpointCard).toContainText("POST");
    await expect(endpointCard).toContainText("已启用");
    await endpointCard.getByRole("button", { name: "测试" }).click();
    await expect(page.getByText(/测试成功.*HTTP 204.*预置通过率 80%/)).toBeVisible();
    await expect.poll(() => receivedBodies.length).toBe(1);
    expect(JSON.parse(receivedBodies[0]!)).toMatchObject({
      batchId: "webhook-test-batch",
      status: "执行完成",
      passRate: "80.0",
    });

    await page.goto(`/case-suites/${suite.body.id}`);
    const bindingCard = page.locator(".case-suite-webhooks-card");
    await expect(bindingCard).toBeVisible();
    const endpointOption = bindingCard.locator("label", { hasText: webhookName });
    await endpointOption.locator('input[type="checkbox"]').check();
    await bindingCard.getByRole("button", { name: "保存通知绑定" }).click();
    await expect(page.locator(".toast-card", { hasText: "Webhook 绑定已保存。" })).toBeVisible();

    const bindings = await browserJson<{ webhookIds: string[] }>(
      page,
      `/api/v1/case-suites/${suite.body.id}/webhooks`,
    );
    expect(bindings.status).toBe(200);
    expect(bindings.body.webhookIds).toContain(configuration.body.id);

    await page.goto("/settings/webhooks");
    await endpointCard.getByRole("button", { name: "编辑" }).click();
    const editor = page.getByRole("dialog", { name: "编辑 Webhook" });
    await expect(editor.getByLabel("JSON 请求体模板")).toContainText("batch.displayStatus");
    await page.keyboard.press("Escape");
  } finally {
    await new Promise<void>((resolve, reject) =>
      webhookServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function ensureDefaultProjectVersion(page: Page): Promise<string> {
  const structure = await browserJson<{
    versions: Array<{ id: string; status: "active" | "archived" }>;
  }>(page, `/api/v1/projects/${DEFAULT_PROJECT_ID}/structure`);
  const activeVersion = structure.body.versions.find((version) => version.status === "active");
  if (activeVersion) return activeVersion.id;
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("management-version") } },
  );
  expect(version.status).toBe(201);
  return version.body.id;
}
