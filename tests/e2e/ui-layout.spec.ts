import { expect, test, type Page } from "@playwright/test";

import { ensureAdministrator } from "./support/session";

test("dense workspaces keep product controls, tabs and desktop layout stable", async ({ page }) => {
  await ensureAdministrator(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.goto("/case-suites");
  await expect(page.locator('select[name="projectId"]')).toHaveCount(0);
  await page.locator(".project-picker-trigger").click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: "默认项目" }).click();

  await page.goto("/audit");
  await expect(page.getByRole("navigation", { name: "运维与审计" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByText("安全审计")).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: "运维与审计" })).toHaveClass(/nav-item-active/);
  await expectGridRow(page, ".audit-filter-panel label", 4);

  await page.goto("/insights");
  await expect(page.locator(".insight-primary-filters label")).toHaveCount(4);
  await expect(page.locator(".insight-advanced-filters")).not.toHaveAttribute("open");
  await page.getByText("更多筛选条件", { exact: true }).click();
  await expect(page.locator(".insight-advanced-filters")).toHaveAttribute("open", "");

  await page.goto("/settings/access?section=users");
  await expect(page.getByRole("navigation", { name: "管理中心模块" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "身份与访问模块" })).toBeVisible();
  await expect(page.locator(".settings-stack > .settings-section")).toHaveCount(1);
  await page.getByRole("link", { name: "角色与权限" }).click();
  await expect(page).toHaveURL(/section=roles/);
  await expect(page.getByRole("heading", { name: "角色与权限分层" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "用户管理" })).toHaveCount(0);

  await page.goto("/settings/platform?section=configuration");
  await expect(page.getByRole("heading", { name: "服务账号与 API 令牌" })).toHaveCount(0);
  await page.getByRole("link", { name: "服务账号" }).click();
  await expect(page.getByRole("heading", { name: "服务账号与 API 令牌" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "保留与清理策略" })).toHaveCount(0);
  await page.getByRole("link", { name: "数据保留" }).click();
  await expect(page.getByRole("heading", { name: "保留与清理策略" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "服务账号与 API 令牌" })).toHaveCount(0);
  await page.getByRole("link", { name: "系统诊断" }).click();
  await expect(page.getByRole("heading", { name: "系统诊断" })).toBeVisible();

  for (const path of ["/audit", "/insights", "/settings/access?section=roles"]) {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path.replace("?", "\\?")));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);
  }
});

async function expectGridRow(page: Page, selector: string, expectedItems: number): Promise<void> {
  const topPositions = await page
    .locator(selector)
    .evaluateAll(
      (elements, itemCount) =>
        elements
          .slice(0, itemCount)
          .map((element) => Math.round(element.getBoundingClientRect().top)),
      expectedItems,
    );
  expect(new Set(topPositions).size).toBe(1);
}
