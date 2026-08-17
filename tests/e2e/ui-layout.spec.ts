import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { ensureAdministrator } from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

const primaryRoutes = [
  "/",
  "/cases",
  "/case-suites",
  "/objects",
  "/run-batches",
  "/runners",
  "/insights",
  "/settings/automation",
  "/audit",
  "/settings/projects?section=members",
  "/settings/projects?section=execution",
  "/settings/access?section=users",
  "/settings/access?section=roles",
  "/settings/access?section=projects",
  "/settings/access?section=ldap",
  "/settings/access?section=sessions",
  "/settings/environments?section=environments",
  "/settings/environments?section=secrets",
  "/settings/platform?section=configuration",
  "/settings/platform?section=accounts",
  "/settings/platform?section=retention",
  "/settings/platform?section=diagnostics",
  "/account/security",
] as const;

test("administration entries are grouped into collapsed two-level navigation", async ({ page }) => {
  await ensureAdministrator(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });

  for (const label of ["项目与权限", "执行与平台"]) {
    await expect(navigation.getByRole("button", { name: label, exact: true })).toHaveCount(1);
  }
  // Groups start collapsed, so nested administration links are not rendered.
  for (const label of [
    "运维审计",
    "项目管理",
    "用户管理",
    "角色权限",
    "项目角色",
    "目录配置",
    "登录会话",
    "执行环境",
    "密文管理",
    "平台配置",
    "服务账号",
    "数据保留",
    "系统诊断",
  ]) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveCount(0);
  }

  // Expanding a group reveals its entries and keeps the chevron state readable.
  const accessToggle = navigation.getByRole("button", { name: "项目与权限" });
  await accessToggle.click();
  await expect(accessToggle).toHaveAttribute("aria-expanded", "true");
  for (const label of ["项目管理", "用户管理", "角色权限", "项目角色", "目录配置", "登录会话"]) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveCount(1);
  }
  await accessToggle.click();
  await expect(accessToggle).toHaveAttribute("aria-expanded", "false");

  // The group owning the current route expands automatically.
  await page.goto("/settings/access?section=roles");
  await expect(page.getByRole("heading", { name: "角色与权限", exact: true })).toBeVisible();
  await expect(accessToggle).toHaveAttribute("aria-expanded", "true");
  await expect(navigation.getByRole("link", { name: "角色权限", exact: true })).toHaveCount(1);
  await expect(page.locator(".settings-stack > .settings-section")).toHaveCount(1);

  await page.goto("/settings/platform?section=retention");
  const platformToggle = navigation.getByRole("button", { name: "执行与平台" });
  await expect(platformToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: "数据保留", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "保留与清理策略" })).toBeVisible();
});

test("primary product and administration routes pass the shared layout guard", async ({ page }) => {
  test.setTimeout(300_000);
  await ensureAdministrator(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const viewport of [
    { width: 1536, height: 1024 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    for (const route of primaryRoutes) {
      await page.goto(route);
      await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
      await expectUiIntegrity(page);
      await captureUi(page, route, viewport.width);
    }
  }
});

test("specified dense pages expose stable product controls", async ({ page }) => {
  await ensureAdministrator(page);

  await page.goto("/case-suites");
  await expect(page.locator('select[name="projectId"]')).toHaveCount(0);
  await page.locator(".project-picker-trigger").click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: "默认项目" }).click();

  await page.goto("/objects");
  await expect(page.locator(".source-filter-panel")).toBeVisible();

  await page.goto("/insights");
  await expect(page.locator(".insight-metric-success")).toContainText("成功率");
  await expect(page.locator(".insight-metric-danger")).toContainText("失败率");

  await page.goto("/runners");
  await expect(page.getByRole("heading", { name: "执行机列表" })).toBeVisible();

  await page.goto("/settings/projects?section=execution");
  await expect(page.getByRole("heading", { name: "项目执行配置" })).toBeVisible();
  await expect(page.locator(".project-structure-manager")).toBeVisible();
});

async function captureUi(page: Page, route: string, width: number): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  const name =
    route
      .replace(/^\//, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "home";
  await page.screenshot({
    path: resolve(screenshotDirectory, `${width}-${name}.png`),
    fullPage: true,
  });
}
