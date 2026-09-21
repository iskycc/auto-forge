import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  acceptSystemDialog,
  appAlert,
  browserJson,
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  ensureAdministrator,
  expandAdministrationGroup,
  login,
  logout,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

const DEFAULT_PROJECT_ID = "00000000-0000-7000-8000-000000000001";
const PROJECT_ADMIN_ROLE_ID = "00000000-0000-7000-8100-000000000002";
const TEST_MANAGER_ROLE_ID = "00000000-0000-7000-8100-000000000003";
const EXECUTION_OPERATOR_ROLE_ID = "00000000-0000-7000-8100-000000000004";
const VIEWER_ROLE_ID = "00000000-0000-7000-8100-000000000005";
const AUDITOR_ROLE_ID = "00000000-0000-7000-8100-000000000006";

async function captureUi(page: Page, name: string): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  const absoluteDirectory = resolve(screenshotDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  await page.screenshot({ path: resolve(absoluteDirectory, `${name}.png`), fullPage: true });
}

test("authenticated landing hand-off is an immediate HTTP redirect", async ({ page }) => {
  await ensureAdministrator(page);

  const response = await page.request.get("/landing", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toBe("/");

  await page.goto("/landing");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
});

test("user creation keeps validation and server errors inside the dialog", async ({ page }) => {
  await ensureAdministrator(page);
  const username = uniqueName("creation-feedback");
  const password = "Initial!Password123";
  await createActiveUser(page, username, password);
  await page.goto("/settings/access?section=users");
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "创建本地用户" });
  const submit = dialog.getByRole("button", { name: "创建本地用户", exact: true });
  const usernameInput = dialog.getByLabel("用户名", { exact: true });
  const displayNameInput = dialog.getByLabel("显示名称", { exact: true });
  const emailInput = dialog.getByLabel("邮箱（可选）", { exact: true });
  const passwordInput = dialog.getByLabel("初始密码", { exact: true });
  const creationRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/users")
      creationRequests.push(request.url());
  });

  await usernameInput.fill("中文账号");
  await displayNameInput.fill("   ");
  await emailInput.fill("invalid-email");
  await passwordInput.fill("OnlyLettersHere");
  await submit.click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("用户名须以字母或数字开头");
  await expect(alert).toContainText("请输入显示名称");
  await expect(alert).toContainText("请输入有效的邮箱地址");
  await expect(alert).toContainText("密码必须包含数字");
  await expect(alert).toContainText("密码必须包含特殊字符");
  await expect(usernameInput).toBeFocused();
  await expect(passwordInput).toHaveValue("OnlyLettersHere");
  expect(creationRequests).toHaveLength(0);
  await expect(page.locator(".settings-stack > .auth-error")).toHaveCount(0);

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    expect(
      await dialog.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(2);
    await expect(submit).toBeInViewport();
    await captureUi(page, `create-user-validation-${viewport.width}`);
  }

  await usernameInput.fill(username);
  await displayNameInput.fill("创建错误反馈验证");
  await emailInput.fill("");
  await passwordInput.fill(password);
  await submit.click();
  await expect(alert).toContainText("用户名已存在");
  await expect(usernameInput).toHaveValue(username);
  await expect(displayNameInput).toHaveValue("创建错误反馈验证");
  await expect(passwordInput).toHaveValue(password);
  await expect(page.locator(".settings-stack > .auth-error")).toHaveCount(0);
  await captureUi(page, "create-user-duplicate-1536");

  const replacementUsername = uniqueName("created-after-error");
  await usernameInput.fill(replacementUsername);
  let rejection: "validation" | "busy" | "network" = "validation";
  await page.route("**/api/v1/users", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (rejection === "network") return route.abort("internetdisconnected");
    await route.fulfill({
      status: rejection === "validation" ? 400 : 503,
      contentType: "application/json",
      body: JSON.stringify({
        error:
          rejection === "validation"
            ? {
                code: "VALIDATION_FAILED",
                message: "请求数据校验失败。",
                requestId: "creation-validation",
                details: [
                  { path: ["email"], message: "请输入有效的邮箱地址，例如 name@example.com。" },
                ],
              }
            : {
                code: "PLATFORM_BUSY",
                message: "平台数据库繁忙，请稍后重试。",
                requestId: "creation-busy",
              },
      }),
    });
  });
  await submit.click();
  await expect(alert).toContainText("邮箱：请输入有效的邮箱地址");
  await expect(emailInput).toHaveAttribute("aria-invalid", "true");
  await expect(emailInput).toBeFocused();
  rejection = "busy";
  await submit.click();
  await expect(alert).toContainText("平台数据库繁忙，请稍后重试");
  await expect(passwordInput).toHaveValue(password);
  await expect(page.locator(".settings-stack > .auth-error")).toHaveCount(0);
  rejection = "network";
  await submit.click();
  await expect(alert).toContainText("创建用户请求未完成，请检查网络连接后重试");
  await expect(passwordInput).toHaveValue(password);
  await expect(submit).toBeEnabled();
  await page.unroute("**/api/v1/users");

  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("本地用户已创建。", { exact: true })).toBeVisible();
  const created = await browserJson(page, `/api/v1/users?query=${replacementUsername}`);
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({
    items: [expect.objectContaining({ username: replacementUsername })],
  });
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(usernameInput).toHaveValue("");
  await expect(passwordInput).toHaveValue("");
  await submit.click();
  await expect(alert).toBeVisible();
  await dialog.getByRole("button", { name: "关闭创建本地用户" }).click();
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("user creation API returns actionable validation without revealing passwords", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const rejectedPassword = "OnlyLettersHere";
  const response = await browserJson(page, "/api/v1/users", {
    method: "POST",
    body: {
      username: "中文账号",
      displayName: " ",
      email: "invalid-email",
      password: rejectedPassword,
    },
  });
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({
    error: {
      code: "VALIDATION_FAILED",
      requestId: expect.any(String),
      message: expect.stringContaining("用户名须以字母或数字开头"),
      details: expect.arrayContaining([
        expect.objectContaining({ path: ["displayName"], message: "请输入显示名称。" }),
        expect.objectContaining({ path: ["password"], message: "密码必须包含数字。" }),
        expect.objectContaining({ path: ["password"], message: "密码必须包含特殊字符。" }),
      ]),
    },
  });
  expect(JSON.stringify(response.body)).not.toContain(rejectedPassword);
});

test("administrator assigns system and project roles directly from the user row", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const username = uniqueName("inline-roles");
  const password = "InlineRoles!Password123";
  const displayName = "直接分配角色的用户".repeat(12);
  const created = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName, password, forcePasswordChange: false },
  });
  expect(created.status).toBe(201);
  const targetId = created.body.id;
  const targetContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  let targetPage = await targetContext.newPage();
  try {
    await login(targetPage, username, password);
    await page.goto(`/settings/access?section=users&query=${username}`);
    const row = page.getByRole("row").filter({ hasText: username });
    const assign = row.getByRole("button", { name: "分配角色", exact: true });
    await expect(assign).toBeVisible();
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 960 },
    ]) {
      await page.setViewportSize(viewport);
      await expectUiIntegrity(page);
      await captureUi(page, `user-role-entry-${viewport.width}`);
    }
    await assign.click();
    const dialog = page.getByRole("dialog", { name: "分配用户角色" });
    await expect(dialog).toContainText(username);
    await expect(dialog).toContainText(displayName);
    await expect(dialog.getByLabel("用户", { exact: true })).toHaveCount(0);
    await dialog.locator(`input[name="roleId"][value="${AUDITOR_ROLE_ID}"]`).check();
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 960 },
    ]) {
      await page.setViewportSize(viewport);
      await expectUiIntegrity(page);
      expect(
        await dialog.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(2);
      await captureUi(page, `user-role-dialog-${viewport.width}`);
    }
    const assignmentPath = "**/api/v1/role-assignments";
    await page.route(assignmentPath, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "PLATFORM_BUSY",
            message: "平台数据库繁忙，请稍后重试。",
            requestId: "role-assignment-busy",
          },
        }),
      }),
    );
    await dialog.getByRole("button", { name: "分配系统角色" }).click();
    await expect(dialog.getByRole("alert")).toContainText("平台数据库繁忙");
    await expect(dialog.locator(`input[name="roleId"][value="${AUDITOR_ROLE_ID}"]`)).toBeChecked();
    await expect(page.locator(".settings-stack > .auth-error")).toHaveCount(0);
    await page.unroute(assignmentPath);
    await dialog.getByRole("button", { name: "分配系统角色" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("已分配 1 个系统角色，旧会话已撤销。", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`section=users&query=${username}$`));
    await row.getByText("1 个绑定", { exact: true }).click();
    await expect(row).toContainText("系统 · 审计员");
    expect((await targetPage.request.get("/api/v1/auth/session")).status()).toBe(401);
    // Revoked pages can redirect themselves while a new login starts. Open a fresh tab
    // in the same browser context so the test does not race that background navigation.
    await targetPage.close();
    targetPage = await targetContext.newPage();
    await login(targetPage, username, password);
    expect((await targetPage.request.get("/api/v1/audit-events?limit=1")).status()).toBe(200);
    await assign.click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByLabel("项目", { exact: true }).selectOption(DEFAULT_PROJECT_ID);
    await dialog.locator(`input[name="roleId"][value="${VIEWER_ROLE_ID}"]`).check();
    await dialog.getByRole("button", { name: "分配项目角色" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("已分配 1 个项目角色，旧会话已撤销。", { exact: true }),
    ).toBeVisible();
    await expect(row.getByText("2 个绑定", { exact: true })).toBeVisible();
    const members = await browserJson<Array<{ user: { id: string }; roleIds: string[] }>>(
      page,
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/members?query=${username}`,
    );
    expect(members.status).toBe(200);
    expect(members.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user: expect.objectContaining({ id: targetId }),
          roleIds: expect.arrayContaining([VIEWER_ROLE_ID]),
        }),
      ]),
    );
    expect((await targetPage.request.get("/api/v1/auth/session")).status()).toBe(401);
    // Revoked pages can redirect themselves while a new login starts. Open a fresh tab
    // in the same browser context so the test does not race that background navigation.
    await targetPage.close();
    targetPage = await targetContext.newPage();
    await login(targetPage, username, password);
    expect(
      (
        await targetPage.request.get(
          `/api/v1/case-definitions?projectId=${DEFAULT_PROJECT_ID}&limit=1`,
        )
      ).status(),
    ).toBe(200);
  } finally {
    await targetContext.close();
  }
});

test("user administration does not confer role assignment permission", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const password = "UserOperator!Password123";
  const username = uniqueName("user-operator");
  const operator = await createActiveUser(page, username, password);
  const role = await browserJson<{ id: string }>(page, "/api/v1/roles", {
    method: "POST",
    body: {
      key: uniqueName("user-operator-role"),
      name: "仅管理用户",
      scope: "system",
      permissions: ["user.read", "user.manage", "role.read", "project.read"],
    },
  });
  expect(role.status).toBe(201);
  expect(
    await browserStatus(page, `/api/v1/users/${operator.id}/system-roles`, "POST", {
      roleId: role.body.id,
    }),
  ).toBe(204);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const operatorPage = await context.newPage();
    await login(operatorPage, username, password);
    await operatorPage.goto(`/settings/access?section=users&query=${username}`);
    await expect(operatorPage.getByRole("button", { name: "创建用户", exact: true })).toBeVisible();
    await expect(operatorPage.getByRole("button", { name: "分配角色", exact: true })).toHaveCount(
      0,
    );
    expect(
      await browserStatus(operatorPage, `/api/v1/users/${operator.id}/system-roles`, "POST", {
        roleId: AUDITOR_ROLE_ID,
      }),
    ).toBe(403);
    expect(
      await browserStatus(operatorPage, `/api/v1/users/${operator.id}/project-roles`, "POST", {
        roleId: VIEWER_ROLE_ID,
        projectId: DEFAULT_PROJECT_ID,
      }),
    ).toBe(403);
  } finally {
    await context.close();
  }
});

test("user role assignment offers only projects the operator can manage", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const username = uniqueName("project-role-operator");
  const password = "ProjectRoles!Password123";
  const operator = await createActiveUser(page, username, password);
  const targetUsername = uniqueName("project-role-target");
  const target = await createActiveUser(page, targetUsername, password);
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: uniqueName("可授权项目"), slug: uniqueName("assignable-project") },
  });
  expect(project.status).toBe(201);
  const readRole = await browserJson<{ id: string }>(page, "/api/v1/roles", {
    method: "POST",
    body: {
      key: uniqueName("user-role-reader"),
      name: "用户与角色读取",
      scope: "system",
      permissions: ["user.read", "role.read", "project.read"],
    },
  });
  expect(readRole.status).toBe(201);
  expect(
    await browserStatus(page, `/api/v1/users/${operator.id}/system-roles`, "POST", {
      roleId: readRole.body.id,
    }),
  ).toBe(204);
  expect(
    await browserStatus(page, `/api/v1/users/${operator.id}/project-roles`, "POST", {
      projectId: project.body.id,
      roleId: PROJECT_ADMIN_ROLE_ID,
    }),
  ).toBe(204);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const operatorPage = await context.newPage();
    await login(operatorPage, username, password);
    await operatorPage.goto(`/settings/access?section=users&query=${targetUsername}`);
    const row = operatorPage.getByRole("row").filter({ hasText: targetUsername });
    await row.getByRole("button", { name: "分配角色", exact: true }).click();
    const dialog = operatorPage.getByRole("dialog", { name: "分配用户角色" });
    await expect(dialog.getByRole("button", { name: "分配系统角色" })).toHaveCount(0);
    expect(
      await dialog
        .getByLabel("项目", { exact: true })
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.getAttribute("value"))),
    ).toEqual([project.body.id]);
    await dialog.locator(`input[name="roleId"][value="${VIEWER_ROLE_ID}"]`).check();
    await dialog.getByRole("button", { name: "分配项目角色" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.getByText("1 个绑定", { exact: true })).toBeVisible();
    expect(
      await browserStatus(operatorPage, `/api/v1/users/${target.id}/project-roles`, "POST", {
        projectId: DEFAULT_PROJECT_ID,
        roleId: VIEWER_ROLE_ID,
      }),
    ).toBe(403);
  } finally {
    await context.close();
  }
});

test("local user completes forced password change and self-service session lifecycle", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const username = uniqueName("forced-user");
  const initialPassword = "Initial!Password123";
  const replacementPassword = "Replacement!Password456";

  await createUserThroughAccessPage(page, username, `Forced ${username}`, initialPassword);

  await page.goto("/settings/access?section=roles");
  await page.getByRole("button", { name: "分配角色" }).click();
  const roleForm = page.locator("form", {
    has: page.getByRole("button", { name: "分配项目角色" }),
  });
  await roleForm.getByLabel("查找用户").fill(username);
  await roleForm.getByRole("button", { name: "查询用户" }).click();
  await roleForm.getByRole("radio", { name: new RegExp(username) }).check();
  await roleForm.locator(`input[name="roleId"][value="${VIEWER_ROLE_ID}"]`).check();
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `role-page-assignment-${viewport.width}`);
  }
  await roleForm.getByRole("button", { name: "分配项目角色" }).click();
  await expect(page.getByText("已分配 1 个项目角色，旧会话已撤销。")).toBeVisible();

  await logout(page);
  await expect(page.getByRole("group", { name: "登录来源" })).toHaveCount(0);
  await expect(page.getByText("系统会自动识别认证方式")).toBeVisible();
  await login(page, username, initialPassword);
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByText("管理员要求你先修改初始密码")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeEmpty();

  const forbiddenWhileForced = await page.request.get("/api/v1/case-definitions");
  expect(forbiddenWhileForced.ok()).toBe(false);
  expect(await forbiddenWhileForced.json()).toMatchObject({
    error: { code: "PASSWORD_CHANGE_REQUIRED" },
  });

  await page.getByLabel("当前密码").fill(initialPassword);
  await page.getByLabel("新密码", { exact: true }).fill(replacementPassword);
  await page.getByLabel("确认新密码").fill(replacementPassword);
  await page.getByRole("button", { name: "修改密码并重新登录" }).click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);

  await login(page, username, replacementPassword);
  const mainNavigation = page.getByRole("navigation", { name: "主导航" });
  await expect(mainNavigation.getByRole("link", { name: "用例管理", exact: true })).toBeVisible();
  await expandAdministrationGroup(page, "执行配置");
  await expect(mainNavigation.getByRole("link", { name: "执行机组", exact: true })).toHaveAttribute(
    "href",
    "/runners?section=groups",
  );
  await page.goto("/account/security");
  await expect(page.getByText("当前会话", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "终止" }).click();
  await acceptSystemDialog(page, "终止登录会话", "终止会话");
  await expect(page).toHaveURL(/\/login$/);
});

test("administrator can reset a user password and the last administrator binding is protected", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const username = uniqueName("reset-user");
  const initialPassword = "Initial!Password123";
  const resetPassword = "AdminReset!Password789";

  await createUserThroughAccessPage(page, username, `Reset ${username}`, initialPassword);

  await page.getByRole("button", { name: "重置密码" }).click();
  const resetForm = page.locator("form", {
    has: page.getByRole("button", { name: "重置密码并撤销会话" }),
  });
  await resetForm.getByLabel("查找用户").fill(username);
  await resetForm.getByRole("button", { name: "查询用户" }).click();
  await resetForm.getByRole("radio", { name: new RegExp(username) }).check();
  await resetForm.getByLabel("新密码").fill(resetPassword);
  await resetForm.getByRole("button", { name: "重置密码并撤销会话" }).click();
  await expect(page.getByText("密码已重置，目标用户的已有会话已撤销。")).toBeVisible();

  await page.goto("/settings/access?section=roles");
  await page.getByText("用户系统角色绑定", { exact: true }).click();
  const administratorRow = page.getByRole("row", { name: /E2E Administrator.*系统管理员/ });
  await administratorRow.getByRole("button", { name: "撤销系统角色" }).click();
  await acceptSystemDialog(page, "撤销系统角色", "确认撤销");
  await expect(appAlert(page)).toContainText("最后一位");

  await logout(page);
  await login(page, username, resetPassword);
  await expect(page).toHaveURL(/\/account\/security$/);
  await logout(page);
  await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  await expandAdministrationGroup(page, "平台运维");
  await expect(page.getByRole("link", { name: "平台设置", exact: true })).toBeVisible();
});

test("administrator unlocks and disables a locked user and manages a custom role", async ({
  browser,
  page,
}) => {
  await ensureAdministrator(page);
  const username = uniqueName("locked-user");
  const password = "LockedUser!Password123";
  const user = await createActiveUser(page, username, password);
  const userContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const userPage = await userContext.newPage();

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await failedLogin(userPage, username, `Wrong!Password${attempt}23`);
  }
  await userPage.getByLabel("用户名").fill(username);
  await userPage.getByLabel("密码").fill(password);
  await userPage.getByRole("button", { name: "登录" }).click();
  // Authentication failures stay deliberately generic to avoid disclosing
  // whether a username exists or has reached its lock threshold.
  await expect(appAlert(userPage)).toContainText("用户名或密码无效");

  await page.goto(`/settings/access?section=users&query=${encodeURIComponent(username)}`);
  let userRow = page.getByRole("row", { name: new RegExp(username) });
  await expect(userRow).toContainText("锁定至");
  await userRow.getByText("更多操作", { exact: true }).click();
  await userRow.getByRole("button", { name: "启用/解锁" }).click();
  await expect(page.getByText("用户已启用并解除登录锁定。")).toBeVisible();

  await login(userPage, username, password);
  expect((await userPage.request.get("/api/v1/auth/session")).status()).toBe(200);
  await page.goto(`/settings/access?section=users&query=${encodeURIComponent(username)}`);
  userRow = page.getByRole("row", { name: new RegExp(username) });
  await userRow.getByText("更多操作", { exact: true }).click();
  await userRow.getByRole("button", { name: "禁用", exact: true }).click();
  await acceptSystemDialog(page, "禁用用户", "确认变更");
  await expect(page.getByText("用户已禁用。")).toBeVisible();
  await expect
    .poll(async () => (await userPage.request.get("/api/v1/auth/session")).status())
    .toBe(401);
  await userContext.close();

  const roleName = uniqueName("发布观察员");
  const roleKey = uniqueName("release-observer");
  await page.goto("/settings/access?section=roles");
  await page.getByRole("button", { name: "创建角色" }).click();
  const roleForm = page.getByRole("dialog", { name: "创建自定义角色" });
  await roleForm.getByLabel("角色标识").fill(roleKey);
  await roleForm.getByLabel("角色名称").fill(roleName);
  await roleForm.getByLabel("作用域").selectOption("project");
  const rolePermissions = roleForm.getByRole("group", { name: "权限" });
  expect(await rolePermissions.getByRole("checkbox").count()).toBeGreaterThan(1);
  await rolePermissions.locator('input[value="case.read"]').check();
  await rolePermissions.locator('input[value="run.read"]').check();
  await captureUi(page, "role-permission-checkboxes");
  await roleForm.getByLabel("描述").fill("E2E custom role");
  await roleForm.getByRole("button", { name: "创建角色" }).click();
  await expect(page.getByText("自定义角色已创建。")).toBeVisible();

  let roleCard = page.locator("article", { hasText: roleName });
  await expect(roleCard).toContainText("查看用例");
  await expect(roleCard).toContainText("查看执行与质量洞察");
  await expect(roleCard).not.toContainText("case.read");
  await expect(roleCard).not.toContainText("run.read");
  await roleCard.getByText("编辑角色").click();
  const editor = roleCard.locator("form", {
    has: page.getByRole("button", { name: "保存角色" }),
  });
  await editor.getByLabel("角色名称").fill(`${roleName} 已更新`);
  await editor.locator('input[name="permissions"][value="artifact.read"]').check();
  await editor.getByRole("button", { name: "保存角色" }).click();
  await expect(page.getByText("角色定义已更新，受影响用户的旧会话已撤销。")).toBeVisible();

  roleCard = page.locator("article", { hasText: `${roleName} 已更新` });
  await roleCard.getByRole("button", { name: "停用角色" }).click();
  await expect(page.getByText(/角色已停用/)).toBeVisible();
  roleCard = page.locator("article", { hasText: `${roleName} 已更新` });
  await roleCard.getByRole("button", { name: "启用角色" }).click();
  await expect(page.getByText("角色已重新启用。")).toBeVisible();
  roleCard = page.locator("article", { hasText: `${roleName} 已更新` });
  await roleCard.getByRole("button", { name: "删除角色" }).click();
  await expect(page.getByText("自定义角色已删除。")).toBeVisible();
  expect(user.id).toBeTruthy();
});

test("project administrator manages member roles from the member dialog", async ({ page }) => {
  await ensureAdministrator(page);
  const username = uniqueName("member-roles");
  const user = await createActiveUser(page, username, "MemberRoles!Password123");
  expect(
    await browserStatus(page, `/api/v1/users/${user.id}/project-roles`, "POST", {
      projectId: DEFAULT_PROJECT_ID,
      roleId: VIEWER_ROLE_ID,
    }),
  ).toBe(204);

  await page.goto(`/settings/projects?section=members&query=${encodeURIComponent(username)}`);
  const memberRow = page.getByRole("row").filter({ hasText: username });
  await memberRow.getByRole("button", { name: "管理角色" }).click();

  const dialog = page.getByRole("dialog", {
    name: `管理“${username}”的项目角色`,
  });
  const viewerRole = dialog.locator(".member-role-card").filter({ hasText: "只读观察者" });
  const testManagerRole = dialog.locator(".member-role-card").filter({ hasText: "测试管理员" });
  await expect(viewerRole.getByText("已分配", { exact: true })).toBeVisible();
  await expect(testManagerRole.getByText("未分配", { exact: true })).toBeVisible();

  await testManagerRole.getByRole("button", { name: "添加项目角色 测试管理员" }).click();
  await expect(page.locator(".toast-card")).toContainText(
    "项目角色已添加，目标用户的旧会话已撤销。",
  );
  await expect(testManagerRole.getByText("已分配", { exact: true })).toBeVisible();

  await viewerRole.getByRole("button", { name: "移除项目角色 只读观察者" }).click();
  await acceptSystemDialog(page, "移除项目角色", "确认移除");
  await expect(page.locator(".toast-card")).toContainText(
    "项目角色已移除，目标用户的旧会话已撤销。",
  );
  await expect(viewerRole.getByText("未分配", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(memberRow.locator(".permission-list")).toContainText("测试管理员");
  await expect(memberRow.locator(".permission-list")).not.toContainText("只读观察者");
});

test("every built-in role receives only its authorized navigation and API surface", async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  await ensureAdministrator(page);
  const projectVersionId = await ensureDefaultProjectVersion(page);
  const password = "BuiltInRole!Password123";
  const roleUsers = [
    {
      key: "project-admin",
      roleId: PROJECT_ADMIN_ROLE_ID,
      scope: "project" as const,
      visible: [
        "工作概览",
        "用例管理",
        "用例任务",
        "执行记录",
        "安全审计",
        "文件来源",
        "执行节点",
        "质量洞察",
        "用例分析",
        "项目管理",
        "执行机组",
      ],
      hidden: [] as string[],
    },
    {
      key: "test-manager",
      roleId: TEST_MANAGER_ROLE_ID,
      scope: "project" as const,
      visible: [
        "工作概览",
        "用例管理",
        "用例任务",
        "执行记录",
        "文件来源",
        "执行节点",
        "质量洞察",
        "用例分析",
        "执行机组",
      ],
      hidden: ["用户管理", "角色权限", "安全审计", "平台配置"],
    },
    {
      key: "execution-operator",
      roleId: EXECUTION_OPERATOR_ROLE_ID,
      scope: "project" as const,
      visible: [
        "工作概览",
        "用例管理",
        "用例任务",
        "执行记录",
        "文件来源",
        "执行节点",
        "质量洞察",
        "用例分析",
        "执行机组",
      ],
      hidden: ["项目管理", "安全审计", "平台配置"],
    },
    {
      key: "viewer",
      roleId: VIEWER_ROLE_ID,
      scope: "project" as const,
      visible: [
        "工作概览",
        "用例管理",
        "用例任务",
        "执行记录",
        "文件来源",
        "执行节点",
        "质量洞察",
        "用例分析",
        "执行机组",
      ],
      hidden: ["项目管理", "安全审计", "平台配置"],
    },
    {
      key: "auditor",
      roleId: AUDITOR_ROLE_ID,
      scope: "system" as const,
      visible: ["执行记录", "质量洞察", "用例分析", "安全审计"],
      hidden: [
        "工作概览",
        "用例管理",
        "用例任务",
        "文件来源",
        "执行节点",
        "执行机组",
        "项目管理",
        "平台配置",
      ],
    },
  ];

  for (const roleUser of roleUsers) {
    const username = uniqueName(roleUser.key);
    const user = await createActiveUser(page, username, password);
    const assignmentPath =
      roleUser.scope === "system"
        ? `/api/v1/users/${user.id}/system-roles`
        : `/api/v1/users/${user.id}/project-roles`;
    const assignmentBody =
      roleUser.scope === "system"
        ? { roleId: roleUser.roleId }
        : { projectId: DEFAULT_PROJECT_ID, roleId: roleUser.roleId };
    expect(await browserStatus(page, assignmentPath, "POST", assignmentBody)).toBe(204);

    const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const rolePage = await context.newPage();
    await login(rolePage, username, password);
    await expandAdministrationGroup(rolePage, "项目协作");
    await expandAdministrationGroup(rolePage, "身份权限");
    await expandAdministrationGroup(rolePage, "执行配置");
    await expandAdministrationGroup(rolePage, "平台运维");
    const mainNavigation = rolePage.getByRole("navigation", { name: "主导航" });
    for (const label of roleUser.visible) {
      await expect(mainNavigation.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    for (const label of roleUser.hidden) {
      await expect(mainNavigation.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    }

    const auditStatus = await browserStatus(rolePage, "/api/v1/audit-events?limit=1");
    const caseStatus = await browserStatus(rolePage, "/api/v1/case-definitions?limit=1");
    const createSuiteStatus = await browserStatus(rolePage, "/api/v1/case-suites", "POST", {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId,
      name: uniqueName(`${roleUser.key}-suite`),
    });
    const terminalStatus = await browserStatus(rolePage, "/api/v1/terminal-sessions", "POST", {
      runnerId: "00000000-0000-7000-9000-000000000099",
      columns: 80,
      rows: 24,
    });

    switch (roleUser.key) {
      case "project-admin":
        expect(auditStatus).toBe(200);
        expect(caseStatus).toBe(200);
        expect(createSuiteStatus).toBe(201);
        expect(terminalStatus).toBe(404);
        break;
      case "test-manager":
        expect(auditStatus).toBe(403);
        expect(caseStatus).toBe(200);
        expect(createSuiteStatus).toBe(201);
        expect(terminalStatus).toBe(403);
        break;
      case "execution-operator":
      case "viewer":
        expect(auditStatus).toBe(403);
        expect(caseStatus).toBe(200);
        expect(createSuiteStatus).toBe(403);
        expect(terminalStatus).toBe(403);
        break;
      case "auditor":
        expect(auditStatus).toBe(200);
        expect(caseStatus).toBe(403);
        expect(createSuiteStatus).toBe(403);
        expect(terminalStatus).toBe(403);
        break;
    }
    await context.close();
  }
});

async function ensureDefaultProjectVersion(page: Page): Promise<string> {
  const structure = await browserJson<{
    versions: Array<{ id: string; status: "active" | "archived" }>;
  }>(page, `/api/v1/projects/${DEFAULT_PROJECT_ID}/structure`);
  const activeVersion = structure.body.versions.find((version) => version.status === "active");
  if (activeVersion) return activeVersion.id;
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("rbac-version") } },
  );
  expect(version.status).toBe(201);
  return version.body.id;
}

async function createActiveUser(page: Page, username: string, password: string) {
  const response = await browserJson<{ id?: string }>(page, "/api/v1/users", {
    method: "POST",
    body: {
      username,
      displayName: username,
      password,
      forcePasswordChange: false,
    },
  });
  expect(response.status).toBe(201);
  expect(response.body.id).toBeTruthy();
  return { id: response.body.id! };
}

async function createUserThroughAccessPage(
  page: Page,
  username: string,
  displayName: string,
  password: string,
): Promise<{ id: string }> {
  await page.goto("/settings/access?section=users");
  await page.getByRole("button", { name: "创建用户" }).click();
  const dialog = page.getByRole("dialog", { name: "创建本地用户" });
  await dialog.getByLabel("用户名", { exact: true }).fill(username);
  await dialog.getByLabel("显示名称", { exact: true }).fill(displayName);
  await dialog.getByLabel("初始密码").fill(password);
  await dialog.getByRole("button", { name: "创建本地用户", exact: true }).click();
  // 提交含 scrypt 哈希与 SQLite 写入，随后整页 reload 再渲染 toast；
  // 全套件并发负载下可能超过默认 5s，放宽到 15s 避免偶发误报。
  await expect(page.getByText("本地用户已创建。")).toBeVisible({ timeout: 15_000 });

  const users = await browserJson<{ items: Array<{ id: string; username: string }> }>(
    page,
    `/api/v1/users?query=${encodeURIComponent(username)}&limit=20`,
  );
  expect(users.status).toBe(200);
  const created = users.body.items.find((user) => user.username === username);
  expect(created).toBeTruthy();
  return { id: created!.id };
}

async function failedLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(appAlert(page)).toBeVisible();
}

async function browserStatus(
  page: Page,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<number> {
  return page.evaluate(
    async ({ requestPath, requestMethod, requestBody }) =>
      (
        await fetch(requestPath, {
          method: requestMethod,
          ...(requestBody
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(requestBody),
              }
            : {}),
        })
      ).status,
    { requestPath: path, requestMethod: method, requestBody: body },
  );
}
