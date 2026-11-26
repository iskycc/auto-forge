import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createAttemptLogStore } from "@autoforge/db/sqlite";
import { documentationArticles } from "../../apps/web/src/lib/user-documentation/catalog";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import { expectPageFitsViewport, expectReadableText, expectUiIntegrity } from "./support/ui-guard";

test("documentation stays at the bottom while reading and preserves section navigation", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  const origin = new URL(testInfo.project.use.baseURL!).origin;
  for (const theme of ["light", "dark"] as const) {
    await page.context().addCookies([{ name: "autoforge-color-mode", value: theme, url: origin }]);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
      await page.goto("/docs/case-logs");
      await expect(
        page.getByRole("heading", {
          name: "阅读公开日志、修改重跑 IP 与查看超时证据",
          exact: true,
        }),
      ).toBeVisible();
      const bottom = await page.evaluate(async () => {
        const expected = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo({ top: expected, behavior: "instant" });
        const positions: number[] = [];
        for (let frame = 0; frame < 40; frame++) {
          await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
          positions.push(window.scrollY);
        }
        return { expected, positions };
      });
      await testInfo.attach(`documentation-bottom-${theme}-${width}.json`, {
        body: JSON.stringify(bottom),
        contentType: "application/json",
      });
      expect(bottom.expected).toBeGreaterThan(200);
      expect(
        Math.min(...bottom.positions),
        "scroll tracking must not pull the reader back to the off-screen directory",
      ).toBeGreaterThanOrEqual(bottom.expected - 1);
      expect(
        Math.max(...bottom.positions) - Math.min(...bottom.positions),
        "the bottom must not oscillate between the article and its directory",
      ).toBeLessThanOrEqual(1);
      await page.mouse.move(width - 100, 300);
      await page.mouse.wheel(0, 1500);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Math.abs(document.documentElement.scrollHeight - innerHeight - scrollY),
          ),
        )
        .toBeLessThanOrEqual(1);
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `documentation-bottom-${theme}-${width}.png`),
        animations: "disabled",
      });
      const directory = page
        .getByRole("navigation", { name: "本页内容", exact: true })
        .getByRole("link", { name: "本页重跑的环境 IP", exact: true });
      await directory.focus();
      await directory.press("Enter");
      await expect(page).toHaveURL(/#rerun-ip$/u);
      await expect(page.locator("section#rerun-ip")).toBeInViewport();
      await page.reload();
      await expect(page.locator("section#rerun-ip")).toBeInViewport();
      await page.goBack();
      await expect(page).toHaveURL(/\/docs\/case-logs$/u);
      await page.goForward();
      await expect(page).toHaveURL(/#rerun-ip$/u);
      await expect(page.locator("section#rerun-ip")).toBeInViewport();
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({
        path: resolve(screenshots, `documentation-directory-${theme}-${width}.png`),
        animations: "disabled",
      });
    }
  }
});

test("anonymous user documentation covers every guide, search history, diagrams and desktop themes", async ({
  page,
}, testInfo) => {
  const origin = new URL(testInfo.project.use.baseURL!).origin;
  const externalRequests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin)
      externalRequests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "让每一次执行都有据可循" })).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await captureDesktopThemes(page, testInfo, "documentation-home");
  const search = page.getByRole("textbox", { name: "搜索使用文档" });
  await search.fill("Jenkins 插件");
  await expect(page).toHaveURL(/q=Jenkins/u);
  await expect(page.getByRole("main").getByText(/找到 \d+ 篇说明/u)).toBeVisible();
  await page.reload();
  await expect(search).toHaveValue("Jenkins 插件");
  await page
    .getByRole("complementary", { name: "文档导航" })
    .getByRole("link", { name: "自动集成", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "接入 Jenkins、API 与依赖更新流水线" }),
  ).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue("Jenkins 插件");
  await search.fill("不存在的功能名称");
  await expect(page.getByRole("main").getByText("没有匹配的文档，请尝试其他关键词")).toBeVisible();
  await captureDesktopThemes(page, testInfo, "documentation-empty-search");
  await page.goto(`/docs?q=${"W".repeat(200)}`);
  await expect(search).toHaveValue("W".repeat(80));
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectUiIntegrity(page);
  await search.fill("");
  await expect(page).toHaveURL(/\/docs$/u);
  for (const article of documentationArticles) {
    await page.goto(`/docs/${article.topic}`);
    await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: new RegExp(article.diagram.title) })).toBeVisible();
    for (const section of article.sections)
      await expect(page.locator(`section#${section.id}`)).toHaveCount(1);
    await expectUiIntegrity(page);
  }
  await page.goto("/docs/ai-analysis#batch-single");
  const batchAnalysis = page.locator("section#batch-single");
  await expect(batchAnalysis).toBeInViewport();
  await expect(batchAnalysis).toContainText("共享结论");
  await expect(page.locator("section#prompts-export")).toContainText("AI分析问题类别");
  await captureDesktopThemes(page, testInfo, "documentation-ai-analysis");
  await page.goto("/docs/project-versions#copy-version");
  const copyVersion = page.locator("section#copy-version");
  await expect(copyVersion).toBeInViewport();
  await expect(copyVersion).toContainText("归档任务的历史执行、结果和日志");
  await captureDesktopThemes(page, testInfo, "documentation-version-copy");
  await page.goto("/docs/case-logs#rerun-ip");
  await expect(page.locator("#rerun-ip")).toBeInViewport();
  await page.reload();
  await expect(page.locator("#rerun-ip")).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await captureDesktopThemes(page, testInfo, "documentation-article");
  // Next.js can send a streamed not-found boundary with an already committed 200.
  await page.goto("/docs/unknown-guide");
  await expect(page).toHaveURL(/\/docs\/unknown-guide$/u);
  await expect(page.getByText("未找到这篇说明", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("the platform topbar and public homepage open the user documentation without leaving the current page", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("支付钱包与账户完整回归验证") } },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  await page.goto("/");
  const originalUrl = page.url();
  const entry = page
    .locator(".topbar-actions")
    .getByRole("link", { name: "使用文档", exact: true });
  await expect(entry).toHaveAttribute("href", "/docs");
  await captureDesktopThemes(page, testInfo, "documentation-topbar");
  const popup = page.waitForEvent("popup");
  await entry.click();
  const docs = await popup;
  await expect(docs.getByRole("heading", { name: "让每一次执行都有据可循" })).toBeVisible();
  await expect(page).toHaveURL(originalUrl);
  await docs.close();
  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    await visitor.goto("/");
    await expect(visitor.getByRole("link", { name: "使用文档", exact: true })).toHaveAttribute(
      "href",
      "/docs",
    );
    await captureDesktopThemes(visitor, testInfo, "documentation-public-home");
  } finally {
    await context.close();
  }
});

test("published task, execution, log and analysis pages deep-link to their own instructions with real data", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    !process.env.AUTOFORGE_E2E_DATA_DIR,
    "The published-result fixture uses the Lite database; public documentation itself is checked in both modes.",
  );
  await ensureAdministrator(page);
  const suffix = uniqueName("documentation");
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: suffix } },
  );
  expect(version.status).toBe(201);
  const fixture = insertFailureAnalysisFixture(
    process.env.AUTOFORGE_E2E_DATA_DIR!,
    version.body.id,
    suffix,
  );
  const database = new DatabaseSync(
    resolve(process.env.AUTOFORGE_E2E_DATA_DIR!, "db", "autoforge.sqlite"),
  );
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database
      .prepare("UPDATE run_batches SET scheduled_for=created_at WHERE id=?")
      .run(fixture.batchId);
  } finally {
    database.close();
  }
  const recordedAt = new Date().toISOString();
  const logs = createAttemptLogStore(resolve(process.env.AUTOFORGE_E2E_DATA_DIR!, "attempt-logs"));
  try {
    await logs.appendChunks({
      batchId: fixture.batchId,
      attemptId: `attempt-run-failed-0-${suffix}`,
      receivedAt: recordedAt,
      chunks: [
        {
          stream: "stdout",
          sequence: 0,
          recordedAt,
          content:
            "[INFO] 开始校验支付钱包状态\n[ERROR] java.lang.AssertionError: 预期状态与返回状态不一致\n at e2e.analysis.Failed0Test.verify(Failed0Test.java:42)\n",
        },
      ],
    });
  } finally {
    logs.close();
  }
  const share = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-batches/${fixture.batchId}/share`,
    { method: "POST" },
  );
  expect(share.status).toBe(200);
  const log = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-attempts/attempt-run-failed-0-${suffix}/log-share`,
    { method: "POST" },
  );
  expect(log.status).toBe(200);
  const analysis = await browserJson(page, "/api/v1/failure-analysis/batches", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      batchId: fixture.batchId,
    },
  });
  expect(analysis.status).toBe(201);
  const publication = await browserJson(
    page,
    `/api/v1/failure-analysis/batches/${fixture.batchId}/publication`,
    { method: "POST" },
  );
  expect(publication.status).toBe(200);
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      name: "文档入口验证 · 支付钱包与账户管理回归任务",
    },
  });
  expect(suite.status).toBe(201);
  const taskLink = await browserJson<{ url: string }>(
    page,
    `/api/v1/case-suites/${suite.body.id}/execution-link`,
    { method: "POST" },
  );
  expect(taskLink.status).toBe(200);
  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    for (const [path, topic, section] of [
      [taskLink.body.url, "public-tasks", "run-and-control"],
      [share.body.shareUrl, "execution-records", "public-progress"],
      [log.body.shareUrl, "case-logs", "public-case-log"],
      [`/CaseAnalysis?BatchId=${fixture.batchId}`, "failure-analysis", "public-analysis"],
    ]) {
      await visitor.goto(path!);
      const entry = visitor.getByRole("link", { name: "使用说明", exact: true });
      await expect(entry).toHaveAttribute("href", `/docs/${topic}#${section}`);
      await expect(entry).toHaveAttribute("target", "_blank");
      await expect(entry).toHaveAttribute("rel", "noopener noreferrer");
      await captureDesktopThemes(visitor, testInfo, `documentation-entry-${topic}`, {
        integrityScope: topic === "failure-analysis" ? "publication-header" : "page",
      });
      const originalUrl = visitor.url();
      const popup = visitor.waitForEvent("popup");
      await entry.click();
      const docs = await popup;
      await expect(docs.locator(`section#${section}`)).toBeInViewport();
      expect(new URL(docs.url()).search).toBe("");
      expect(await docs.evaluate(() => window.opener)).toBeNull();
      await expect(visitor).toHaveURL(originalUrl);
      expect((await visitor.request.get("/api/v1/auth/session")).status()).toBe(401);
      await docs.close();
    }
  } finally {
    await context.close();
  }
});

async function captureDesktopThemes(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { integrityScope?: "page" | "publication-header" } = {},
) {
  const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(directory, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    const toggle = page.getByRole("button", {
      name: theme === "dark" ? "切换到深色模式" : "切换到浅色模式",
      exact: true,
    });
    if (await toggle.isVisible()) await toggle.click();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      if (options.integrityScope === "publication-header") {
        // Pinned sheet columns intentionally overlay offscreen cells. Check the modified header
        // separately; sheet interaction and pinned-column behavior have their own E2E coverage.
        await expectPageFitsViewport(page);
        const header = page.locator("main > header");
        const bounds = (await header.boundingBox())!;
        const controls = await header.locator("button, a[href]").all();
        const boxes = [];
        for (const control of controls) {
          await expect(control).toBeInViewport();
          const box = (await control.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(32);
          expect(box.x).toBeGreaterThanOrEqual(bounds.x);
          expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
          boxes.push(box);
        }
        for (let index = 0; index < boxes.length; index++)
          for (const other of boxes.slice(index + 1)) {
            const box = boxes[index]!;
            const width = Math.max(
              0,
              Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x),
            );
            const height = Math.max(
              0,
              Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y),
            );
            expect(width * height, "publication header controls must not overlap").toBe(0);
          }
      } else await expectUiIntegrity(page);
      if (name === "documentation-home")
        await expectReadableText(
          page.getByRole("main").getByText("阅读指南", { exact: false }).first(),
        );
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: resolve(directory, `${name}-${theme}-${width}.png`),
        animations: "disabled",
      });
    }
  }
}
