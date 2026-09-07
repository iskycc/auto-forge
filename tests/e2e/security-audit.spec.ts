import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createSqliteDatabase, SqliteIdentityAccessRepository } from "@autoforge/db/sqlite";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { browserJson, ensureAdministrator, uniqueName } from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("security audit keeps Chinese CRUD, login failures and denied access through the real API", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const origin = new URL(baseURL ?? "http://127.0.0.1:3100").origin;
  await ensureAdministrator(page);
  const username = uniqueName("audit-viewer");
  const password = "Audit!Viewer123";
  const created = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: "审计验证观察者", password, forcePasswordChange: false },
  });
  expect(created.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("审计版本") } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "安全验证阶段" } },
  );
  expect(stage.status).toBe(201);

  const viewer = await browser.newContext({ baseURL: origin });
  try {
    const rejected = await viewer.request.post("/api/v1/auth/login", {
      headers: { origin },
      data: { username, password: "Incorrect!Password123" },
    });
    expect(rejected.status()).toBe(401);
    const login = await viewer.request.post("/api/v1/auth/login", {
      headers: { origin },
      data: { username, password },
    });
    expect(login.status()).toBe(200);
    const denied = await viewer.request.get("/api/v1/users", {
      headers: { "x-request-id": "security-audit-ui-denial" },
    });
    expect(denied.status()).toBe(403);
    const platformDenied = await viewer.request.get("/api/v1/settings/retention");
    expect(platformDenied.status()).toBe(403);

    const eventsResponse = await page.request.get(
      `/api/v1/audit-events?actorId=${created.body.id}&category=access`,
    );
    expect(eventsResponse.status()).toBe(200);
    const events = (await eventsResponse.json()).items as Array<{
      action: string;
      result: string;
      details: Record<string, unknown>;
    }>;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "auth.login",
          result: "rejected",
          details: expect.objectContaining({ eventDescription: "用户登录" }),
        }),
        expect.objectContaining({ action: "auth.login", result: "succeeded" }),
        expect.objectContaining({
          action: "auth.access_denied",
          result: "rejected",
          details: expect.objectContaining({
            eventDescription: "越权访问被拒绝",
            permission: "user.read",
          }),
        }),
      ]),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "auth.access_denied",
        details: expect.objectContaining({ permission: "settings.read" }),
      }),
    );
  } finally {
    await viewer.close();
  }

  await page.goto(`/audit?actorId=${created.body.id}&action=auth.access_denied`);
  await expect(page.getByRole("cell", { name: "越权访问被拒绝 登录与访问" }).first()).toBeVisible();
  const toggle = page
    .getByRole("button", { name: "查看事件详情：越权访问被拒绝" })
    .filter({ visible: true })
    .last();
  await toggle.focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("region", { name: "越权访问被拒绝的事件详情" });
  await expect(details.getByText("请求的权限", { exact: true })).toBeVisible();
  await expect(details.getByText("查看用户", { exact: true })).toBeVisible();
  await expect(details).not.toContainText("user.read");
  await expect(page.locator(".audit-card")).not.toContainText("auth.access_denied");
  await page.screenshot({ path: testInfo.outputPath("access-denial-details.png"), fullPage: true });

  const projectEvents = await page.request.get(
    `/api/v1/audit-events?category=project&projectId=${DEFAULT_PROJECT_ID}`,
  );
  expect((await projectEvents.json()).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "project_version.create",
        resourceId: version.body.id,
        details: expect.objectContaining({ eventDescription: "创建项目版本" }),
      }),
      expect.objectContaining({
        action: "test_stage.create",
        resourceId: stage.body.id,
        details: expect.objectContaining({ eventDescription: "创建测试阶段" }),
      }),
    ]),
  );
});

test("historical audit has clean desktop layout, Chinese search, stable pagination and matching export", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("full-"),
    "历史数据兼容布局使用隔离的 Lite 数据库；双数据库语义由共享契约测试验证。",
  );
  await ensureAdministrator(page);
  const actorId = `historical-audit-${randomUUID()}`;
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("安全审计历史兼容测试需要独立的 Lite E2E 数据目录。");
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "db/autoforge.sqlite"),
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
  });
  try {
    const repository = new SqliteIdentityAccessRepository(handle);
    const timestamp = new Date().toISOString();
    for (let index = 0; index < 37; index++) {
      await repository.appendAudit({
        id: `${actorId}-${String(index).padStart(3, "0")}`,
        actorId,
        actorType: "user",
        action:
          index < 35
            ? "case_definition.update"
            : index === 35
              ? "execution_run.retry_scheduled"
              : "run_attempt.rerun",
        resourceType: "case_definition",
        resourceId: `historical-case-${index}`,
        projectId: DEFAULT_PROJECT_ID,
        result: "succeeded",
        details: { name: `支付用例 ${index}`, enabled: true },
        recordedAt: timestamp,
      });
    }
  } finally {
    handle.close();
  }

  await page.goto(`/audit?actorId=${actorId}`);
  await expect(page.locator(".audit-event-row")).toHaveCount(30);
  await expect(page.locator(".audit-card")).not.toContainText("retry");
  for (const width of [1024, 1440, 1920, 2560]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectUiIntegrity(page);
    const overlaps = await page.locator(".audit-filter-grid").evaluate((grid) => {
      const boxes = Array.from(grid.children).map((element) => element.getBoundingClientRect());
      return boxes.some((a, i) =>
        boxes.some(
          (b, j) =>
            i < j &&
            Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
            Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1,
        ),
      );
    });
    expect(overlaps).toBe(false);
    const searchTextClearOfIcon = await page.locator(".audit-search-field").evaluate((field) => {
      const icon = field.querySelector("svg")!.getBoundingClientRect();
      const input = field.querySelector("input")!;
      return (
        input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft) >=
        icon.right + 4
      );
    });
    expect(searchTextClearOfIcon).toBe(true);
    expect(
      await page
        .locator(".table-scroll")
        .evaluate((table) => table.scrollWidth <= table.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`audit-desktop-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("link", { name: "下一页", exact: true }).click();
  await expect(page.locator(".audit-event-row")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "上一页", exact: true }).click();
  await expect(page.locator(".audit-event-row")).toHaveCount(30);
  await page.getByLabel("搜索审计记录").fill("修改用例");
  await page.locator('select[name="category"]').selectOption("case");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(/query=/u);
  await expect(page.locator(".audit-event-row")).toHaveCount(30);
  await page.reload();
  await expect(page.getByLabel("搜索审计记录")).toHaveValue("修改用例");
  const csvUrl = await page.getByRole("link", { name: "导出记录" }).getAttribute("href");
  const csvResponse = await page.request.get(csvUrl!);
  expect(csvResponse.status()).toBe(200);
  const csv = await csvResponse.text();
  expect(csv.split("\r\n")).toHaveLength(36);
  expect(csv).toContain("修改用例");
  expect(csv).not.toMatch(/retry|case_definition\.update|eventDescription/u);
  await page.getByLabel("搜索审计记录").fill("不存在的安全事件");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.getByText("没有符合条件的审计记录")).toBeVisible();
  await page.getByRole("button", { name: "刷新日志" }).click();
  await expect(page.getByText("没有符合条件的审计记录")).toBeVisible();
  await page.getByRole("link", { name: "清空筛选" }).click();
  await expect(page.getByLabel("搜索审计记录")).toHaveValue("");
});
