import { expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expectUiIntegrity } from "./ui-guard";

export async function expectLogCaseDetail(
  page: Page,
  expectedPath: string,
  expectedHeading: string,
  screenshotPrefix?: string,
): Promise<void> {
  const originalUrl = page.url();
  const link = page.getByRole("link", { name: "用例详情", exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", expectedPath);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const popup = page.waitForEvent("popup");
  await link.click();
  const details = await popup;
  try {
    await expect(
      details.getByRole("heading", { name: expectedHeading, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(details.getByRole("heading", { name: "全部执行历史", exact: true })).toBeVisible();
    await expect(details.locator(".case-execution-history tbody tr").first()).toBeVisible();
    await expect(details.locator(".case-execution-history")).not.toContainText(
      "当前用例尚无执行记录",
    );
    expect(page.url()).toBe(originalUrl);
    if (!screenshotPrefix) return;
    const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 960 },
    ]) {
      await details.setViewportSize(viewport);
      await expectUiIntegrity(details);
      await details.screenshot({
        path: resolve(directory, `${screenshotPrefix}-${viewport.width}.png`),
        animations: "disabled",
      });
    }
  } finally {
    await details.close();
  }
}
