import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import type { ClaimAssignmentsResponse } from "@autoforge/contracts";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { configureTaskExecution, createTaskRun } from "./support/task-execution";
import { expectUiIntegrity } from "./support/ui-guard";
import { expectLogCaseDetail } from "./support/log-case-detail";
import { legacyAttemptLogPath } from "./support/legacy-public-links";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";

const runnerCapabilities = [
  "executor:testng-v1",
  "isolation:cgroup-v2",
  "java:21.0.8",
  "testng:7.11.0",
  "adapter:cotest-testng-v1",
];

const registeredRunnerIds = new WeakMap<Page, string[]>();

test.afterEach(async ({ page }) => {
  // Automatic API execution may select any online compatible Runner. A fake
  // Runner has no claim loop after its scenario, so stop advertising it.
  for (const runnerId of registeredRunnerIds.get(page) ?? []) {
    const response = await page.request.patch(`/api/v1/runners/${runnerId}`, {
      headers: { origin: new URL(page.url()).origin },
      data: { state: "disabled" },
    });
    expect(response.status()).toBe(200);
  }
  registeredRunnerIds.delete(page);
});

test("global execution dialog schedules one case through a runner group with Adapter IP", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const project = await createProject(page);
  await selectProjectContext(page, project.id);
  await uploadAdapterDependencies(page, project.id);
  await importCases(page, project, ["com.example.SingleCaseFixture"]);

  const runner = await registerRunner(page);
  const groupName = `单用例执行池-${randomUUID().slice(0, 8)}`;
  await page.goto("/runners?section=groups");
  await page.getByRole("button", { name: "创建机组" }).click();
  const createGroup = page.getByRole("dialog", { name: "新建执行机组" });
  await createGroup.getByLabel("组名称").fill(groupName);
  await createGroup.locator(`input[name="runnerIds"][value="${runner.runnerId}"]`).check();
  await createGroup.getByRole("button", { name: "创建执行机组" }).click();
  await expect(page.locator(".runner-group-card", { hasText: groupName })).toBeVisible();

  // 全局入口必须在任意业务页可见，且旧的侧栏“用例批跑”入口不再存在。
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "本周质量" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByText("用例批跑")).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "开始执行" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "单个用例", exact: true }).locator("..").click();
  await expect(dialog.getByLabel("使用 CoTest TestNG Adapter")).toBeChecked();
  await dialog.getByLabel("使用 CoTest TestNG Adapter").uncheck();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(dialog.getByLabel("使用 CoTest TestNG Adapter")).toBeChecked();
  await selectOptionContaining(
    dialog.locator('select[aria-label="待执行单个用例"]'),
    "SingleCaseFixture",
  );
  await dialog.getByRole("radio", { name: "使用执行机组" }).locator("..").click();
  await selectOptionContaining(dialog.locator('select[aria-label="执行机组"]'), groupName);
  await expect(dialog.getByLabel("使用 CoTest TestNG Adapter")).toBeChecked();
  await expect(dialog.getByText("单用例参数覆盖")).toHaveCount(0);
  await dialog.getByLabel("单用例 Adapter Suite Name").fill("Single Case Suite");
  await dialog.getByLabel("单用例 Adapter Test Name").fill("Single Case Test");
  await dialog.getByLabel("单用例执行环境 IP 地址").fill("10.0.0.21");
  await expect(dialog.locator('select[aria-label="失败重跑方式"]')).toHaveValue("round");
  await expect(dialog.locator('select[aria-label="失败重跑次数"]')).toHaveValue("0");
  const retryModeTrigger = dialog.getByRole("combobox", { name: "失败重跑方式", exact: true });
  await expect(
    dialog.locator(".ui-select", {
      has: page.getByRole("combobox", { name: "失败重跑方式", exact: true }),
    }),
  ).toContainText("本轮结束后统一重跑");
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await retryModeTrigger.scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({
        path: resolve(screenshotDirectory, `single-case-default-round-${viewport.width}.png`),
      });
    }
  }

  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/v1\/case-definitions\/[^/]+\/execute$/u.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole("button", { name: "确认并开始执行" }).click();
  const response = await createResponse;
  expect(response.status()).toBe(201);
  const batch = (await response.json()) as {
    id: string;
    projectId: string;
    selectedRunnerIds: string[];
    retryMode: "immediate" | "round";
    retryLimit: number;
  };
  expect(batch.projectId).toBe(project.id);
  expect(batch.selectedRunnerIds).toEqual([runner.runnerId]);
  expect(batch.retryMode).toBe("round");
  expect(batch.retryLimit).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/run-batches/${batch.id}$`));

  const claim = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/claims`,
    {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        requestId: `single-case-claim-${randomUUID()}`,
        availableSlots: 1,
        labels: ["linux", "java", "testng"],
        capabilities: runnerCapabilities,
        waitSeconds: 0,
      },
    },
  );
  expect(claim.status()).toBe(200);
  const body = (await claim.json()) as {
    assignments: Array<{
      assignment: {
        attemptId: string;
        executionSpec: {
          className: string;
          parameters: Record<string, string>;
          adapter?: { suiteName: string; testName: string; environmentAddress: string };
        };
      };
      lease: { token: string };
    }>;
  };
  expect(body.assignments).toHaveLength(1);
  expect(body.assignments[0]!.assignment.executionSpec).toMatchObject({
    className: "com.example.SingleCaseFixture",
    parameters: {},
    adapter: {
      suiteName: "Single Case Suite",
      testName: "Single Case Test",
      environmentAddress: "10.0.0.21",
    },
  });
  expect(body.assignments[0]!.assignment.executionSpec.adapter).not.toHaveProperty("ddtScope");

  const assigned = body.assignments[0]!;
  const logLink = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-attempts/${assigned.assignment.attemptId}/log-share`,
    { method: "POST" },
  );
  expect(logLink.status).toBe(200);
  await page.goto(logLink.body.shareUrl);
  await expect(page.getByText("实时日志", { exact: true })).toBeVisible();
  const logResponse = await page.request.post(
    `/api/v1/run-attempts/${assigned.assignment.attemptId}/logs`,
    {
      headers: {
        authorization: `Bearer ${runner.credential}`,
        "x-autoforge-runner-id": runner.runnerId,
      },
      data: {
        schemaVersion: 1,
        requestId: randomUUID(),
        leaseToken: assigned.lease.token,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "single-case detail live update\n",
            recordedAt: new Date().toISOString(),
          },
          {
            stream: "agent",
            sequence: 0,
            content: "single-case Agent diagnostics\n",
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  expect(logResponse.status()).toBe(200);
  await expect(page.locator(".share-log-output:visible")).toContainText(
    "single-case detail live update",
  );
  await verifyLogStreamIsolation(page, batch.id, assigned.assignment.attemptId, testInfo);
  await page.goto(logLink.body.shareUrl);
  await page.getByRole("button", { name: "强行中断", exact: true }).click();
  const stopWarning = page.getByRole("dialog", { name: "中断手动执行" });
  await expect(stopWarning).toContainText("环境脏数据");
  await stopWarning.getByRole("button", { name: "继续执行", exact: true }).click();
  await expect(stopWarning).toHaveCount(0);
});

async function verifyLogStreamIsolation(
  page: Page,
  batchId: string,
  attemptId: string,
  testInfo: TestInfo,
): Promise<void> {
  let releaseStdout!: () => void;
  let markStdoutReceived!: () => void;
  let markStdoutFinished!: () => void;
  const stdoutReleased = new Promise<void>((resolve) => {
    releaseStdout = resolve;
  });
  const stdoutReceived = new Promise<void>((resolve) => {
    markStdoutReceived = resolve;
  });
  const stdoutFinished = new Promise<void>((resolve) => {
    markStdoutFinished = resolve;
  });
  let delayed = false;
  const logUrl = `**/api/v1/run-attempts/${attemptId}/logs?*`;
  await page.route(logUrl, async (route) => {
    if (delayed || new URL(route.request().url()).searchParams.get("stream") !== "stdout") {
      await route.continue();
      return;
    }
    delayed = true;
    const response = await route.fetch();
    markStdoutReceived();
    await stdoutReleased;
    await route.fulfill({ response });
    markStdoutFinished();
  });
  try {
    await page.goto(`/run-batches/${batchId}`);
    await page.getByRole("button", { name: "查看日志", exact: true }).click();
    await stdoutReceived;
    await page.getByRole("radio", { name: "agent", exact: true }).locator("..").click();
    await expect(page.locator(".execution-log")).toContainText("single-case Agent diagnostics");
    releaseStdout();
    await stdoutFinished;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(page.getByRole("radio", { name: "agent", exact: true })).toBeChecked();
    await expect(page.locator(".execution-log")).toContainText("single-case Agent diagnostics");
    await expect(page.locator(".execution-log")).not.toContainText(
      "single-case detail live update",
    );
    const screenshotDirectory =
      process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
    await mkdir(screenshotDirectory, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark")
        await page.getByRole("button", { name: "深色日志", exact: true }).click();
      for (const viewport of [
        { width: 1024, height: 768 },
        { width: 1536, height: 960 },
      ]) {
        await page.setViewportSize(viewport);
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshotDirectory, `log-stream-isolation-${theme}-${viewport.width}.png`),
          animations: "disabled",
        });
      }
    }
  } finally {
    releaseStdout();
    await page.unroute(logUrl);
  }
}

test("log detail reruns a completed case from an active 501-case batch and its manual rerun", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const project = await createProject(page);
  await selectProjectContext(page, project.id);
  await uploadAdapterDependencies(page, project.id);
  const classNames = Array.from(
    { length: 501 },
    (_, index) => `com.example.LogRerun${String(index).padStart(3, "0")}`,
  );
  await importCases(page, project, classNames);
  const caseDefinitionIds = await listCaseIds(page, project);
  expect(caseDefinitionIds).toHaveLength(501);
  const runner = await registerRunner(page);
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: project.id,
      projectVersionId: project.versionId,
      name: uniqueName("large-log-rerun"),
    },
  });
  expect(suite.status).toBe(201);
  await configureTaskExecution(page, suite.body.id, runner.runnerId, {
    concurrency: 1,
    retryLimit: 0,
    adapter: {
      enabled: true,
      suiteName: "Large batch log rerun",
      testName: "Log rerun case",
      environmentAddresses: ["10.0.0.21"],
    },
  });
  const members = await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
    method: "POST",
    body: { caseDefinitionIds },
  });
  expect(members.status).toBe(200);
  const sourceBatch = await createTaskRun(page, suite.body.id);
  const sourceClaims = await claimAvailableAttempts(page, runner);
  expect(sourceClaims).toHaveLength(1);
  const sourceClaim = sourceClaims[0]!;
  await finishSuccessfulAttempt(page, runner, sourceClaim);

  const summaryUrl = `/api/v1/run-batches/${sourceBatch.id}?view=summary`;
  const sourceSummary = await browserJson<{ status: string; totalRuns: number }>(page, summaryUrl);
  expect(sourceSummary.status).toBe(200);
  expect(sourceSummary.body.totalRuns).toBe(501);
  expect(["dispatching", "scheduled", "running"]).toContain(sourceSummary.body.status);
  const fullDetails = await browserJson<{ error: { code: string } }>(
    page,
    `/api/v1/run-batches/${sourceBatch.id}`,
  );
  expect(fullDetails.body.error.code).toBe("DETAIL_RESPONSE_TOO_LARGE");

  const originalLog = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-attempts/${sourceClaim.assignment.attemptId}/log-share`,
    { method: "POST" },
  );
  expect(originalLog.status).toBe(200);
  await page.goto(originalLog.body.shareUrl);
  const caseDetails = await browserJson<{ items: Array<{ id: string; displayName: string }> }>(
    page,
    `/api/v1/case-definitions?${new URLSearchParams({
      projectId: project.id,
      projectVersionId: project.versionId,
      testStageId: project.stageId,
      query: sourceClaim.assignment.executionSpec.className,
      limit: "10",
    })}`,
  );
  expect(caseDetails.status).toBe(200);
  expect(caseDetails.body.items).toHaveLength(1);
  const sourceCaseId = caseDetails.body.items[0]!.id;
  const sourceDisplayName = caseDetails.body.items[0]!.displayName;
  const detailPath = `/cases/${encodeURIComponent(sourceCaseId)}`;
  await expectLogCaseDetail(page, detailPath, sourceDisplayName, "ordinary-case-history");
  await page.goto(await legacyAttemptLogPath(sourceClaim.assignment.attemptId));
  await expectLogCaseDetail(page, detailPath, sourceDisplayName);
  const detailLink = page.getByRole("link", { name: "用例详情", exact: true });
  await detailLink.focus();
  const keyboardPopup = page.waitForEvent("popup");
  await detailLink.press("Enter");
  const keyboardDetails = await keyboardPopup;
  try {
    await expect(keyboardDetails).toHaveURL(new URL(detailPath, page.url()).href);
  } finally {
    await keyboardDetails.close();
  }
  await page.goto(originalLog.body.shareUrl);
  for (let execution = 0; execution < 2; execution += 1) {
    const submission = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/rerun"),
    );
    await page.getByRole("button", { name: "执行此用例", exact: true }).click();
    const response = await submission;
    expect(response.status(), await response.text()).toBe(201);
    const manual = (await response.json()) as { batchId: string };
    if (execution === 0) {
      const activeSource = await browserJson<{ status: string }>(page, summaryUrl);
      expect(["dispatching", "scheduled", "running"]).toContain(activeSource.body.status);
      // CI also runs with one project execution slot. After proving that rerun
      // creation works during the source batch, release its slot for the manual run.
      const cancelled = await browserJson(page, `/api/v1/run-batches/${sourceBatch.id}/cancel`, {
        method: "POST",
        body: { reason: "Release the source batch slot for log rerun acceptance" },
      });
      expect(cancelled.status).toBe(200);
    }
    let manualClaim: ClaimAssignmentsResponse["assignments"][number] | undefined;
    await expect
      .poll(
        async () => {
          const claims = await claimAvailableAttempts(page, runner);
          manualClaim = claims.find(
            (claim) => claim.assignment.executionSpec.batchId === manual.batchId,
          );
          return manualClaim?.assignment.executionSpec.className;
        },
        { timeout: 15_000 },
      )
      .toBe(sourceClaim.assignment.executionSpec.className);
    expect(manualClaim!.assignment.executionSpec.adapter).toMatchObject({
      suiteName: "Large batch log rerun",
      testName: "Log rerun case",
      environmentAddress: "10.0.0.21",
    });
    await finishSuccessfulAttempt(page, runner, manualClaim!);

    const manualLog = await browserJson<{ shareUrl: string }>(
      page,
      `/api/v1/run-attempts/${manualClaim!.assignment.attemptId}/log-share`,
      { method: "POST" },
    );
    expect(manualLog.status).toBe(200);
    await page.goto(manualLog.body.shareUrl);
    await expect(page.getByRole("button", { name: "执行此用例", exact: true })).toBeVisible();
    await expectLogCaseDetail(page, detailPath, sourceDisplayName);
  }

  const finalSource = await browserJson<{ status: string; totalRuns: number }>(page, summaryUrl);
  expect(finalSource.body.totalRuns).toBe(501);
  expect(finalSource.body.status).toBe("cancelled");
  for (const theme of ["light", "dark"] as const) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
      ]);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", theme);
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 960 },
    ]) {
      await page.setViewportSize(viewport);
      await expectUiIntegrity(page);
      const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
      if (screenshotDirectory) {
        await mkdir(screenshotDirectory, { recursive: true });
        await page.screenshot({
          path: resolve(
            screenshotDirectory,
            `large-batch-log-rerun-${theme}-${viewport.width}.png`,
          ),
          animations: "disabled",
        });
      }
    }
  }
});

test("version execution API authenticates calls and separates single results from task records", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const project = await createProject(page);
  await selectProjectContext(page, project.id, project.versionId, project.stageId);
  await uploadAdapterDependencies(page, project.id);
  const className = "com.example.VersionApiExecution";
  await importCases(page, project, [className]);
  const caseIds = await listCaseIds(page, project);
  expect(caseIds).toHaveLength(1);
  const caseDefinitionId = caseIds[0]!;
  const runner = await registerRunner(page);
  const permissions = ["run.create", "run.read", "log.read"];
  const account = await browserJson<{ id: string }>(page, "/api/v1/service-accounts", {
    method: "POST",
    body: {
      name: uniqueName("version-execution-api"),
      projectPermissions: { [project.id]: permissions },
    },
  });
  expect(account.status).toBe(201);
  const token = await browserJson<{ token: string }>(
    page,
    `/api/v1/service-accounts/${account.body.id}/tokens`,
    {
      method: "POST",
      body: {
        name: "version-run",
        scopes: permissions,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  );
  expect(token.status).toBe(201);
  const endpoint = `/api/v1/projects/${project.id}/versions/${project.versionId}/case-executions`;
  const input = {
    className,
    environmentIp: "10.0.0.21",
  };
  const headers = { authorization: `Bearer ${token.body.token}` };
  const denied = await page.request.post(endpoint.replace(project.id, "other-project"), {
    headers,
    data: input,
  });
  expect(denied.status()).toBe(403);
  const wrongVersion = await page.request.post(
    endpoint.replace(project.versionId, "missing-version"),
    { headers, data: input },
  );
  expect(wrongVersion.status()).toBe(404);
  const invalidToken = await page.request.post(endpoint, {
    headers: { authorization: "Bearer af_api_invalid" },
    data: input,
  });
  expect(invalidToken.status()).toBe(401);
  const partialClass = await page.request.post(endpoint, {
    headers,
    data: { className: "VersionApiExecution", environmentIp: input.environmentIp },
  });
  expect(partialClass.status()).toBe(404);
  const created = await page.request.post(endpoint, { headers, data: input });
  expect(created.status(), await created.text()).toBe(201);
  const execution = (await created.json()) as { batchId: string; statusUrl: string };
  let claim: ClaimAssignmentsResponse["assignments"][number] | undefined;
  await expect
    .poll(async () => {
      claim = (await claimAvailableAttempts(page, runner)).find(
        (item) => item.assignment.executionSpec.batchId === execution.batchId,
      );
      return Boolean(claim);
    })
    .toBe(true);
  expect(claim!.assignment.executionSpec).toMatchObject({
    className,
    adapter: {
      suiteName: project.name,
      testName: "单用例 E2E 版本 - 单用例 E2E 阶段",
      environmentAddress: "10.0.0.21",
    },
  });
  const logs = await page.request.post(`/api/v1/run-attempts/${claim!.assignment.attemptId}/logs`, {
    headers: {
      authorization: `Bearer ${runner.credential}`,
      "x-autoforge-runner-id": runner.runnerId,
    },
    data: {
      schemaVersion: 1,
      requestId: randomUUID(),
      leaseToken: claim!.lease.token,
      chunks: [
        {
          stream: "stdout",
          sequence: 0,
          content: "version API execution log\n",
          recordedAt: new Date().toISOString(),
        },
      ],
    },
  });
  expect(logs.status()).toBe(200);
  await finishSuccessfulAttempt(page, runner, claim!, 0);
  const status = await page.request.get(execution.statusUrl, { headers });
  expect(status.status()).toBe(200);
  expect(await status.json()).toMatchObject({
    execution: { className, attempt: { outcome: "succeeded" } },
  });
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: project.id,
      projectVersionId: project.versionId,
      name: uniqueName("任务分组"),
    },
  });
  expect(suite.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
        method: "POST",
        body: { caseDefinitionIds: [caseDefinitionId] },
      })
    ).status,
  ).toBe(200);
  await configureTaskExecution(page, suite.body.id, runner.runnerId, {
    concurrency: 1,
    retryLimit: 0,
    adapter: { enabled: false, suiteName: "", testName: "", environmentAddresses: [] },
  });
  const task = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
    method: "POST",
    body: { suiteId: suite.body.id },
  });
  expect(task.status).toBe(201);
  try {
    // Keep the comparison record without occupying the only project slot in
    // the execution CI partition while checking subsequent API requests.
    let taskClaim: ClaimAssignmentsResponse["assignments"][number] | undefined;
    await expect
      .poll(async () => {
        taskClaim = (await claimAvailableAttempts(page, runner)).find(
          (item) => item.assignment.executionSpec.batchId === task.body.id,
        );
        return Boolean(taskClaim);
      })
      .toBe(true);
    await finishSuccessfulAttempt(page, runner, taskClaim!);
    const singleQuery = new URLSearchParams({
      projectId: project.id,
      projectVersionId: project.versionId,
      executionKind: "single",
    });
    const singlePage = await browserJson<{ items: Array<{ id: string }> }>(
      page,
      `/api/v1/run-batches?${singleQuery}`,
    );
    expect(singlePage.body.items.map((item) => item.id)).toEqual([execution.batchId]);
    singleQuery.set("executionKind", "task");
    const taskPage = await browserJson<{ items: Array<{ id: string }> }>(
      page,
      `/api/v1/run-batches?${singleQuery}`,
    );
    expect(taskPage.body.items.map((item) => item.id)).toEqual([task.body.id]);
    await page.goto("/execution-records?view=single");
    const row = page.getByRole("row").filter({ hasText: className });
    await expect(row).toContainText("成功");
    await expect(row.getByRole("link", { name: /详情/ })).toHaveCount(0);
    await row.getByRole("button", { name: "结果", exact: true }).click();
    const resultDialog = page.getByRole("dialog", { name: /单用例执行结果/ });
    await expect(resultDialog).toContainText("TESTNG_SUCCEEDED");
    await expect(resultDialog.getByRole("heading", { name: /单用例执行结果/ })).toBeVisible();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`version-execution-result-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    await resultDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await row.getByRole("button", { name: "日志", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /执行日志/ })).toContainText(
      "version API execution log",
    );
    await page.keyboard.press("Escape");
    for (const appearance of ["light", "dark"] as const) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: appearance, url: "http://127.0.0.1:3100" },
        ]);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        for (const view of ["single", "task", "api"]) {
          await page.goto(`/execution-records?view=${view}`);
          await expect(page.getByRole("heading", { name: "执行记录", exact: true })).toBeVisible();
          if (view === "api") {
            await expect(
              page.getByRole("heading", { name: "必填参数", exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole("heading", { name: "选填参数", exact: true }),
            ).toBeVisible();
            await expect(page.locator("pre")).toContainText('"className"');
            await expect(page.locator("pre")).toContainText("com.example.CheckoutTest");
            await expect(page.locator("pre")).not.toContainText('"caseDefinitionId"');
            await expect(page.locator("pre")).toContainText('"environmentIp"');
            await expect(page.locator("pre")).not.toContainText('"execution"');
            await expect(page.locator("pre")).not.toContainText('"kind"');
            await expect(page.locator("pre")).not.toContainText('"selection"');
            await expect(page.locator("pre")).not.toContainText('"testStageId"');
          }
          await expectUiIntegrity(page);
          await page.screenshot({
            path: testInfo.outputPath(`version-execution-${view}-${appearance}-${width}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
    }
    await page.goto("/execution-records?view=api");
    await page.getByRole("combobox", { name: "执行 API 用例类型" }).click();
    await page.getByRole("option", { name: "DDT 用例", exact: true }).click();
    await expect(page.locator("pre")).toContainText("订单支付_001");
    await expect(page.locator("pre")).toContainText('"caseId"');
    await expect(page.locator("pre")).not.toContainText('"kind"');
    await expect(page.locator("pre")).toContainText(endpoint);
    await page.getByRole("combobox", { name: "执行 API 接口范围" }).click();
    await page.getByRole("option", { name: "限定当前测试阶段", exact: true }).click();
    await expect(page.locator("pre")).toContainText(`/stages/${project.stageId}/case-executions`);
    await expect(page.locator("pre")).not.toContainText('"testStageId"');
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`version-execution-api-ddt-dark-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    const cancellable = await page.request.post(endpoint, {
      headers,
      data: {
        caseDefinitionId,
        environmentIp: input.environmentIp,
        execution: { runnerIds: [runner.runnerId] },
      },
    });
    expect(cancellable.status()).toBe(201);
    const cancellation = (await cancellable.json()) as {
      batchId: string;
      sequenceNumber: number;
      statusUrl: string;
    };
    await page.goto("/execution-records?view=single");
    const cancelRow = page.getByRole("row").filter({ hasText: `#${cancellation.sequenceNumber}` });
    await cancelRow.getByRole("button", { name: "终止", exact: true }).click();
    await page
      .getByRole("dialog", { name: "终止单用例执行？" })
      .getByRole("button", { name: "终止执行", exact: true })
      .click();
    await expect
      .poll(async () => {
        const response = await page.request.get(cancellation.statusUrl, { headers });
        return ((await response.json()) as { execution: { status: string } }).execution.status;
      })
      .toBe("cancelled");
    const duplicateStage = await browserJson<{ id: string }>(
      page,
      `/api/v1/projects/${project.id}/versions/${project.versionId}/stages`,
      {
        method: "POST",
        body: { name: "类路径重复阶段", description: "完整类路径定位验收" },
      },
    );
    expect(duplicateStage.status).toBe(201);
    const emptyStage = await page.request.post(
      endpoint.replace("/case-executions", `/stages/${duplicateStage.body.id}/case-executions`),
      { headers, data: input },
    );
    expect(emptyStage.status()).toBe(404);
    await selectProjectContext(page, project.id, project.versionId, duplicateStage.body.id);
    await importCases(page, { ...project, stageId: duplicateStage.body.id }, [className]);
    const duplicateDefinitions = await browserJson<{ items: Array<{ className: string }> }>(
      page,
      `/api/v1/case-definitions?${new URLSearchParams({
        projectId: project.id,
        projectVersionId: project.versionId,
        testStageId: duplicateStage.body.id,
        limit: "2",
      })}`,
    );
    expect(duplicateDefinitions.body.items.map((item) => item.className)).toEqual([className]);
    const ambiguousClass = await page.request.post(endpoint, { headers, data: input });
    expect(ambiguousClass.status(), await ambiguousClass.text()).toBe(409);
    expect(await ambiguousClass.json()).toMatchObject({
      error: { code: "CASE_CLASS_SCOPE_CONFLICT" },
    });
    await heartbeatRunner(page, runner);
    const scoped = await page.request.post(
      endpoint.replace("/case-executions", `/stages/${project.stageId}/case-executions`),
      { headers, data: input },
    );
    expect(scoped.status(), await scoped.text()).toBe(201);
    const scopedExecution = (await scoped.json()) as { batchId: string; statusUrl: string };
    let scopedClaim: ClaimAssignmentsResponse["assignments"][number] | undefined;
    await expect
      .poll(async () => {
        scopedClaim = (await claimAvailableAttempts(page, runner)).find(
          (item) => item.assignment.executionSpec.batchId === scopedExecution.batchId,
        );
        return Boolean(scopedClaim);
      })
      .toBe(true);
    expect(scopedClaim!.assignment.executionSpec.adapter).toMatchObject({
      suiteName: project.name,
      testName: "单用例 E2E 版本 - 单用例 E2E 阶段",
      environmentAddress: input.environmentIp,
    });
    await finishSuccessfulAttempt(page, runner, scopedClaim!);
    const scopedResult = await page.request.get(scopedExecution.statusUrl, { headers });
    expect(await scopedResult.json()).toMatchObject({
      execution: {
        caseDefinitionId,
        className,
        attempt: { outcome: "succeeded" },
      },
    });
  } finally {
    await browserJson(page, `/api/v1/run-batches/${task.body.id}/terminate`, {
      method: "POST",
      body: { reason: "E2E complete" },
    });
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: "light", url: "http://127.0.0.1:3100" }]);
  }
});

async function listCaseIds(
  page: Page,
  project: { id: string; versionId: string },
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const parameters = new URLSearchParams({
      projectId: project.id,
      projectVersionId: project.versionId,
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const response = await browserJson<{ items: Array<{ id: string }>; nextCursor?: string }>(
      page,
      `/api/v1/case-definitions?${parameters}`,
    );
    expect(response.status).toBe(200);
    ids.push(...response.body.items.map((item) => item.id));
    cursor = response.body.nextCursor;
  } while (cursor);
  return ids;
}

async function claimAvailableAttempts(
  page: Page,
  runner: { runnerId: string; credential: string },
): Promise<ClaimAssignmentsResponse["assignments"]> {
  const response = await page.request.post(`/api/v1/runner-agents/${runner.runnerId}/claims`, {
    headers: { authorization: `Bearer ${runner.credential}` },
    data: {
      schemaVersion: 1,
      requestId: randomUUID(),
      availableSlots: 2,
      labels: ["linux", "java", "testng"],
      capabilities: runnerCapabilities,
      waitSeconds: 0,
    },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as ClaimAssignmentsResponse).assignments;
}

async function finishSuccessfulAttempt(
  page: Page,
  runner: { runnerId: string; credential: string },
  claim: ClaimAssignmentsResponse["assignments"][number],
  stdoutSequence = -1,
): Promise<void> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${claim.assignment.attemptId}/complete`,
    {
      headers: {
        authorization: `Bearer ${runner.credential}`,
        "x-autoforge-runner-id": runner.runnerId,
      },
      data: {
        schemaVersion: 1,
        completionId: randomUUID(),
        leaseToken: claim.lease.token,
        result: {
          status: "succeeded",
          resultCode: "TESTNG_SUCCEEDED",
          summary: "Log rerun acceptance passed",
          durationMs: 100,
          logWatermarks: { stdout: stdoutSequence, stderr: -1, agent: -1 },
          artifacts: [],
        },
      },
    },
  );
  expect(response.status()).toBe(200);
}

async function selectOptionContaining(select: Locator, text: string): Promise<void> {
  const option = select.locator("option").filter({ hasText: text });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  if (!value) throw new Error(`Option containing ${text} has no selectable value.`);
  await select.selectOption(value);
}

async function createProject(page: Page) {
  const suffix = uniqueName("single-case");
  const project = await browserJson<{ id: string; name: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: `单用例项目 ${suffix}`, slug: suffix },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(project.body.id)}/versions`,
    { method: "POST", body: { name: "单用例 E2E 版本" } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(project.body.id)}/versions/${encodeURIComponent(version.body.id)}/stages`,
    { method: "POST", body: { name: "单用例 E2E 阶段", description: "全局单用例调度验收" } },
  );
  expect(stage.status).toBe(201);
  return { ...project.body, versionId: version.body.id, stageId: stage.body.id };
}

async function uploadAdapterDependencies(page: Page, projectId: string): Promise<void> {
  const dependencyJar = zipSync({
    "META-INF/MANIFEST.MF": new TextEncoder().encode("Manifest-Version: 1.0\n"),
  });
  const dependencyArchive = zipSync({ "lib/e2e-placeholder.jar": dependencyJar });
  await page.goto(
    `/settings/projects?${new URLSearchParams({
      projectId,
      section: "execution",
    }).toString()}`,
  );
  await page.getByText("上传本地压缩包", { exact: true }).click();
  const uploadForm = page.locator("form", {
    has: page.getByRole("button", { name: "上传并启用" }),
  });
  await uploadForm
    .getByLabel("资源类型")
    .and(uploadForm.locator("select"))
    .selectOption("jar-bundle");
  await uploadForm.getByLabel("压缩格式").and(uploadForm.locator("select")).selectOption("zip");
  await uploadForm.getByLabel("本地文件").setInputFiles({
    name: "single-case-dependencies.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(dependencyArchive),
  });
  await uploadForm.getByRole("button", { name: "上传并启用" }).click();
  await expect(page.getByText("运行时资源已上传并设为当前配置。")).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    uploadForm.getByRole("progressbar", { name: "运行时资源上传完成进度" }),
  ).toHaveAttribute("aria-valuenow", "100");
}

async function importCases(
  page: Page,
  project: { id: string; name: string; versionId: string; stageId: string },
  classNames: string[],
): Promise<void> {
  const jar = zipSync(
    Object.fromEntries(
      classNames.map((className) => [
        `${className.replaceAll(".", "/")}.class`,
        buildClassFile({
          className,
          methods: [{ name: "runsOnce", annotations: [{ type: "Test", values: {} }] }],
        }),
      ]),
    ),
  );
  await page.goto(
    `/cases/import?${new URLSearchParams({
      projectVersionId: project.versionId,
      testStageId: project.stageId,
    }).toString()}`,
  );
  await expect(page.locator(".global-project-switcher")).toContainText(project.name);
  await page.locator('input[type="file"]').setInputFiles({
    name: "single-case-fixture.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(
    page.getByText(`将创建 ${classNames.length} 个用例定义`, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status").filter({ hasText: /已导入|已返回现有用例/u })).toBeVisible({
    timeout: 60_000,
  });
}

async function registerRunner(page: Page): Promise<{ runnerId: string; credential: string }> {
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: "E2E Single Case Runner",
      labels: ["linux", "java", "testng"],
      capabilities: runnerCapabilities,
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.7.2",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const runner = (await registration.json()) as { runnerId: string; credential: string };
  registeredRunnerIds.set(page, [...(registeredRunnerIds.get(page) ?? []), runner.runnerId]);
  await heartbeatRunner(page, runner);
  return runner;
}

async function heartbeatRunner(
  page: Page,
  runner: { runnerId: string; credential: string },
): Promise<void> {
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        busySlots: 0,
        labels: ["linux", "java", "testng"],
        capabilities: runnerCapabilities,
        maxConcurrency: 2,
        agentVersion: "0.7.2",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 10,
          memoryUtilizationPercent: 20,
          loadAverage1m: 0.1,
          logicalCpuCount: 4,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(heartbeat.status()).toBe(200);
}
