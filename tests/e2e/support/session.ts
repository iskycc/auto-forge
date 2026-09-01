import { expect, type Locator, type Page } from "@playwright/test";

export const E2E_ADMIN_USERNAME = "e2e-admin";
export const E2E_ADMIN_PASSWORD = "E2e!Administrator123";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// Next.js mounts an always-present route announcer with role="alert";
// application feedback lives in its own alert regions instead.
export function appAlert(page: Page): Locator {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

export async function acceptSystemDialog(
  page: Page,
  title: string | RegExp,
  action: string | RegExp,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: action, exact: typeof action === "string" }).click();
  await expect(dialog).toHaveCount(0);
}

export async function ensureAdministrator(page: Page): Promise<void> {
  // Decide through the public setup-status API instead of the /login page:
  // while setup is required, /login answers 200 and only redirects to /setup
  // client-side, which aborts in-flight navigations (ERR_ABORTED) and swaps
  // the login form for the setup form in the middle of fills.
  const response = await page.request.get("/api/v1/auth/setup-status");
  const status = (await response.json()) as { setupRequired?: unknown };
  if (status.setupRequired === true) {
    await page.goto("/setup");
    await page
      .getByLabel("一次性管理员引导令牌")
      .fill(requiredEnvironment("E2E_ADMIN_BOOTSTRAP_TOKEN"));
    // The setup labels embed their hint <small> in the accessible name, so
    // exact matching fails here; "用户名" is unique on this page.
    await page.getByLabel("用户名").fill(E2E_ADMIN_USERNAME);
    await page.getByLabel("显示名称").fill("E2E Administrator");
    await page.getByLabel("管理员密码").fill(E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "创建系统管理员" }).click();
    // Several spec files share one deployment and can all observe
    // setupRequired=true before the first bootstrap transaction commits. The
    // winner receives a session and navigates home; losers receive the
    // expected bootstrap conflict and must log in with the account that now
    // exists instead of waiting forever on /setup.
    await expect
      .poll(
        async () => {
          if (new URL(page.url()).pathname !== "/setup") return "navigated";
          const current = await page.request.get("/api/v1/auth/setup-status");
          const currentStatus = (await current.json()) as { setupRequired?: unknown };
          return currentStatus.setupRequired === false ? "completed-by-peer" : "pending";
        },
        { timeout: 20_000, intervals: [100, 250, 500] },
      )
      .not.toBe("pending");
    if (new URL(page.url()).pathname === "/setup") {
      const session = await page.request.get("/api/v1/auth/session");
      if (session.ok()) {
        // The bootstrap response has installed the session cookie, but its
        // document-level /landing navigation can trail the status request by
        // a few milliseconds. Let that navigation finish instead of racing it
        // with an unnecessary trip to /login.
        await expect
          .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
          .not.toBe("/setup");
      } else {
        await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
      }
    }
    await openAuthenticatedRoot(page);
    await expectAdministratorShell(page);
    return;
  }
  await login(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  await openAuthenticatedRoot(page);
  await expectAdministratorShell(page);
}

async function openAuthenticatedRoot(page: Page): Promise<void> {
  // Older supported Releases can complete bootstrap or login with a valid
  // cookie while rendering a public root document prefetched before that
  // cookie existed. Wait out the landing hand-off before making an explicit
  // authenticated request, otherwise Playwright can race a document that is
  // still being replaced.
  await waitForAuthenticatedRoute(page);
  await page.goto("/", { waitUntil: "load" });
}

async function expectAdministratorShell(page: Page): Promise<void> {
  // Do not return while the landing response is still handing off to the
  // permission-appropriate destination; that redirect can abort the caller's
  // next navigation.
  await waitForAuthenticatedRoute(page);
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
}

async function waitForAuthenticatedRoute(page: Page): Promise<void> {
  await expect
    .poll(
      () => {
        const pathname = new URL(page.url()).pathname;
        return pathname !== "/setup" && pathname !== "/login" && pathname !== "/landing";
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.waitForLoadState("load");
}

export async function login(page: Page, username: string, password: string): Promise<void> {
  if (new URL(page.url()).pathname !== "/login") {
    await page.goto("/login");
  }
  // Wait for the login submit button before filling: while setup is still
  // required the page mutates from /login into /setup client-side, and the
  // setup form also carries 用户名 / 管理员密码 fields that would otherwise
  // swallow these fills.
  const submitButton = page.getByRole("button", { name: "登录", exact: true });
  await expect(submitButton).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await submitButton.click();
  await expect
    .poll(
      () => {
        const pathname = new URL(page.url()).pathname;
        return pathname !== "/login" && pathname !== "/landing";
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.waitForLoadState("load");
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

export async function selectProjectContext(
  page: Page,
  projectId: string,
  projectVersionId?: string,
  testStageId?: string,
): Promise<void> {
  const response = await browserJson(page, "/api/v1/selected-project", {
    method: "PUT",
    body: {
      projectId,
      ...(projectVersionId ? { projectVersionId } : {}),
      ...(testStageId ? { testStageId } : {}),
    },
  });
  expect(response.status).toBe(200);
}

// Compatibility helper for older scenario code. Administration capabilities are
// now first-level links, so callers only need to wait until the shell is mounted.
export async function expandAdministrationGroup(
  page: Page,
  groupLabel: "项目协作" | "身份权限" | "执行配置" | "平台运维",
): Promise<void> {
  void groupLabel;
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible({ timeout: 10_000 });
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
  // A client-side navigation (login redirect, landing hand-off) destroys the
  // execution context mid-evaluate; retry once the page settles instead of
  // failing the test on a browser-internal race.
  for (let attempt = 0; ; attempt += 1) {
    try {
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
          const text = await response.text();
          if (text.trim().length === 0) return { status: response.status, body: null };
          try {
            return { status: response.status, body: JSON.parse(text) as unknown };
          } catch {
            throw new Error(
              `Expected a JSON response from ${requestPath}, got ${response.status} with: ${text.slice(0, 200)}`,
            );
          }
        },
        request,
      );
      return { status: result.status, body: result.body as T };
    } catch (error) {
      const navigationRace =
        error instanceof Error && error.message.includes("Execution context was destroyed");
      if (!navigationRace || attempt >= 4) throw error;
      await page.waitForLoadState("load").catch(() => undefined);
      await page.waitForTimeout(150 * (attempt + 1));
    }
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for browser acceptance tests.`);
  return value;
}
