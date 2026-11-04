import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import {
  browserJson,
  ensureAdministrator,
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity, waitForUiTransitions } from "./support/ui-guard";

const password = "SelfRegistration!Password123";
test.setTimeout(90000);

test.beforeEach(async ({ page }) => {
  await ensureAdministrator(page);
  expect(
    (
      await browserJson(page, "/api/v1/ldap/configuration", {
        method: "PUT",
        body: { enabled: false, url: "", userBaseDn: "" },
      })
    ).status,
  ).toBe(200);
});

async function fillRegistration(page: Page, username: string) {
  const form = page.getByRole("form", { name: "创建本地账号", exact: true });
  await form.getByLabel("用户名", { exact: true }).fill(username);
  await form.getByLabel("显示名称", { exact: true }).fill("自助注册验证用户");
  await form.getByLabel("密码", { exact: true }).fill(password);
  await form.getByLabel("确认密码", { exact: true }).fill(password);
  return form;
}

test("public registration validates input and signs in immediately without changing the chosen password", async ({
  page,
  browser,
}, testInfo) => {
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  context.setDefaultTimeout(30000);
  try {
    const visitor = await context.newPage();
    await visitor.goto("/register");
    await expect(
      visitor.getByRole("heading", { name: "创建账号，即刻登录", exact: true }),
    ).toBeVisible();
    const username = uniqueName("self-register");
    const form = await fillRegistration(visitor, username);
    await form.getByLabel("邮箱（可选）", { exact: true }).fill("local-user@example.invalid");
    await form.getByLabel("确认密码", { exact: true }).fill("different");
    await form.getByRole("button", { name: "创建账号并登录", exact: true }).click();
    await expect(form.getByText("两次输入的密码不一致。", { exact: true })).toBeVisible();
    await form.getByLabel("确认密码", { exact: true }).fill(password);
    for (const appearance of ["light", "dark"]) {
      if (appearance === "dark")
        await visitor.getByRole("button", { name: "切换到深色模式", exact: true }).click();
      for (const viewport of [
        { width: 1024, height: 768 },
        { width: 1536, height: 1024 },
      ]) {
        await visitor.setViewportSize(viewport);
        await waitForUiTransitions(visitor);
        await expectUiIntegrity(visitor);
        await visitor.screenshot({
          path: testInfo.outputPath(`registration-${appearance}-${viewport.width}.png`),
          animations: "disabled",
          fullPage: true,
        });
      }
    }
    const registered = visitor.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/auth/register") && response.request().method() === "POST",
    );
    await form.getByRole("button", { name: "创建账号并登录", exact: true }).click();
    const response = await registered;
    expect(response.status()).toBe(201);
    // Registration immediately leaves this document; verify identity through the new session.
    await expect(visitor).toHaveURL(new URL("/", page.url()).toString());
    await expect(visitor.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
    const identity = await visitor.request.get("/api/v1/auth/session");
    expect(identity.status()).toBe(200);
    expect(await identity.json()).toMatchObject({
      user: { username, source: "local", forcePasswordChange: false },
      systemPermissions: [],
      projectPermissions: {
        [DEFAULT_PROJECT_ID]: expect.arrayContaining([
          "case.read",
          "run.create",
          "run.cancel",
          "log.read",
        ]),
      },
    });
    expect((await visitor.request.get("/api/v1/users")).status()).toBe(403);
    expect(
      (await context.cookies()).find((cookie) => cookie.name === "autoforge_session"),
    ).toMatchObject({ httpOnly: true, sameSite: "Strict" });
    await visitor.getByRole("button", { name: "退出登录", exact: true }).click();
    const login = visitor.getByRole("dialog", { name: "登录控制台", exact: true });
    await expect(login).toBeVisible();
    await login.getByLabel("用户名", { exact: true }).fill(username);
    await login.getByLabel("密码", { exact: true }).fill(password);
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await expect(login).toHaveCount(0);
    await expect(visitor).toHaveURL(new URL("/", page.url()).toString());
    expect(
      (await (await visitor.request.get("/api/v1/auth/session")).json()).user.forcePasswordChange,
    ).toBe(false);
  } finally {
    await context.close();
  }
});

test("registration from a public task returns to the task and reports existing usernames clearly", async ({
  page,
  browser,
}, testInfo) => {
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("registration-version") } },
  );
  expect(version.status).toBe(201);
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      name: uniqueName("registration-task"),
    },
  });
  expect(suite.status).toBe(201);
  const link = await browserJson<{ url: string }>(
    page,
    `/api/v1/case-suites/${suite.body.id}/execution-link`,
    { method: "POST", body: {} },
  );
  expect(link.status).toBe(200);
  const existingUsername = uniqueName("already-registered");
  expect(
    (
      await browserJson(page, "/api/v1/users", {
        method: "POST",
        body: { username: existingUsername, displayName: "已有账号", password },
      })
    ).status,
  ).toBe(201);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  context.setDefaultTimeout(30000);
  try {
    const visitor = await context.newPage();
    const original = `${link.body.url}#execution-controls`;
    await visitor.goto(original);
    await visitor.getByRole("button", { name: "登录", exact: true }).click();
    const login = visitor.getByRole("dialog", { name: "登录控制台", exact: true });
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 1024 },
    ]) {
      await visitor.setViewportSize(viewport);
      await waitForUiTransitions(visitor);
      await expectUiIntegrity(visitor);
      await visitor.screenshot({
        path: testInfo.outputPath(`login-registration-entry-${viewport.width}.png`),
        animations: "disabled",
      });
    }
    await login.getByRole("link", { name: "创建账号", exact: true }).click();
    await expect(visitor).toHaveURL(/\/register\?/);
    const destination = new URL(original);
    expect(new URL(visitor.url()).searchParams.get("returnTo")).toBe(
      `${destination.pathname}${destination.search}${destination.hash}`,
    );
    await visitor.getByRole("button", { name: "登录现有账号", exact: true }).click();
    const registrationLogin = visitor.getByRole("dialog", { name: "登录控制台", exact: true });
    await registrationLogin.getByRole("link", { name: "创建账号", exact: true }).click();
    await expect(registrationLogin).toBeHidden();
    expect(new URL(visitor.url()).searchParams.get("returnTo")).toBe(
      `${destination.pathname}${destination.search}${destination.hash}`,
    );
    const form = await fillRegistration(visitor, existingUsername);
    await form.getByRole("button", { name: "创建账号并登录", exact: true }).click();
    await expect(form.getByRole("alert").first()).toContainText("用户名已存在");
    expect((await visitor.request.get("/api/v1/auth/session")).status()).toBe(401);
    await form.getByLabel("用户名", { exact: true }).fill(uniqueName("public-register"));
    await form.getByRole("button", { name: "创建账号并登录", exact: true }).click();
    await expect(visitor).toHaveURL(original);
    await expect(visitor.getByText("已登录", { exact: true })).toBeVisible();
    expect(
      (await (await visitor.request.get("/api/v1/auth/session")).json()).user.forcePasswordChange,
    ).toBe(false);
  } finally {
    await context.close();
  }
});

for (const staleSession of [false, true]) {
  test(`login returns to the requested protected link after switching registration with ${staleSession ? "an expired session" : "no session"}`, async ({
    page,
    browser,
  }, testInfo) => {
    const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      if (staleSession)
        await context.addCookies([
          {
            name: "autoforge_session",
            value: "expired-auth-return-session",
            url: new URL("/", page.url()).href,
          },
        ]);
      const visitor = await context.newPage();
      const original = new URL("/execution-records?kind=single#execution-history", page.url()).href;
      await visitor.goto(original);
      const login = visitor.getByRole("dialog", { name: "登录控制台", exact: true });
      await expect(login).toBeVisible();
      expect(new URL(visitor.url()).searchParams.get("returnTo")).toBe(
        "/execution-records?kind=single#execution-history",
      );
      await visitor.reload();
      await expect(login).toBeVisible();
      await login.getByRole("link", { name: "创建账号", exact: true }).click();
      await expect(visitor).toHaveURL(/\/register\?/);
      expect(new URL(visitor.url()).searchParams.get("returnTo")).toBe(
        "/execution-records?kind=single#execution-history",
      );
      await visitor.getByRole("button", { name: "登录现有账号", exact: true }).click();
      await login.getByLabel("用户名", { exact: true }).fill(E2E_ADMIN_USERNAME);
      await login.getByLabel("密码", { exact: true }).fill("incorrect-password");
      await login.getByRole("button", { name: "登录", exact: true }).click();
      await expect(login.getByRole("alert")).toBeVisible();
      await login.getByLabel("密码", { exact: true }).fill(E2E_ADMIN_PASSWORD);
      for (const viewport of [
        { width: 1024, height: 768 },
        { width: 1536, height: 1024 },
      ]) {
        await visitor.setViewportSize(viewport);
        await expectUiIntegrity(visitor);
        await visitor.screenshot({
          path: testInfo.outputPath(`login-return-${viewport.width}.png`),
          animations: "disabled",
        });
      }
      await login.getByRole("button", { name: "登录", exact: true }).click();
      await expect(visitor).toHaveURL(original);
      await expect(login).toBeHidden();
      expect((await visitor.request.get("/api/v1/auth/session")).status()).toBe(200);
      for (const entry of ["/login", "/register"]) {
        await visitor.goto(
          `${entry}?${new URLSearchParams({
            returnTo: "/execution-records?kind=single#execution-history",
          })}`,
        );
        await expect(visitor).toHaveURL(original);
      }
    } finally {
      await context.close();
    }
  });
}

test("mandatory password changes retain the protected destination through the next login", async ({
  page,
  browser,
}) => {
  const username = uniqueName("return-after-password");
  const user = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: username, password, forcePasswordChange: true },
  });
  expect(user.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/users/${user.body.id}/project-roles`, {
        method: "POST",
        body: { projectId: DEFAULT_PROJECT_ID, roleId: "00000000-0000-7000-8100-000000000004" },
      })
    ).status,
  ).toBe(204);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const visitor = await context.newPage();
    const originalPath = "/execution-records?kind=single#after-password";
    await visitor.goto(`/login?${new URLSearchParams({ returnTo: originalPath })}`);
    const login = visitor.getByRole("dialog", { name: "登录控制台", exact: true });
    await login.getByLabel("用户名", { exact: true }).fill(username);
    await login.getByLabel("密码", { exact: true }).fill(password);
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await expect(visitor).toHaveURL(
      (url) =>
        url.pathname === "/account/security" && url.searchParams.get("returnTo") === originalPath,
    );
    const newPassword = "ChangedReturn!Password123";
    await visitor.getByLabel("当前密码", { exact: true }).fill(password);
    await visitor.getByLabel("新密码", { exact: true }).fill(newPassword);
    await visitor.getByLabel("确认新密码", { exact: true }).fill(newPassword);
    await visitor.getByRole("button", { name: "修改密码并重新登录", exact: true }).click();
    await expect(login).toContainText("密码已修改");
    await login.getByLabel("用户名", { exact: true }).fill(username);
    await login.getByLabel("密码", { exact: true }).fill(newPassword);
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await expect(visitor).toHaveURL(new URL(originalPath, page.url()).href);
    expect((await visitor.request.get("/api/v1/auth/session")).status()).toBe(200);
  } finally {
    await context.close();
  }
});

test("enabling LDAP closes all registration paths and disabling it restores the public form", async ({
  page,
  browser,
}, testInfo) => {
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  context.setDefaultTimeout(30000);
  const configuration = {
    enabled: true,
    url: "ldaps://127.0.0.1:10636",
    userBaseDn: "dc=example,dc=invalid",
  };
  try {
    const visitor = await context.newPage();
    await visitor.goto("/register");
    const username = uniqueName("ldap-policy");
    const form = await fillRegistration(visitor, username);
    expect(
      (
        await browserJson(page, "/api/v1/ldap/configuration", {
          method: "PUT",
          body: configuration,
        })
      ).status,
    ).toBe(200);
    const rejected = visitor.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/auth/register") && response.request().method() === "POST",
    );
    await form.getByRole("button", { name: "创建账号并登录", exact: true }).click();
    expect((await rejected).status()).toBe(403);
    await expect(form.getByRole("alert")).toContainText("自助注册已关闭");
    await visitor.reload();
    await expect(
      visitor.getByRole("heading", { name: "自助注册已关闭", exact: true }),
    ).toBeVisible();
    await expect(visitor.getByRole("form", { name: "创建本地账号", exact: true })).toHaveCount(0);
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 1024 },
    ]) {
      await visitor.setViewportSize(viewport);
      await waitForUiTransitions(visitor);
      await expectUiIntegrity(visitor);
      await visitor.screenshot({
        path: testInfo.outputPath(`registration-ldap-closed-${viewport.width}.png`),
        animations: "disabled",
      });
    }
    await visitor.getByRole("button", { name: "登录平台", exact: true }).click();
    const dialog = visitor.getByRole("dialog", { name: "登录控制台", exact: true });
    await expect(
      dialog.getByText("企业目录已启用，请使用目录账号或已有本地账号登录。", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("link", { name: "创建账号", exact: true })).toHaveCount(0);
    expect(
      (await browserJson<{ items: unknown[] }>(page, `/api/v1/users?query=${username}&limit=10`))
        .body.items,
    ).toHaveLength(0);
    await visitor.keyboard.press("Escape");
    expect(
      (
        await browserJson(page, "/api/v1/ldap/configuration", {
          method: "PUT",
          body: { ...configuration, enabled: false },
        })
      ).status,
    ).toBe(200);
    await visitor.reload();
    await expect(visitor.getByRole("form", { name: "创建本地账号", exact: true })).toBeVisible();
    const availability = await visitor.request.get("/api/v1/auth/register");
    expect(await availability.json()).toEqual({ enabled: true, reason: "available" });
  } finally {
    await browserJson(page, "/api/v1/ldap/configuration", {
      method: "PUT",
      body: { ...configuration, enabled: false },
    });
    await context.close();
  }
});
