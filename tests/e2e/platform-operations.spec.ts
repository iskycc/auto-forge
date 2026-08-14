import { expect, test } from "@playwright/test";

import { appAlert, ensureAdministrator } from "./support/session";

test("configuration conflicts, diagnostics and retention controls remain observable", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const concurrentPage = await page.context().newPage();
  await Promise.all([page.goto("/settings/platform"), concurrentPage.goto("/settings/platform")]);

  await page.getByLabel("公开大盘刷新间隔（秒）").fill("6");
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(page.getByText(/平台配置已保存/)).toBeVisible();

  await concurrentPage.getByLabel("公开大盘刷新间隔（秒）").fill("7");
  await concurrentPage.getByRole("button", { name: "保存平台配置" }).click();
  await expect(appAlert(concurrentPage)).toContainText(/刷新|修订|其他操作|重新加载/);

  await page.getByLabel("公开大盘刷新间隔（秒）").fill("8");
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(page.getByText(/平台配置已保存/)).toBeVisible();
  await concurrentPage.close();

  await page.getByRole("link", { name: "系统诊断" }).click();
  await expect(page.getByRole("heading", { name: "系统诊断" })).toBeVisible();
  await expect(page.locator(".diagnostic-summary")).toContainText(/LITE|FULL/);
  await page.getByRole("button", { name: "刷新诊断" }).click();
  await expect(page.locator(".diagnostic-grid")).toContainText("就绪");
  const diagnostic = await page.request.get("/api/v1/settings/diagnostics?download=1");
  expect(diagnostic.status()).toBe(200);
  expect(diagnostic.headers()["content-disposition"]).toContain("attachment");
  const diagnosticBody = (await diagnostic.json()) as Record<string, unknown>;
  expect(diagnosticBody).not.toHaveProperty("secrets");
  expect(JSON.stringify(diagnosticBody)).not.toContain("adminBootstrapToken");
  expect(JSON.stringify(diagnosticBody)).not.toContain("databaseUrl");

  await page.getByRole("link", { name: "数据保留" }).click();
  const logRetention = page.locator(".retention-policy-grid form").filter({ hasText: "日志" });
  await logRetention.getByRole("button", { name: "影响预览" }).click();
  await expect(logRetention).toContainText(/当前将影响 \d+ 条/);
  await logRetention.getByLabel("保留天数").fill("31");
  await logRetention.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("保留策略已更新。")).toBeVisible();

  await logRetention.getByRole("button", { name: "影响预览" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await logRetention.getByRole("button", { name: "执行清理" }).click();
  await expect(page.getByText(/清理已完成：删除 \d+ 条记录/)).toBeVisible();
  const cleanupAudit = await page.request.get(
    "/api/v1/audit-events?action=retention.execute&limit=10",
  );
  expect(cleanupAudit.status()).toBe(200);
  expect(await cleanupAudit.json()).toMatchObject({
    items: [expect.objectContaining({ action: "retention.execute", resourceId: "log" })],
  });
});
