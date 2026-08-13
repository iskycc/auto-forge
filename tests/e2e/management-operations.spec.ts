import { expect, test } from "@playwright/test";

import { browserJson, ensureAdministrator, uniqueName } from "./support/session";

test("service account lifecycle immediately narrows token access and produces exportable audit", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const accountName = uniqueName("release-automation");
  await page.goto("/settings/platform");
  const createForm = page.locator("form", {
    has: page.getByRole("button", { name: "创建服务账号" }),
  });
  await createForm.getByLabel("账号名称").fill(accountName);
  await createForm.getByLabel("用途说明").fill("E2E service account lifecycle");
  await createForm.locator('select[name="permissions"]').selectOption(["case.read", "audit.read"]);
  const projectPermissionSelect = createForm.locator('select[name^="projectPermissions:"]').first();
  if ((await projectPermissionSelect.count()) > 0) {
    await projectPermissionSelect.selectOption(["run.read"]);
  }
  const accountResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/v1/service-accounts"),
  );
  await createForm.getByRole("button", { name: "创建服务账号" }).click();
  const account = (await (await accountResponse).json()) as { id: string };
  const accountCard = page.locator("article", { hasText: accountName });
  await expect(accountCard).toContainText("active");

  const tokenForm = accountCard.locator("form", {
    has: page.getByRole("button", { name: "签发" }),
  });
  await tokenForm.getByLabel("令牌名称").fill("e2e-token");
  await tokenForm
    .getByLabel("过期时间")
    .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  await tokenForm.getByLabel("作用域").selectOption(["case.read", "audit.read"]);
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
  await editor.locator('select[name="permissions"]').selectOption(["audit.read"]);
  await editor.locator('select[name^="projectPermissions:"]').evaluateAll((selects) => {
    for (const select of selects) {
      for (const option of Array.from((select as HTMLSelectElement).options))
        option.selected = false;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
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
  await replacementForm.getByLabel("作用域").selectOption(["audit.read"]);
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

test("schedule overview can pause plans and LDAP failures remain diagnosable and retryable", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const suiteName = uniqueName("scheduled-suite");
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { name: suiteName, description: "Schedule operations E2E" },
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

  const failedLdap = await browserJson<{ error?: { code?: string } }>(
    page,
    "/api/v1/ldap/synchronize",
    { method: "POST" },
  );
  expect(failedLdap.status).toBeGreaterThanOrEqual(400);

  await page.goto("/settings/automation");
  const scheduleRow = page.getByRole("row", { name: new RegExp(suiteName) });
  await expect(scheduleRow).toContainText("错过后补跑一次");
  await expect(scheduleRow).toContainText("Asia/Shanghai");
  await scheduleRow.getByRole("button", { name: "暂停" }).click();
  await expect(page.getByText("计划已暂停。")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(suiteName) })).toContainText("暂停");
  await expect(page.getByRole("heading", { name: "LDAP 同步历史" })).toBeVisible();
  await expect(page.getByText(/LDAP_.*|LDAP/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "立即同步 / 重试" })).toBeVisible();
});
