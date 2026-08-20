import { expect, test } from "@playwright/test";

import { ensureAdministrator } from "./support/session";

const restartPhase = process.env.E2E_PLATFORM_RESTART_PHASE ?? "verify";
if (restartPhase !== "seed" && restartPhase !== "verify") {
  throw new Error(`Unsupported platform restart phase: ${restartPhase}`);
}

test(`platform restart persistence · ${restartPhase}`, async ({ page }) => {
  await ensureAdministrator(page);
  await page.goto("/settings/platform");

  if (restartPhase === "seed") {
    await page.getByLabel("公开大盘刷新间隔（秒）").fill("8");
    await page.getByRole("button", { name: "保存平台配置" }).click();
    await expect(page.getByText(/平台配置已保存/)).toBeVisible();

    await page.goto("/settings/platform?section=retention");
    const logRetention = page.locator(".retention-policy-grid form").filter({ hasText: "日志" });
    await logRetention.getByLabel("保留天数").fill("31");
    await logRetention.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("保留策略已更新。")).toBeVisible();
    return;
  }

  await expect(page.getByLabel("公开大盘刷新间隔（秒）")).toHaveValue("8");
  await page.goto("/settings/platform?section=retention");
  const logRetention = page.locator(".retention-policy-grid form").filter({ hasText: "日志" });
  await expect(logRetention.getByLabel("保留天数")).toHaveValue("31");
  await page.goto("/settings/platform?section=diagnostics");
  await expect(page.locator(".diagnostic-summary")).toContainText(/LITE|FULL/);
});
