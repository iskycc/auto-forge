import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  appAlert,
  browserJson,
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  ensureAdministrator,
  expandAdministrationGroup,
  login,
} from "./support/session";

const execFileAsync = promisify(execFile);
const directoryPassword = "Directory!Alice123";

test("authenticates and synchronizes against real private-CA LDAP", async ({ browser, page }) => {
  test.setTimeout(420_000);
  await ensureAdministrator(page);
  const caPem = await readFile(requiredEnvironment("E2E_LDAP_CA_FILE"), "utf8");
  await configureDirectory(page, caPem, "ldaps");
  await addGroupMapping(page, "cn=auditors,ou=groups,dc=example,dc=test", "审计员");
  await addGroupMapping(page, "cn=viewers,ou=groups,dc=example,dc=test", "只读观察者", "默认项目");

  const ldapsContext = await loginWithLdap(browser, "alice", directoryPassword);
  const ldapsPage = ldapsContext.pages()[0]!;
  await expect(ldapsPage.getByRole("link", { name: "用例管理", exact: true })).toBeVisible();
  await expandAdministrationGroup(ldapsPage, "平台运维");
  await expect(ldapsPage.getByRole("link", { name: "安全审计" })).toBeVisible();
  await ldapsPage.goto("/account/security");
  await expect(ldapsPage.getByText("LDAP 账号密码由目录服务管理", { exact: false })).toBeVisible();
  await expect(ldapsPage.getByRole("button", { name: "修改密码并重新登录" })).toHaveCount(0);

  await configureDirectory(page, caPem, "starttls");
  const startTlsContext = await loginWithLdap(browser, "alice", directoryPassword);
  await expect(
    startTlsContext.pages()[0]!.getByRole("heading", { level: 1, name: /Alice Directory/ }),
  ).toBeVisible();

  const synchronization = await browserJson<{
    status: string;
    processedUsers: number;
    disabledUsers: number;
  }>(page, "/api/v1/ldap/synchronize", { method: "POST" });
  expect(synchronization.status).toBe(202);
  expect(synchronization.body).toMatchObject({ status: "succeeded", disabledUsers: 0 });
  expect(synchronization.body.processedUsers).toBeGreaterThanOrEqual(51);
  await expect
    .poll(
      async () => {
        const jobs = await browserJson<{
          items: Array<{ triggerKind: string; status: string }>;
        }>(page, "/api/v1/ldap/synchronize?limit=50");
        expect(jobs.status).toBe(200);
        return jobs.body.items.some(
          (job) => job.triggerKind === "scheduled" && job.status === "succeeded",
        );
      },
      { timeout: 120_000, intervals: [2_000, 5_000] },
    )
    .toBe(true);
  await page.goto("/settings/automation");
  await expect(page.getByRole("heading", { name: "LDAP 同步历史" })).toBeVisible();
  await expect(page.getByText(/更新\s*5[1-9]/).first()).toBeVisible();

  await addConflictingDirectoryUser();
  await expectLdapConflict(browser);
  await removeDirectoryUser("uid=e2e-admin,ou=people,dc=example,dc=test");
  await verifyDirectoryOutageAndLocalFallback(browser, page);
  await removeDirectoryUser("uid=alice,ou=people,dc=example,dc=test");
  const departureSync = await browserJson<{
    status: string;
    processedUsers: number;
    disabledUsers: number;
  }>(page, "/api/v1/ldap/synchronize", { method: "POST" });
  expect(departureSync.status).toBe(202);
  expect(departureSync.body.status).toBe("succeeded");
  expect(departureSync.body.disabledUsers).toBeGreaterThanOrEqual(1);
  await expectSessionRevoked(ldapsPage);
  await expectSessionRevoked(startTlsContext.pages()[0]!);

  await ldapsContext.close();
  await startTlsContext.close();
});

async function configureDirectory(
  page: Page,
  caPem: string,
  tlsMode: "ldaps" | "starttls",
): Promise<void> {
  await page.goto("/settings/access?section=ldap");
  const form = page.locator("form", {
    has: page.getByRole("button", { name: "保存 LDAP 配置" }),
  });
  const enabled = form.getByLabel("启用 LDAP 登录");
  if (!(await enabled.isChecked())) await enabled.check();
  await form.getByLabel("TLS 模式").selectOption(tlsMode);
  await form
    .getByLabel("服务器地址（每行一个）")
    .fill(
      tlsMode === "ldaps"
        ? (process.env.E2E_LDAP_LDAPS_URL ?? "ldaps://ldap:636")
        : (process.env.E2E_LDAP_STARTTLS_URL ?? "ldap://ldap:389"),
    );
  await form.getByLabel("Bind DN").fill("cn=admin,dc=example,dc=test");
  const bindPassword = form.getByLabel("Bind 密码");
  if ((await bindPassword.getAttribute("required")) !== null) {
    await bindPassword.fill("Admin!Directory123");
  }
  await form.getByLabel("LDAP 分页大小").fill("50");
  await form.getByLabel("单次同步用户上限").fill("500");
  await form.getByLabel("计划同步间隔（分钟，0 为关闭）").fill("1");
  await form.getByLabel("用户 Base DN").fill("ou=people,dc=example,dc=test");
  await form.getByLabel("用户过滤器").fill("(&(objectClass=inetOrgPerson)(uid={username}))");
  await form.getByLabel("稳定 ID 属性").fill("entryUUID");
  await form.getByLabel("用户名属性").fill("uid");
  await form.getByLabel("显示名属性").fill("displayName");
  await form.getByLabel("邮箱属性").fill("mail");
  await form.getByLabel("组 Base DN（可选）").fill("ou=groups,dc=example,dc=test");
  await form.getByLabel(/组过滤器/).fill("(&(objectClass=groupOfNames)(member={userDn}))");
  await form.getByLabel("私有 CA PEM（可选）").fill(caPem);
  await form.getByRole("button", { name: "保存 LDAP 配置" }).click();
  await expect(page.getByText("LDAP 配置已加密保存。")).toBeVisible({ timeout: 20_000 });

  const persistedForm = page.locator("form", {
    has: page.getByRole("button", { name: "测试连接" }),
  });
  await persistedForm.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText("LDAP 连接、TLS 和 bind 验证成功。")).toBeVisible({
    timeout: 20_000,
  });
}

async function addGroupMapping(
  page: Page,
  groupDn: string,
  roleName: string,
  projectName?: string,
): Promise<void> {
  await page.goto("/settings/access?section=ldap");
  const form = page.locator("form", {
    has: page.getByRole("button", { name: "添加组映射" }),
  });
  await form.getByLabel("LDAP 组 DN").fill(groupDn);
  await form.locator('select[name="roleId"]').selectOption({ label: roleName });
  await form
    .getByLabel("项目（系统角色留空）")
    .selectOption(projectName ? { label: projectName } : "");
  await form.getByRole("button", { name: "添加组映射" }).click();
  await expect(page.getByText("LDAP 组角色映射已添加。")).toBeVisible();
}

async function loginWithLdap(
  browser: Browser,
  username: string,
  password: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: requiredEnvironment("E2E_BASE_URL") });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "LDAP" }).click();
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 20_000 });
  return context;
}

async function expectLdapConflict(browser: Browser): Promise<void> {
  const context = await browser.newContext({ baseURL: requiredEnvironment("E2E_BASE_URL") });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "LDAP" }).click();
  await page.getByLabel("用户名").fill("e2e-admin");
  await page.getByLabel("密码").fill("Directory!Conflict123");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(appAlert(page)).toContainText(/冲突|已有账号/);
  await context.close();
}

async function verifyDirectoryOutageAndLocalFallback(
  browser: Browser,
  adminPage: Page,
): Promise<void> {
  const container = requiredEnvironment("E2E_LDAP_CONTAINER");
  await execFileAsync("docker", ["stop", "--time", "1", container]);
  const ldapContext = await browser.newContext({ baseURL: requiredEnvironment("E2E_BASE_URL") });
  const ldapPage = await ldapContext.newPage();
  await ldapPage.goto("/login");
  await ldapPage.getByRole("button", { name: "LDAP" }).click();
  await ldapPage.getByLabel("用户名").fill("alice");
  await ldapPage.getByLabel("密码").fill(directoryPassword);
  await ldapPage.getByRole("button", { name: "登录" }).click();
  await expect(appAlert(ldapPage)).toContainText(/LDAP|目录|连接/, {
    timeout: 20_000,
  });

  const fallbackContext = await browser.newContext({
    baseURL: requiredEnvironment("E2E_BASE_URL"),
  });
  const fallbackPage = await fallbackContext.newPage();
  await login(fallbackPage, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  await expandAdministrationGroup(fallbackPage, "身份权限");
  const accessManagement = fallbackPage.getByRole("link", { name: "访问管理", exact: true });
  await expect(accessManagement).toBeVisible();
  await accessManagement.click();
  await expect(fallbackPage.getByRole("link", { name: "目录配置", exact: true })).toBeVisible();
  expect((await adminPage.request.get("/api/v1/auth/session")).status()).toBe(200);

  await execFileAsync("docker", ["start", container]);
  await waitForDirectory(container);
  await ldapContext.close();
  await fallbackContext.close();
}

async function waitForDirectory(container: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await execFileAsync("docker", [
            "exec",
            container,
            "ldapsearch",
            "-x",
            "-H",
            "ldap://127.0.0.1:389",
            "-D",
            "cn=admin,dc=example,dc=test",
            "-w",
            "Admin!Directory123",
            "-b",
            "dc=example,dc=test",
            "-s",
            "base",
            "dn",
          ]);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe(true);
}

async function removeDirectoryUser(distinguishedName: string): Promise<void> {
  const container = requiredEnvironment("E2E_LDAP_CONTAINER");
  await execFileAsync("docker", [
    "exec",
    container,
    "ldapdelete",
    "-x",
    "-H",
    "ldap://127.0.0.1:389",
    "-D",
    "cn=admin,dc=example,dc=test",
    "-w",
    "Admin!Directory123",
    distinguishedName,
  ]);
}

async function addConflictingDirectoryUser(): Promise<void> {
  const container = requiredEnvironment("E2E_LDAP_CONTAINER");
  await execFileAsync("docker", [
    "exec",
    container,
    "ldapadd",
    "-x",
    "-H",
    "ldap://127.0.0.1:389",
    "-D",
    "cn=admin,dc=example,dc=test",
    "-w",
    "Admin!Directory123",
    "-f",
    "/fixtures/conflicting-user.ldif",
  ]);
}

async function expectSessionRevoked(page: Page): Promise<void> {
  await expect
    .poll(async () => (await page.request.get("/api/v1/auth/session")).status(), {
      timeout: 20_000,
    })
    .toBe(401);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for real LDAP acceptance.`);
  return value;
}
