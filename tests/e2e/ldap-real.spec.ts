import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import {
  browserJson,
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  ensureAdministrator,
  login,
  logout,
} from "./support/session";

const directoryPassword = "Directory!Alice123";

test("matches DDT Insight LDAP configuration, authentication, and Group profile semantics", async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000);
  await ensureAdministrator(page);
  await configureDirectory(page, "ldaps");

  await logout(page);
  await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  await page.goto("/settings/access?section=users");
  await page.getByRole("link", { name: "目录配置", exact: true }).click();
  await expect(page.getByLabel("启用 LDAP 登录")).toBeChecked();

  const persistedConfiguration = await browserJson<Record<string, unknown>>(
    page,
    "/api/v1/ldap/configuration",
  );
  expect(persistedConfiguration.status).toBe(200);
  expect(Object.keys(persistedConfiguration.body).sort()).toEqual(
    [
      "bindDn",
      "connectTimeoutMs",
      "defaultRole",
      "displayNameAttribute",
      "enabled",
      "groupAttribute",
      "groupNameAttribute",
      "groupSearchBase",
      "groupSearchFilter",
      "hasBindPassword",
      "mailAttribute",
      "tlsRejectUnauthorized",
      "updatedAt",
      "updatedBy",
      "url",
      "userBaseDn",
      "userFilter",
    ].sort(),
  );

  const ldapContext = await loginWithLdap(browser, "alice", directoryPassword);
  const ldapPage = ldapContext.pages()[0]!;
  await expect(ldapPage.getByRole("heading", { level: 1, name: /Alice Directory/ })).toBeVisible();
  await expect(ldapPage.getByRole("link", { name: "用例管理", exact: true })).toBeVisible();
  await expect(ldapPage.getByRole("link", { name: "安全审计" })).toHaveCount(0);

  await page.goto("/settings/access?section=users&query=alice&source=ldap");
  await expect(page.getByText("Group · auditors、viewers", { exact: true })).toBeVisible();
  await expect(page.getByText("1 个绑定", { exact: true })).toBeVisible();
  await page.goto("/settings/access?section=ldap");
  await expect(page.getByText("Group 仅保存到用户档案", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /添加组映射|立即同步目录/ })).toHaveCount(0);
  expect((await page.request.post("/api/v1/ldap/synchronize")).status()).toBe(404);
  expect((await page.request.get("/api/v1/ldap/group-mappings")).status()).toBe(404);

  await configureDirectory(page, "ldap");
  const plainContext = await loginWithLdap(browser, "alice", directoryPassword);
  await expect(
    plainContext.pages()[0]!.getByRole("heading", { level: 1, name: /Alice Directory/ }),
  ).toBeVisible();

  await configureDirectory(page, "ldap", "(&(objectClass=inetOrgPerson)(cn={{username}}))");
  const attributeFreeContext = await loginWithLdap(
    browser,
    "login-fallback",
    "Directory!Fallback123",
  );
  await expect(
    attributeFreeContext.pages()[0]!.getByRole("heading", {
      level: 1,
      name: /LDAP Login Fallback/,
    }),
  ).toBeVisible();

  await ldapContext.close();
  await plainContext.close();
  await attributeFreeContext.close();
});

async function configureDirectory(
  page: Page,
  protocol: "ldaps" | "ldap",
  userFilter = "(&(objectClass=inetOrgPerson)(uid={{username}}))",
): Promise<void> {
  await page.goto("/settings/access?section=ldap");
  const form = page.locator("form", {
    has: page.getByRole("button", { name: "保存 LDAP 配置" }),
  });
  const enabled = form.getByLabel("启用 LDAP 登录");
  if (!(await enabled.isChecked())) await enabled.check();
  await form
    .getByLabel("LDAP 服务地址")
    .fill(
      protocol === "ldaps"
        ? (process.env.E2E_LDAP_LDAPS_URL ?? "ldaps://ldap:636")
        : (process.env.E2E_LDAP_PLAIN_URL ?? "ldap://ldap:389"),
    );
  const certificateVerification = form.getByLabel("校验 TLS 服务器证书");
  if (await certificateVerification.isChecked()) await certificateVerification.uncheck();
  await form.getByLabel("连接超时（毫秒）").fill("5000");
  await form.getByLabel("Bind DN（可选）").fill("cn=admin,dc=example,dc=test");
  await form.getByLabel("Bind 密码", { exact: true }).fill("Admin!Directory123");
  await form.getByLabel("用户 Base DN").fill("ou=people,dc=example,dc=test");
  await form.getByLabel("用户过滤器").fill(userFilter);
  await form.getByLabel("显示名称属性").fill("displayName");
  await form.getByLabel("邮箱属性（可选）").fill("mail");
  await form.getByLabel("LDAP 用户统一角色").selectOption("editor");
  await form.getByLabel("Group Search Base（可选）").fill("ou=groups,dc=example,dc=test");
  await form
    .getByLabel("Group Search Filter")
    .fill("(&(objectClass=groupOfNames)(member={{userDn}}))");
  await form.getByLabel("Group 名称属性").fill("cn");
  await form.getByLabel("用户 Group 属性").fill("memberOf");
  await form.getByRole("button", { name: "保存 LDAP 配置" }).click();
  await expect(page.getByText("LDAP 配置已加密保存。")).toBeVisible({ timeout: 20_000 });

  const persistedForm = page.locator("form", {
    has: page.getByRole("button", { name: "测试连接" }),
  });
  await persistedForm.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText("LDAP 连接、用户与 Group Base DN 验证成功。")).toBeVisible({
    timeout: 20_000,
  });
}

async function loginWithLdap(
  browser: Browser,
  username: string,
  password: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: requiredEnvironment("E2E_BASE_URL") });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("group", { name: "登录来源" })).toHaveCount(0);
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 20_000 });
  return context;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for real LDAP acceptance.`);
  return value;
}
