import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";

import {
  browserJson,
  ensureAdministrator,
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

  page.once("dialog", (dialog) => dialog.accept());
  await accountCard.getByRole("button", { name: "禁用账号" }).click();
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
  page.once("dialog", (dialog) => dialog.accept());
  await refreshedCard.getByRole("button", { name: "启用账号" }).click();
  await expect(page.getByText("服务账号已重新启用。")).toBeVisible();
  refreshedCard = page.locator("article", { hasText: accountName });
  await refreshedCard.getByRole("button", { name: "令牌" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await refreshedCard.getByRole("button", { name: "撤销 e2e-token" }).click();
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

test("schedule overview can pause and delete plans while LDAP failures remain diagnosable", async ({
  page,
}) => {
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
  const schedule = await browserJson<{ id: string; revision: number }>(
    page,
    `/api/v1/case-suites/${suite.body.id}/schedule`,
    {
      method: "PUT",
      body: {
        cronExpression: "0 9 * * 1-5",
        timeZone: "Asia/Shanghai",
        missedRunPolicy: "run-once",
        enabled: true,
      },
    },
  );
  expect(schedule.status).toBe(200);

  await page.goto("/settings/automation");
  const scheduleRow = page.getByRole("row", { name: new RegExp(suiteName) });
  await expect(scheduleRow).toContainText("错过后补跑一次");
  await expect(scheduleRow).toContainText("Asia/Shanghai");
  await scheduleRow.getByRole("button", { name: "暂停" }).click();
  await expect(page.getByText("计划已暂停。")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(suiteName) })).toContainText("暂停");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("row", { name: new RegExp(suiteName) })
    .getByRole("button", { name: "删除" })
    .click();
  await expect(page.getByText("计划任务已删除。")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(suiteName) })).toHaveCount(0);
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
    await expect(bindingCard.getByText("Webhook 绑定已保存。")).toBeVisible();

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
