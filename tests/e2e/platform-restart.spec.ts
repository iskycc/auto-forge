import { expect, test } from "@playwright/test";

import { ensureAdministrator } from "./support/session";

test("persisted platform and retention settings survive a production restart", async ({ page }) => {
  await ensureAdministrator(page);
  await page.goto("/settings/platform");
  await expect(page.getByLabel("公开大盘刷新间隔（秒）")).toHaveValue("8");
  const logRetention = page.locator(".retention-policy-grid form").filter({ hasText: "日志" });
  await expect(logRetention.getByLabel("保留天数")).toHaveValue("31");
  await expect(page.locator(".diagnostic-summary")).toContainText(/LITE|FULL/);
});
