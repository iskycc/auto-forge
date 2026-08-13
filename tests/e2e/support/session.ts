import { expect, type Page } from "@playwright/test";

export const E2E_ADMIN_USERNAME = "e2e-admin";
export const E2E_ADMIN_PASSWORD = "E2e!Administrator123";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export async function ensureAdministrator(page: Page): Promise<void> {
  await page.goto("/login");
  // /login answers 200 and finishes its redirect to /setup client-side while
  // setup is still required; wait for the final URL before branching on it,
  // otherwise the follow-up navigation races that in-flight redirect.
  await page.waitForURL(/\/(login|setup)$/, { timeout: 20_000 });
  if (new URL(page.url()).pathname === "/setup") {
    await page
      .getByLabel("一次性管理员引导令牌")
      .fill(requiredEnvironment("E2E_ADMIN_BOOTSTRAP_TOKEN"));
    await page.getByLabel("用户名").fill(E2E_ADMIN_USERNAME);
    await page.getByLabel("显示名称").fill("E2E Administrator");
    await page.getByLabel("管理员密码").fill(E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "创建系统管理员" }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    return;
  }
  if (new URL(page.url()).pathname !== "/login") return;
  await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
}

export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 20_000 });
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function browserJson<T>(
  page: Page,
  path: string,
  init: { method?: string; body?: JsonValue } = {},
): Promise<{ status: number; body: T }> {
  // The evaluate boundary uses unknown instead of the recursive JsonValue so
  // Playwright's PageFunction inference does not trip TS2589.
  const request: { requestPath: string; requestMethod: string; requestBody: unknown } = {
    requestPath: path,
    requestMethod: init.method ?? "GET",
    requestBody: init.body,
  };
  const result = await page.evaluate(
    async ({
      requestPath,
      requestMethod,
      requestBody,
    }: typeof request): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(requestPath, {
        method: requestMethod,
        ...(requestBody === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestBody),
            }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    request,
  );
  return { status: result.status, body: result.body as T };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for browser acceptance tests.`);
  return value;
}
