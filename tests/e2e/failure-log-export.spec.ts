import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createAttemptLogStore } from "@autoforge/db/sqlite";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { openExecutionCaseDetails } from "./support/execution-details";
import { expectUiIntegrity } from "./support/ui-guard";
import { readExportedWorkbook } from "./support/export-workbook";

test("independent failure log ZIP exports 2000 complete logs while the platform remains responsive", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("日志ZIP") } },
  );
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("Log fixture requires a Lite data directory.");
  const suffix = uniqueName("log-zip");
  const fixture = insertFailureAnalysisFixture(directory, version.body.id, suffix);
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  const logs = createAttemptLogStore(join(directory, "attempt-logs"));
  const attempts: { id: string; title: string }[] = Array.from({ length: 4 }, (_, index) => ({
    id: `attempt-run-failed-${index}-${suffix}`,
    title: `e2e.analysis.Failed${index}Test`,
  }));
  const now = new Date().toISOString();
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database
      .prepare(
        "UPDATE run_batches SET total_runs=2001,scheduled_for=?,retry_mode='round' WHERE id=?",
      )
      .run(now, fixture.batchId);
    const insertRun = database.prepare(
      "INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,case_type,status,attempt_count,terminal_outcome,created_at,updated_at) VALUES(?,?,?,1,?,?,?,'failed',1,'failed',?,?)",
    );
    const insertAttempt = database.prepare(
      "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,scheduling_score,outcome,result_code,result_summary,created_at,finished_at) VALUES(?,?,?,1,1,'failed',1,'failed','TESTNG_RESULT','assertion',?,?)",
    );
    database.exec("BEGIN");
    for (let index = 4; index < 2000; index++) {
      const id = `attempt-${suffix}-${index}`;
      const title = index % 2 ? `Wallet_中文CaseID_${index}` : `e2e.wallet.Case${index}`;
      insertRun.run(
        `run-${suffix}-${index}`,
        fixture.batchId,
        `case-${suffix}-${index}`,
        index % 2 ? title : `名称${index}`,
        index % 2 ? "e2e.wallet.SharedDdt" : title,
        index % 2 ? "ddt" : "testng",
        now,
        now,
      );
      insertAttempt.run(id, `run-${suffix}-${index}`, `analysis-runner-${suffix}`, now, now);
      attempts.push({ id, title });
    }
    database.exec("COMMIT");
    for (const [index, attempt] of attempts.entries()) {
      const body = `开始${index} 中文😀\n${"完整堆栈内容 wallet.method:123\n".repeat(index === 0 ? 2000 : 400)}END-${index}`;
      await logs.appendChunks({
        batchId: fixture.batchId,
        attemptId: attempt.id,
        receivedAt: now,
        chunks: [
          { stream: "stdout", sequence: 0, content: "\u001b[3", recordedAt: now },
          { stream: "stdout", sequence: 1, content: `1m${body}\u001b[0m`, recordedAt: now },
          { stream: "stderr", sequence: 0, content: `错误详情-${index}\n`, recordedAt: now },
          { stream: "agent", sequence: 0, content: `执行诊断-${index}\n`, recordedAt: now },
        ],
      });
    }
  } finally {
    database.close();
    logs.close();
  }

  await page.goto(`/run-batches/${fixture.batchId}`);
  await openExecutionCaseDetails(page);
  await page.getByRole("button", { name: "导出结果", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出执行结果", exact: true });
  await dialog.getByRole("radio", { name: /最终结果/u }).check();
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") {
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
        ]);
      await page.reload();
      await openExecutionCaseDetails(page);
      await page.getByRole("button", { name: "导出结果", exact: true }).click();
      await dialog.getByRole("radio", { name: /最终结果/u }).check();
    }
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await dialog
        .getByRole("button", { name: "导出失败日志 ZIP", exact: true })
        .scrollIntoViewIfNeeded();
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `failure-log-zip-${theme}-${width}.png`),
        animations: "disabled",
      });
    }
  }
  await page.route(
    "**/failure-logs/export?*",
    async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "PLATFORM_BUSY", message: "日志库暂时繁忙，请重试。", requestId: "e2e" },
        }),
      });
    },
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "导出失败日志 ZIP", exact: true }).click();
  await expect(dialog.getByText("日志库暂时繁忙，请重试。", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "导出失败日志 ZIP", exact: true })).toBeEnabled();
  await page.screenshot({
    path: resolve(screenshots, "failure-log-zip-error-1536.png"),
    animations: "disabled",
  });
  const downloadPromise = page.waitForEvent("download");
  let pending = true;
  const latencies: number[] = [];
  const probe = (async () => {
    while (pending) {
      const started = Date.now();
      const response = await page.request.get("/api/v1/auth/session", { timeout: 10000 });
      expect(response.status()).toBe(200);
      latencies.push(Date.now() - started);
      await new Promise((resume) => setTimeout(resume, 150));
    }
  })();
  const started = Date.now();
  const download = await (async () => {
    try {
      await dialog.getByRole("button", { name: "导出失败日志 ZIP", exact: true }).click();
      const downloaded = await downloadPromise;
      expect(await downloaded.failure()).toBeNull();
      return downloaded;
    } finally {
      pending = false;
      await probe;
    }
  })();
  const bytes = await readFile((await download.path())!);
  expect(download.suggestedFilename()).toContain("_失败用例日志_最终结果_");
  expect(download.suggestedFilename()).toMatch(/\.zip$/u);
  const files = unzipSync(bytes);
  expect(Object.keys(files)).toHaveLength(2000);
  for (const [index, attempt] of attempts.entries()) {
    const name = Object.keys(files).find((key) => key.startsWith(`${attempt.title}__`));
    expect(name, `missing ${attempt.title}`).toBeDefined();
    const text = Buffer.from(files[name!]!).toString("utf8");
    expect(text).toContain(`开始${index} 中文😀`);
    expect(text).toContain(`END-${index}`);
    expect(text).toContain(`错误详情-${index}`);
    expect(text).toContain(`执行诊断-${index}`);
    expect(text).not.toContain("\u001b");
    expect(text.match(/完整堆栈内容 wallet.method:123\n/gu)).toHaveLength(index === 0 ? 2000 : 400);
  }
  expect(latencies.length).toBeGreaterThan(1);
  expect(Math.max(...latencies)).toBeLessThan(3000);
  testInfo.annotations.push({
    type: "performance",
    description: `2000 logs: ${Date.now() - started}ms including download validation; ${latencies.length} session probes, max ${Math.max(...latencies)}ms; ZIP ${bytes.length} bytes`,
  });
  await page.getByRole("button", { name: "导出结果", exact: true }).click();
  await dialog.getByRole("radio", { name: /失败用例分析清单/u }).check();
  await dialog.getByRole("radio", { name: /最终结果/u }).check();
  const excelPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出分析清单", exact: true }).click();
  const excel = await excelPromise;
  const workbook = await readExportedWorkbook(await readFile((await excel.path())!));
  expect(workbook.worksheets[0]!.rowCount).toBe(2001);
  expect(workbook.worksheets[0]!.getRow(1).values).not.toContain("完整日志");
});
