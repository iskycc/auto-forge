import { expect, test, type Page } from "@playwright/test";

import {
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

const DEFAULT_PROJECT_ID = "00000000-0000-7000-8000-000000000001";
const PROJECT_ADMIN_ROLE_ID = "00000000-0000-7000-8100-000000000002";
const TEST_MANAGER_ROLE_ID = "00000000-0000-7000-8100-000000000003";
const EXECUTION_OPERATOR_ROLE_ID = "00000000-0000-7000-8100-000000000004";
const VIEWER_ROLE_ID = "00000000-0000-7000-8100-000000000005";
const AUDITOR_ROLE_ID = "00000000-0000-7000-8100-000000000006";

test("local user completes forced password change and self-service session lifecycle", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const username = uniqueName("forced-user");
  const initialPassword = "Initial!Password123";
  const replacementPassword = "Replacement!Password456";

  const createdUser = await createUserThroughAccessPage(
    page,
    username,
    `Forced ${username}`,
    initialPassword,
  );

  await page.goto("/settings/access?section=roles");
  const roleForm = page.locator("form", {
    has: page.getByRole("button", { name: "分配项目角色" }),
  });
  await roleForm.getByLabel("用户").selectOption(createdUser.id);
  await roleForm.getByLabel("项目角色").selectOption({ label: "只读观察者" });
  await roleForm.getByRole("button", { name: "分配项目角色" }).click();
  await expect(page.getByText("项目成员角色已分配。")).toBeVisible();

  await logout(page);
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
  await expect(page.getByRole("link", { name: "用例管理", exact: true })).toBeVisible();
  await expandAdministrationGroup(page, "执行与平台");
  const environmentLink = page.getByRole("link", { name: "执行环境", exact: true });
  await expect(environmentLink).toHaveAttribute(
    "href",
    "/settings/environments?section=environments",
  );
  await page.goto("/account/security");
  await expect(page.getByText("当前会话", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "终止" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("administrator can reset a user password and the last administrator binding is protected", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const username = uniqueName("reset-user");
  const initialPassword = "Initial!Password123";
  const resetPassword = "AdminReset!Password789";

  const createdUser = await createUserThroughAccessPage(
    page,
    username,
    `Reset ${username}`,
    initialPassword,
  );

  const resetForm = page.locator("form", {
    has: page.getByRole("button", { name: "重置密码并撤销会话" }),
  });
  await resetForm.getByLabel("本地用户").selectOption(createdUser.id);
  await resetForm.getByLabel("新密码").fill(resetPassword);
  await resetForm.getByRole("button", { name: "重置密码并撤销会话" }).click();
  await expect(page.getByText("密码已重置，目标用户的已有会话已撤销。")).toBeVisible();

  await page.goto("/settings/access?section=roles");
  const administratorRow = page.getByRole("row", { name: /E2E Administrator.*系统管理员/ });
  page.once("dialog", (dialog) => dialog.accept());
  await administratorRow.getByRole("button", { name: "撤销系统角色" }).click();
  await expect(appAlert(page)).toContainText("最后一位");

  await logout(page);
  await login(page, username, resetPassword);
  await expect(page).toHaveURL(/\/account\/security$/);
  await logout(page);
  await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  await expandAdministrationGroup(page, "执行与平台");
  await expect(page.getByRole("link", { name: "平台配置", exact: true })).toBeVisible();
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
  await userRow.getByRole("button", { name: "启用/解锁" }).click();
  await expect(page.getByText("用户已启用并解除登录锁定。")).toBeVisible();

  await login(userPage, username, password);
  expect((await userPage.request.get("/api/v1/auth/session")).status()).toBe(200);
  await page.goto(`/settings/access?section=users&query=${encodeURIComponent(username)}`);
  userRow = page.getByRole("row", { name: new RegExp(username) });
  await userRow.getByRole("button", { name: "禁用", exact: true }).click();
  await expect(page.getByText("用户已禁用。")).toBeVisible();
  await expect
    .poll(async () => (await userPage.request.get("/api/v1/auth/session")).status())
    .toBe(401);
  await userContext.close();

  const roleName = uniqueName("发布观察员");
  const roleKey = uniqueName("release-observer");
  await page.goto("/settings/access?section=roles");
  const roleForm = page.locator("form", {
    has: page.getByRole("button", { name: "创建角色" }),
  });
  await roleForm.getByLabel("角色标识").fill(roleKey);
  await roleForm.getByLabel("角色名称").fill(roleName);
  await roleForm.getByLabel("作用域").selectOption("project");
  await roleForm.getByLabel("权限（英文逗号分隔）").fill("case.read,run.read");
  await roleForm.getByLabel("描述").fill("E2E custom role");
  await roleForm.getByRole("button", { name: "创建角色" }).click();
  await expect(page.getByText("自定义角色已创建。")).toBeVisible();

  let roleCard = page.locator("article", { hasText: roleName });
  await roleCard.getByText("编辑角色").click();
  const editor = roleCard.locator("form", {
    has: page.getByRole("button", { name: "保存角色" }),
  });
  await editor.getByLabel("角色名称").fill(`${roleName} 已更新`);
  await editor.getByLabel("权限（英文逗号分隔）").fill("case.read,run.read,artifact.read");
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

test("every built-in role receives only its authorized navigation and API surface", async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  await ensureAdministrator(page);
  const password = "BuiltInRole!Password123";
  const roleUsers = [
    {
      key: "project-admin",
      roleId: PROJECT_ADMIN_ROLE_ID,
      scope: "project" as const,
      visible: [
        "工作台",
        "用例管理",
        "用例任务",
        "运维审计",
        "文件来源",
        "用例批跑",
        "执行节点",
        "质量洞察",
        "项目管理",
        "执行环境",
        "密文管理",
      ],
      hidden: [] as string[],
    },
    {
      key: "test-manager",
      roleId: TEST_MANAGER_ROLE_ID,
      scope: "project" as const,
      visible: [
        "工作台",
        "用例管理",
        "用例任务",
        "运维审计",
        "文件来源",
        "用例批跑",
        "执行节点",
        "质量洞察",
        "执行环境",
        "密文管理",
      ],
      hidden: ["用户管理", "角色权限", "平台配置"],
    },
    {
      key: "execution-operator",
      roleId: EXECUTION_OPERATOR_ROLE_ID,
      scope: "project" as const,
      visible: [
        "工作台",
        "用例管理",
        "用例任务",
        "运维审计",
        "文件来源",
        "用例批跑",
        "执行节点",
        "质量洞察",
        "执行环境",
      ],
      hidden: ["项目管理", "密文管理", "平台配置"],
    },
    {
      key: "viewer",
      roleId: VIEWER_ROLE_ID,
      scope: "project" as const,
      visible: [
        "工作台",
        "用例管理",
        "用例任务",
        "运维审计",
        "文件来源",
        "用例批跑",
        "执行节点",
        "质量洞察",
        "执行环境",
      ],
      hidden: ["项目管理", "密文管理", "平台配置"],
    },
    {
      key: "auditor",
      roleId: AUDITOR_ROLE_ID,
      scope: "system" as const,
      visible: ["用例批跑", "质量洞察", "安全审计"],
      hidden: [
        "工作台",
        "用例管理",
        "用例任务",
        "文件来源",
        "执行节点",
        "项目管理",
        "执行环境",
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
    await expandAdministrationGroup(rolePage, "项目与权限");
    await expandAdministrationGroup(rolePage, "执行与平台");
    for (const label of roleUser.visible) {
      await expect(rolePage.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    for (const label of roleUser.hidden) {
      await expect(rolePage.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    }

    const auditStatus = await browserStatus(rolePage, "/api/v1/audit-events?limit=1");
    const caseStatus = await browserStatus(rolePage, "/api/v1/case-definitions?limit=1");
    const createSuiteStatus = await browserStatus(rolePage, "/api/v1/case-suites", "POST", {
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
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("显示名称", { exact: true }).fill(displayName);
  await page.getByLabel("初始密码").fill(password);
  await page.getByRole("button", { name: "创建本地用户" }).click();
  await expect(page.getByText("本地用户已创建。")).toBeVisible();

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
