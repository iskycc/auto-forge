import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { readExportedWorkbook } from "./support/export-workbook";
import { resolve } from "node:path";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { openExecutionCaseDetails, closeExecutionCaseDetails } from "./support/execution-details";
import { expectUiIntegrity } from "./support/ui-guard";

test("console and anonymous execution overviews isolate full-screen case details with one close action", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    {
      method: "POST",
      body: { name: uniqueName("执行布局") },
    },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("Execution layout fixture requires AUTOFORGE_E2E_DATA_DIR.");
  const fixture = insertFailureAnalysisFixture(directory, version.body.id, uniqueName("layout"));
  const addresses = Array.from({ length: 12 }, (_, index) => `192.168.100.${index + 1}`);
  const failureSummary =
    "java.lang.AssertionError: 预期交易状态与实际返回不一致\n" +
    "at wallet.payment.RefundVerification.verifyCompleteResponse(RefundVerification.java:188)\n".repeat(
      20,
    );
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database
      .prepare(
        "UPDATE run_batches SET suite_name=?,policy_json=?,scheduled_for=?,retry_mode='round',retry_limit=2 WHERE id=?",
      )
      .run(
        "支付钱包与账户管理完整回归任务 · 多环境并发执行与最终结果验证（含历史失败重跑）",
        JSON.stringify({ projectVersionId: version.body.id, environmentAddresses: addresses }),
        new Date(Date.now() - 75000).toISOString(),
        fixture.batchId,
      );
    database
      .prepare(
        "UPDATE run_attempts SET result_summary=? WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id=? AND status='failed')",
      )
      .run(failureSummary, fixture.batchId);
    database
      .prepare(
        "UPDATE execution_runs SET display_name=display_name||?,class_name=class_name||? WHERE batch_id=? AND status='failed'",
      )
      .run("超长用例名称与场景说明".repeat(10), ".verylongpackage".repeat(10), fixture.batchId);
  } finally {
    database.close();
  }
  const share = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-batches/${fixture.batchId}/share`,
    { method: "POST" },
  );
  expect(share.status).toBe(200);
  const anonymous = await browser.newContext();
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  try {
    const visitor = await anonymous.newPage();
    for (const [target, url, access] of [
      [page, `/run-batches/${fixture.batchId}`, "console"],
      [visitor, share.body.shareUrl, "anonymous"],
    ] as const) {
      const errors: string[] = [];
      let caseRequests = 0;
      target.on("pageerror", (cause) => errors.push(cause.message));
      target.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith(`/run-batches/${fixture.batchId}/cases`))
          caseRequests += 1;
      });
      for (const theme of ["light", "dark"]) {
        await target
          .context()
          .addCookies([
            { name: "autoforge-color-mode", value: theme, url: "http://127.0.0.1:3100" },
          ]);
        caseRequests = 0;
        await target.goto(url);
        await expect(
          target.getByRole("region", { name: "本次执行环境", exact: true }),
        ).toContainText(addresses.at(-1)!);
        const charts = target.getByRole("region", { name: "执行结果图表", exact: true });
        await expect(charts).toBeVisible();
        await expect(target.locator(".execution-case-table")).toHaveCount(0);
        await expect(target.getByRole("dialog")).toHaveCount(0);
        const chartBounds = (await charts.boundingBox())!;
        expect(chartBounds.y + chartBounds.height).toBeLessThan(
          (await target.getByRole("region", { name: "轮次列表", exact: true }).boundingBox())!.y,
        );
        expect(caseRequests, "overview must not fetch hidden case pages").toBe(0);
        for (const width of [1024, 1536, 1920]) {
          await target.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
          await target.evaluate(() => window.scrollTo(0, 0));
          await expectUiIntegrity(target);
          await target.screenshot({
            path: resolve(screenshots, `overview-${access}-${theme}-${width}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
        await target
          .getByRole("button", { name: "查看用例明细", exact: true })
          .scrollIntoViewIfNeeded();
        const overviewScroll = await target.evaluate(() => window.scrollY);
        const overviewUrl = target.url();
        const overviewText = await charts.innerText();
        await openExecutionCaseDetails(target);
        const workspace = target.getByRole("dialog", { name: "用例执行明细", exact: true });
        await expect(target.locator(".round-row-actions")).toHaveCount(5);
        await expect(workspace.getByRole("button", { name: "关闭明细", exact: true })).toHaveCount(
          1,
        );
        await expect(workspace.locator(".ant-modal-close, .ant-modal-footer")).toHaveCount(0);
        await target.keyboard.press("Escape");
        await expect(workspace).toBeVisible();
        await target.locator(".ant-modal-mask").dispatchEvent("click");
        await expect(workspace).toBeVisible();
        for (const width of [1024, 1536, 1920]) {
          await target.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
          await expectUiIntegrity(target);
          const bounds = (await workspace.boundingBox())!;
          const viewport = target.viewportSize()!;
          expect(Math.abs(bounds.x)).toBeLessThan(2);
          expect(Math.abs(bounds.y)).toBeLessThan(2);
          expect(Math.abs(bounds.width - viewport.width)).toBeLessThan(2);
          expect(Math.abs(bounds.height - viewport.height)).toBeLessThan(2);
          const heights = await target
            .locator(".execution-case-result-row")
            .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
          expect(heights).toHaveLength(5);
          expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(2);
          await target.screenshot({
            path: resolve(screenshots, `workspace-${access}-${theme}-${width}.png`),
            animations: "disabled",
          });
        }
        if (access === "anonymous") {
          for (const scope of ["summary", "all", "1"]) {
            await workspace
              .getByLabel("明细查看范围")
              .and(workspace.locator("select"))
              .selectOption(scope);
            await workspace.getByRole("button", { name: "导出结果", exact: true }).click();
            const exportDialog = target.getByRole("dialog", { name: "导出执行结果", exact: true });
            await expect(exportDialog).toBeVisible();
            await expect(exportDialog).not.toHaveClass(/ant-zoom-(?:appear|enter)/u);
            await expect(exportDialog.getByRole("radio", { name: /分析/ })).toHaveCount(0);
            await expect(
              exportDialog.getByRole("button", { name: "导出失败日志 ZIP", exact: true }),
            ).toHaveCount(0);
            if (scope === "summary")
              for (const width of [1024, 1536]) {
                await target.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
                await expectUiIntegrity(target);
                await target.screenshot({
                  path: resolve(screenshots, `public-export-${theme}-${width}.png`),
                });
              }
            const [download] = await Promise.all([
              target.waitForEvent("download"),
              exportDialog.getByRole("button", { name: "导出 Excel", exact: true }).click(),
            ]);
            const file = await download.path();
            expect(file).not.toBeNull();
            const workbook = await readExportedWorkbook(await readFile(file!));
            expect(workbook.worksheets[0]!.rowCount).toBeGreaterThan(1);
            expect(workbook.worksheets[0]!.getRow(1).values!.toString()).not.toContain(
              "AI 初步分析",
            );
            await expect(exportDialog).not.toBeVisible();
          }
          await workspace
            .getByLabel("明细查看范围")
            .and(workspace.locator("select"))
            .selectOption("summary");
        }
        await workspace
          .getByRole("button", { name: /^查看执行结果：失败/ })
          .first()
          .click();
        const content = target.getByRole("dialog", { name: "用例执行信息", exact: true });
        await expect(content).toContainText(failureSummary);
        for (const width of [1024, 1536]) {
          await target.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
          await expectUiIntegrity(target);
          await target.screenshot({
            path: resolve(screenshots, `content-${access}-${theme}-${width}.png`),
            animations: "disabled",
          });
        }
        await content.press("Escape");
        await expect(content).toHaveCount(0);
        await expect(workspace).toBeVisible();
        const scope = workspace.locator('select[aria-label="明细查看范围"]');
        await scope.selectOption("summary");
        await expect(
          workspace.getByRole("region", { name: "轮次详情：总结", exact: true }),
        ).toBeVisible();
        await scope.selectOption("all");
        await expect(
          workspace.getByRole("columnheader", { name: "轮次", exact: true }),
        ).toBeVisible();
        await scope.selectOption("1");
        await expect(target.locator(".round-row-actions")).toHaveCount(5);
        await workspace.locator('select[aria-label="按状态筛选"]').selectOption("succeeded");
        await expect(target.locator(".round-row-actions")).toHaveCount(1);
        await workspace.locator('select[aria-label="按状态筛选"]').selectOption("failed");
        await expect(target.locator(".round-row-actions")).toHaveCount(4);
        await workspace.locator('select[aria-label="按状态筛选"]').selectOption("all");
        await workspace
          .getByRole("textbox", { name: "按名称搜索用例", exact: true })
          .fill("PassedTest");
        await expect(target.locator(".round-row-actions")).toHaveCount(1);
        await workspace.getByRole("textbox", { name: "按名称搜索用例", exact: true }).fill("");
        await expect(target.locator(".round-row-actions")).toHaveCount(5);
        expect(target.url()).toBe(overviewUrl);
        expect(await charts.innerText()).toBe(overviewText);
        if (access === "anonymous") {
          await expect(
            workspace.getByRole("button", { name: "导出结果", exact: true }),
          ).toHaveCount(1);
          for (const name of [
            "终止任务",
            "再次执行",
            "以未通过用例创建任务",
            "总体调度日志",
            "AI 初步分析",
          ])
            await expect(workspace.getByRole("button", { name, exact: true })).toHaveCount(0);
          await expect(
            workspace.getByRole("link", { name: "查看公开日志", exact: true }).first(),
          ).toHaveAttribute("target", "_blank");
        } else {
          await workspace
            .locator(".round-row-actions")
            .first()
            .getByRole("button", { name: "详情", exact: true })
            .click();
          const details = target.getByRole("dialog", { name: "结构化执行详情", exact: true });
          await expect(details).toBeVisible();
          await details.press("Escape");
          await expect(workspace).toBeVisible();
          await workspace.getByRole("button", { name: "导出结果", exact: true }).click();
          const exporting = target.getByRole("dialog", { name: "导出执行结果", exact: true });
          await expect(exporting).toBeVisible();
          await exporting.press("Escape");
          await expect(exporting).toHaveCount(0);
          await expect(workspace).toBeVisible();
        }
        // Return to the viewport where the overview's scroll position was recorded.
        await target.setViewportSize({ width: 1920, height: 960 });
        await closeExecutionCaseDetails(target);
        await expect(target.locator(".execution-case-table")).toHaveCount(0);
        await expect(
          target.getByRole("button", { name: "查看用例明细", exact: true }),
        ).toBeFocused();
        expect(
          Math.abs((await target.evaluate(() => window.scrollY)) - overviewScroll),
        ).toBeLessThan(2);
        expect(target.url()).toBe(overviewUrl);
        await expectUiIntegrity(target);
        // Closing the only case workspace aborts a pending page request.
        await openExecutionCaseDetails(target);
        const pendingUrl = new RegExp(
          `/api/v1/run-batches/${fixture.batchId}/cases[?].*pageSize=100`,
        );
        let releaseRequest!: () => void;
        const heldRequest = new Promise<void>((resolve) => {
          releaseRequest = resolve;
        });
        await target.route(pendingUrl, async () => {
          await heldRequest;
        });
        const started = target.waitForRequest(pendingUrl);
        await target.locator('select[aria-label="每页显示用例数"]').selectOption("100");
        const request = await started;
        const aborted = target.waitForEvent("requestfailed", (failed) => failed === request);
        await closeExecutionCaseDetails(target);
        await aborted;
        releaseRequest();
        await target.unroute(pendingUrl);
      }
      expect(errors).toEqual([]);
    }
  } finally {
    await anonymous.close();
  }
});

test("retry charts use only eligible round members and task actions keep a consistent alignment", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("轮次图表") } },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const { insertRoundChartFixture } = await import("./support/round-chart-fixture");
  const fixture = await insertRoundChartFixture(version.body.id);
  const share = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-batches/${fixture.batchId}/share`,
    { method: "POST" },
  );
  expect(share.status).toBe(200);
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  const anonymous = await browser.newContext();
  try {
    const visitor = await anonymous.newPage();
    for (const [target, url, access] of [
      [page, `/run-batches/${fixture.batchId}?round=2`, "console"],
      [visitor, `${share.body.shareUrl}&round=2`, "public"],
    ] as const) {
      for (const mode of ["light", "dark"]) {
        await target
          .context()
          .addCookies([
            { name: "autoforge-color-mode", value: mode, url: new URL(page.url()).origin },
          ]);
        await target.goto(url);
        const charts = target.getByRole("region", { name: "执行结果图表", exact: true });
        await expect(
          charts.getByRole("img", {
            name: /结果分布：通过 4，失败 6，超时 0，进行中 0，取消 0，未执行 0$/u,
          }),
        ).toBeVisible();
        await expect(charts).toContainText("本轮用例 10 个");
        await expect(
          charts.getByRole("img", {
            name: "总体通过进度：累计通过 94 个用例，共 100 个",
            exact: true,
          }),
        ).toBeVisible();
        for (const width of [1024, 1536, 2560]) {
          await target.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
          await charts.scrollIntoViewIfNeeded();
          await expectUiIntegrity(target);
          await target.evaluate(() => window.scrollTo(0, 0));
          await target.screenshot({
            path: resolve(screenshots, `round-charts-${access}-${mode}-${width}.png`),
            fullPage: true,
          });
          const legends = await charts.locator(".round-donut-legend").evaluateAll((elements) =>
            elements.map((element) => ({
              width: element.getBoundingClientRect().width,
              overflow: element.scrollWidth - element.clientWidth,
              rows: Array.from(element.children).map((row) => ({
                width: row.getBoundingClientRect().width,
                border: parseFloat(getComputedStyle(row).borderBottomWidth),
              })),
            })),
          );
          expect(legends).toHaveLength(2);
          for (const legend of legends) {
            expect(legend.width, "chart legends stay compact on wide screens").toBeLessThanOrEqual(
              176,
            );
            expect(
              legend.overflow,
              "chart labels and counts remain inside the legend",
            ).toBeLessThanOrEqual(1);
            expect(legend.rows.at(-1)?.border, "the last status has no extra divider").toBe(0);
            for (const row of legend.rows.slice(0, -1)) {
              expect(row.border, "status rows retain subtle separators").toBe(1);
              expect(
                row.width,
                "separators stay short and inset within the legend",
              ).toBeLessThanOrEqual(152);
            }
          }
        }
        await target.goto(url.replace("round=2", "round=summary"));
        await expect(
          charts.getByRole("img", {
            name: /结果分布：通过 94，失败 6，超时 0，进行中 0，取消 0，未执行 0$/u,
          }),
        ).toBeVisible();
        await target.goto(url.replace("round=2", "round=all"));
        await expect(
          charts.getByRole("img", {
            name: /结果分布：通过 94，失败 16，超时 0，进行中 0，取消 0，未执行 0$/u,
          }),
        ).toBeVisible();
        await expect(charts).toContainText("累计执行数 110 个");
      }
    }
  } finally {
    await anonymous.close();
  }
  const sparse = await browserJson<{ id: string; revision: number }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      name: uniqueName("少按钮任务"),
      adapter: { enabled: false, suiteName: "", testName: "", environmentAddresses: [] },
    },
  });
  expect(sparse.status).toBe(201);
  const peer = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: {
      username: uniqueName("chart-lock-peer"),
      displayName: "其他任务维护人",
      password: "ChartPeer!Password123",
      forcePasswordChange: false,
    },
  });
  expect(peer.status).toBe(201);
  const { openHistoryFixtureConnection } = await import("./support/history-fixture-connection");
  const db = await openHistoryFixtureConnection({
    directory: process.env.AUTOFORGE_E2E_POSTGRES_URL
      ? undefined
      : process.env.AUTOFORGE_E2E_DATA_DIR,
    postgresUrl: process.env.AUTOFORGE_E2E_POSTGRES_URL,
  });
  try {
    await db.execute("UPDATE case_suites SET locked_by=?,locked_by_name=?,locked_at=? WHERE id=?", [
      peer.body.id,
      "其他任务维护人",
      new Date().toISOString(),
      sparse.body.id,
    ]);
  } finally {
    await db.close();
  }
  for (const mode of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: mode, url: new URL(page.url()).origin }]);
    await page.goto("/case-suites");
    const cards = page.locator(".suite-card");
    await expect(cards).toHaveCount(2);
    for (const width of [1024, 1536, 1920]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      for (const card of await cards.all()) {
        const footer = card.locator("footer");
        await expect(footer).toHaveCSS("justify-content", "space-evenly");
        await expect(footer).toHaveCSS("align-items", "center");
        const rows = await footer.evaluate((element) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const contentLeft =
            bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
          const contentRight =
            bounds.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
          const boxes = Array.from(element.children)
            .map((child) => child.getBoundingClientRect())
            .filter((box) => box.width > 0 && box.height > 0);
          const grouped: Array<{ center: number; boxes: DOMRect[] }> = [];
          for (const box of boxes) {
            const center = box.y + box.height / 2;
            let row = grouped.find((candidate) => Math.abs(candidate.center - center) < 2);
            if (!row) {
              row = { center, boxes: [] };
              grouped.push(row);
            }
            row.boxes.push(box);
          }
          return grouped.map((row) => ({
            left: row.boxes[0]!.left - contentLeft,
            right: contentRight - row.boxes.at(-1)!.right,
            columnGap: parseFloat(style.columnGap),
            gaps: row.boxes.slice(1).map((box, index) => box.left - row.boxes[index]!.right),
          }));
        });
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(Math.abs(row.left - row.right), "each wrapped row stays centered").toBeLessThan(2);
          for (const gap of row.gaps) {
            expect(gap).toBeGreaterThanOrEqual(row.columnGap);
            expect(
              Math.abs(gap - row.columnGap - row.left),
              "actions share the remaining row space evenly",
            ).toBeLessThan(2);
          }
        }
      }
      await page.screenshot({
        path: resolve(screenshots, `task-actions-${mode}-${width}.png`),
        fullPage: true,
      });
    }
  }
});
