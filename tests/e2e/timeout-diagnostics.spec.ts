import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_PROJECT_ID, describeExecutionTimeout } from "@autoforge/domain";
import { createAttemptLogStore } from "@autoforge/db/sqlite";
import type { PlatformConfigurationView } from "@autoforge/contracts";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import { browserJson, ensureAdministrator, uniqueName } from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("platform log silence timeout saves and reloads without a restart", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  await page.goto("/settings/platform?section=configuration");
  const field = page.getByRole("spinbutton", { name: /^日志上报超时（秒）/u });
  await expect(field).toHaveValue("0");
  const save = async (seconds: number) => {
    await field.fill(String(seconds));
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/settings/platform" &&
        response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "保存平台配置", exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const settings = (await response.json()) as PlatformConfigurationView;
    expect(settings.appliedImmediatelyFields).toContain("日志上报超时");
    expect(settings.restartRequiredFields).toEqual([]);
    expect(settings.limits.caseLogSilenceTimeoutSeconds).toBe(seconds);
  };
  await save(120);
  await page.reload();
  await expect(field).toHaveValue("120");
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  const origin = new URL(page.url()).origin;
  for (const theme of ["light", "dark"] as const) {
    await page.context().addCookies([{ name: "autoforge-color-mode", value: theme, url: origin }]);
    await page.reload();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await field
        .locator("xpath=ancestor::label")
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `log-silence-settings-${theme}-${width}.png`),
      });
    }
  }
  await save(0);
  await page.reload();
  await expect(field).toHaveValue("0");
});

test("timeout diagnostics show watchdog evidence and authenticated JVM logs without exposing them anonymously", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("超时诊断") } },
  );
  expect(version.status).toBe(201);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("This timeout fixture requires the Lite test data directory.");
  const suffix = uniqueName("timeout-evidence");
  const fixture = insertFailureAnalysisFixture(directory, version.body.id, suffix);
  const attemptId = `attempt-run-failed-0-${suffix}`;
  const detectedAt = new Date().toISOString();
  const summary = describeExecutionTimeout({
    startedAt: new Date(Date.now() - 601000).toISOString(),
    detectedAt,
    timeoutMs: 600000,
    leaseRenewedAt: new Date(Date.now() - 5000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 40000).toISOString(),
    runnerLastSeenAt: new Date(Date.now() - 3000).toISOString(),
  });
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database
      .prepare(
        "UPDATE run_attempts SET status='timed_out',outcome='timed_out',result_code='EXECUTION_TIMEOUT',result_summary=?,finished_at=? WHERE id=?",
      )
      .run(summary, detectedAt, attemptId);
    database
      .prepare(
        "UPDATE execution_runs SET terminal_outcome='timed_out',terminal_reason_code='EXECUTION_TIMEOUT' WHERE id=?",
      )
      .run(`run-failed-0-${suffix}`);
  } finally {
    database.close();
  }
  const logs = createAttemptLogStore(resolve(directory, "attempt-logs"));
  try {
    await logs.appendChunks({
      batchId: fixture.batchId,
      attemptId,
      receivedAt: detectedAt,
      chunks: [
        {
          stream: "stdout",
          sequence: 0,
          recordedAt: detectedAt,
          content: "Starting payment request...\n",
        },
        {
          stream: "agent",
          sequence: 0,
          recordedAt: detectedAt,
          content:
            "[AutoForge 超时前诊断]\n日志上传：90 次，429 限流 12 次。\n记录时距最后输出 245.0 秒。\n线程证据：业务线程正在等待 Java 锁。\n采集方式：JDK Java 入口。\n节点进程快照：PID 812；Linux 状态 S；21 个线程；常驻内存 106.0 MiB。\n本次用例的环境 IP：192.0.2.3。\n[JVM 线程快照]\njava.lang.Thread.State: BLOCKED\n at e2e.analysis.Failed0Test.send(Failed0Test.java:42)\n",
        },
      ],
    });
  } finally {
    logs.close();
  }
  const shared = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-attempts/${attemptId}/log-share`,
    { method: "POST" },
  );
  expect(shared.status).toBe(200);
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: theme, url: "http://127.0.0.1:3100" }]);
    await page.goto(shared.body.shareUrl);
    await expect(page.getByText("超时诊断", { exact: true })).toBeVisible();
    await expect(page.getByText(/配置期限：600 秒/)).toBeVisible();
    await page.getByRole("button", { name: "查看超时诊断", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /执行日志.*Agent 诊断/ });
    await expect(dialog.getByText(/429 限流 12 次/)).toBeVisible();
    await expect(dialog.getByText(/记录时距最后输出 245.0 秒/)).toBeVisible();
    await expect(dialog.getByText(/常驻内存 106.0 MiB/)).toBeVisible();
    await expect(dialog.getByText(/本次用例的环境 IP：192.0.2.3/)).toBeVisible();
    await expect(dialog.getByText(/Failed0Test.java:42/)).toBeVisible();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await expect(dialog.getByRole("button", { name: "关闭日志终端" })).toBeInViewport();
      await page.screenshot({
        path: resolve(screenshots, `timeout-diagnostics-${theme}-${width}.png`),
      });
    }
    await dialog.getByRole("button", { name: "关闭日志终端" }).click();
  }
  expect(errors).toEqual([]);
  const anonymous = await browser.newContext();
  try {
    const visitor = await anonymous.newPage();
    await visitor.goto(shared.body.shareUrl);
    await expect(
      visitor.getByRole("button", { name: "登录查看超时诊断", exact: true }),
    ).toBeVisible();
    expect(
      (await visitor.request.get(`/api/v1/run-attempts/${attemptId}/logs?stream=agent`)).status(),
    ).toBe(401);
    await expect(visitor.getByText("java.lang.Thread.State: BLOCKED", { exact: true })).toHaveCount(
      0,
    );
    await expect(visitor.getByText(/本次用例的环境 IP：192.0.2.3/)).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
  const username = uniqueName("diagnostic-no-access");
  const password = "Diagnostic!Password123";
  const user = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: "无项目日志权限", password, forcePasswordChange: false },
  });
  expect(user.status).toBe(201);
  const origin = new URL(page.url()).origin;
  const restricted = await browser.newContext({ baseURL: origin });
  try {
    const visitor = await restricted.newPage();
    const session = await visitor.request.post("/api/v1/auth/login", {
      headers: { origin },
      data: { username, password },
    });
    expect(session.status()).toBe(200);
    await visitor.goto(shared.body.shareUrl);
    await expect(visitor.getByText("超时诊断", { exact: true })).toBeVisible();
    await expect(visitor.getByRole("button", { name: "查看超时诊断", exact: true })).toHaveCount(0);
    expect(
      (await visitor.request.get(`/api/v1/run-attempts/${attemptId}/logs?stream=agent`)).status(),
    ).toBe(403);
    for (const width of [1024, 1536]) {
      await visitor.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(visitor);
      await visitor.screenshot({
        path: resolve(screenshots, `timeout-diagnostics-forbidden-${width}.png`),
      });
    }
  } finally {
    await restricted.close();
  }
});
