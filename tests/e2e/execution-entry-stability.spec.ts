import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";

async function fixture(page: import("@playwright/test").Page) {
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("执行首屏") } },
  );
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("Missing Lite fixture directory.");
  const suffix = uniqueName("entry");
  const batch = insertFailureAnalysisFixture(directory, version.body.id, suffix);
  const db = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  try {
    db.prepare(
      "UPDATE run_batches SET current_round=3,retry_limit=2,retry_mode='round' WHERE id=?",
    ).run(batch.batchId);
  } finally {
    db.close();
  }
  return batch;
}

test("execution entry defaults to summary and retains explicit round deep links", async ({
  page,
}) => {
  const batch = await fixture(page);
  await page.goto(`/run-batches/${batch.batchId}`);
  await expect(page.getByText("当前查看：总结", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看用例明细", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用例执行明细", exact: true });
  await expect(dialog.locator('select[aria-label="明细查看范围"]')).toHaveValue("summary");
  await dialog.getByRole("button", { name: "关闭明细", exact: true }).click();
  await page.goto(`/run-batches/${batch.batchId}?round=1`);
  await expect(page.getByText("当前查看：初始轮次", { exact: true })).toBeVisible();
});

type OpeningSample = { width: number; height: number; opacity: string; transform: string };

async function recordOpening(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => {
    const samples: OpeningSample[] = [];
    (
      window as unknown as { entrySamples: OpeningSample[]; entryCaptureDone: boolean }
    ).entrySamples = samples;
    (window as unknown as { entryCaptureDone: boolean }).entryCaptureDone = false;
    let start: number | undefined;
    const sample = () => {
      const element = document.querySelector<HTMLElement>(".execution-case-details-dialog");
      if (element) {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (bounds.width > 0) {
          start ??= performance.now();
          samples.push({
            width: bounds.width,
            height: bounds.height,
            opacity: style.opacity,
            transform: style.transform,
          });
        }
      }
      if (start === undefined || performance.now() - start < 700) requestAnimationFrame(sample);
      else (window as unknown as { entryCaptureDone: boolean }).entryCaptureDone = true;
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole("button", { name: "查看用例明细", exact: true }).click();
  // Sample the complete entry interval, including the native animation's former duration.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { entryCaptureDone: boolean }).entryCaptureDone),
    )
    .toBe(true);
  const samples = await page.evaluate(
    () => (window as unknown as { entrySamples: OpeningSample[] }).entrySamples,
  );
  await testInfo.attach(name, { body: JSON.stringify(samples), contentType: "application/json" });
  expect(samples.length).toBeGreaterThan(2);
  expect(
    samples.every(
      (sample) =>
        sample.width >= page.viewportSize()!.width - 1 &&
        sample.height >= page.viewportSize()!.height - 1 &&
        sample.transform === "none" &&
        Number(sample.opacity) === 1,
    ),
  ).toBe(true);
}

test("execution workspace remains full size through cold loading and cached reopening with normal motion", async ({
  page,
  browser,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const batch = await fixture(page);
  const shared = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-batches/${batch.batchId}/share`,
    { method: "POST" },
  );
  expect(shared.status).toBe(200);
  const visitorContext = await browser.newContext({ reducedMotion: "no-preference" });
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  try {
    const visitor = await visitorContext.newPage();
    for (const [target, url, access] of [
      [page, `/run-batches/${batch.batchId}`, "console"],
      [visitor, shared.body.shareUrl, "anonymous"],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        await target
          .context()
          .addCookies([
            { name: "autoforge-color-mode", value: theme, url: "http://127.0.0.1:3100" },
          ]);
        for (const width of [1024, 1536]) {
          await target.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
          await target.goto(url);
          await expect(target.getByText("当前查看：总结", { exact: true })).toBeVisible();
          let release: () => void = () => undefined;
          const held = new Promise<void>((resolveHold) => {
            release = resolveHold;
          });
          const pattern = `**/run-batches/${batch.batchId}/cases?*`;
          await target.route(
            pattern,
            async (route) => {
              await held;
              await route.continue();
            },
            { times: 1 },
          );
          try {
            await recordOpening(target, testInfo, `cold-${access}-${theme}-${width}`);
            const dialog = target.getByRole("dialog", { name: "用例执行明细", exact: true });
            await expect(dialog.getByText("正在读取当前页用例", { exact: true })).toBeVisible();
            await target.screenshot({
              path: resolve(screenshots, `workspace-loading-${access}-${theme}-${width}.png`),
              animations: "disabled",
            });
            release();
            await expect(dialog.locator(".round-cases tbody tr")).toHaveCount(5);
            await expectUiIntegrity(target);
            await target.screenshot({
              path: resolve(screenshots, `workspace-ready-${access}-${theme}-${width}.png`),
              animations: "disabled",
            });
            await dialog.getByRole("button", { name: "关闭明细", exact: true }).click();
            await recordOpening(target, testInfo, `cached-${access}-${theme}-${width}`);
            await expect(dialog.locator(".round-cases tbody tr")).toHaveCount(5);
            await dialog.getByRole("button", { name: "关闭明细", exact: true }).click();
            await expect(target.getByText("当前查看：总结", { exact: true })).toBeVisible();
          } finally {
            release();
            await target.unroute(pattern);
          }
        }
      }
    }
  } finally {
    await visitorContext.close();
  }
});
