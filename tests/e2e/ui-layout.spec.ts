import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { selectJarForInspection } from "./support/jar-import";
import { insertSuiteProgressFixture } from "./support/suite-progress-fixture";

import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectReadableText, expectUiIntegrity, inspectUiIntegrity } from "./support/ui-guard";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";

const primaryRoutes = [
  "/",
  "/cases",
  "/cases/import",
  "/cases?tab=ddt&ddtView=cases",
  "/cases?tab=ddt&ddtView=templates",
  "/cases?tab=ddt&ddtView=search",
  "/cases?tab=ddt&ddtView=api",
  "/case-suites",
  "/objects",
  "/execution-records",
  "/runners",
  "/runners?section=groups",
  "/insights",
  "/case-analysis",
  "/settings/webhooks",
  "/audit",
  "/settings/access?section=users&scope=project",
  "/settings/projects",
  "/settings/access?section=users",
  "/settings/access?section=roles",
  "/settings/access?section=ldap",
  "/settings/access?section=sessions",
  "/settings/platform?section=configuration",
  "/settings/platform?section=accounts",
  "/settings/platform?section=retention",
  "/settings/platform?section=diagnostics",
  "/settings/platform?section=storage",
  "/account/security",
] as const;

test("management actions wait for hydration and respond to the first click", async ({ page }) => {
  await ensureAdministrator(page);
  let releaseScripts: () => void = () => undefined;
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route("**/_next/static/**/*.js", async (route) => {
    await scriptsReady;
    await route.continue();
  });
  const createUser = page.getByRole("button", { name: "创建用户", exact: true });
  try {
    await page.goto("/settings/access?section=users", { waitUntil: "commit" });
    await expect(createUser).toBeVisible();
    await expect(createUser).toBeDisabled();
    await expect(page.getByRole("tab", { name: "目录配置" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  } finally {
    releaseScripts();
  }
  await createUser.click();
  await expect(page.getByRole("dialog", { name: "创建本地用户" })).toBeVisible();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await captureUi(page, "/hydrated-user-dialog", width, false);
  }
  await page.getByRole("button", { name: "关闭创建本地用户", exact: true }).click();
  await page.getByRole("link", { name: "目录配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "LDAP 目录", exact: true })).toBeVisible();
});

test("LDAP form waits for hydration before accepting the first checkbox change", async ({
  page,
}) => {
  await ensureAdministrator(page);
  let releaseScripts: () => void = () => undefined;
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route("**/_next/static/**/*.js", async (route) => {
    await scriptsReady;
    await route.continue();
  });
  const enabled = page.getByLabel("启用 LDAP 登录");
  try {
    await page.goto("/settings/access?section=ldap", { waitUntil: "commit" });
    await expect(enabled).toBeVisible();
    await expect(enabled).toBeDisabled();
  } finally {
    releaseScripts();
  }
  await enabled.check();
  await expect(enabled).toBeChecked();
  await expect(page.locator('input[name="url"]')).toBeEditable();
});

test("multiline notifications keep separate click targets at desktop widths", async ({ page }) => {
  await ensureAdministrator(page);
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: `layout-notification-${index}`,
    kind: "batch.completed",
    severity: "info",
    title: `执行批次已完成 ${index + 1}`,
    message: "这是一条包含较长任务名称与执行说明的通知，用于检查多行内容是否挤压相邻通知。".repeat(
      2,
    ),
    createdAt: "2026-09-23T00:00:00Z",
    readAt: null,
  }));
  await page.route("**/api/v1/notifications?**", (route) =>
    route.fulfill({ json: { items, nextCursor: null } }),
  );
  await page.route("**/api/v1/notifications/*/read", (route) => route.fulfill({ status: 204 }));
  await page.goto("/runners");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await page.getByRole("button", { name: /^(通知|\d+ 条未读通知)$/u }).click();
    const notifications = page.locator(".notification-item");
    await expect(notifications).toHaveCount(3);
    const overflow = await notifications.evaluateAll(
      (buttons) =>
        buttons.filter((button) => {
          const bounds = button.getBoundingClientRect();
          return Array.from(button.querySelectorAll("strong, small, time")).some((text) => {
            const content = text.getBoundingClientRect();
            return content.top < bounds.top - 1 || content.bottom > bounds.bottom + 1;
          });
        }).length,
    );
    expect(overflow, "notification text must stay inside its own click target").toBe(0);
    await notifications.nth(1).click({ timeout: 5000 });
    await expect(notifications.nth(1)).toHaveClass(/\bread\b/u);
    await expectUiIntegrity(page);
    await captureUi(page, "/multiline-notifications", width, false);
    await page.getByRole("button", { name: "关闭通知", exact: true }).click();
  }
});

test("native-backed filters keep accessible names, keyboard selection and form values", async ({
  page,
}) => {
  await ensureAdministrator(page);
  await page.goto("/audit");
  const category = page.getByRole("combobox", { name: "审计分类", exact: true });
  const nativeCategory = page.locator('select[name="category"]');
  const option = await nativeCategory
    .locator("option")
    .nth(1)
    .evaluate((element) => ({
      value: (element as HTMLOptionElement).value,
      label: element.textContent ?? "",
    }));
  await category.focus();
  await page.keyboard.press("Space");
  const menuOption = page.getByRole("option", { name: option.label, exact: true });
  await expect(menuOption).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(nativeCategory).toHaveValue(option.value);
  await expect(category).toBeFocused();
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`category=${option.value}`));
  await expect(page.locator(".ui-select", { has: category })).toContainText(option.label);
  await page.getByRole("link", { name: "清空筛选", exact: true }).click();
  await expect(nativeCategory).toHaveValue("");
  await expect(page.locator(".ui-select", { has: category })).toContainText("全部分类");

  await page.getByText("人员与时间筛选", { exact: true }).click();
  const startsAt = page.getByRole("textbox", { name: "开始时间", exact: true });
  await startsAt.fill("2026/09/01 09:30");
  await expect(page.locator(".ant-picker-content th")).toHaveText([
    "一",
    "二",
    "三",
    "四",
    "五",
    "六",
    "日",
  ]);
  await expect(page.locator(".ant-picker-month-btn")).toHaveText("9月");
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await captureUi(page, "date-picker", viewport.width, false);
  }
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.locator('input[name="recordedAfter"]')).toHaveValue("2026-09-01T09:30");
  await page
    .locator("form.audit-filter-panel")
    .evaluate((form) => (form as HTMLFormElement).reset());
  await expect(startsAt).toHaveValue("");
  await expect(page.locator('input[name="recordedAfter"]')).toHaveValue("");
  await startsAt.fill("2026/09/02 11:45");
  await page
    .locator("form.audit-filter-panel")
    .evaluate((form) => (form as HTMLFormElement).reset());
  await expect(startsAt).toHaveValue("");
  const search = page.getByLabel("搜索审计记录");
  await search.fill("尚未提交的筛选");
  await nativeCategory.selectOption(option.value);
  await page
    .locator("form.audit-filter-panel")
    .evaluate((form) => (form as HTMLFormElement).reset());
  await expect(search).toHaveValue("");
  await expect(nativeCategory).toHaveValue("");
  await expect(page.locator(".ui-select", { has: category })).toContainText("全部分类");
});

test("layout guard distinguishes floating actions from overlapping controls on the same surface", async ({
  page,
}) => {
  await page.setContent(`
    <style>
      body { margin: 0; min-height: 100vh; font: 14px sans-serif; }
      input, button { box-sizing: border-box; height: 36px; width: 160px; font: inherit; }
      input { position: absolute; left: 24px; bottom: 24px; }
      footer { position: fixed; bottom: 0; left: 0; right: 0; height: 84px; background: white; z-index: 2; }
      button { position: absolute; left: 24px; bottom: 24px; }
      button + button { left: 200px; }
    </style>
    <input aria-label="Scrolling field" />
    <footer><button>Save</button><button>Cancel</button></footer>
  `);
  await expectUiIntegrity(page);
  await page.getByRole("button", { name: "Save", exact: true }).click({ trial: true });

  await page.getByRole("button", { name: "Cancel", exact: true }).evaluate((button) => {
    button.style.left = "24px";
  });
  expect((await inspectUiIntegrity(page)).overlapViolations).toEqual([
    expect.objectContaining({ element: "button + button", label: "Save / Cancel" }),
  ]);

  await page.getByRole("button", { name: "Cancel", exact: true }).evaluate((button) => {
    button.style.left = "200px";
  });
  await page.locator("footer").evaluate((footer) => {
    footer.style.position = "absolute";
  });
  expect((await inspectUiIntegrity(page)).overlapViolations).toEqual([
    expect.objectContaining({ element: "input + button" }),
  ]);

  await page.locator("footer").evaluate((footer) => {
    footer.style.position = "fixed";
  });
  await page.getByLabel("Scrolling field").evaluate((input) => {
    const separateSurface = document.createElement("aside");
    separateSurface.style.cssText = "position: fixed; inset: 0; z-index: 1";
    input.before(separateSurface);
    separateSurface.append(input);
  });
  expect((await inspectUiIntegrity(page)).overlapViolations).toEqual([
    expect.objectContaining({ element: "input + button" }),
  ]);
});

test("administration entries are exposed as four-character first-level navigation", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });

  for (const label of ["组织管理", "回调通知", "执行机组", "安全审计", "平台设置", "文件来源"]) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(navigation.getByRole("button")).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: /^(项目管理|访问管理)$/ })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "运维计划", exact: true })).toHaveCount(0);
  await expect(navigation.locator(".nav-item-nested, .nav-group")).toHaveCount(0);

  await page.goto("/settings/access?section=roles");
  await expect(page.getByRole("heading", { name: "角色与权限", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "组织管理", exact: true })).toHaveClass(
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
  await expect(page).toHaveURL(/\/case-suites(?:\?|$)/u);
  await expect(page.getByRole("heading", { name: "用例任务", exact: true })).toBeVisible();
});

test("project member filters stay below stable section tabs", async ({ page }) => {
  await ensureAdministrator(page);
  const scope = await createUiProject(page);
  const memberName = uniqueName("tab-member");
  const member = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: {
      username: memberName,
      displayName: memberName,
      password: "UiMember!12345",
      forcePasswordChange: false,
    },
  });
  expect(member.status).toBe(201);
  const assigned = await browserJson(page, `/api/v1/users/${member.body.id}/project-roles`, {
    method: "POST",
    body: { projectId: scope.projectId, roleId: "00000000-0000-7000-8100-000000000005" },
  });
  expect(assigned.status).toBe(204);
  const tabs = page.getByRole("navigation", { name: "组织管理模块" });
  const memberSearch = page.getByLabel("搜索用户");

  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/settings/projects?section=members");
    await expect(memberSearch).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: memberName })).toBeVisible();
    await expectUiIntegrity(page);
    await captureUi(page, "project-members-search", width);
    const initialTabs = (await tabs.boundingBox())!;
    const searchBox = (await memberSearch.boundingBox())!;
    expect(searchBox.y).toBeGreaterThanOrEqual(initialTabs.y + initialTabs.height);

    await tabs.getByRole("link", { name: "角色权限", exact: true }).click();
    await expect(tabs.getByRole("link", { name: "角色权限", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(memberSearch).not.toBeVisible();
    await expectUiIntegrity(page);
    const executionTabs = (await tabs.boundingBox())!;
    expect(Math.abs(executionTabs.y - initialTabs.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(executionTabs.x - initialTabs.x)).toBeLessThanOrEqual(1);
    await captureUi(page, "project-execution-tabs", width);

    await tabs.getByRole("link", { name: "用户管理", exact: true }).click();
    await page.getByRole("link", { name: "当前项目成员", exact: true }).click();
    await expect(memberSearch).toBeVisible();
    expect(Math.abs((await tabs.boundingBox())!.y - initialTabs.y)).toBeLessThanOrEqual(1);
    await memberSearch.fill("no-matching-project-member");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page).toHaveURL(/section=users&scope=project&query=no-matching-project-member/);
    await expect(page.getByRole("row").filter({ hasText: memberName })).toHaveCount(0);
    await expect(memberSearch).toHaveValue("no-matching-project-member");
    expect(Math.abs((await tabs.boundingBox())!.y - initialTabs.y)).toBeLessThanOrEqual(1);
  }
});

test("many project versions stay compact and configure only the selected version", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const scope = await createUiProject(page);
  for (let index = 1; index <= 24; index += 1) {
    const version = await browserJson<{ id: string }>(
      page,
      `/api/v1/projects/${scope.projectId}/versions`,
      {
        method: "POST",
        body: { name: `版本 ${String(index).padStart(2, "0")} · 钱包支付与跨境结算长期回归验证` },
      },
    );
    expect(version.status).toBe(201);
    expect(
      (
        await browserJson(
          page,
          `/api/v1/projects/${scope.projectId}/versions/${version.body.id}/stages`,
          {
            method: "POST",
            body: { name: `专属阶段 ${index}`, description: "阶段说明与资源配置仅随所选版本展示" },
          },
        )
      ).status,
    ).toBe(201);
  }
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/settings/projects");
    const versions = page.getByRole("complementary", { name: "配置所属版本" });
    await expect(versions.getByRole("button")).toHaveCount(25);
    expect((await versions.boundingBox())!.height).toBeLessThan(620);
    await expect(page.locator(".project-stage-row")).toHaveCount(1);
    await page.getByLabel("搜索项目版本").fill("版本 24");
    await expect(versions.getByRole("button")).toHaveCount(1);
    await versions.getByRole("button").click();
    await expect(page.getByRole("heading", { name: /版本 24/ })).toBeVisible();
    await expect(page.locator(".project-stage-row")).toContainText("专属阶段 24");
    await page.getByLabel("搜索项目版本").fill("");
    await expectUiIntegrity(page);
    await captureUi(page, "organization-many-versions", viewport.width);
    await page.getByLabel("搜索项目版本").fill("没有这个版本");
    await expect(versions.getByText("没有匹配的版本")).toBeVisible();
    // Filtering must not silently change the configuration target.
    await expect(page.getByRole("heading", { name: /版本 24/ })).toBeVisible();
    await page.getByLabel("搜索项目版本").fill("");
    await page.locator(".project-picker-trigger").click();
    const picker = page.locator(".project-picker-options");
    await picker.getByLabel("搜索项目", { exact: true }).fill("ui-selection");
    await expect(picker.getByRole("option").first()).toBeVisible();
    await expectUiIntegrity(page);
    await captureUi(page, "organization-project-search", viewport.width, false);
    await picker.getByLabel("搜索项目", { exact: true }).fill("没有匹配的项目");
    await expect(picker.getByRole("option")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".project-picker-trigger")).toBeFocused();
  }
  // Changing the global version resets the configuration view to that version.
  await page.getByRole("button", { name: "当前项目版本", exact: true }).click();
  await page
    .getByRole("option", { name: "版本 23 · 钱包支付与跨境结算长期回归验证", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: /版本 23/ })).toBeVisible();
  await expect(page.locator(".project-stage-row")).toContainText("专属阶段 23");
  await page.getByText("登记内网资源链接", { exact: true }).click();
  const resourceForm = page.locator("form", {
    has: page.getByRole("button", { name: "登记链接并启用", exact: true }),
  });
  await resourceForm
    .getByLabel("资源类型")
    .and(resourceForm.locator("select"))
    .selectOption("jar-bundle");
  await resourceForm.getByLabel("压缩格式").and(resourceForm.locator("select")).selectOption("zip");
  await resourceForm.getByLabel("HTTP(S) 链接").fill("http://runtime.invalid/dependencies.zip");
  await resourceForm.getByLabel("文件名").fill("dependencies-for-version-23.zip");
  await resourceForm.getByLabel("SHA-256").fill("a".repeat(64));
  await resourceForm.getByLabel("大小（字节）").fill("128");
  let releaseSave!: () => void;
  const saving = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/adapter-configuration", async (route) => {
    await saving;
    await route.continue();
  });
  try {
    const request = page.waitForRequest(
      (request) => request.method() === "PUT" && request.url().endsWith("/adapter-configuration"),
    );
    await resourceForm.getByRole("button", { name: "登记链接并启用", exact: true }).click();
    await request;
    await expect(page.getByRole("button", { name: /版本 24.*个阶段/ })).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(
    page.getByText("运行时资源链接已登记并设为当前配置。", { exact: true }),
  ).toBeVisible();
  await page.unroute("**/adapter-configuration");
  await page.getByRole("button", { name: /版本 24.*个阶段/ }).click();
  const runtimeSummary = page.locator(".project-version-detail .settings-note");
  await expect(runtimeSummary).not.toContainText("dependencies-for-version-23.zip");
  await page.getByRole("button", { name: /版本 23.*个阶段/ }).click();
  await expect(runtimeSummary).toContainText("dependencies-for-version-23.zip");
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, "organization-configured-version", viewport.width);
  }
});

test("project settings preserve long project names and slugs within the administration bar", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const name = "跨境钱包支付与结算长期回归验证项目".repeat(7).slice(0, 120);
  const slug = uniqueName("long-project").padEnd(64, "x");
  await createUiProject(page, { name, slug });
  await page.goto("/settings/projects");
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await captureUi(page, "project-long-identifiers", viewport.width);
    const summary = page.locator(".project-administration-summary");
    const bounds = await summary.evaluate((element) => ({
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
    }));
    expect(bounds.contentWidth).toBeLessThanOrEqual(bounds.width + 2);
    expect((await summary.locator("strong").boundingBox())!.width).toBeGreaterThan(80);
    await expect(summary).toContainText(slug);
    await expectUiIntegrity(page);
  }
});

test("topbar hierarchy selectors support keyboard opening, searching and focus restoration", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const scope = await createUiProject(page);
  expect(
    (
      await browserJson(page, `/api/v1/projects/${scope.projectId}/versions`, {
        method: "POST",
        body: { name: "另一个验证版本" },
      })
    ).status,
  ).toBe(201);
  await page.goto("/settings/projects");
  const trigger = page.getByRole("button", { name: "当前项目版本", exact: true });
  const listbox = page.getByRole("listbox", { name: "项目版本列表", exact: true });
  const contextSwitchRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/v1/selected-project"
    ) {
      contextSwitchRequests.push(request.url());
    }
  });
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await trigger.focus();
    await trigger.press("ArrowDown");
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole("option", { name: "UI 验证版本", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(
      listbox.getByRole("option", { name: "另一个验证版本", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(listbox).toHaveCount(0);

    await trigger.press("Enter");
    const search = page.locator(".project-picker-options").getByLabel("搜索项目版本");
    await search.fill("UI 验证");
    await search.press("ArrowUp");
    await expect(listbox.getByRole("option")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(listbox).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(contextSwitchRequests).toEqual([]);
    await captureUi(page, "topbar-keyboard-selection", viewport.width, false);
  }
});

test("unified role scope selector exposes both system and project filters", async ({ page }) => {
  await ensureAdministrator(page);
  await page.goto("/settings/access?section=roles");
  const scope = page.getByRole("combobox", { name: "角色范围", exact: true });
  const systemRole = page.locator(".role-card").filter({ hasText: "system-admin" });
  const projectRole = page.locator(".role-card").filter({ hasText: "project-admin" });
  await expect(page.locator(".ui-select").filter({ has: scope })).toContainText("全部范围");
  await scope.click();
  await page.getByRole("option", { name: "系统", exact: true }).click();
  await expect(systemRole).toBeVisible();
  await expect(projectRole).toHaveCount(0);
  await scope.click();
  await page.getByRole("option", { name: "项目", exact: true }).click();
  await expect(projectRole).toBeVisible();
  await expect(systemRole).toHaveCount(0);
  await scope.click();
  await page.getByRole("option", { name: "全部范围", exact: true }).click();
  await expect(systemRole).toBeVisible();
  await expect(projectRole).toBeVisible();
});

test("audit findings use bounded, localized, and unambiguous controls", async ({ page }) => {
  await ensureAdministrator(page);

  await page.goto("/settings/platform?section=configuration");
  const deploymentMode = page.getByLabel("部署模式");
  await expect(deploymentMode).toContainText(/Lite|Full/u);
  await expect(deploymentMode.locator("select")).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("/opt/auto-forge/");

  await page.goto("/settings/access?section=ldap");
  if (!(await page.getByLabel("启用 LDAP 登录").isChecked())) {
    await expect(page.getByLabel("Group Search Base（可选）")).toBeHidden();
    await page.getByLabel("启用 LDAP 登录").check();
  }
  await expect(page.getByLabel("Group Search Base（可选）")).toBeVisible();
  await expect(page.getByText("Group 仅保存到用户档案", { exact: true })).toBeVisible();
  await expect(page.getByText("不会根据 Group 创建或修改任何权限绑定")).toBeVisible();
  await expect(page.getByRole("button", { name: /添加组映射|立即同步目录/ })).toHaveCount(0);
  const ldapEnabled = page.getByLabel("启用 LDAP 登录");
  if (!(await ldapEnabled.isChecked())) {
    await expect(page.getByLabel("Bind DN（可选）")).toBeDisabled();
    const testConnection = page.getByRole("button", { name: "测试连接" });
    await expect(testConnection).toBeDisabled();
    await expect(testConnection).toHaveCSS("opacity", "0.5");
    await ldapEnabled.check();
    await expect(page.getByLabel("Bind DN（可选）")).toBeEnabled();
  }
  const verifyTlsCertificate = page.getByLabel("校验 TLS 服务器证书");
  if (!(await verifyTlsCertificate.isChecked())) await verifyTlsCertificate.check();
  await verifyTlsCertificate.uncheck();
  await expect(page.getByText("中间人攻击风险", { exact: false })).toBeVisible();
  await page.getByLabel("Bind DN（可选）").fill("cn=service,dc=example,dc=test");
  await page.getByLabel("Bind 密码", { exact: true }).fill("Directory!Password123");
  await page.getByLabel("用户 Base DN").fill("ou=people,dc=example,dc=test");
  await page.getByLabel("用户过滤器").fill("(&(objectClass=person)(uid={{username}}))");
  await page.getByRole("button", { name: "保存 LDAP 配置" }).click();
  await expect(page.getByText("LDAP 配置已加密保存。")).toBeVisible();
  await expect(page.getByLabel("校验 TLS 服务器证书")).not.toBeChecked();

  await page.goto("/audit");
  await expect(page.getByRole("navigation", { name: "运维审计" })).toHaveCount(0);
  await page.getByText("人员与时间筛选", { exact: true }).click();
  await expect(page.locator('select[name="actorId"]')).toBeAttached();
  await expect(page.getByLabel("搜索审计记录")).toBeVisible();

  await page.goto("/runners");
  await expect(page.getByRole("navigation", { name: "执行资源视图" })).toHaveCount(0);
  await expect(page.getByLabel("执行机 IP / 主机名")).toHaveCount(0);
  await page.getByRole("button", { name: "打开自动安装" }).click();
  const installerDialog = page.getByRole("dialog", { name: "自动安装执行机 Agent" });
  await expect(installerDialog.getByLabel("执行机 IP / 主机名")).toBeVisible();
  await expectUiIntegrity(page);
  await page.keyboard.press("Escape");
  await expect(installerDialog).toHaveCount(0);

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
  // The picker updates optimistically; wait until the refreshed case page uses the new scope.
  await expect(page.getByLabel("当前用例层级")).toContainText("2.0.0");
  await expect(page.getByLabel("当前用例层级")).toContainText("回归测试");

  await switcher.getByRole("button", { name: "当前测试阶段" }).click();
  const stageSwitched = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/v1/selected-project",
  );
  await page.getByRole("option", { name: "灰度验证", exact: true }).click();
  expect((await stageSwitched).status()).toBe(200);
  await expect(switcher).toContainText("灰度验证");
  await expect(page.getByLabel("当前用例层级")).toContainText("灰度验证");

  await expect(page.getByText("当前项目层级还没有用例")).toBeVisible();
  const emptyCard = page.locator(".case-library-empty-card");
  await expect(emptyCard).toBeVisible();
  // Snapshot publication can replace the visible card between visibility and measurement.
  await expect
    .poll(() => emptyCard.evaluateAll((cards) => cards[0]?.getBoundingClientRect().height ?? 0))
    .toBeGreaterThanOrEqual(320);

  await page.goto("/settings/projects?section=execution");
  await expect(page.getByRole("complementary", { name: "配置所属版本" })).toBeVisible();
  await expect(page.locator(".project-version-option")).toHaveCount(2);
  await expect(page.locator(".project-stage-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /2.0.0.*个阶段/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "继承用例" })).toBeVisible();

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

test("topbar creates project, version and stage and retries selection without duplicate creation", async ({
  page,
}) => {
  await ensureAdministrator(page);
  await selectProjectContext(page, DEFAULT_PROJECT_ID);
  await page.goto("/settings/access?section=users");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.getByRole("link", { name: "组织管理", exact: true })).toHaveAttribute(
    "href",
    "/settings/access?section=users",
  );
  await expect(
    page
      .getByRole("navigation", { name: "组织管理模块" })
      .getByRole("link", { name: "项目与版本", exact: true }),
  ).toHaveCount(0);
  const navigationEntriesBefore = await page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  const suffix = uniqueName("topbar-project");
  const projectName = `顶栏项目 ${suffix}`;
  const switcher = page.locator(".global-project-switcher");
  const scopes = [
    {
      kind: "project",
      trigger: ".project-picker-trigger",
      label: "项目",
      nameLabel: "项目名称",
      name: projectName,
    },
    {
      kind: "version",
      trigger: '[aria-label="当前项目版本"]',
      label: "项目版本",
      nameLabel: "版本名称",
      name: "1.0.0-topbar",
    },
    {
      kind: "stage",
      trigger: '[aria-label="当前测试阶段"]',
      label: "测试阶段",
      nameLabel: "阶段名称",
      name: "顶栏回归测试",
    },
  ];
  let createProjectRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/projects")
      createProjectRequests += 1;
  });
  for (const scope of scopes) {
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await switcher.locator(scope.trigger).click();
      await expectUiIntegrity(page);
      await captureUi(page, `topbar-${scope.kind}-actions`, viewport.width, false);
      await page.getByRole("button", { name: `新建${scope.label}`, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `新建${scope.label}`, exact: true });
      await expectViewportDialog(
        page.locator(".ant-modal-wrap.action-dialog-backdrop"),
        dialog,
        viewport,
      );
      if (scope.kind !== "project") await expect(dialog).toContainText(projectName);
      if (scope.kind === "stage") await expect(dialog).toContainText("1.0.0-topbar");
      await captureUi(page, `topbar-${scope.kind}-create`, viewport.width, false);
      await page.keyboard.press("Escape");
    }
    await switcher.locator(scope.trigger).click();
    await page.getByRole("button", { name: `新建${scope.label}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `新建${scope.label}`, exact: true });
    await dialog.getByLabel(scope.nameLabel, { exact: true }).fill(scope.name);
    if (scope.kind === "project") {
      await dialog.getByLabel("Slug", { exact: true }).fill(suffix);
      await page.route(
        "**/api/v1/selected-project",
        (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "PLATFORM_BUSY", message: "切换暂时不可用" } }),
          }),
        { times: 1 },
      );
    }
    if (scope.kind === "stage")
      await dialog.getByLabel("阶段说明").fill("直接在顶栏创建的测试阶段");
    await dialog.getByRole("button", { name: `新建${scope.label}`, exact: true }).click();
    if (scope.kind === "project") {
      await expect(dialog.getByRole("alert")).toContainText("项目已创建，但切换失败");
      await dialog.getByRole("button", { name: "切换到新建项目", exact: true }).click();
    }
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".toast-card")).toContainText(`${scope.label}已创建并切换。`);
    await expect(switcher.locator(scope.trigger)).toContainText(scope.name);
    if (scope.kind === "project") {
      expect(createProjectRequests).toBe(1);
      await expect(
        switcher.getByRole("button", { name: "当前项目版本", exact: true }),
      ).toBeEnabled();
      await expect(
        switcher.getByRole("button", { name: "当前测试阶段", exact: true }),
      ).toBeDisabled();
    }
  }
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(
    navigationEntriesBefore,
  );
  await switcher.getByRole("button", { name: "当前项目版本", exact: true }).click();
  await page.getByRole("link", { name: "执行资源配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目设置", exact: true })).toBeVisible();
  await expect(page.locator(".project-stage-row")).toContainText("顶栏回归测试");
  await expect(
    page
      .locator("main")
      .getByRole("button", { name: /创建项目|创建版本|创建阶段|新建项目|新建测试阶段/ }),
  ).toHaveCount(0);
});

test("homepage mirrors the designed six-card workspace and exposes global execution", async ({
  page,
}) => {
  await ensureAdministrator(page);
  await expect(page.getByRole("navigation", { name: "工作台快捷入口" })).toBeVisible();
  await expect(page.locator(".dashboard-date")).toBeVisible();
  await expect(page.locator('[aria-label="关键状态"] .dashboard-pulse')).toHaveCount(4);
  await expect(page.locator(".dashboard-focus")).toBeVisible();
  for (const heading of ["本周质量", "活动执行", "用例库", "执行机组", "失败洞察", "最近动态"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.locator(".quality-outcome-distribution")).toBeVisible();
  await expect(page.locator(".dashboard-library-overview")).toBeVisible();
  await expect(page.locator(".runner-capacity-overview")).toBeVisible();
  await expect(page.locator(".failure-action-strip")).toBeVisible();
  await expect(page.locator(".activity-summary-strip")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始执行", exact: true })).toBeVisible();

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
    { width: 2560, height: 1440 },
    { width: 3840, height: 2160 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const dashboardPage = page.locator(".dashboard-page");
    const sidebarRegion = page.locator(".sidebar");
    await expect(dashboardPage).toBeVisible();
    await expect(sidebarRegion).toBeVisible();
    await expect(page.locator(".dashboard-focus")).toBeVisible();
    await expect(page.locator('[aria-label="关键状态"] .dashboard-pulse')).toHaveCount(4);
    for (const donut of await page.locator(".failure-donut, .active-run-donut").all()) {
      const innerHole = await donut.evaluate((element) => {
        const style = getComputedStyle(element, "::after");
        const diameter = Math.min(parseFloat(style.width), parseFloat(style.height));
        const cornerRadii = [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomLeftRadius,
          style.borderBottomRightRadius,
        ].map((radius) =>
          radius.endsWith("%") ? (parseFloat(radius) / 100) * diameter : parseFloat(radius),
        );
        return { diameter, minimumRadius: Math.min(...cornerRadii) };
      });
      expect(
        innerHole.minimumRadius,
        "中心数字背景应为圆形，不能挡住圆环的四个斜角",
      ).toBeGreaterThanOrEqual(innerHole.diameter / 2);
    }
    const dashboard = await dashboardPage.boundingBox();
    const sidebar = await sidebarRegion.boundingBox();
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

test("topbar tools remain separate from execution controls across desktop widths", async ({
  page,
}) => {
  let unreadCount = 2;
  await page.route("**/api/v1/notifications/unread-count", (route) =>
    route.fulfill({ json: { count: unreadCount } }),
  );
  await ensureAdministrator(page);
  await expect(page.getByRole("button", { name: "2 条未读通知" })).toBeVisible();
  const unreadBadge = page.locator(".notification-count");
  await expect(unreadBadge).toHaveCSS("border-width", "0px");
  await expect(unreadBadge).toHaveCSS("box-shadow", "none");
  await expectReadableText(unreadBadge);
  for (const width of [1024, 1180, 1181, 1280, 1500, 1501, 1536, 1024]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    const tools = page.locator(".topbar-tools");
    const actions = page.locator(".topbar-actions");
    await expect(tools.getByRole("button", { name: "搜索配置" })).toBeVisible();
    await expect(tools.getByRole("button", { name: /通知$/ })).toBeVisible();
    await expect(actions.getByRole("button", { name: "开始执行", exact: true })).toBeVisible();
    const search = tools.getByRole("search");
    if (await search.isVisible()) {
      const input = await search.getByRole("searchbox").boundingBox();
      expect(
        input?.width,
        "expanded search must leave room to read the query",
      ).toBeGreaterThanOrEqual(80);
    }
    const toolbarGeometry = await tools.evaluate((toolbar) => {
      const bounds = toolbar.getBoundingClientRect();
      return Array.from(toolbar.querySelectorAll(".notification-shell")).map((control) => {
        const controlBounds = control.getBoundingClientRect();
        return {
          left: controlBounds.left - bounds.left,
          right: bounds.right - controlBounds.right,
        };
      });
    });
    for (const control of toolbarGeometry) {
      expect(control.left, "toolbar must reserve space for each icon").toBeGreaterThanOrEqual(0);
      expect(
        control.right,
        "toolbar icons must stay inside their allocated width",
      ).toBeGreaterThanOrEqual(0);
    }
    await expectUiIntegrity(page);
    await captureUi(page, "/topbar-controls", width, false);
  }
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await expect(unreadBadge).toHaveText("2");
    await expect(unreadBadge).toHaveCSS("border-width", "0px");
    await expect(unreadBadge).toHaveCSS("box-shadow", "none");
    await expectReadableText(unreadBadge);
    await expectUiIntegrity(page);
    await captureUi(page, "/topbar-controls-dark", width, false);
  }
  unreadCount = 128;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "128 条未读通知" })).toBeVisible();
  await expect(unreadBadge).toHaveAttribute("title", "128");
  await expect(unreadBadge).toHaveText("128");
  await expectUiIntegrity(page);
  await captureUi(page, "/topbar-controls-three-digit-count", 1536, false);
  unreadCount = 0;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(unreadBadge).toHaveCount(0);
  await expect(page.getByRole("button", { name: "通知", exact: true })).toBeVisible();
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
    const backdrop = page.locator(".ant-modal-wrap.global-run-backdrop");
    const dialog = page.getByRole("dialog", { name: "开始执行" });
    await expect(backdrop).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".global-run-loading")).toHaveCount(0);
    await dialog.getByRole("radio", { name: "用例任务", exact: true }).locator("..").click();

    await expectViewportDialog(backdrop, dialog, viewport);
    expect(
      await page.evaluate(() =>
        document.elementFromPoint(8, 8)?.classList.contains("global-run-backdrop"),
      ),
    ).toBe(true);
    await dialog.getByRole("radio", { name: "倒计时执行", exact: true }).locator("..").click();
    await expect(dialog.getByLabel("倒计时分钟")).toBeVisible();
    await expect(dialog.getByLabel("倒计时秒")).toBeVisible();
    await expect(dialog.locator(".delay-start-panel")).toBeInViewport();
    await captureUi(page, "/global-run-dialog-suite", viewport.width, false);

    await dialog.getByRole("radio", { name: "单个用例", exact: true }).locator("..").click();
    const adapterToggle = dialog.getByLabel("使用 CoTest TestNG Adapter");
    await expect(adapterToggle).toBeChecked();
    await expect(dialog.getByText("单用例参数覆盖")).toHaveCount(0);
    await expect(dialog.locator('[name="parameters"]')).toHaveCount(0);
    await dialog.locator(".global-run-form-content").evaluate((form) => {
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
    await page.goto("/settings/projects");
    await expect(page.locator(".project-administration-bar > form")).toHaveCount(0);
    await page.locator(".project-picker-trigger").click();
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    const projectBackdrop = page.locator(".ant-modal-wrap.action-dialog-backdrop");
    const projectDialog = page.getByRole("dialog", { name: "新建项目" });
    await expect(projectDialog.getByLabel("项目名称")).toBeVisible();
    await expect(projectDialog.getByLabel("Slug")).toBeVisible();
    await expectViewportDialog(projectBackdrop, projectDialog, viewport);
    await captureUi(page, "/project-create-dialog", viewport.width, false);
    await page.keyboard.press("Escape");
    await expect(projectBackdrop).toHaveCount(0);

    await page.goto("/settings/access?section=users&scope=project");
    const administratorRow = page.getByRole("row").filter({ hasText: "E2E Administrator" });
    await administratorRow.getByRole("button", { name: "分配角色" }).click();
    const memberRoleBackdrop = page.locator(".ant-modal-wrap.action-dialog-backdrop");
    const memberRoleDialog = page.getByRole("dialog", {
      name: "分配用户角色",
    });
    await expect(memberRoleDialog.locator(".assigned-role-list")).toContainText("项目管理员");
    await expectViewportDialog(memberRoleBackdrop, memberRoleDialog, viewport);
    await captureUi(page, "/project-member-role-dialog", viewport.width, false);
    await page.keyboard.press("Escape");
    await expect(memberRoleBackdrop).toHaveCount(0);

    await page.goto("/settings/access?section=users");
    await page.getByRole("button", { name: "创建用户", exact: true }).click();
    const userBackdrop = page.locator(".ant-modal-wrap.action-dialog-backdrop");
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
    dropdown?: string;
  }> = [
    {
      route: "/settings/webhooks",
      trigger: "新建 Webhook",
      dialog: "新建 Webhook",
      screenshot: "webhook-create-dialog",
      bottomAction: "创建端点",
    },
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
      dialog: "分配用户角色",
      screenshot: "project-member-dialog",
    },
    {
      route: "/settings/projects",
      trigger: "转移负责",
      dialog: "转移项目负责人",
      screenshot: "project-owner-dialog",
    },
    {
      route: "/settings/projects?section=execution",
      dropdown: "当前项目版本",
      trigger: "新建项目版本",
      dialog: "新建项目版本",
      screenshot: "project-version-dialog",
    },
    {
      route: "/settings/projects?section=execution",
      dropdown: "当前测试阶段",
      trigger: "新建测试阶段",
      dialog: "新建测试阶段",
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
    if (state.dropdown)
      await page.getByRole("button", { name: state.dropdown, exact: true }).click();
    await page.getByRole("button", { name: state.trigger, exact: true }).click();
    const backdrop = page.locator(".ant-modal-wrap.action-dialog-backdrop");
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

test("role cards keep long names and identifiers within desktop layout boundaries", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const roleName = uniqueName("ReleaseValidationRole".repeat(4));
  const created = await browserJson<{ id: string }>(page, "/api/v1/roles", {
    method: "POST",
    body: {
      key: `${uniqueName("layout-role")}-${"x".repeat(30)}`,
      name: roleName,
      scope: "project",
      permissions: ["case_suite.read"],
      description: "LongDescriptionWithoutSpaces".repeat(8),
    },
  });
  expect(created.status).toBe(201);
  await page.goto("/settings/access?section=roles");
  const card = page
    .locator(".role-card")
    .filter({ has: page.getByText(roleName, { exact: true }) });
  await expect(card).toBeVisible();
  for (const width of [1024, 1536, 1920]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    // Card screenshots scroll the document; inspect the page before content passes under its sticky bar.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expectUiIntegrity(page);
    const bounds = await card.evaluate((element) => ({
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
    }));
    expect(bounds.contentWidth).toBeLessThanOrEqual(bounds.width + 2);
    await card.screenshot({ path: testInfo.outputPath(`long-role-${width}.png`) });
  }
});

test("primary product and administration routes pass the shared layout guard", async ({ page }) => {
  test.setTimeout(300_000);
  await ensureAdministrator(page);
  await createUiProject(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const colorMode of ["light", "dark"] as const) {
    if (colorMode === "dark")
      await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    for (const viewport of [
      { width: 1536, height: 1024 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      for (const route of primaryRoutes) {
        await page.goto(route);
        await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
        await expectUiIntegrity(page);
        await expect(page.locator("html")).toHaveAttribute("data-color-mode", colorMode);
        if (route === "/settings/access?section=users") {
          await expectReadableText(page.locator(".ant-menu-item-selected a").first());
          await expectReadableText(page.locator(".ant-tabs-tab-active .ant-tabs-tab-btn").first());
          await expectReadableText(
            page.getByRole("button", { name: "分配角色", exact: true }).first(),
          );
          await expectReadableText(page.getByRole("button", { name: "创建用户", exact: true }));
        }
        await captureUi(page, colorMode === "dark" ? `/dark${route}` : route, viewport.width);
      }
    }
  }
});

test("global dark appearance persists in SSR, login dialogs and public pages without external resources", async ({
  page,
  context,
  browser,
}) => {
  await ensureAdministrator(page);
  await page.goto("about:blank");
  await context.clearCookies();
  await page.goto("/");
  const appearanceToggle = page.getByRole("button", { name: "切换到深色模式", exact: true });
  await expect(appearanceToggle).toBeEnabled();
  await appearanceToggle.focus();
  await appearanceToggle.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(page.getByRole("button", { name: "切换到浅色模式", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "登录控制台", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录控制台", exact: true });
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await expectDarkSurface(page.locator(".ant-modal-container"));
    await expectDarkSurface(dialog.locator(".ant-input").first());
    await captureUi(page, "/dark-login-dialog", viewport.width, false);
  }
  await dialog.getByRole("button", { name: "关闭登录控制台" }).click();
  const offlineRequests: string[] = [];
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== new URL(page.url()).origin) {
      offlineRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  for (const route of ["/share/case/invalid", "/share/run/invalid", "/share/attempt-log/invalid"]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: "链接无效" })).toBeVisible();
    await expect(page.getByRole("button", { name: "切换到浅色模式" })).toBeVisible();
  }
  await page.getByRole("button", { name: "切换到浅色模式" }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "切换到深色模式" })).toBeVisible();
  expect(offlineRequests).toEqual([]);

  const serverRendered = await browser.newContext({ javaScriptEnabled: false });
  try {
    await serverRendered.addCookies([
      { name: "autoforge-color-mode", value: "dark", url: new URL(page.url()).origin },
    ]);
    const firstPaint = await serverRendered.newPage();
    await firstPaint.goto(new URL("/", page.url()).href);
    await expect(firstPaint.locator("html")).toHaveAttribute("data-color-mode", "dark");
    await expect(firstPaint.locator("html")).toHaveCSS("color-scheme", "dark");
    await expectDarkSurface(firstPaint.locator(".public-header").locator("..").first());
  } finally {
    await serverRendered.close();
  }
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  await ensureAdministrator(page);
  await page.goto("/cases");
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await expect(page.getByRole("button", { name: "切换到浅色模式", exact: true })).toBeVisible();
  await page.locator(".project-picker-trigger").click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expectDarkSurface(page.locator(".ant-popover-container"));
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expectUiIntegrity(page);
    await captureUi(page, "/dark-project-picker", width, false);
  }
});

async function expectDarkSurface(surface: Locator) {
  const channels = await surface.evaluate((element) =>
    getComputedStyle(element)
      .backgroundColor.match(/[\d.]+/gu)
      ?.map(Number),
  );
  expect(channels?.length).toBeGreaterThanOrEqual(3);
  expect(channels?.[3] ?? 1).toBe(1);
  expect(Math.max(...channels!.slice(0, 3))).toBeLessThan(100);
}

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
  const flakyFilter = page.locator(".insight-flaky-filter");
  await expect(flakyFilter.getByRole("combobox", { name: "指定任务" })).toBeVisible();
  await flakyFilter.locator('input[name="flakyCompletedAfter"]').fill("2026-08-01T00:00");
  await flakyFilter.locator('input[name="flakyCompletedBefore"]').fill("2026-08-24T23:59");
  await page.route(
    "**/insights?**",
    async (route) => {
      if (route.request().url().includes("flakyCompletedAfter=")) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
      }
      await route.continue();
    },
    { times: 1 },
  );
  const flakySubmit = flakyFilter.locator('button[type="submit"]');
  await expect(flakySubmit).toContainText("筛选不稳定用例");
  const filtering = flakySubmit.click();
  await expect(flakySubmit).toHaveAttribute("aria-busy", "true");
  await expect(flakySubmit).toContainText("正在分析不稳定用例");
  await filtering;
  await expect(page).toHaveURL(/flakyCompletedAfter=.*flakyCompletedBefore=/u);
  await page.unroute("**/insights?**");
  await expect(page.locator(".insight-flaky-scope")).toContainText("2026");
  await page.setViewportSize({ width: 1536, height: 1024 });
  const trendCard = page.locator(".insight-trend-card");
  const failureCard = page.locator(".insight-failure-card");
  const flakyCard = page.locator(".insight-flaky-card");
  const metrics = page.locator(".insight-metrics");
  const caseOutcomeCard = page.locator(".insight-case-outcome-card");
  await Promise.all(
    [trendCard, failureCard, flakyCard, metrics, caseOutcomeCard].map((locator) =>
      expect(locator).toBeVisible(),
    ),
  );
  await expect
    .poll(async () => {
      const boxes = await Promise.all(
        [trendCard, failureCard, flakyCard, metrics, caseOutcomeCard].map((locator) =>
          locator.boundingBox(),
        ),
      );
      return boxes.every((box) => box !== null);
    })
    .toBe(true);
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
      fitsHorizontally: element.scrollWidth <= element.clientWidth,
    })),
  ]);
  expect(dialogBox!.width).toBeLessThanOrEqual(1536 - 24);
  expect(dialogBox!.width).toBeGreaterThanOrEqual(1_300);
  expect(dialogBox!.height).toBeLessThanOrEqual(1024 - 24);
  expect(tableScrollBox!.height).toBeLessThan(dialogBox!.height);
  expect(tableOverflow).toEqual({
    overflowX: "hidden",
    overflowY: "auto",
    fitsHorizontally: true,
  });
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

  const detailButtons = page.getByRole("button", { name: "查看明细" });
  const detailCount = await detailButtons.count();
  for (let index = 0; index < detailCount; index += 1) {
    await detailButtons.nth(index).click();
    const activeDialog = page.getByRole("dialog");
    await expect(activeDialog).toBeVisible();
    const activeDialogBox = await activeDialog.boundingBox();
    expect(activeDialogBox!.x).toBeGreaterThanOrEqual(12);
    expect(activeDialogBox!.x + activeDialogBox!.width).toBeLessThanOrEqual(1012);
    expect(activeDialogBox!.width).toBeGreaterThanOrEqual(980);
    expect(activeDialogBox!.y).toBeGreaterThanOrEqual(12);
    expect(activeDialogBox!.y + activeDialogBox!.height).toBeLessThanOrEqual(756);
    if (index === 2) {
      expect(
        activeDialogBox!.height,
        "empty insight details should fit their content instead of reserving a full-screen table",
      ).toBeLessThanOrEqual(320);
    }
    const scrollAreas = activeDialog.locator(".insight-detail-table-scroll");
    for (let areaIndex = 0; areaIndex < (await scrollAreas.count()); areaIndex += 1) {
      expect(
        await scrollAreas.nth(areaIndex).evaluate((element) => ({
          fitsHorizontally: element.scrollWidth <= element.clientWidth,
          overflowX: getComputedStyle(element).overflowX,
        })),
      ).toEqual({ fitsHorizontally: true, overflowX: "hidden" });
    }
    await captureUi(page, `/insight-detail-${index + 1}`, 1024, false);
    await activeDialog.getByRole("button", { name: /^关闭/ }).click();
    await expect(activeDialog).toHaveCount(0);
  }

  await page.goto("/runners");
  await expect(page.getByRole("heading", { name: "执行机列表" })).toBeVisible();

  await page.goto("/settings/projects?section=execution");
  await expect(page.getByRole("heading", { name: "项目设置" })).toBeVisible();
  await expect(page.locator(".project-structure-manager")).toBeVisible();
});

test("imported case selection keeps counts compact before adding to a task", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const scope = await createUiProject(page);
  const classes = Array.from(
    { length: 8 },
    (_, index) =>
      `com.example.selection.${index === 7 ? "LongCaseName".repeat(12) : `Selection${index}`}Test`,
  );
  const jar = zipSync(
    Object.fromEntries(
      classes.map((className) => [
        `${className.replaceAll(".", "/")}.class`,
        buildClassFile({
          className,
          methods: [{ name: "verify", annotations: [{ type: "Test", values: {} }] }],
        }),
      ]),
    ),
  );
  await page.goto("/cases/import");
  await selectJarForInspection(page, {
    name: "selection-layout.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText(classes[0]!, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
  const suite = await createUiSuite(page, scope, "勾选布局验证任务");
  await page.goto("/cases");
  const pane = page.getByRole("region", { name: "用例目录工作区" });
  const checkbox = page.getByRole("checkbox", { name: "选择当前搜索结果中的全部用例" });
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    const rows = pane.locator(".case-tree-case");
    await expect(rows).toHaveCount(8);
    const rowBounds = await rows.evaluateAll((elements) =>
      elements.map((element) => ({
        height: element.getBoundingClientRect().height,
        overflow: element.scrollWidth - element.clientWidth,
      })),
    );
    const directoryHeights = await pane
      .locator(".case-tree-directory > .ant-collapse > .ant-collapse-item > .ui-disclosure-header")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    await pane.scrollIntoViewIfNeeded();
    await captureUi(page, "/compact-case-tree", viewport.width, false);
    expect(directoryHeights.length).toBeGreaterThan(0);
    expect(Math.max(...directoryHeights)).toBeLessThanOrEqual(32);
    expect(Math.max(...rowBounds.map((row) => row.height))).toBeLessThanOrEqual(40);
    expect(Math.max(...rowBounds.map((row) => row.overflow))).toBeLessThanOrEqual(1);
    await pane.getByRole("button", { name: "快速预览 Selection0Test", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page
        .locator(".case-inspector-header")
        .getByRole("heading", { name: "Selection0Test", exact: true }),
    ).toBeVisible();
    const folder = pane.locator(".case-tree-directory").first();
    const folderCheckbox = folder.getByRole("checkbox", { name: /^选择文件夹 com（/ });
    await folderCheckbox.check();
    await expect(folder).toHaveAttribute("data-open", "true");
    await expect(page.getByRole("status", { name: "已勾选用例的执行统计" })).toContainText(
      "已勾选 8 个用例",
    );
    await folderCheckbox.uncheck();
    await page.getByRole("button", { name: "导入用例", exact: true }).click();
    const importDialog = page.getByRole("dialog", { name: "导入用例", exact: true });
    await importDialog.getByLabel("粘贴用例路径").fill(classes.join("\n"));
    await importDialog.getByRole("button", { name: "解析并预览" }).click();
    await importDialog.getByRole("button", { name: "勾选匹配用例" }).click();
    const stats = page.getByRole("status", { name: "已勾选用例的执行统计" });
    await expect(stats).toContainText("已勾选 8 个用例");
    await expect(stats).toContainText("未执行 8");
    await expect(checkbox).toBeChecked();
    await expect(page.getByRole("button", { name: "加入任务", exact: true })).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`selected-cases-${viewport.width}.png`),
      fullPage: true,
    });
    await expectUiIntegrity(page);
    const [statsBox, treeBox, paneBox] = await Promise.all([
      stats.boundingBox(),
      pane.locator(".case-directory-scroll").boundingBox(),
      pane.boundingBox(),
    ]);
    expect(
      statsBox!.height,
      "selection counts must not stretch into the directory's free space",
    ).toBeLessThan(140);
    expect(treeBox!.height, "case directory remains usable after selection").toBeGreaterThan(160);
    expect(treeBox!.y).toBeGreaterThanOrEqual(statsBox!.y + statsBox!.height - 1);
    expect(treeBox!.y + treeBox!.height).toBeLessThanOrEqual(paneBox!.y + paneBox!.height);
    await checkbox.uncheck();
    await expect(stats).toHaveCount(0);
  }
  expect(
    (await browserJson<{ caseCount: number }>(page, `/api/v1/case-suites/${suite.id}`)).body
      .caseCount,
  ).toBe(0);
  const folderHeader = pane
    .locator(".case-tree-directory .ui-disclosure-header .ant-collapse-title[role='button']")
    .first();
  await folderHeader.focus();
  await expect(folderHeader).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(pane.locator(".case-tree-case")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(pane.locator(".case-tree-case")).toHaveCount(8);
  await pane.getByRole("link", { name: "查看 Selection0Test 详情", exact: true }).click();
  await expect(page).toHaveURL(/\/cases\/[^/?]+$/u);
});

test("execution dialog remembers the last chosen task across reopening, edits and project versions", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const scope = await createUiProject(page);
  const first = await createUiSuite(page, scope, "上次选择的任务");
  const newest = await createUiSuite(page, scope, "随后修改的任务");
  await page.goto("/case-suites");
  const open = () => page.getByRole("button", { name: "开始执行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "开始执行", exact: true });
  const select = dialog.locator('select[aria-label="执行用例任务"]');
  await open();
  await select.selectOption(first.id);
  await dialog.getByRole("button", { name: "关闭执行弹窗" }).click();
  const current = await browserJson<{ revision: number }>(page, `/api/v1/case-suites/${newest.id}`);
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${newest.id}`, {
        method: "PATCH",
        body: { description: "最新修改不应改变执行选择", expectedRevision: current.body.revision },
      })
    ).status,
  ).toBe(200);
  await open();
  await expect(select).toHaveValue(first.id);
  await dialog.getByRole("button", { name: "关闭执行弹窗" }).click();
  await page.reload();
  await open();
  await expect(select).toHaveValue(first.id);
  await dialog.getByRole("button", { name: "关闭执行弹窗" }).click();
  const otherVersion = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${scope.projectId}/versions`,
    {
      method: "POST",
      body: { name: "独立记忆的项目版本" },
    },
  );
  expect(otherVersion.status).toBe(201);
  const versionTask = await createUiSuite(
    page,
    { ...scope, projectVersionId: otherVersion.body.id },
    "另一版本的任务",
  );
  await selectProjectContext(page, scope.projectId, otherVersion.body.id);
  await page.reload();
  await open();
  await select.selectOption(versionTask.id);
  await dialog.getByRole("button", { name: "关闭执行弹窗" }).click();
  await selectProjectContext(page, scope.projectId, scope.projectVersionId, scope.testStageId);
  await page.reload();
  await open();
  await expect(select).toHaveValue(first.id);
  await dialog.getByRole("button", { name: "关闭执行弹窗" }).click();
  const otherScope = await createUiProject(page);
  const otherTask = await createUiSuite(page, otherScope, "另一个项目的任务");
  await page.goto("/case-suites");
  await open();
  await select.selectOption(otherTask.id);
  await dialog.getByRole("button", { name: "关闭执行弹窗" }).click();
  await selectProjectContext(page, scope.projectId, scope.projectVersionId, scope.testStageId);
  await page.reload();
  await open();
  await expect(select).toHaveValue(first.id);
  await dialog.getByRole("button", { name: "关闭执行弹窗" }).click();
  const firstVersion = await browserJson<{ revision: number }>(
    page,
    `/api/v1/case-suites/${first.id}`,
  );
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${first.id}`, {
        method: "PATCH",
        body: { enabled: false, expectedRevision: firstVersion.body.revision },
      })
    ).status,
  ).toBe(200);
  await open();
  await expect(select).toHaveValue("");
  await expect(dialog).toContainText("上次选择的任务当前不可用，请重新选择可执行任务");
  await expect(dialog.getByRole("button", { name: "确认并开始执行" })).toBeDisabled();
});

test("task pass-rate bars keep their full track at zero, partial and complete values in both appearances", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const scope = await createUiProject(page);
  const suites = [];
  for (const passedRuns of [0, 1, 2]) {
    const name = `通过率 ${passedRuns * 50}% 验证任务`;
    const suite = await createUiSuite(page, scope, name);
    suites.push({ ...suite, name, passedRuns });
  }
  await createUiSuite(page, scope, "暂无执行记录的任务");
  insertSuiteProgressFixture(process.env.AUTOFORGE_E2E_DATA_DIR!, scope, suites);
  await page.goto("/case-suites");
  const bars = page.getByRole("progressbar", { name: "近 7 天平均通过率", exact: true });
  await expect(bars).toHaveCount(3, { timeout: 30_000 });
  for (const appearance of ["light", "dark"] as const) {
    if (appearance === "dark") {
      await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    }
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      for (const suite of suites) {
        const card = page.getByRole("article", { name: `任务 ${suite.name}`, exact: true });
        const bar = card.getByRole("progressbar");
        await expect(bar).toHaveAttribute("aria-valuenow", String(suite.passedRuns * 50));
        await expect(card.locator(".suite-statistics dd").nth(1)).toHaveText(
          `${suite.passedRuns * 50}%`,
        );
        const geometry = await bar.evaluate((element) => {
          const root = element.getBoundingClientRect();
          const rail = element.querySelector(".ant-progress-rail")!.getBoundingClientRect();
          const track = element.querySelector(".ant-progress-track")!.getBoundingClientRect();
          return {
            topInset: rail.top - root.top,
            bottomInset: root.bottom - rail.bottom,
            height: track.height,
            fraction: track.width / rail.width,
          };
        });
        expect(geometry.topInset).toBeGreaterThanOrEqual(-0.5);
        expect(geometry.bottomInset, "任务卡片不能裁掉 Ant Design 的进度条").toBeGreaterThanOrEqual(
          -0.5,
        );
        expect(geometry.height).toBeGreaterThanOrEqual(6);
        expect(geometry.fraction).toBeCloseTo(suite.passedRuns / 2, 2);
      }
      const emptyCard = page.getByRole("article", { name: "任务 暂无执行记录的任务", exact: true });
      await expect(emptyCard).toContainText("暂无已结束执行，均值待统计");
      await expect(emptyCard.getByRole("progressbar")).toHaveCount(0);
      await expectUiIntegrity(page);
      await captureUi(page, `task-progress-${appearance}`, viewport.width);
    }
  }
});

async function createUiProject(page: Page, projectInput?: { name: string; slug: string }) {
  const name = uniqueName("ui-selection");
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: projectInput ?? { name, slug: name },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions`,
    { method: "POST", body: { name: "UI 验证版本" } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "UI 验证阶段" } },
  );
  expect(stage.status).toBe(201);
  await selectProjectContext(page, project.body.id, version.body.id, stage.body.id);
  return {
    projectId: project.body.id,
    projectVersionId: version.body.id,
    testStageId: stage.body.id,
  };
}

async function createUiSuite(
  page: Page,
  scope: { projectId: string; projectVersionId: string },
  name: string,
) {
  const result = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId: scope.projectId, projectVersionId: scope.projectVersionId, name },
  });
  expect(result.status).toBe(201);
  return result.body;
}

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
  const [backdropBox, dialogBox, contentWidth] = await Promise.all([
    backdrop.boundingBox(),
    dialog.boundingBox(),
    backdrop.page().evaluate(() => document.documentElement.getBoundingClientRect().width),
  ]);
  // A stable scrollbar gutter is outside the document's fixed-position containing block.
  expect(backdropBox).toEqual({ x: 0, y: 0, width: contentWidth, height: viewport.height });
  expect(dialogBox).not.toBeNull();
  expect(Math.abs(dialogBox!.x + dialogBox!.width / 2 - contentWidth / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(dialogBox!.y + dialogBox!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(
    1,
  );
}
