import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import type {
  FailureAnalysisClaimView,
  FailureAnalysisExecutionHistory,
} from "@autoforge/contracts";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import { insertAnalysisExecutionHistory } from "./support/analysis-execution-history-fixture";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("single and bulk analysis show previous executions and compare real logs without losing drafts", async ({
  page,
}) => {
  const fixture = await prepareAnalysis(page);
  const card = page.locator(".failure-analysis-card").filter({ hasText: fixture.failedNames[0] });
  await card.getByRole("button", { name: "开始分析" }).click();
  const analysis = page.getByRole("dialog", { name: `分析 ${fixture.failedNames[0]}` });
  const history = analysis.getByRole("region", { name: "前 5 次执行结果" });
  await expect(history.locator("tbody tr")).toHaveCount(5);
  await expect(history.locator("tbody tr").first()).toContainText("#980");
  await expect(history.locator("tbody tr").first()).toContainText("通过");
  await expect(history.getByRole("link").first()).toHaveAttribute("target", "_blank");
  await analysis.getByLabel("代码问题已提单", { exact: false }).check();
  await analysis.getByLabel("问题说明 *").fill("对比历史执行后确认响应状态回归");
  await history.scrollIntoViewIfNeeded();
  await screenshot(page, "single-history-1536");
  const compareButton = history.getByRole("button", { name: "日志对比" }).first();
  let delayLogReads = true;
  await page.route("**/api/v1/run-attempts/*/logs?**", async (route) => {
    if (delayLogReads) await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await route.continue();
  });
  await compareButton.click();
  const comparison = page.getByRole("dialog", { name: `日志对比 · ${fixture.failedNames[0]}` });
  await expect(comparison.getByRole("progressbar", { name: "日志加载进度" })).toBeVisible();
  await expect(comparison).toContainText("正在连续加载两侧日志");
  await screenshot(page, "log-comparison-loading-1536");
  await expect(comparison).toContainText("2 处差异");
  delayLogReads = false;
  await page.unroute("**/api/v1/run-attempts/*/logs?**");
  await expect(comparison.getByRole("progressbar", { name: "日志加载进度" })).toHaveCount(0);
  await expect(comparison.getByRole("region", { name: "历史日志", exact: true })).toContainText(
    "响应状态：200",
  );
  await expect(comparison.getByRole("region", { name: "本次分析日志", exact: true })).toContainText(
    "响应状态：500",
  );
  await expect(comparison.locator('[data-change="removed"]')).toHaveCount(1);
  await expect(comparison.locator('[data-change="added"]')).toHaveCount(1);
  await expect(comparison).toContainText("单页连续对比 420 行");
  await expect(comparison.getByRole("button", { name: /上一页日志|下一页日志/u })).toHaveCount(0);
  for (const width of [1536, 1024]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expectUiIntegrity(page);
    await screenshot(page, `log-comparison-${width}`);
  }
  const windows = comparison.locator(".analysis-log-lines");
  await windows.first().evaluate((element) => {
    element.scrollTop = 400;
  });
  await expect.poll(() => windows.last().evaluate((element) => element.scrollTop)).toBe(400);
  await comparison.getByRole("button", { name: "下一处差异" }).click();
  await comparison.getByRole("button", { name: "下一处差异" }).click();
  await expect(comparison.locator('[data-selected="true"]').first()).toBeVisible();
  await comparison.getByRole("button", { name: "对比日志流" }).click();
  await comparison.getByRole("option", { name: "执行机诊断" }).click();
  await expect(comparison).toContainText("本次仅对比各日志开头最多 2,000 行");
  await expect(comparison).toContainText("单页连续对比 2,000 行");
  const longLogWindows = comparison.locator(".analysis-log-lines");
  expect(await comparison.locator(".analysis-log-line").count()).toBeLessThan(160);
  await longLogWindows.first().evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => longLogWindows.last().evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(longLogWindows.first().locator('[data-diff-row="1999"]')).toHaveCount(1);
  await comparison.getByRole("button", { name: "对比日志流" }).click();
  await comparison.getByRole("option", { name: "错误输出" }).click();
  await expect(comparison).toContainText("两侧均暂无日志");
  await page.keyboard.press("Escape");
  await expect(comparison).toHaveCount(0);
  await expect(analysis.getByLabel("问题说明 *")).toHaveValue("对比历史执行后确认响应状态回归");
  await expect(compareButton).toBeFocused();
  await analysis.getByRole("button", { name: "关闭分析弹窗" }).click();

  for (const name of fixture.failedNames.slice(0, 2)) {
    await page
      .locator(".failure-analysis-card")
      .filter({ hasText: name })
      .getByRole("checkbox")
      .check();
  }
  await page.getByRole("button", { name: "批量分析" }).click();
  const bulk = page.getByRole("dialog", { name: "批量分析 2 个用例" });
  const bulkHistory = bulk.getByRole("region", { name: "前 5 次执行结果" });
  await expect(bulkHistory.locator("tbody tr")).toHaveCount(5);
  await bulk.getByRole("button", { name: "选择查看执行历史的用例" }).click();
  await bulk.getByRole("option", { name: new RegExp(fixture.failedNames[1]) }).click();
  await expect(bulkHistory.locator("tbody tr").first()).toContainText("失败");
  await bulkHistory.scrollIntoViewIfNeeded();
  await bulk.locator(".runner-update-body").evaluate((element) => {
    element.scrollTop += 180;
  });
  await screenshot(page, "bulk-history-1024");
  await bulkHistory.getByRole("button", { name: "日志对比" }).first().click();
  const bulkComparison = page.getByRole("dialog", { name: `日志对比 · ${fixture.failedNames[1]}` });
  await expect(
    bulkComparison.getByRole("region", { name: "本次分析日志", exact: true }),
  ).toContainText("用例 1 响应状态：500");
  await page.keyboard.press("Escape");
  await bulk.getByRole("button", { name: "关闭分析弹窗" }).click();
});

test("history and log failures are recoverable and missing executions do not become false matches", async ({
  page,
}) => {
  const fixture = await prepareAnalysis(page);
  const claim = fixture.claims[0]!;
  const scopeQuery = new URLSearchParams({ projectId: DEFAULT_PROJECT_ID, analysisId: claim.id });
  const response = await browserJson<FailureAnalysisExecutionHistory>(
    page,
    `/api/v1/failure-analysis/executions?${scopeQuery}`,
  );
  expect(response.status).toBe(200);
  expect(response.body.items).toHaveLength(5);
  const wrongProject = await browserJson(
    page,
    `/api/v1/failure-analysis/executions?projectId=another-project&analysisId=${claim.id}`,
  );
  expect(wrongProject.status).toBe(404);

  let failHistory = true;
  await page.route("**/api/v1/failure-analysis/executions?**", async (route) => {
    if (failHistory)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "执行历史暂不可用。" } }),
      });
    else await route.continue();
  });
  await page
    .locator(".failure-analysis-card")
    .filter({ hasText: fixture.failedNames[0] })
    .getByRole("button", { name: "开始分析" })
    .click();
  const analysis = page.getByRole("dialog", { name: `分析 ${fixture.failedNames[0]}` });
  await expect(analysis.getByRole("alert")).toContainText("执行历史暂不可用");
  failHistory = false;
  await analysis.getByRole("button", { name: "重新加载历史" }).click();
  await expect(analysis.locator(".analysis-execution-table tbody tr")).toHaveCount(5);
  let failLog = true;
  await page.route(`**/run-attempts/${fixture.previousAttemptIds[0]}/logs?**`, async (route) => {
    if (failLog)
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "没有查看历史日志的权限。" } }),
      });
    else await route.continue();
  });
  await analysis.getByRole("button", { name: "日志对比" }).first().click();
  const comparison = page.getByRole("dialog", { name: `日志对比 · ${fixture.failedNames[0]}` });
  await expect(comparison.getByRole("alert")).toContainText("没有查看历史日志的权限");
  await expect(comparison).not.toContainText("日志内容一致");
  failLog = false;
  await comparison.getByRole("button", { name: "重新加载对比日志" }).click();
  await expect(comparison).toContainText("2 处差异");
  await page.keyboard.press("Escape");
  await analysis.getByRole("button", { name: "关闭分析弹窗" }).click();
  await page
    .locator(".failure-analysis-card")
    .filter({ hasText: fixture.failedNames[3] })
    .getByRole("button", { name: "开始分析" })
    .click();
  await expect(page.getByRole("dialog", { name: `分析 ${fixture.failedNames[3]}` })).toContainText(
    "暂无更早的执行结果",
  );
});

test("quality insight comparison preserves scroll, can rerun, and compares both batch logs", async ({
  page,
}) => {
  const fixture = await prepareAnalysis(page);
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto("/insights");
  const comparisonCard = page.locator(".insight-comparison-card");
  await expect(comparisonCard).toBeVisible({ timeout: 30_000 });
  await comparisonCard.getByRole("button", { name: "选择基准批次" }).click();
  const baselineOption = page.getByRole("option", { name: /^#980/u });
  await expect(baselineOption).toBeVisible({ timeout: 10_000 });
  await baselineOption.click();
  await comparisonCard.getByRole("button", { name: "选择对比批次" }).click();
  const candidateOption = page.getByRole("option", { name: /^#991/u });
  await expect(candidateOption).toBeVisible({ timeout: 10_000 });
  await candidateOption.click();
  await comparisonCard.scrollIntoViewIfNeeded();
  const initialScrollTop = await page.evaluate(() => window.scrollY);
  expect(initialScrollTop).toBeGreaterThan(0);

  const startComparison = comparisonCard.getByRole("button", { name: "开始对比" });
  await startComparison.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("leftBatchId"))
    .toBe(fixture.historyBatchIds[0]);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("rightBatchId"))
    .toBe(fixture.batchId);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(initialScrollTop);
  await expect(comparisonCard.getByRole("button", { name: "查看明细" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(startComparison).toBeEnabled();

  const repeatedScrollTop = await page.evaluate(() => window.scrollY);
  await startComparison.click();
  await expect(startComparison).toBeEnabled({ timeout: 15_000 });
  await expect(startComparison).toHaveText("开始对比");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(repeatedScrollTop);
  await expectUiIntegrity(page);
  await screenshot(page, "quality-comparison-1536");

  await comparisonCard.getByRole("button", { name: "查看明细" }).click();
  const details = page.getByRole("dialog", { name: "批次对比明细" });
  const compareLogs = details.getByRole("button", { name: /对比 .* 的两次执行日志/u }).first();
  await expect(compareLogs).toBeEnabled();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectUiIntegrity(page);
  await screenshot(page, "quality-comparison-details-1024");
  await compareLogs.click();
  const logComparison = page.getByRole("dialog", { name: /日志对比 ·/u });
  await expect(logComparison.getByRole("region", { name: "基准批次日志" })).toContainText(
    "响应状态：200",
  );
  await expect(logComparison.getByRole("region", { name: "对比批次日志" })).toContainText(
    "响应状态：500",
  );
  await expect(logComparison).toContainText("单页连续对比 420 行");
  await expectUiIntegrity(page);
  await screenshot(page, "quality-comparison-log-diff-1024");
  await page.setViewportSize({ width: 1536, height: 960 });
  await expectUiIntegrity(page);
  await screenshot(page, "quality-comparison-log-diff-1536");
  await page.keyboard.press("Escape");
  await expect(logComparison).toHaveCount(0);
  await expect(details).toBeVisible();
  await expect(compareLogs).toBeFocused();
});

async function prepareAnalysis(page: Page) {
  await ensureAdministrator(page);
  const suffix = uniqueName("log-diff");
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: `日志对比版本 ${suffix}` } },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR!;
  const fixture = insertFailureAnalysisFixture(directory, version.body.id, suffix);
  const histories = await insertAnalysisExecutionHistory(directory, fixture.batchId, suffix);
  const input = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: version.body.id,
    batchId: fixture.batchId,
  };
  expect(
    (await browserJson(page, "/api/v1/failure-analysis/batches", { method: "POST", body: input }))
      .status,
  ).toBe(201);
  const claimed = await browserJson<{ claimed: FailureAnalysisClaimView[] }>(
    page,
    "/api/v1/failure-analysis/claims",
    {
      method: "POST",
      body: {
        ...input,
        executionRunIds: [0, 1, 2, 3].map((index) => `run-failed-${index}-${suffix}`),
      },
    },
  );
  expect(claimed.status).toBe(201);
  await page.goto(`/case-analysis/${fixture.batchId}?view=workbench`);
  await expect(page.locator(".failure-analysis-card")).toHaveCount(4);
  return { ...fixture, ...histories, claims: claimed.body.claimed };
}

async function screenshot(page: Page, name: string) {
  const directory = resolve("test-results/analysis-log-comparison");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}
