import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";

const primaryRoutes = [
  "/",
  "/cases",
  "/case-suites",
  "/objects",
  "/execution-records",
  "/runners",
  "/runners?section=groups",
  "/insights",
  "/settings/automation",
  "/audit",
  "/settings/projects?section=members",
  "/settings/projects?section=execution",
  "/settings/access?section=users",
  "/settings/access?section=roles",
  "/settings/access?section=ldap",
  "/settings/access?section=sessions",
  "/settings/platform?section=configuration",
  "/settings/platform?section=accounts",
  "/settings/platform?section=retention",
  "/settings/platform?section=diagnostics",
  "/account/security",
] as const;

test("administration entries are grouped into focused two-level navigation", async ({ page }) => {
  await ensureAdministrator(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });

  for (const label of ["项目协作", "身份权限", "执行配置", "平台运维"]) {
    await expect(navigation.getByRole("button", { name: label, exact: true })).toHaveCount(1);
  }
  // Groups start collapsed, so nested administration links are not rendered.
  for (const label of ["安全审计", "项目管理", "访问管理", "运维计划", "执行机组", "平台设置"]) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveCount(0);
  }

  // Expanding a group reveals its entries and keeps the chevron state readable.
  const accessToggle = navigation.getByRole("button", { name: "身份权限" });
  await accessToggle.click();
  await expect(accessToggle).toHaveAttribute("aria-expanded", "true");
  await expect(navigation.getByRole("link", { name: "访问管理", exact: true })).toHaveCount(1);
  await accessToggle.click();
  await expect(accessToggle).toHaveAttribute("aria-expanded", "false");

  // The group owning the current route expands automatically.
  await page.goto("/settings/access?section=roles");
  await expect(page.getByRole("heading", { name: "角色与权限", exact: true })).toBeVisible();
  await expect(accessToggle).toHaveAttribute("aria-expanded", "true");
  await expect(navigation.getByRole("link", { name: "访问管理", exact: true })).toHaveCount(1);
  await expect(page.locator(".settings-stack > .settings-section")).toHaveCount(1);

  await page.goto("/settings/platform?section=retention");
  const platformToggle = navigation.getByRole("button", { name: "平台运维" });
  await expect(platformToggle).toHaveAttribute("aria-expanded", "true");
  await expect(navigation.getByRole("link", { name: "平台设置", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "数据保留", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "保留与清理策略" })).toBeVisible();
});

test("top-bar project context persists across pages and removes local project switchers", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("global-project");
  const projectName = `全局项目 ${suffix}`;
  const created = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: projectName, slug: suffix },
  });
  expect(created.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID);

  await page.goto("/cases?projectId=stale-project&cursor=stale-cursor");
  const switcher = page.locator(".global-project-switcher");
  await switcher.locator(".project-picker-trigger").click();
  const switched = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/v1/selected-project",
  );
  await page.getByRole("option", { name: projectName }).click();
  expect((await switched).status()).toBe(200);
  await expect(switcher).toContainText(projectName);
  await expect(page).not.toHaveURL(/projectId|cursor/u);

  for (const route of ["/", "/case-suites", "/execution-records", "/cases/import"]) {
    await page.goto(route);
    await expect(page.locator(".global-project-switcher")).toContainText(projectName);
    await expect(page.locator('select[name="projectId"]')).toHaveCount(0);
  }
  await expect(page.getByLabel("导入项目")).toHaveCount(0);
});

test("homepage mirrors the designed six-card workspace and exposes global execution", async ({
  page,
}) => {
  await ensureAdministrator(page);
  for (const heading of ["本周质量", "活动执行", "用例库", "执行机组", "失败洞察", "最近动态"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "开始执行", exact: true })).toBeVisible();

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
    { width: 2560, height: 1440 },
    { width: 3840, height: 2160 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const dashboard = await page.locator(".dashboard-page").boundingBox();
    const sidebar = await page.locator(".sidebar").boundingBox();
    expect(dashboard).not.toBeNull();
    expect(sidebar).not.toBeNull();
    const availableWidth = viewport.width - sidebar!.width;
    // 4K 下工作台仍应占据主内容区至少 85%，不能退化成居中的窄小卡片岛。
    expect(dashboard!.width).toBeGreaterThanOrEqual(availableWidth * 0.85);
    if (viewport.width === 1024) {
      const failureCard = await page.locator(".design-failure-card").boundingBox();
      expect(failureCard).not.toBeNull();
      // 最小桌面视口下失败洞察独占一行，不能在右侧留下一个空 Bento 网格位。
      expect(failureCard!.width).toBeGreaterThanOrEqual(dashboard!.width * 0.9);
    }
    await expectUiIntegrity(page);
    await captureUi(page, "/", viewport.width);
  }

  await page.goto("/cases");
  await expect(page.getByRole("button", { name: "开始执行", exact: true })).toBeVisible();
});

test("global execution dialog covers and centers within the whole viewport", async ({ page }) => {
  await ensureAdministrator(page);
  await page.goto("/cases");

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    const backdrop = page.locator("body > .global-run-backdrop");
    const dialog = page.getByRole("dialog", { name: "开始执行" });
    await expect(backdrop).toBeVisible();
    await expect(dialog).toBeVisible();

    const [backdropBox, dialogBox] = await Promise.all([
      backdrop.boundingBox(),
      dialog.boundingBox(),
    ]);
    expect(backdropBox).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    expect(dialogBox).not.toBeNull();
    expect(Math.abs(dialogBox!.x + dialogBox!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(
      1,
    );
    expect(
      Math.abs(dialogBox!.y + dialogBox!.height / 2 - viewport.height / 2),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() =>
        document.elementFromPoint(8, 8)?.classList.contains("global-run-backdrop"),
      ),
    ).toBe(true);
    await captureUi(page, "/global-run-dialog", viewport.width);

    await page.keyboard.press("Escape");
    await expect(backdrop).toHaveCount(0);
  }
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
  await expect(page.getByRole("heading", { name: "TestNG JAR" })).toBeVisible();
  await expect(page.locator('select[name="projectId"]')).toHaveCount(0);

  await page.goto("/insights");
  await expect(page.locator(".insight-metric-success")).toContainText("方法通过率");
  await expect(page.locator(".insight-metric-danger")).toContainText("方法失败率");
  await page.setViewportSize({ width: 1536, height: 1024 });
  const trendCard = page.locator(".insight-trend-card");
  const failureCard = page.locator(".insight-failure-card");
  const flakyCard = page.locator(".insight-flaky-card");
  const [trendBox, failureBox, flakyBox] = await Promise.all([
    trendCard.boundingBox(),
    failureCard.boundingBox(),
    flakyCard.boundingBox(),
  ]);
  expect(trendBox?.y).toBe(failureBox?.y);
  expect(flakyBox!.y).toBeGreaterThan(Math.max(trendBox!.y, failureBox!.y));

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
