import { expect, test, type Locator, type Page } from "@playwright/test";
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

test("administration entries are exposed as four-character first-level navigation", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });

  for (const label of [
    "项目管理",
    "访问管理",
    "运维计划",
    "执行机组",
    "安全审计",
    "平台设置",
    "文件来源",
  ]) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(navigation.getByRole("button")).toHaveCount(0);
  await expect(navigation.locator(".nav-item-nested, .nav-group")).toHaveCount(0);

  await page.goto("/settings/access?section=roles");
  await expect(page.getByRole("heading", { name: "角色与权限", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "访问管理", exact: true })).toHaveClass(
    /nav-item-active/u,
  );
  await expect(page.locator(".settings-stack > .settings-section")).toHaveCount(1);

  await page.goto("/settings/platform?section=retention");
  await expect(navigation.getByRole("link", { name: "平台设置", exact: true })).toHaveClass(
    /nav-item-active/u,
  );
  await expect(page.getByRole("heading", { name: "数据保留", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "保留与清理策略" })).toBeVisible();

  await page.goto("/settings/automation");
  const automationPage = page.getByRole("main");
  await expect(automationPage.getByRole("link", { name: "平台配置", exact: true })).toHaveCount(0);
  await expect(automationPage.getByRole("link", { name: "LDAP 配置", exact: true })).toHaveCount(0);
});

test("audit findings use bounded, localized, and unambiguous controls", async ({ page }) => {
  await ensureAdministrator(page);

  await page.goto("/settings/platform?section=configuration");
  const deploymentMode = page.getByLabel("部署模式");
  await expect(deploymentMode).toContainText(/Lite|Full/u);
  await expect(deploymentMode.locator("select")).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("/opt/auto-forge/");

  await page.goto("/settings/access?section=ldap");
  const ldapEnabled = page.getByLabel("启用 LDAP 登录");
  if (!(await ldapEnabled.isChecked())) {
    await expect(page.getByLabel("Bind DN")).toBeDisabled();
    const testConnection = page.getByRole("button", { name: "测试连接" });
    await expect(testConnection).toBeDisabled();
    await expect(testConnection).toHaveCSS("background-color", "rgb(240, 240, 243)");
    await ldapEnabled.check();
    await expect(page.getByLabel("Bind DN")).toBeEnabled();
  }

  await page.goto("/audit");
  await expect(page.getByRole("navigation", { name: "运维审计" })).toHaveCount(0);
  await expect(page.getByLabel("操作者")).toHaveAttribute("list", "audit-actor-options");

  await page.goto("/runners");
  await expect(page.getByRole("navigation", { name: "执行资源视图" })).toHaveCount(0);

  await page.goto("/case-suites");
  await page.getByRole("button", { name: "创建任务" }).click();
  const suiteDialog = page.getByRole("dialog", { name: "创建用例任务" });
  await expect(suiteDialog.getByText("TestNG Suite Name")).toHaveCount(0);
  await suiteDialog.getByLabel("使用 CoTest TestNG Adapter").check();
  await expect(suiteDialog.getByText("TestNG Suite Name")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/route-that-does-not-exist");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回工作概览" })).toBeVisible();
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
  const firstVersion = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${created.body.id}/versions`,
    { method: "POST", body: { name: "1.0.0" } },
  );
  expect(firstVersion.status).toBe(201);
  const firstStage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${created.body.id}/versions/${firstVersion.body.id}/stages`,
    { method: "POST", body: { name: "系统测试", description: "第一层级" } },
  );
  expect(firstStage.status).toBe(201);
  const secondVersion = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${created.body.id}/versions`,
    { method: "POST", body: { name: "2.0.0" } },
  );
  expect(secondVersion.status).toBe(201);
  const secondStage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${created.body.id}/versions/${secondVersion.body.id}/stages`,
    { method: "POST", body: { name: "回归测试", description: "第二层级" } },
  );
  expect(secondStage.status).toBe(201);
  const alternateStage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${created.body.id}/versions/${secondVersion.body.id}/stages`,
    { method: "POST", body: { name: "灰度验证", description: "手工切换目标" } },
  );
  expect(alternateStage.status).toBe(201);
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
  await expect(switcher).toContainText("1.0.0");
  await expect(switcher).toContainText("系统测试");
  await expect(page).not.toHaveURL(/projectId|cursor/u);

  await switcher.getByRole("button", { name: "当前项目版本" }).click();
  const versionSwitched = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/v1/selected-project",
  );
  await page.getByRole("option", { name: "2.0.0", exact: true }).click();
  expect((await versionSwitched).status()).toBe(200);
  await expect(switcher).toContainText("2.0.0");
  await expect(switcher).toContainText("回归测试");

  await switcher.getByRole("button", { name: "当前测试阶段" }).click();
  const stageSwitched = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/v1/selected-project",
  );
  await page.getByRole("option", { name: "灰度验证", exact: true }).click();
  expect((await stageSwitched).status()).toBe(200);
  await expect(switcher).toContainText("灰度验证");

  for (const route of ["/", "/case-suites", "/execution-records", "/cases/import"]) {
    await page.goto(route);
    await expect(page.locator(".global-project-switcher")).toContainText(projectName);
    await expect(page.locator(".global-project-switcher")).toContainText("2.0.0");
    await expect(page.locator(".global-project-switcher")).toContainText("灰度验证");
    await expect(page.locator('select[name="projectId"]')).toHaveCount(0);
  }
  await expect(page.getByLabel("导入项目")).toHaveCount(0);
  await expect(page.locator(".import-card .ui-select")).toHaveCount(0);
  await expect(page.getByLabel("JAR 导入目标层级")).toContainText("2.0.0");
  await expect(page.getByLabel("JAR 导入目标层级")).toContainText("灰度验证");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await page.goto("/cases/import");
    await expectUiIntegrity(page);
    await captureUi(page, "/global-project-hierarchy", width);
  }
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
    { width: 1536, height: 1024 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    const backdrop = page.locator("body > .global-run-backdrop");
    const dialog = page.getByRole("dialog", { name: "开始执行" });
    await expect(backdrop).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".global-run-loading")).toHaveCount(0);

    await expectViewportDialog(backdrop, dialog, viewport);
    expect(
      await page.evaluate(() =>
        document.elementFromPoint(8, 8)?.classList.contains("global-run-backdrop"),
      ),
    ).toBe(true);
    await captureUi(page, "/global-run-dialog-suite", viewport.width, false);

    await dialog.getByRole("button", { name: "单个用例", exact: true }).click();
    const adapterToggle = dialog.getByLabel("使用 CoTest TestNG Adapter");
    await expect(adapterToggle).toBeChecked();
    await expect(dialog.getByText("单用例参数覆盖")).toHaveCount(0);
    await expect(dialog.locator('[name="parameters"]')).toHaveCount(0);
    await dialog.locator(".global-run-form").evaluate((form) => {
      form.scrollTop = form.scrollHeight;
    });
    await expect(adapterToggle).toBeInViewport();
    await expectViewportDialog(backdrop, dialog, viewport);
    await captureUi(page, "/global-run-dialog-single-case", viewport.width, false);

    await page.keyboard.press("Escape");
    await expect(backdrop).toHaveCount(0);
  }
});

test("project and user creation stay in centered low-frequency dialogs", async ({ page }) => {
  await ensureAdministrator(page);

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/settings/projects?section=members");
    await expect(page.locator(".project-scope-card > form")).toHaveCount(0);
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    const projectBackdrop = page.locator("body > .action-dialog-backdrop");
    const projectDialog = page.getByRole("dialog", { name: "创建项目" });
    await expect(projectDialog.getByLabel("项目名称")).toBeVisible();
    await expect(projectDialog.getByLabel("Slug")).toBeVisible();
    await expectViewportDialog(projectBackdrop, projectDialog, viewport);
    await captureUi(page, "/project-create-dialog", viewport.width, false);
    await page.keyboard.press("Escape");
    await expect(projectBackdrop).toHaveCount(0);

    await page.goto("/settings/access?section=users");
    await page.getByRole("button", { name: "创建用户", exact: true }).click();
    const userBackdrop = page.locator("body > .action-dialog-backdrop");
    const userDialog = page.getByRole("dialog", { name: "创建本地用户" });
    await expect(userDialog.getByLabel("用户名", { exact: true })).toBeVisible();
    await expect(userDialog.getByLabel("显示名称", { exact: true })).toBeVisible();
    await expect(userDialog.getByLabel("初始密码")).toBeVisible();
    await expectViewportDialog(userBackdrop, userDialog, viewport);
    await captureUi(page, "/user-create-dialog", viewport.width, false);
    await page.keyboard.press("Escape");
    await expect(userBackdrop).toHaveCount(0);
  }
});

test("remaining low-frequency management actions expose reviewable dialogs", async ({ page }) => {
  await ensureAdministrator(page);
  const viewport = { width: 1024, height: 768 };
  await page.setViewportSize(viewport);

  const dialogStates: Array<{
    route: string;
    trigger: string;
    dialog: string;
    screenshot: string;
    bottomAction?: string;
  }> = [
    {
      route: "/case-suites",
      trigger: "创建任务",
      dialog: "创建用例任务",
      screenshot: "suite-create-dialog",
      bottomAction: "创建任务",
    },
    {
      route: "/runners?section=groups",
      trigger: "创建机组",
      dialog: "新建执行机组",
      screenshot: "runner-group-create-dialog",
    },
    {
      route: "/settings/projects?section=members",
      trigger: "添加成员",
      dialog: "添加项目成员",
      screenshot: "project-member-dialog",
    },
    {
      route: "/settings/projects?section=members",
      trigger: "转移负责",
      dialog: "转移项目负责人",
      screenshot: "project-owner-dialog",
    },
    {
      route: "/settings/projects?section=execution",
      trigger: "创建版本",
      dialog: "创建项目版本",
      screenshot: "project-version-dialog",
    },
    {
      route: "/settings/projects?section=execution",
      trigger: "创建阶段",
      dialog: "创建测试阶段",
      screenshot: "test-stage-dialog",
    },
    {
      route: "/settings/access?section=users",
      trigger: "重置密码",
      dialog: "重置用户密码",
      screenshot: "user-password-dialog",
    },
    {
      route: "/settings/access?section=roles",
      trigger: "分配角色",
      dialog: "分配用户角色",
      screenshot: "role-assignment-dialog",
    },
    {
      route: "/settings/access?section=roles",
      trigger: "创建角色",
      dialog: "创建自定义角色",
      screenshot: "role-create-dialog",
    },
    {
      route: "/settings/platform?section=accounts",
      trigger: "创建账号",
      dialog: "创建服务账号",
      screenshot: "service-account-create-dialog",
      bottomAction: "创建服务账号",
    },
  ];

  for (const state of dialogStates) {
    await page.goto(state.route);
    await page.getByRole("button", { name: state.trigger, exact: true }).click();
    const backdrop = page.locator("body > .action-dialog-backdrop");
    const dialog = page.getByRole("dialog", { name: state.dialog });
    await expect(dialog).toBeVisible();
    await expectViewportDialog(backdrop, dialog, viewport);
    await captureUi(page, `/${state.screenshot}`, viewport.width, false);
    if (state.bottomAction) {
      await dialog.locator(".action-dialog-body").evaluate((body) => {
        body.scrollTop = body.scrollHeight;
      });
      await expect(
        dialog.getByRole("button", { name: state.bottomAction, exact: true }),
      ).toBeInViewport();
      await captureUi(page, `/${state.screenshot}-bottom`, viewport.width, false);
    }
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
  const metrics = page.locator(".insight-metrics");
  const caseOutcomeCard = page.locator(".insight-case-outcome-card");
  const [trendBox, failureBox, flakyBox, metricsBox, caseOutcomeBox] = await Promise.all([
    trendCard.boundingBox(),
    failureCard.boundingBox(),
    flakyCard.boundingBox(),
    metrics.boundingBox(),
    caseOutcomeCard.boundingBox(),
  ]);
  expect(trendBox?.y).toBe(failureBox?.y);
  expect(flakyBox!.y).toBeGreaterThan(Math.max(trendBox!.y, failureBox!.y));
  expect(flakyBox?.y).toBe(caseOutcomeBox?.y);
  expect(metricsBox!.y).toBeLessThan(caseOutcomeBox!.y);
  expect(trendBox!.y).toBeLessThan(caseOutcomeBox!.y);

  await trendCard.getByRole("button", { name: "查看明细" }).click();
  const trendDialog = page.getByRole("dialog", { name: "每日趋势明细" });
  await expect(trendDialog).toBeVisible();
  await expect(trendDialog.locator(".insight-data-table")).toBeVisible();
  const [dialogBox, tableScrollBox, tableOverflow] = await Promise.all([
    trendDialog.boundingBox(),
    trendDialog.locator(".insight-detail-table-scroll").boundingBox(),
    trendDialog.locator(".insight-detail-table-scroll").evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      overflowY: getComputedStyle(element).overflowY,
    })),
  ]);
  expect(dialogBox!.width).toBeLessThanOrEqual(1536 - 40);
  expect(dialogBox!.height).toBeLessThanOrEqual(1024 - 40);
  expect(tableScrollBox!.height).toBeLessThan(dialogBox!.height);
  expect(tableOverflow).toEqual({ overflowX: "auto", overflowY: "auto" });
  await trendDialog.getByRole("button", { name: "关闭每日趋势明细" }).click();
  await expect(trendDialog).toHaveCount(0);

  await page.setViewportSize({ width: 1024, height: 768 });
  const [compactTrendBox, compactFailureBox, compactFlakyBox, compactCaseOutcomeBox, pageHeight] =
    await Promise.all([
      trendCard.boundingBox(),
      failureCard.boundingBox(),
      flakyCard.boundingBox(),
      caseOutcomeCard.boundingBox(),
      page.evaluate(() => document.documentElement.scrollHeight),
    ]);
  expect(compactTrendBox?.y).toBe(compactFailureBox?.y);
  expect(compactFlakyBox?.y).toBe(compactCaseOutcomeBox?.y);
  expect(pageHeight).toBeLessThan(2_200);

  await page.goto("/runners");
  await expect(page.getByRole("heading", { name: "执行机列表" })).toBeVisible();

  await page.goto("/settings/projects?section=execution");
  await expect(page.getByRole("heading", { name: "项目执行配置" })).toBeVisible();
  await expect(page.locator(".project-structure-manager")).toBeVisible();
});

async function captureUi(page: Page, route: string, width: number, fullPage = true): Promise<void> {
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
    fullPage,
  });
}

async function expectViewportDialog(
  backdrop: Locator,
  dialog: Locator,
  viewport: { width: number; height: number },
): Promise<void> {
  const [backdropBox, dialogBox] = await Promise.all([
    backdrop.boundingBox(),
    dialog.boundingBox(),
  ]);
  expect(backdropBox).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  expect(dialogBox).not.toBeNull();
  expect(Math.abs(dialogBox!.x + dialogBox!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(dialogBox!.y + dialogBox!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(
    1,
  );
}
