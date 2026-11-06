import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import type { FailureAnalysisSheetPage } from "@autoforge/contracts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import { expectUiIntegrity } from "./support/ui-guard";

test("public analysis publication dialog keeps padding and controls inside the desktop modal", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const batch = await fixture(page);
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  const endpoint = `/api/v1/failure-analysis/batches/${batch.batchId}/publication`;
  for (const theme of ["light", "dark"] as const) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
      ]);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.goto(`/case-analysis/${batch.batchId}`);
      let releaseRead: () => void = () => {};
      const heldRead = new Promise<void>((resolveRead) => {
        releaseRead = resolveRead;
      });
      let failPublish = true;
      await page.route(endpoint, async (route) => {
        if (route.request().method() === "GET") await heldRead;
        if (route.request().method() === "POST" && failPublish) {
          failPublish = false;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "PLATFORM_BUSY",
                message: "暂时无法生成公开链接，请稍后重试。".repeat(30),
                requestId: "publication-ui-fixture",
              },
            }),
          });
          return;
        }
        await route.continue();
      });
      const dialog = page.getByRole("dialog", { name: "公开分析链接", exact: true });
      const capture = async (state: string) => {
        await expectUiIntegrity(page);
        const bounds = await dialog.boundingBox();
        const title = await dialog
          .getByRole("heading", { name: "公开分析链接", exact: true })
          .boundingBox();
        expect(title!.x - bounds!.x).toBeGreaterThanOrEqual(20);
        expect(title!.y - bounds!.y).toBeGreaterThanOrEqual(16);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(width === 1024 ? 768 : 960);
        const footer = dialog.locator("footer");
        for (const control of await footer.locator("button,a").all()) {
          await expect(control).toBeInViewport();
          const box = (await control.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(bounds!.x + 20);
          expect(box.x + box.width).toBeLessThanOrEqual(bounds!.x + bounds!.width - 20);
          expect(box.y + box.height).toBeLessThanOrEqual(bounds!.y + bounds!.height - 12);
        }
        await page.screenshot({
          path: resolve(screenshots, `publication-${state}-${theme}-${width}.png`),
          animations: "disabled",
        });
      };
      try {
        await page.getByRole("button", { name: "公开分析", exact: true }).click();
        await expect(dialog.getByText("正在读取链接状态…", { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: /启用并生成链接$/u })).toBeDisabled();
        await capture("loading");
      } finally {
        releaseRead();
      }
      await expect(dialog.getByRole("button", { name: /启用并生成链接$/u })).toBeEnabled();
      await capture("unpublished");
      await dialog.getByRole("button", { name: /启用并生成链接$/u }).click();
      await expect(dialog.getByText(/暂时无法生成公开链接/u)).toBeVisible();
      await capture("error");
      await dialog.getByRole("button", { name: /启用并生成链接$/u }).click();
      const openLink = dialog.getByRole("link", { name: "新标签页查看", exact: true });
      await expect(openLink).toHaveAttribute("href", batch.publicPath);
      await expect(openLink).toHaveAttribute("target", "_blank");
      await capture("published");
      await dialog.locator(".ant-typography-copy").click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(new URL(batch.publicPath, page.url()).href);
      await dialog.getByRole("button", { name: "撤销链接", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "撤销公开分析链接？", exact: true });
      await expect(confirmation).toBeVisible();
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `publication-revoke-${theme}-${width}.png`),
        animations: "disabled",
      });
      await confirmation.getByRole("button", { name: "确认撤销", exact: true }).click();
      await expect(dialog.getByText("当前未启用公开分析。", { exact: true })).toBeVisible();
      await capture("revoked");
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await page.unroute(endpoint);
      const longPath = `${batch.publicPath}&note=${"long-link-segment-".repeat(120)}`;
      await page.route(endpoint, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ path: longPath }),
        }),
      );
      await page.getByRole("button", { name: "公开分析", exact: true }).click();
      await expect(openLink).toHaveAttribute("href", longPath);
      await capture("long-link");
      await dialog.locator(".ant-typography-copy").click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(new URL(longPath, page.url()).href);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await page.unroute(endpoint);
    }
  }
});

async function fixture(page: Page, extraCases = 0, options: { reuseSession?: boolean } = {}) {
  if (!options.reuseSession) await ensureAdministrator(page);
  const suffix = uniqueName("analysis-sheet");
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: suffix } },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("Missing Lite fixture directory.");
  const batch = insertFailureAnalysisFixture(directory, version.body.id, suffix);
  if (extraCases) {
    const db = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      for (let index = 0; index < extraCases; index++) {
        const id = `sheet-extra-${index}-${suffix}`;
        db.prepare(
          `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,terminal_outcome,created_at,updated_at) SELECT ?,batch_id,?,case_version,?,?,'failed',1,'failed',created_at,updated_at FROM execution_runs WHERE batch_id=? AND status='failed' LIMIT 1`,
        ).run(
          id,
          `case-${id}`,
          `额外用例 ${index}`,
          `example.extra.Case${String(index).padStart(3, "0")}`,
          batch.batchId,
        );
        db.prepare(
          `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_summary,created_at,finished_at) SELECT ?,?,runner_id,1,'failed',1,'failed','Assertion extra',created_at,finished_at FROM run_attempts WHERE execution_run_id=?`,
        ).run(`attempt-${id}`, id, `run-failed-0-${suffix}`);
      }
      db.prepare("UPDATE run_batches SET total_runs=total_runs+? WHERE id=?").run(
        extraCases,
        batch.batchId,
      );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  const started = await browserJson(page, "/api/v1/failure-analysis/batches", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      batchId: batch.batchId,
    },
  });
  expect(started.status).toBe(201);
  return {
    ...batch,
    suffix,
    projectVersionId: version.body.id,
    endpoint: `/api/v1/public/failure-analysis/${batch.batchId}`,
    publicPath: `/CaseAnalysis?BatchId=${batch.batchId}`,
  };
}
async function createUser(page: Page, suffix: string) {
  const username = `sheet-${suffix}`.slice(0, 60);
  const password = "Sheet-local-test-only-2026!";
  const created = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: username, password, forcePasswordChange: false },
  });
  expect(created.status).toBe(201);
  return { id: created.body.id, username, password };
}
async function fillAndDrag(
  page: Page,
  caseName: string,
  field: string,
  label: string,
  value: string,
  targetIndex: number,
) {
  await page.getByRole("button", { name: `编辑${label}：${caseName}`, exact: true }).click();
  if (field === "category") {
    await page.getByRole("combobox", { name: `${label}：${caseName}`, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  } else
    await page.getByRole("textbox", { name: `${label}：${caseName}`, exact: true }).fill(value);
  const handle = page.getByRole("button", { name: `向下填充${label}`, exact: true });
  const target = page.locator(`[data-sheet-cell="${targetIndex}:${field}"]`);
  // Keep both ends painted before pressing the mouse; scrolling between down and dragstart cancels native HTML drag.
  await target.scrollIntoViewIfNeeded();
  await expect(handle).toBeInViewport();
  await handle.dragTo(target);
  await expect(page.locator(`[data-sheet-cell="${targetIndex}:${field}"]`)).toContainText(value);
  await expect(page.getByRole("button", { name: "撤销填充", exact: true })).toBeEnabled();
}

for (const width of [1024, 1536])
  test(`published analysis supports in-place login, own claims and drag fill without overwriting another analyst (${width}px)`, async ({
    page,
    browser,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const batch = await fixture(page);
    const first = await createUser(page, `${batch.suffix}-a`);
    const second = await createUser(page, `${batch.suffix}-b`);
    await page.goto(`/case-analysis/${batch.batchId}`);
    await expect(page.getByRole("tab", { name: "表格分析", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: "公开分析", exact: true }).click();
    const publication = page.getByRole("dialog", { name: "公开分析链接", exact: true });
    await publication.getByRole("button", { name: "启用并生成链接", exact: true }).click();
    await expect(publication.getByRole("link", { name: "新标签页查看" })).toHaveAttribute(
      "href",
      batch.publicPath,
    );
    await publication.getByRole("button", { name: "关闭", exact: true }).click();
    const visitor = await browser.newContext({
      reducedMotion: "reduce",
      viewport: { width, height: width === 1024 ? 768 : 960 },
    });
    const colleague = await browser.newContext({ reducedMotion: "reduce" });
    const target = await visitor.newPage();
    const clientErrors: string[] = [];
    target.on("pageerror", (error) => clientErrors.push(error.message));
    try {
      await target.goto(batch.publicPath);
      await expect(target.getByText("访客 · 只读", { exact: true })).toBeVisible();
      await expect(target.getByRole("button", { name: "认领所选", exact: true })).toHaveCount(0);
      expect(
        (
          await browserJson(target, `${batch.endpoint}/claim`, {
            method: "POST",
            body: { executionRunIds: [`run-failed-0-${batch.suffix}`] },
          })
        ).status,
      ).toBe(401);
      await target.getByRole("button", { name: "登录后认领与分析", exact: true }).click();
      const login = target.getByRole("dialog", { name: "登录控制台", exact: true });
      await login.locator('input[name="username"]').fill(first.username);
      await login.locator('input[name="password"]').fill(first.password);
      await login.getByRole("button", { name: "登录", exact: true }).click();
      await expect(target.getByRole("button", { name: "认领所选", exact: true })).toBeVisible();
      expect(new URL(target.url()).pathname).toBe("/CaseAnalysis");
      expect(new URL(target.url()).searchParams.get("BatchId")).toBe(batch.batchId);
      expect(
        (await browserJson(target, `/api/v1/failure-analysis/batches/${batch.batchId}/sheet`))
          .status,
      ).toBe(403);
      const other = await colleague.newPage();
      await other.goto(batch.publicPath);
      expect(
        (
          await browserJson(other, "/api/v1/auth/login", {
            method: "POST",
            body: { username: second.username, password: second.password },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await browserJson(other, `${batch.endpoint}/claim`, {
            method: "POST",
            body: { executionRunIds: [`run-failed-1-${batch.suffix}`] },
          })
        ).status,
      ).toBe(200);
      for (const name of batch.failedNames)
        await target.getByRole("checkbox", { name: `选择用例：${name}`, exact: true }).check();
      await target.getByRole("button", { name: "认领所选", exact: true }).click();
      await expect(
        target.getByText("已认领 3 个用例，1 个已由其他人认领，请刷新查看。", { exact: true }),
      ).toBeVisible();
      await target.getByRole("button", { name: "刷新", exact: true }).click();
      await expect(target.getByRole("row").filter({ hasText: batch.failedNames[1] })).toContainText(
        second.username,
      );
      await fillAndDrag(target, batch.failedNames[0], "category", "分析类别", "代码问题已提单", 3);
      await fillAndDrag(
        target,
        batch.failedNames[0],
        "issueDescription",
        "问题说明",
        "同一故障原因，逐例确认后提单",
        3,
      );
      await fillAndDrag(
        target,
        batch.failedNames[0],
        "ticketReference",
        "问题单",
        "BUG-SHEET-2026",
        3,
      );
      await fillAndDrag(
        target,
        batch.failedNames[0],
        "remark",
        "分析备注",
        "拖拽复制的备注 中文 αβ",
        3,
      );
      await target.getByRole("button", { name: "提交草稿", exact: true }).click();
      await target
        .getByRole("dialog", { name: "提交分析结论", exact: true })
        .getByRole("button", { name: "确认提交", exact: true })
        .click();
      await expect(target.getByText("已提交 3 行分析结论。", { exact: true })).toBeVisible();
      await expect(
        target.getByRole("button", { name: "填充至本页末行", exact: true }),
      ).toBeDisabled();
      const saved = await browserJson<FailureAnalysisSheetPage>(target, batch.endpoint);
      expect(saved.status).toBe(200);
      const completed = saved.body.items.filter((row) => row.analysis?.claimantId === first.id);
      expect(completed).toHaveLength(3);
      for (const row of completed)
        expect(row.analysis).toMatchObject({
          status: "completed",
          category: "code_issue_filed",
          ticketReference: "BUG-SHEET-2026",
          remark: "拖拽复制的备注 中文 αβ",
        });
      const screenshots =
        process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
      await mkdir(screenshots, { recursive: true });
      await target.screenshot({
        path: resolve(screenshots, `analysis-sheet-collaboration-${width}.png`),
      });
      const untouched = saved.body.items.find((row) => row.analysis?.claimantId === second.id)!;
      expect(untouched.analysis?.status).toBe("claimed");
      expect(untouched.analysis?.category).toBeUndefined();
      expect(
        (
          await browserJson(target, `${batch.endpoint}/complete`, {
            method: "POST",
            body: {
              analysisIds: [untouched.analysis!.id],
              category: "code_issue_filed",
              issueDescription: "forged",
              ticketReference: "BUG-forged",
            },
          })
        ).status,
      ).toBe(404);
      await page.getByRole("button", { name: "公开分析", exact: true }).click();
      await publication.getByRole("button", { name: "撤销链接", exact: true }).click();
      await page
        .getByRole("dialog", { name: "撤销公开分析链接？", exact: true })
        .getByRole("button", { name: "确认撤销", exact: true })
        .click();
      await expect(publication.getByText("当前未启用公开分析。", { exact: true })).toBeVisible();
      expect((await browserJson(target, batch.endpoint)).status).toBe(404);
      expect(
        (
          await browserJson(target, `${batch.endpoint}/claim`, {
            method: "POST",
            body: { executionRunIds: [untouched.executionRunId] },
          })
        ).status,
      ).toBe(404);
      await target.reload();
      await expect(target.getByText("公开分析链接不可用", { exact: true })).toBeVisible();
    } catch (cause) {
      await target.screenshot({ path: testInfo.outputPath("public-collaboration-failure.png") });
      await testInfo.attach("public-collaboration-state", {
        body: JSON.stringify({
          url: target.url(),
          clientErrors,
          text: await target.locator("body").innerText(),
        }),
        contentType: "application/json",
      });
      throw cause;
    } finally {
      await visitor.close();
      await colleague.close();
    }
  });

test("analysis spreadsheet has bounded pagination and consistent public/private desktop layouts", async ({
  page,
  browser,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const batch = await fixture(page, 60);
  expect(
    (
      await browserJson(page, `/api/v1/failure-analysis/batches/${batch.batchId}/publication`, {
        method: "POST",
      })
    ).status,
  ).toBe(200);
  const visitor = await browser.newContext({ reducedMotion: "reduce" });
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  try {
    const anonymous = await visitor.newPage();
    for (const [target, path, access] of [
      [page, `/case-analysis/${batch.batchId}`, "console"],
      [anonymous, batch.publicPath, "visitor"],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        await target
          .context()
          .addCookies([
            { name: "autoforge-color-mode", value: theme, url: "http://127.0.0.1:3100" },
          ]);
        for (const width of [1024, 1536]) {
          await target.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
          await target.goto(path);
          await expect(target.locator(".ant-table-tbody tr.ant-table-row")).toHaveCount(50);
          await expectUiIntegrity(target);
          await target.screenshot({
            path: resolve(screenshots, `analysis-sheet-${access}-${theme}-${width}.png`),
            fullPage: false,
          });
        }
      }
      await target.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(target.locator(".ant-table-tbody tr.ant-table-row")).toHaveCount(14);
      await target.getByRole("button", { name: "上一页", exact: true }).click();
      await expect(target.locator(".ant-table-tbody tr.ant-table-row")).toHaveCount(50);
      await target
        .getByRole("textbox", { name: "搜索分析表格", exact: true })
        .fill(batch.failedNames[0]);
      await target.getByRole("button", { name: "搜索", exact: true }).click();
      await expect(target.locator(".ant-table-tbody tr.ant-table-row")).toHaveCount(1);
      await target.reload();
      await expect(target.locator(".ant-table-tbody tr.ant-table-row")).toHaveCount(1);
      await target.getByRole("button", { name: batch.failedNames[0], exact: true }).click();
      const details = target.getByRole("dialog", { name: "用例分析完整内容", exact: true });
      await expect(details).toContainText("Assertion failure 0");
      await target.screenshot({
        path: resolve(screenshots, `analysis-sheet-details-${access}.png`),
      });
      await details.getByRole("button", { name: "关闭", exact: true }).click();
      await target.goBack();
      await expect(target.locator(".ant-table-tbody tr.ant-table-row")).toHaveCount(50);
    }
  } finally {
    await visitor.close();
  }
});

test("spreadsheet keyboard fill keeps rerun proofs per case and retains rejected drafts", async ({
  page,
  browser,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const batch = await fixture(page);
  const otherBatch = await fixture(page, 0, { reuseSession: true });
  expect(
    (
      await browserJson(page, `/api/v1/failure-analysis/batches/${batch.batchId}/publication`, {
        method: "POST",
      })
    ).status,
  ).toBe(200);
  await page.goto(batch.publicPath);
  for (const name of batch.failedNames.slice(2))
    await page.getByRole("checkbox", { name: `选择用例：${name}`, exact: true }).check();
  await page.getByRole("button", { name: "认领所选", exact: true }).click();
  await expect(page.getByText("已认领 2 个用例，可直接填写分析。", { exact: true })).toBeVisible();
  // Candidates put unclaimed cases first after a reload; keep this loaded, stable row order while editing.
  const first = batch.failedNames[2];
  await page.getByRole("button", { name: `编辑分析类别：${first}`, exact: true }).click();
  await page.getByRole("combobox", { name: `分析类别：${first}`, exact: true }).click();
  await page.getByRole("option", { name: "重跑通过", exact: true }).click();
  const handle = page.getByRole("button", { name: "向下填充分析类别", exact: true });
  await handle.focus();
  await handle.press("ArrowDown");
  await handle.press("Enter");
  await page.getByRole("button", { name: "撤销填充", exact: true }).click();
  await expect(page.getByText("1 行草稿", { exact: true })).toBeVisible();
  await handle.focus();
  await handle.press("ArrowDown");
  await handle.press("Enter");
  await page.getByRole("button", { name: "提交草稿", exact: true }).click();
  await page
    .getByRole("dialog", { name: "提交分析结论", exact: true })
    .getByRole("button", { name: "确认提交", exact: true })
    .click();
  await expect(
    page.getByText("已提交 0 行，2 行未提交，草稿已保留，请查看行内原因。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/未检测到公开日志页重跑通过记录，请粘贴执行通过截图/u)).toHaveCount(
    2,
  );
  await page.getByRole("button", { name: `更多操作：${first}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "查看 / 补充证明", exact: true }).click();
  const proof = page.getByRole("dialog", { name: "分析证明", exact: true });
  await proof.locator('input[type="file"]').setInputFiles({
    name: "pass.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(
    proof.getByText("本用例证明已保存；分析结论仍需在表格中提交。", { exact: true }),
  ).toBeVisible();
  await proof.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "提交草稿", exact: true }).click();
  await page
    .getByRole("dialog", { name: "提交分析结论", exact: true })
    .getByRole("button", { name: "确认提交", exact: true })
    .click();
  await expect(
    page.getByText("已提交 1 行，1 行未提交，草稿已保留，请查看行内原因。", { exact: true }),
  ).toBeVisible();
  const result = await browserJson<FailureAnalysisSheetPage>(page, batch.endpoint);
  const completed = result.body.items.find((row) => row.caseName === first)!;
  const pending = result.body.items.find((row) => row.caseName === batch.failedNames[3])!;
  expect(completed.analysis?.status).toBe("completed");
  expect(completed.analysis?.screenshot).toBeDefined();
  expect(pending.analysis?.status).toBe("claimed");
  expect(pending.analysis?.screenshot).toBeUndefined();
  await expectUiIntegrity(page);
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, "analysis-sheet-partial-proof-error.png") });
  const visitor = await browser.newContext();
  try {
    const target = await visitor.newPage();
    await target.goto(batch.publicPath);
    const response = await target.request.get(
      `${batch.endpoint}/evidence?${new URLSearchParams({ analysisId: completed.analysis!.id })}`,
    );
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect((await response.body()).byteLength).toBeGreaterThan(0);
    const cross = await target.request.get(
      `${batch.endpoint}/logs?${new URLSearchParams({ executionRunId: `run-failed-0-${otherBatch.suffix}`, stream: "stdout" })}`,
    );
    expect(cross.status()).toBe(404);
  } finally {
    await visitor.close();
  }
});
