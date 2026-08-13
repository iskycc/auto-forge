import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import {
  appAlert,
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  ensureAdministrator,
} from "./support/session";

async function captureUi(page: Page, name: string): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  const absoluteDirectory = resolve(screenshotDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  await page.screenshot({ path: resolve(absoluteDirectory, `${name}.png`), fullPage: true });
}

test("imports TestNG methods from a JAR into the case library", async ({ page }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const jar = zipSync({
    "com/example/CheckoutTest.class": buildClassFile({
      className: "com.example.CheckoutTest",
      methods: [
        {
          name: "checkout",
          annotations: [{ type: "Test", values: { groups: ["smoke", "checkout"] } }],
        },
      ],
    }),
    "testng.xml": new TextEncoder().encode('<suite name="AutoForge fixture" />'),
  });
  const jarV2 = zipSync({
    "com/example/CheckoutTest.class": buildClassFile({
      className: "com.example.CheckoutTest",
      methods: [
        {
          name: "checkout",
          annotations: [{ type: "Test", values: { groups: ["smoke", "checkout", "v2"] } }],
        },
        {
          name: "refund",
          annotations: [{ type: "Test", values: { groups: ["regression"] } }],
        },
      ],
    }),
  });
  const javaSource = `package com.example;

import org.testng.annotations.Test;

public class SourceVisibleTest {
  @Test(groups = {"source-view"}, description = "source JAR case")
  public void displaysSource() {
    String visibleMarker = "AUTOFORGE_SOURCE_VIEW_E2E";
  }
}
`;
  const sourcesJar = zipSync({
    "com/example/SourceVisibleTest.java": new TextEncoder().encode(javaSource),
  });
  const mixedSource = `package com.example;

import org.testng.annotations.Test;

public class MixedVisibleTest {
  @Test
  public void executesAndDisplaysSource() {
    String marker = "AUTOFORGE_MIXED_SOURCE_E2E";
  }
}
`;
  const mixedJar = zipSync({
    "com/example/MixedVisibleTest.class": buildClassFile({
      className: "com.example.MixedVisibleTest",
      methods: [
        {
          name: "executesAndDisplaysSource",
          annotations: [{ type: "Test", values: { groups: ["mixed"] } }],
        },
      ],
    }),
    "com/example/MixedVisibleTest.java": new TextEncoder().encode(mixedSource),
    "com/example/Damaged.class": new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00]),
  });

  const setupStatus = await page.request.get("/api/v1/auth/setup-status");
  const setup = (await setupStatus.json()) as { setupRequired: boolean };
  if (setup.setupRequired) {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /汇聚到一个可信控制面/ })).toBeVisible();
    await expect(page.getByText("平台数据实时同步")).toBeVisible();
    await expectDesktopLayoutFits(page, 1024, 768);
    await expectUiConsistency(page);

    await page.goto("/setup");
    await page.getByRole("button", { name: /^Full/ }).click();
    await expect(page.getByLabel("PostgreSQL URL")).toBeVisible();
    await expectUiConsistency(page);
    await page.getByRole("button", { name: /^Lite/ }).click();
  }
  const publicStatistics = await page.request.get("/api/v1/public/statistics");
  expect(publicStatistics.status()).toBe(200);
  expect(await publicStatistics.json()).not.toHaveProperty("secrets");

  await ensureAdministrator(page);
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByRole("link", { name: "首页", exact: true })).toHaveClass(
    /nav-item-active/,
  );
  await expect(page.getByText("E2E Administrator", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("用户名").fill(E2E_ADMIN_USERNAME);
  await page.getByLabel("密码").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByRole("link", { name: "首页", exact: true })).toHaveClass(
    /nav-item-active/,
  );
  await expect(page.getByText("E2E Administrator", { exact: true })).toBeVisible();

  await page.goto("/cases/import");
  await expect(page.getByRole("heading", { name: "导入 TestNG JAR" })).toBeVisible();
  await expect(page.getByRole("link", { name: "管理中心 → 平台配置" })).toBeVisible();
  await expectUiConsistency(page);

  const largeUploadBoundary = await page.evaluate(
    async (sizeBytes) => {
      const formData = new FormData();
      formData.set(
        "file",
        new File([new Uint8Array(sizeBytes)], "48-mib-boundary.jar", {
          type: "application/java-archive",
        }),
      );
      const response = await fetch("/api/v1/case-sources/jar/inspect", {
        method: "POST",
        body: formData,
      });
      return {
        status: response.status,
        payload: (await response.json()) as { error?: { code?: string } },
      };
    },
    48 * 1024 * 1024,
  );
  expect(largeUploadBoundary.status).toBe(400);
  expect(largeUploadBoundary.payload.error?.code).toBe("INVALID_JAR");

  const largeClassName = `com.example.LargeBoundary${Date.now()}Test`;
  const validLargeJar = zipSync(
    {
      [`${largeClassName.replaceAll(".", "/")}.class`]: buildClassFile({
        className: largeClassName,
        methods: [{ name: "validBeyondLegacyLimit", annotations: [{ type: "Test", values: {} }] }],
      }),
      "fixtures/incompressible.bin": randomBytes(48 * 1024 * 1024),
    },
    { level: 0 },
  );
  expect(validLargeJar.byteLength).toBeGreaterThan(40 * 1024 * 1024);
  const validLargeResponse = await page.request.post("/api/v1/case-sources/jar/inspect", {
    headers: { origin: new URL(page.url()).origin },
    multipart: {
      file: {
        name: "valid-48-mib-tests.jar",
        mimeType: "application/java-archive",
        buffer: Buffer.from(validLargeJar),
      },
    },
  });
  expect(validLargeResponse.status()).toBe(200);
  expect(await validLargeResponse.json()).toMatchObject({
    classes: [{ className: largeClassName }],
  });

  await page.locator('input[type="file"]').setInputFiles({
    name: "valid-48-mib-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(validLargeJar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText(largeClassName)).toBeVisible({ timeout: 60_000 });
  const largeImportResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/case-sources/jar/import",
  );
  await page.getByRole("button", { name: "确认导入" }).click();
  expect((await largeImportResponse).status()).toBe(202);
  await page.getByRole("button", { name: "取消导入" }).click();
  await expect(appAlert(page)).toContainText("导入任务已取消", { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "幂等重试" })).toBeVisible();
  await page.getByRole("button", { name: "幂等重试" }).click();
  await expect(page.getByRole("status")).toContainText("已导入", { timeout: 120_000 });

  await page.locator('input[type="file"]').setInputFiles({
    name: "checkout-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();

  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".method-row code")).toHaveText("checkout");
  await expect(page.getByText("smoke", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });

  await page.getByRole("link", { name: "查看用例库" }).click();
  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible();
  await expectUiConsistency(page);
  await captureUi(page, "case-library");

  await page.getByRole("link", { name: "CheckoutTest" }).click();
  await expect(page.getByRole("heading", { name: "CheckoutTest" })).toBeVisible();
  await expectUiConsistency(page);
  const checkoutCaseUrl = page.url();

  await page.goto("/cases/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "mixed-visible-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(mixedJar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.MixedVisibleTest")).toBeVisible();
  await expect(page.getByText("这是混合 JAR")).toBeVisible();
  await expect(page.getByText("可查看源码", { exact: true })).toBeVisible();
  await expect(page.getByText(/Damaged\.class/)).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText("已导入", { timeout: 60_000 });

  await page.goto("/cases/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "mixed-visible-tests-copy.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(mixedJar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText("已返回现有用例", {
    timeout: 60_000,
  });
  await page.getByRole("link", { name: "查看用例库" }).click();
  await page.getByRole("link", { name: "MixedVisibleTest" }).click();
  await expect(page.locator(".source-code-viewer")).toContainText("AUTOFORGE_MIXED_SOURCE_E2E");
  await expect(page.getByRole("button", { name: "立即执行" })).toBeVisible();

  await page.goto("/cases/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "checkout-tests-v2.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jarV2),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
  await page.goto(checkoutCaseUrl);
  await expect(page.getByText("版本历史（2）")).toBeVisible();
  await expect(page.getByText(/方法(?:新增|移除)：refund/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "从该版本创建" }).last().click();
  await expect(page.getByText("版本历史（3）")).toBeVisible({ timeout: 20_000 });

  await page.goto("/case-suites");
  await page.getByLabel("任务名称").fill("每日冒烟测试");
  await page.getByLabel("说明").fill("E2E 创建的可复用任务");
  await page.getByRole("button", { name: "创建任务" }).click();
  await expect(page.getByRole("link", { name: /每日冒烟测试/ })).toBeVisible();
  await page.keyboard.press("Control+K");
  const globalSearch = page.getByLabel("全局搜索");
  await expect(globalSearch).toBeFocused();
  await globalSearch.fill("每日冒烟");
  await expect(page.getByRole("option", { name: /每日冒烟测试/ })).toBeVisible();
  await globalSearch.press("ArrowDown");
  await expect(page.getByRole("option", { name: /每日冒烟测试/ })).toBeFocused();
  await expectUiConsistency(page);

  await page.goto("/cases");
  await page.getByLabel("选择 CheckoutTest").check();
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByRole("status")).toContainText("已将 1 个用例加入任务");

  await page.goto("/case-suites");
  await page.getByRole("link", { name: /每日冒烟测试/ }).click();
  await expectUiConsistency(page);
  await page.getByRole("button", { name: "移除" }).click();
  await expect(page.getByText("任务中还没有用例")).toBeVisible({ timeout: 20_000 });

  await page.goto("/objects");
  await expect(page.getByText("checkout-tests.jar")).toBeVisible();
  await expectUiConsistency(page);
  await page.getByRole("link", { name: "预览" }).first().click();
  await expect(page.getByRole("heading", { name: "测试类与方法" })).toBeVisible();
  await expectUiConsistency(page);
  await page.getByRole("button", { name: "设为全量来源" }).click();
  await expect(page.getByRole("button", { name: "当前全量来源" })).toBeVisible();

  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: "E2E Runner",
      labels: ["linux", "java", "testng"],
      capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.2.0",
      protocolVersion: 1,
      terminalEnabled: true,
    },
  });
  expect(registration.status()).toBe(201);
  const identity = (await registration.json()) as { runnerId: string; credential: string };
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${identity.credential}` },
      data: {
        schemaVersion: 1,
        busySlots: 1,
        labels: ["linux", "java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: true,
        resourceSnapshot: {
          cpuUtilizationPercent: 24,
          memoryUtilizationPercent: 38,
          loadAverage1m: 0.6,
          logicalCpuCount: 4,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(heartbeat.status()).toBe(200);
  const heartbeatResult = (await heartbeat.json()) as { terminalConnectionToken: string };
  expect(heartbeatResult.terminalConnectionToken).toBeTruthy();

  await page.goto("/cases");
  await page.getByLabel("选择 CheckoutTest").check();
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByRole("status")).toContainText("已将 1 个用例加入任务");

  await page.goto("/run-batches");
  const runnerChoice = page.locator(".runner-choice").filter({ hasText: "E2E Runner" });
  await runnerChoice.locator('input[type="checkbox"]').check();
  await page.getByLabel("失败用例重跑次数").selectOption("2");
  await page.getByRole("button", { name: "添加变量" }).click();
  await page.getByLabel("环境变量名").fill("TEST_ENV");
  await page.getByLabel("环境变量值").fill("e2e");
  await expectUiConsistency(page);
  const createBatchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/run-batches",
  );
  await page.getByRole("button", { name: "开始调度" }).click();
  const batch = (await (await createBatchResponse).json()) as { id: string };
  await expect(page.getByText("已生成分配", { exact: true })).toBeVisible();
  await expect(page.getByText("已分配 1", { exact: true })).toBeVisible();
  await captureUi(page, "run-batch-planner");

  const firstClaim = await claimAssignment(page, identity);
  const firstAttemptId = firstClaim.assignment.attemptId;
  const testJarInput = firstClaim.assignment.executionSpec.inputs.find(
    (input) => input.kind === "test-jar",
  );
  expect(testJarInput).toBeTruthy();
  const downloadedInput = await page.request.get(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/inputs/${encodeURIComponent(testJarInput!.inputId)}`,
    { headers: runnerHeaders(identity, firstClaim.lease.token) },
  );
  expect(downloadedInput.status()).toBe(200);
  const downloadedJar = await downloadedInput.body();
  expect(downloadedJar.byteLength).toBe(testJarInput!.sizeBytes);
  expect(createHash("sha256").update(downloadedJar).digest("hex")).toBe(testJarInput!.sha256);

  const firstLog = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/logs`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: "e2e-log-first",
        leaseToken: firstClaim.lease.token,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "\u001b[31mfirst attempt assertion failed\u001b[0m\n",
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  expect(firstLog.status()).toBe(200);
  expect(await firstLog.json()).toMatchObject({ acknowledgedSequence: { stdout: 0 } });

  const report = Buffer.from("AutoForge E2E report\n", "utf8");
  const reportDeclaration = {
    artifactId: "e2e-report",
    relativePath: "reports/testng/e2e-report.txt",
    mediaType: "text/plain",
    sizeBytes: report.byteLength,
    sha256: createHash("sha256").update(report).digest("hex"),
    required: false,
  };
  const artifactDeclaration = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/artifacts`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: "e2e-artifact-declare",
        leaseToken: firstClaim.lease.token,
        artifacts: [reportDeclaration],
      },
    },
  );
  expect(artifactDeclaration.status()).toBe(200);
  const declaredArtifact = (
    (await artifactDeclaration.json()) as {
      artifacts: Array<{ uploadPath: string; uploadMethod: string; finalizePath?: string }>;
    }
  ).artifacts[0]!;
  if (declaredArtifact.uploadMethod === "control-plane") {
    const artifactUpload = await page.request.put(declaredArtifact.uploadPath, {
      headers: runnerHeaders(identity, firstClaim.lease.token),
      data: report,
    });
    expect(artifactUpload.status()).toBe(200);
  } else {
    expect(declaredArtifact.uploadMethod).toBe("direct");
    expect(declaredArtifact.finalizePath).toBeTruthy();
    const directUpload = await page.request.put(declaredArtifact.uploadPath, { data: report });
    expect([200, 204]).toContain(directUpload.status());
    const finalize = await page.request.post(declaredArtifact.finalizePath!, {
      headers: runnerHeaders(identity, firstClaim.lease.token),
    });
    expect(finalize.status()).toBe(200);
  }

  const failedCompletion = await completeAttempt(page, identity, firstClaim, {
    completionId: "e2e-completion-failed",
    status: "failed",
    resultCode: "TEST_ASSERTION_FAILED",
    summary: "E2E intentional failure",
    durationMs: 200,
    artifacts: [reportDeclaration],
  });
  expect(failedCompletion).toMatchObject({
    disposition: "accepted",
    retryScheduled: true,
  });

  const retryHeartbeat = await postHeartbeat(page, identity, 0);
  expect(retryHeartbeat.status()).toBe(200);
  const secondClaim = await claimAssignment(page, identity);
  expect(secondClaim.assignment.attemptId).not.toBe(firstAttemptId);
  expect(secondClaim.assignment.executionSpec.executionRunId).toBe(
    firstClaim.assignment.executionSpec.executionRunId,
  );
  const secondLog = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(secondClaim.assignment.attemptId)}/logs`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: "e2e-log-retry",
        leaseToken: secondClaim.lease.token,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "retry passed\n",
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  expect(secondLog.status()).toBe(200);
  const successfulCompletion = await completeAttempt(page, identity, secondClaim, {
    completionId: "e2e-completion-succeeded",
    status: "succeeded",
    resultCode: "TESTNG_SUCCEEDED",
    summary: "E2E retry passed",
    durationMs: 120,
    artifacts: [],
  });
  expect(successfulCompletion).toMatchObject({
    disposition: "accepted",
    retryScheduled: false,
  });

  const userHeaders = await browserSessionHeaders(page);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/run-batches/${encodeURIComponent(batch.id)}`,
        { headers: userHeaders },
      );
      expect(response.status()).toBe(200);
      return (await response.json()) as {
        status: string;
        succeededRuns: number;
        attempts: Array<{ id: string; attemptNumber: number }>;
      };
    })
    .toMatchObject({ status: "succeeded", succeededRuns: 1, attempts: [{}, {}] });

  const artifactDownload = await page.request.get(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/artifacts/e2e-report`,
    { headers: userHeaders },
  );
  expect(artifactDownload.status()).toBe(200);
  expect(artifactDownload.headers()["content-disposition"]).toContain("attachment");
  expect(await artifactDownload.body()).toEqual(report);

  await page.goto(`/run-batches/${encodeURIComponent(batch.id)}`);
  await expect(page.getByText("成功", { exact: true }).first()).toBeVisible();
  await page.getByLabel("执行尝试").selectOption(firstAttemptId);
  await expect(page.locator(".execution-log")).toContainText("first attempt assertion failed");
  await expect(page.locator(".execution-log")).toHaveClass(/execution-log-dark/);
  await expect(page.locator(".execution-log .ansi-red")).toContainText(
    "first attempt assertion failed",
  );
  await expect(page.getByText("reports/testng/e2e-report.txt")).toBeVisible();
  await expect(page.getByLabel("下载 reports/testng/e2e-report.txt")).toBeVisible();
  await expectUiConsistency(page);

  await page.goto("/run-batches");
  const cancellationRunner = page.locator(".runner-choice").filter({ hasText: "E2E Runner" });
  await cancellationRunner.locator('input[type="checkbox"]').check();
  const cancellationBatchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/run-batches",
  );
  await page.getByRole("button", { name: "开始调度" }).click();
  const cancellationBatch = (await (await cancellationBatchResponse).json()) as { id: string };
  await page.goto(`/run-batches/${encodeURIComponent(cancellationBatch.id)}`);
  page.once("dialog", (dialog) => dialog.accept("E2E single run cancellation"));
  await page.getByRole("button", { name: "取消该用例" }).click();
  await expect(page.getByText("已取消", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  await page.goto("/insights");
  await expect(
    page.getByText("执行样本").locator("..").getByText("2", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".failure-signature-list")).toContainText("TEST_ASSERTION_FAILED");
  await expectUiConsistency(page);

  await page.goto(
    `/insights?outcome=succeeded&leftBatchId=${encodeURIComponent(batch.id)}&rightBatchId=${encodeURIComponent(cancellationBatch.id)}`,
  );
  await expect(page.getByLabel("结果")).toHaveValue("succeeded");
  await expect(page.getByText(/共同用例 1 个/)).toBeVisible();
  await page.getByRole("button", { name: "导出当前范围" }).click();
  const exportLink = page.getByRole("link", { name: /下载 \d+ 行/ });
  await expect(exportLink).toBeVisible({ timeout: 30_000 });
  const exportHref = await exportLink.getAttribute("href");
  expect(exportHref).toBeTruthy();
  const exportDownload = await page.request.get(exportHref!);
  expect(exportDownload.status()).toBe(200);
  expect(exportDownload.headers()["content-type"]).toContain("text/csv");
  expect(await exportDownload.text()).toContain("caseDefinitionId");

  const jsonExport = await page.evaluate(async () => {
    const response = await fetch("/api/v1/analytics/exports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ filter: { outcome: "succeeded" }, format: "json" }),
    });
    return {
      status: response.status,
      job: (await response.json()) as { id: string; status: string },
    };
  });
  expect(jsonExport.status).toBe(202);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/v1/analytics/exports/${encodeURIComponent(jsonExport.job.id)}`,
        );
        expect(response.status()).toBe(200);
        return ((await response.json()) as { status: string }).status;
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe("succeeded");
  const jsonDownload = await page.request.get(
    `/api/v1/analytics/exports/${encodeURIComponent(jsonExport.job.id)}/download`,
  );
  expect(jsonDownload.status()).toBe(200);
  expect(jsonDownload.headers()["content-type"]).toContain("application/json");
  const jsonRows = (await jsonDownload.json()) as Array<Record<string, unknown>>;
  expect(jsonRows.length).toBeGreaterThan(0);
  expect(jsonRows.every((row) => row.outcome === "succeeded")).toBe(true);

  expect(await searchKinds(page, "CheckoutTest")).toContain("case");
  expect(await searchKinds(page, "每日冒烟测试")).toEqual(
    expect.arrayContaining(["suite", "batch"]),
  );
  expect(await searchKinds(page, "E2E Runner")).toContain("runner");

  const agentSocket = new WebSocket(terminalStreamUrl(), "autoforge-runner-terminal-v1", {
    headers: { authorization: `Bearer ${heartbeatResult.terminalConnectionToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    agentSocket.once("open", resolve);
    agentSocket.once("error", reject);
  });

  await page.goto("/runners");
  await expect(page.getByText("E2E Runner")).toBeVisible();
  await expectUiConsistency(page);
  await page.getByRole("button", { name: "终端浮窗" }).click();

  const openCommand = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Agent did not receive terminal open command")),
      10_000,
    );
    agentSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "open") {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
  await page.getByRole("button", { name: "连接终端" }).click();
  const command = await openCommand;
  const sessionId = String(command.sessionId);
  agentSocket.send(JSON.stringify({ schemaVersion: 1, type: "ready", sessionId }));
  agentSocket.send(
    JSON.stringify({
      schemaVersion: 1,
      type: "output",
      sessionId,
      data: Buffer.from("direct-terminal-ready\r\n").toString("base64"),
    }),
  );
  await expect(page.locator(".terminal-viewport")).toContainText("direct-terminal-ready");
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expectUiConsistency(page);
  await captureUi(page, "runner-terminal");
  await page.getByRole("button", { name: "关闭终端" }).click();
  agentSocket.close();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "自动化用例工作台" })).toBeVisible();
  await expectDesktopLayoutFits(page, 1024, 768);
  await expectDesktopLayoutFits(page, 1920, 1080);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect(page.getByRole("heading", { name: "自动化用例工作台" })).toBeVisible();
  await expect(page.getByLabel("全局搜索")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await expectDesktopLayoutFits(page, 1920, 1080);
  await expectUiConsistency(page);
  await captureUi(page, "dashboard");

  await page.getByRole("button", { name: "通知" }).click();
  await expect(page.getByText("通知中心")).toBeVisible();
  const completionNotification = page
    .locator(".notification-item")
    .filter({ hasText: "执行批次已完成" })
    .first();
  await expect(completionNotification).toBeVisible();
  await completionNotification.click();
  await expect(completionNotification).toHaveClass(/read/);
  await expectUiConsistency(page);
  await page.getByRole("button", { name: "关闭通知" }).click();
  await page.reload();
  await page.getByRole("button", { name: "通知" }).click();
  await expect(
    page.locator(".notification-item.read").filter({ hasText: "执行批次已完成" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭通知" }).click();

  await page.goto("/cases/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "source-visible-tests-sources.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(sourcesJar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.SourceVisibleTest")).toBeVisible();
  await expect(page.getByText("这是 sources JAR")).toBeVisible();
  await expect(page.getByText("可查看源码", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.locator(".alert-success")).toContainText("已导入 1 个测试类、1 个测试方法", {
    timeout: 60_000,
  });
  await page.getByRole("link", { name: "查看用例库" }).click();
  await page.getByRole("link", { name: "SourceVisibleTest" }).click();
  await expect(page.getByRole("heading", { name: "用例源码" })).toBeVisible();
  await expect(page.locator(".source-code-viewer")).toContainText("AUTOFORGE_SOURCE_VIEW_E2E");
  await expect(page.getByText(/不能直接执行/)).toBeVisible();
  await expect(page.getByRole("button", { name: "立即执行" })).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "管理中心" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "后台管理功能" })).toBeVisible();
  await page.getByRole("link", { name: /用户管理/ }).click();
  await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
  await page.goto("/settings");
  await page.getByRole("link", { name: /LDAP 配置/ }).click();
  await expect(page.getByRole("heading", { name: "LDAP 配置" })).toBeVisible();

  for (const route of ["/settings/platform", "/settings/access", "/settings/environments"]) {
    await page.goto(route);
    await expect(page.getByRole("navigation", { name: "系统设置分类" })).toBeVisible();
    await expectUiConsistency(page);
    if (route === "/settings/platform") {
      await expect(page.getByLabel("JAR 大小上限（MiB）")).toHaveValue("256");
    }
    if (route === "/settings/environments") {
      await page.getByRole("button", { name: "密文", exact: true }).click();
      await expect(page.getByRole("heading", { name: "创建执行密文" })).toBeVisible();
      await expectUiConsistency(page);

      const secretCreatePanel = page.locator(".secret-create-panel");
      await secretCreatePanel.getByLabel("名称").fill("E2E API Token");
      await secretCreatePanel.getByLabel("说明").fill("UI consistency fixture");
      await secretCreatePanel.getByLabel("密文值").fill("e2e-secret-value");
      await secretCreatePanel.getByRole("button", { name: "创建密文" }).click();
      await expect(page.getByText("执行密文已创建。")).toBeVisible();
      await expectUiConsistency(page);

      await page.getByRole("button", { name: "环境", exact: true }).click();
      await page.getByRole("button", { name: "创建执行环境" }).click();
      const environmentCreateForm = page.locator(".compact-create-form");
      await environmentCreateForm.getByLabel("名称").fill("E2E Staging");
      await environmentCreateForm.getByLabel("说明").fill("UI consistency fixture");
      await environmentCreateForm.getByLabel("普通变量").fill("BASE_URL=https://staging.invalid");
      await environmentCreateForm.getByRole("button", { name: "创建环境" }).click();
      await expect(page.getByRole("heading", { name: "E2E Staging" })).toBeVisible();
      await expectUiConsistency(page);
    }
  }

  await page.goto("/forbidden");
  await expect(page.getByText("没有访问权限")).toBeVisible();
  await expectUiConsistency(page);

  const secondaryBaseUrl = process.env.E2E_SECONDARY_BASE_URL;
  if (secondaryBaseUrl) {
    await page.goto(new URL("/", secondaryBaseUrl).toString());
    await expect(page.getByRole("heading", { name: "自动化用例工作台" })).toBeVisible();
    const secondaryReadiness = await page.request.get(
      new URL("/api/v1/health/ready", secondaryBaseUrl).toString(),
    );
    expect(secondaryReadiness.status()).toBe(200);
  }

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expectUiConsistency(page);

  const loginUsername = page.getByLabel("用户名");
  await loginUsername.focus();
  const focusStyles = await loginUsername.evaluate((input) => {
    const label = input.closest("label");
    return {
      inputBoxShadow: window.getComputedStyle(input).boxShadow,
      labelOutlineStyle: label ? window.getComputedStyle(label).outlineStyle : "missing",
    };
  });
  expect(focusStyles.labelOutlineStyle).toBe("none");
  expect(focusStyles.inputBoxShadow).not.toBe("none");

  await loginUsername.fill(E2E_ADMIN_USERNAME);
  await page.getByLabel("密码").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "自动化用例工作台" })).toBeVisible();
  const authenticatedSession = await page.request.get("/api/v1/auth/session");
  expect(authenticatedSession.status()).toBe(200);
});

function terminalStreamUrl(): string {
  const url = new URL(
    "/api/v1/terminal-stream",
    process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

type RunnerIdentity = { runnerId: string; credential: string };

type ClaimedAssignment = {
  assignment: {
    attemptId: string;
    executionSpec: {
      executionRunId: string;
      inputs: Array<{ inputId: string; kind: string; sizeBytes: number; sha256: string }>;
    };
  };
  lease: { token: string };
};

async function claimAssignment(page: Page, identity: RunnerIdentity): Promise<ClaimedAssignment> {
  const deadline = Date.now() + 15_000;
  let requestNumber = 0;
  while (Date.now() < deadline) {
    requestNumber += 1;
    const response = await page.request.post(
      `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/claims`,
      {
        headers: { authorization: `Bearer ${identity.credential}` },
        data: {
          schemaVersion: 1,
          requestId: `e2e-claim-${requestNumber}-${randomUUID()}`,
          availableSlots: 1,
          labels: ["linux", "java", "testng"],
          capabilities: [
            "executor:testng-v1",
            "isolation:cgroup-v2",
            "java:21.0.8",
            "testng:7.11.0",
          ],
          waitSeconds: 0,
        },
      },
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { assignments: ClaimedAssignment[] };
    if (body.assignments[0]) return body.assignments[0];
    await page.waitForTimeout(250);
  }
  throw new Error("Runner did not receive an assignment within 15 seconds.");
}

async function completeAttempt(
  page: Page,
  identity: RunnerIdentity,
  claim: ClaimedAssignment,
  result: {
    completionId: string;
    status: "succeeded" | "failed" | "timed_out" | "cancelled";
    resultCode: string;
    summary: string;
    durationMs: number;
    artifacts: Array<Record<string, unknown>>;
  },
): Promise<Record<string, unknown>> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(claim.assignment.attemptId)}/complete`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        completionId: result.completionId,
        leaseToken: claim.lease.token,
        result: {
          status: result.status,
          resultCode: result.resultCode,
          summary: result.summary,
          durationMs: result.durationMs,
          logWatermarks: { stdout: 0, stderr: -1, agent: -1 },
          artifacts: result.artifacts,
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function postHeartbeat(page: Page, identity: RunnerIdentity, busySlots: number) {
  return page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${identity.credential}` },
      data: {
        schemaVersion: 1,
        busySlots,
        labels: ["linux", "java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: true,
        resourceSnapshot: {
          cpuUtilizationPercent: 24,
          memoryUtilizationPercent: 38,
          loadAverage1m: 0.6,
          logicalCpuCount: 4,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
}

function runnerHeaders(identity: RunnerIdentity, leaseToken?: string): Record<string, string> {
  return {
    authorization: `Bearer ${identity.credential}`,
    "x-autoforge-runner-id": identity.runnerId,
    ...(leaseToken ? { "x-autoforge-lease-token": leaseToken } : {}),
  };
}

async function browserSessionHeaders(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  return { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; ") };
}

async function searchKinds(page: Page, query: string): Promise<string[]> {
  const response = await page.request.get(`/api/v1/search?query=${encodeURIComponent(query)}`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<{ kind: string }> };
  return body.items.map((item) => item.kind);
}

async function expectDesktopLayoutFits(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      })),
    )
    .toEqual({ viewportWidth: width, documentWidth: width });
}

async function expectUiConsistency(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const minimumFontSize = 12;
    const minimumControlSize = 32;
    const isVisible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    const label = (element: HTMLElement) =>
      (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 80);
    const hasDirectText = (element: HTMLElement) =>
      Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );

    const fontViolations = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .filter((element) => isVisible(element) && hasDirectText(element))
      .map((element) => ({
        element: element.tagName.toLowerCase(),
        fontSize: Number.parseFloat(window.getComputedStyle(element).fontSize),
        label: label(element),
      }))
      .filter(({ fontSize }) => fontSize > 0 && fontSize < minimumFontSize)
      .slice(0, 20);

    const controlSelector = [
      "button",
      'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"])',
      "select",
      "textarea",
      "a.button",
      "a.primary-button",
      "a.secondary-button",
      "a.icon-button",
    ].join(",");
    const controlViolations = Array.from(
      document.body.querySelectorAll<HTMLElement>(controlSelector),
    )
      .filter(isVisible)
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          element: element.tagName.toLowerCase(),
          height: Math.round(bounds.height * 10) / 10,
          label: label(element),
        };
      })
      .filter(({ height }) => height < minimumControlSize)
      .slice(0, 20);

    return {
      controlViolations,
      documentWidth: document.documentElement.scrollWidth,
      fontViolations,
      viewportWidth: window.innerWidth,
    };
  });

  expect(report.fontViolations, "visible text smaller than 12px").toEqual([]);
  expect(report.controlViolations, "visible controls shorter than 32px").toEqual([]);
  expect(report.documentWidth, "page-level horizontal overflow").toBe(report.viewportWidth);
}
