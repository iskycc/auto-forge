import { expect, test, type Page, type Route } from "@playwright/test";
import type { PublicPlatformStatistics } from "@autoforge/contracts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expectUiIntegrity } from "./support/ui-guard";
import { ensureAdministrator } from "./support/session";

const populatedStatistics: PublicPlatformStatistics = {
  snapshotState: "ready",
  sourceCount: 128,
  caseCount: 128640,
  methodCount: 386720,
  enabledMethodCount: 380000,
  runnerCount: 48,
  onlineRunnerCount: 42,
  busyRunnerCount: 16,
  activeBatchCount: 12,
  completedBatchCount: 2864,
  totalRunCount: 1284560,
  succeededRunCount: 1207486,
  failedRunCount: 24602,
  successRatePercent: 98,
  generatedAt: "2026-09-10T02:30:00.000Z",
  refreshSeconds: 5,
};

const emptyStatistics: PublicPlatformStatistics = {
  ...populatedStatistics,
  sourceCount: 0,
  caseCount: 0,
  methodCount: 0,
  enabledMethodCount: 0,
  runnerCount: 0,
  onlineRunnerCount: 0,
  busyRunnerCount: 0,
  activeBatchCount: 0,
  completedBatchCount: 0,
  totalRunCount: 0,
  succeededRunCount: 0,
  failedRunCount: 0,
  successRatePercent: 0,
};

test("unauthenticated homepage presents the trusted control plane at desktop widths", async ({
  page,
}) => {
  const setupStatus = await page.request.get("/api/v1/auth/setup-status");
  const { setupRequired } = (await setupStatus.json()) as { setupRequired: boolean };

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "让每一次执行，都可控、可追溯。",
  );
  await expect(page.getByRole("button", { name: "刷新公开统计" })).toBeVisible();
  await expect(page.getByRole("region", { name: "平台实时运行概况" })).toBeVisible();
  await expect(page.getByRole("region", { name: "公开平台统计" })).toContainText("TestNG 用例");
  await expect(page.getByRole("region", { name: "AutoForge 核心能力" })).toContainText(
    "统一用例资产",
  );
  await expect(
    page
      .locator(".public-header")
      .getByRole("link", { name: setupRequired ? "初始化平台" : "登录控制台", exact: true }),
  ).toBeVisible();

  await reviewDesktopLayouts(page, "actual");
  await page.getByRole("link", { name: "了解平台能力", exact: true }).click();
  await expect(page).toHaveURL(/#capabilities$/u);
  await expect(page.getByRole("heading", { name: "从用例资产，到质量结论。" })).toBeInViewport();
});

test("empty statistics do not show a misleading zero success rate", async ({ page }) => {
  await page.route("**/api/v1/public/statistics", (route) =>
    route.fulfill({ json: emptyStatistics }),
  );
  await page.goto("/");
  await refreshStatistics(page);
  await expect(page.getByLabel("执行结果分布")).toContainText("暂无执行记录");
  await expect(page.getByLabel("执行成功率", { exact: true })).toHaveText("—");
  await expect(page.getByText("尚未接入执行机")).toBeVisible();
  await reviewDesktopLayouts(page, "empty");
});

test("populated statistics retain large counts and all result categories", async ({ page }) => {
  await page.route("**/api/v1/public/statistics", (route) =>
    route.fulfill({ json: populatedStatistics }),
  );
  await page.goto("/");
  await refreshStatistics(page);
  await expect(page.getByLabel("执行成功率", { exact: true })).toHaveText("98%");
  await expect(page.getByRole("region", { name: "公开平台统计" })).toContainText("128,640");
  await expect(page.getByLabel("执行结果分布")).toContainText("1,207,486");
  await expect(page.getByLabel("执行结果分布")).toContainText("52,472");
  await reviewDesktopLayouts(page, "populated");
});

test("pending and failed snapshots do not masquerade as zeros and can recover", async ({
  page,
}) => {
  let snapshot: PublicPlatformStatistics = { ...emptyStatistics, snapshotState: "pending" };
  await page.route("**/api/v1/public/statistics", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");
  await refreshStatistics(page);
  await expect(page.getByRole("status")).toContainText("统计正在生成");
  await expect(page.getByRole("region", { name: "公开平台统计" })).not.toContainText("0");
  await reviewDesktopLayouts(page, "pending");
  snapshot = { ...emptyStatistics, snapshotState: "failed" };
  await refreshStatistics(page);
  await expect(page.getByRole("status")).toContainText("统计暂时不可用");
  await expect(page.getByLabel("执行成功率", { exact: true })).toHaveText("—");
  snapshot = populatedStatistics;
  await refreshStatistics(page);
  await expect(page.getByRole("status")).toContainText("公开统计已更新");
  await expect(page.getByLabel("执行成功率", { exact: true })).toHaveText("98%");
});

test("refresh failure preserves the previous snapshot and supports keyboard retry", async ({
  page,
}) => {
  let failRefresh = false;
  await page.route("**/api/v1/public/statistics", (route) =>
    route.fulfill(
      failRefresh
        ? { status: 503, json: { message: "Unavailable" } }
        : { json: populatedStatistics },
    ),
  );
  await page.goto("/");
  await refreshStatistics(page);
  failRefresh = true;
  await refreshStatistics(page);
  await expect(page.getByRole("status")).toContainText("同步中断，保留上次统计");
  await expect(page.getByLabel("执行成功率", { exact: true })).toHaveText("98%");
  await reviewDesktopLayouts(page, "sync-failed");
  failRefresh = false;
  await page.getByRole("button", { name: "刷新公开统计" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("公开统计已更新");
});

test("stale snapshots retain counts and zero percent is valid with failed executions", async ({
  page,
}) => {
  let snapshot: PublicPlatformStatistics = { ...populatedStatistics, snapshotState: "stale" };
  await page.route("**/api/v1/public/statistics", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");
  await refreshStatistics(page);
  await expect(page.getByRole("status")).toContainText("统计待刷新，显示上次快照");
  await expect(page.getByLabel("执行成功率", { exact: true })).toHaveText("98%");
  snapshot = { ...emptyStatistics, totalRunCount: 1, failedRunCount: 1 };
  await refreshStatistics(page);
  await expect(page.getByLabel("执行成功率", { exact: true })).toHaveText("0%");
});

test("slow refresh is single flight, times out, and permits recovery", async ({ page }) => {
  const requests: Route[] = [];
  await page.clock.install();
  await page.route("**/api/v1/public/statistics", async (route) => {
    requests.push(route);
    if (requests.length > 1) await route.fulfill({ json: populatedStatistics });
  });
  await page.goto("/");
  const refresh = page.getByRole("button", { name: "刷新公开统计" });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("正在同步公开统计");
  await page.clock.runFor(10_000);
  expect(requests).toHaveLength(1);
  await page.clock.runFor(5_100);
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole("status")).toContainText("同步中断");
  await requests[0]!.fulfill({ json: emptyStatistics });
  await refreshStatistics(page);
  await expect(page.getByLabel("执行成功率", { exact: true })).toHaveText("98%");
});

test("hidden pages suspend polling and refresh when visible again", async ({ page }) => {
  let requestCount = 0;
  await page.clock.install();
  await page.route("**/api/v1/public/statistics", async (route) => {
    requestCount += 1;
    await route.fulfill({ json: populatedStatistics });
  });
  await page.goto("/");
  await refreshStatistics(page);
  const initialRequestCount = requestCount;
  await setDocumentVisibility(page, "hidden");
  await page.clock.runFor(30_000);
  expect(requestCount).toBe(initialRequestCount);
  await setDocumentVisibility(page, "visible");
  await expect.poll(() => requestCount).toBe(initialRequestCount + 1);
  await expect(page.getByRole("status")).toContainText("公开统计已更新");
});

test("an initialized platform offers login without exposing the authenticated shell", async ({
  page,
  context,
}) => {
  await ensureAdministrator(page);
  // Unmount the authenticated shell before clearing its session so its
  // background requests cannot redirect the anonymous visit to /login.
  await page.goto("about:blank");
  await context.clearCookies();
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
  await expect(
    page.locator(".public-header").getByRole("link", { name: "登录控制台" }),
  ).toHaveAttribute("href", "/login");
  await reviewDesktopLayouts(page, "login-entry");
  await page.getByRole("link", { name: "进入管理平台" }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
});

async function setDocumentVisibility(page: Page, visibility: DocumentVisibilityState) {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

async function refreshStatistics(page: Page) {
  const response = page.waitForResponse("**/api/v1/public/statistics");
  await page.getByRole("button", { name: "刷新公开统计" }).click();
  await response;
  await expect(page.getByRole("button", { name: "刷新公开统计" })).toBeEnabled();
}

async function reviewDesktopLayouts(page: Page, state: string) {
  for (const viewport of [
    { width: 1536, height: 960 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.locator(".public-hero").scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await page.getByRole("region", { name: "AutoForge 核心能力" }).scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await page.locator(".public-footer").scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await capturePublicHomepage(page, viewport.width, state);
  }
}

async function capturePublicHomepage(page: Page, width: number, state: string) {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDirectory, `${width}-${state}.png`),
    fullPage: true,
  });
}
