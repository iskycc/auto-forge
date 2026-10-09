import { expect, test, type Locator, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import {
  acceptSystemDialog,
  browserJson,
  ensureAdministrator,
  E2E_ADMIN_USERNAME,
  login,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { selectJarForInspection } from "./support/jar-import";
import { configureTaskExecution, createTaskRun } from "./support/task-execution";
import { expectUiIntegrity } from "./support/ui-guard";
import { insertCaseExecutionHistoryFixture } from "./support/case-execution-history-fixture";

test("case detail and preview list only completed executions and keep filtered pagination and empty states", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("completed-history");
  const project = await createProject(page, suffix);
  const runner = await registerRunner(page, suffix);
  const className = `example.History${Date.now()}Test`;
  const emptyClassName = className.replace(/Test$/u, "EmptyTest");
  await importJar(
    page,
    project,
    `${suffix}.jar`,
    className,
    ["verify"],
    [{ className: emptyClassName, methodNames: ["verify"] }],
  );
  const definitions = await browserJson<{
    items: Array<{ id: string; className: string; displayName: string }>;
  }>(
    page,
    `/api/v1/case-definitions?${new URLSearchParams({ projectId: project.id, query: className })}`,
  );
  const definition = definitions.body.items.find((item) => item.className === className)!;
  const emptyDefinition = await findVersionCase(
    page,
    project.id,
    project.versionId,
    project.stageId,
    emptyClassName,
  );
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  const postgresUrl = process.env.AUTOFORGE_E2E_POSTGRES_URL;
  const fixtureLocation = {
    ...(directory ? { directory } : {}),
    ...(postgresUrl ? { postgresUrl } : {}),
  };
  const fixture = await insertCaseExecutionHistoryFixture({
    ...fixtureLocation,
    projectId: project.id,
    projectVersionId: project.versionId,
    caseId: definition.id,
    runnerId: runner.id,
  });
  await insertCaseExecutionHistoryFixture({
    ...fixtureLocation,
    projectId: project.id,
    projectVersionId: project.versionId,
    caseId: emptyDefinition.id,
    runnerId: runner.id,
    completedCount: 0,
  });
  const api = await browserJson<{ items: Array<{ runId: string }>; nextCursor?: string }>(
    page,
    `/api/v1/case-definitions/${definition.id}/executions?limit=2`,
  );
  expect(api.status).toBe(200);
  expect(api.body.items.map((item) => item.runId)).toEqual(fixture.completedRunIds.slice(0, 2));
  expect(api.body.nextCursor).toBeTruthy();
  const history = page.locator(".case-execution-history");
  const assertHistory = async (count: number) => {
    await expect(history.locator("tbody tr")).toHaveCount(count);
    await expect(history).not.toContainText(
      /隐藏历史|已取消|等待资源|已分配|执行中|尚未生成执行尝试/u,
    );
    await expect(history).toContainText("TestNG 通过");
    await expect(history).toContainText("TestNG 断言失败");
    await expect(history).toContainText("执行超时");
    await expect(history.getByRole("button", { name: "查看第 1 轮总结日志" })).toHaveCount(count);
  };
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: theme, url: page.url() }]);
    await page.goto(`/cases/${definition.id}`);
    await assertHistory(50);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await history
        .locator("thead")
        .evaluate((element) =>
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
        );
      await expectUiIntegrity(page);
      await captureUi(page, `completed-history-detail-${theme}-${width}`);
    }
    await history.getByRole("button", { name: "加载更早的执行历史" }).click();
    await assertHistory(51);
    await expect(history.getByText("已显示该用例的全部执行历史。")).toBeVisible();
    await page.goto(
      `/cases?${new URLSearchParams({ projectId: project.id, projectVersionId: project.versionId, testStageId: project.stageId, query: definition.displayName })}`,
    );
    await page
      .getByRole("button", { name: `快速预览 ${definition.displayName}`, exact: true })
      .click();
    await assertHistory(50);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await history
        .locator("thead")
        .evaluate((element) =>
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
        );
      await expectUiIntegrity(page);
      await captureUi(page, `completed-history-preview-${theme}-${width}`);
    }
    await history.getByRole("button", { name: "加载更早的执行历史" }).click();
    await assertHistory(51);
    await history.getByRole("button", { name: "查看第 1 轮总结日志" }).first().click();
    await expect(page.locator(".execution-log")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".execution-log")).toHaveCount(0);
  }
  await page.goto(`/cases/${emptyDefinition.id}`);
  await expect(history).toContainText("当前用例尚无执行记录。");
  await expect(history.getByRole("button", { name: "加载更早的执行历史" })).toHaveCount(0);
  await page.setViewportSize({ width: 1024, height: 768 });
  await history
    .locator("thead")
    .evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
    );
  await captureUi(page, "completed-history-empty-1024");
});

test("task deletion preserves history, public logs, analysis and in-flight execution with reviewable confirmations", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("delete-task");
  const project = await createProject(page, suffix);
  await selectProjectContext(page, project.id, project.versionId, project.stageId);
  const className = `example.DeleteTask${Date.now()}Test`;
  await importJar(page, project, `${suffix}.jar`, className, ["verify"]);
  const definition = await findVersionCase(
    page,
    project.id,
    project.versionId,
    project.stageId,
    className,
  );
  const name = `删除任务 ${suffix} ${"保留历史".repeat(12)}`;
  const suite = await createVersionSuite(page, project.id, project.versionId, name, definition.id);
  const runner = await registerRunner(page, suffix);
  await configureTaskExecution(page, suite.id, runner.id, {
    concurrency: 1,
    retryLimit: 0,
    adapter: { enabled: false, suiteName: "", testName: "", environmentAddresses: [] },
  });
  const completed = await createTaskRun(page, suite.id);
  const batchBeforeDeletion = await browserJson(
    page,
    `/api/v1/run-batches/${completed.id}?view=summary`,
  );
  expect(batchBeforeDeletion.body).toMatchObject({
    requestedBy: { username: E2E_ADMIN_USERNAME, source: "local" },
  });
  const completedClaim = await claimDeletionAttempt(page, runner);
  const marker = `preserved-task-log-${suffix}`;
  await uploadDeletionLog(page, runner, completedClaim, marker);
  await completeDeletionAttempt(page, runner, completedClaim, "failed");
  const share = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-attempts/${completedClaim.assignment.attemptId}/log-share`,
    { method: "POST", body: {} },
  );
  expect(share.status).toBe(200);
  const analysisScope = {
    projectId: project.id,
    projectVersionId: project.versionId,
    batchId: completed.id,
  };
  expect(
    (
      await browserJson(page, "/api/v1/failure-analysis/batches", {
        method: "POST",
        body: analysisScope,
      })
    ).status,
  ).toBe(201);
  const analysisEndpoint = `/api/v1/failure-analysis/candidates?${new URLSearchParams(analysisScope)}`;
  const analysisBefore = await browserJson<{ items: unknown[] }>(page, analysisEndpoint);
  expect(analysisBefore.status).toBe(200);
  expect(analysisBefore.body.items).toHaveLength(1);
  const active = await createTaskRun(page, suite.id);
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suite.id}/schedule`, {
        method: "PUT",
        body: {
          cronExpression: "0 9 * * *",
          timeZone: "Asia/Shanghai",
          missedRunPolicy: "skip",
          enabled: true,
        },
      })
    ).status,
  ).toBe(200);

  const card = page.getByRole("article", { name: `任务 ${name}`, exact: true });
  const trigger = () => card.getByRole("button", { name: `删除任务 ${name}`, exact: true });
  const dialog = page.getByRole("dialog", { name: "删除任务", exact: true });
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
      ]);
    await page.goto("/case-suites");
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", theme);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await card.scrollIntoViewIfNeeded();
      await expect(trigger()).toBeEnabled();
      await expectUiIntegrity(page);
      await captureUi(page, `task-delete-list-${theme}-${width}`);
      await trigger().click();
      await expect(dialog).toContainText(name);
      await expect(dialog).toContainText("历史执行记录、日志、产物和分析结果都会保留");
      await expectUiIntegrity(page);
      await captureUi(page, `task-delete-confirm-${theme}-${width}`);
      if (width === 1536) await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(trigger()).toBeFocused();
    }
  }
  expect((await browserJson(page, `/api/v1/case-suites/${suite.id}`)).status).toBe(200);
  const taskPath = `/api/v1/case-suites/${suite.id}`;
  let releaseDeletionFailure!: () => void;
  const deletionFailureGate = new Promise<void>((resolve) => {
    releaseDeletionFailure = resolve;
  });
  await page.route(`**${taskPath}`, async (route) => {
    if (route.request().method() === "DELETE") {
      await deletionFailureGate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "暂时无法删除，请重试。" } }),
      });
    } else await route.continue();
  });
  await trigger().click();
  try {
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(dialog.getByRole("button", { name: /确认删除/u })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    releaseDeletionFailure();
  }
  await expect(dialog.getByRole("alert")).toContainText("暂时无法删除");
  await expect(dialog.getByRole("button", { name: "确认删除" })).toBeEnabled();
  await expectUiIntegrity(page);
  await captureUi(page, "task-delete-failed-1536");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.unroute(`**${taskPath}`);

  const beforeUpdate = await browserJson<{ revision: number }>(page, taskPath);
  expect(
    (
      await browserJson(page, taskPath, {
        method: "PATCH",
        body: {
          description: "Concurrent saved edit",
          expectedRevision: beforeUpdate.body.revision,
        },
      })
    ).status,
  ).toBe(200);
  await trigger().click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  const conflict = page.getByRole("dialog", { name: "用例任务已被其他人修改", exact: true });
  await expect(conflict).toBeVisible();
  await page.mouse.move(0, 0);
  await expectUiIntegrity(page);
  await captureUi(page, "task-delete-conflict-1536");
  await conflict.getByRole("button", { name: "重新加载最新内容", exact: true }).click();
  await expect(card).toContainText("Concurrent saved edit");
  const activeClaim = await claimDeletionAttempt(page, runner);
  await trigger().click();
  const deletion = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" && new URL(response.url()).pathname === taskPath,
  );
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  expect((await deletion).status()).toBe(204);
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(card).toHaveCount(0);
  expect((await browserJson(page, taskPath)).status).toBe(404);
  expect((await browserJson(page, `${taskPath}/schedule`)).status).toBe(404);
  expect(
    (
      await browserJson(page, "/api/v1/run-batches", {
        method: "POST",
        body: { suiteId: suite.id },
      })
    ).status,
  ).toBe(404);
  expect((await browserJson(page, `/api/v1/case-definitions/${definition.id}`)).status).toBe(200);
  const analysisAfter = await browserJson(page, analysisEndpoint);
  expect(analysisAfter.status).toBe(200);
  expect(analysisAfter.body).toEqual(analysisBefore.body);

  // A previously claimed assignment continues to accept logs and completion after task deletion.
  await uploadDeletionLog(page, runner, activeClaim, "after-task-deletion");
  await completeDeletionAttempt(page, runner, activeClaim, "succeeded");
  const finished = await browserJson<{ status: string }>(
    page,
    `/api/v1/run-batches/${active.id}?view=summary`,
  );
  expect(finished.body.status).toBe("succeeded");
  const logs = await browserJson<{ items: Array<{ content: string }> }>(
    page,
    `/api/v1/run-attempts/${completedClaim.assignment.attemptId}/logs?stream=stdout`,
  );
  expect(logs.status).toBe(200);
  expect(logs.body.items.map((chunk) => chunk.content).join("")).toContain(marker);
  const exportedLogUrls: string[] = [];
  for (const template of ["results", "failure-analysis"]) {
    const exported = await page.request.get(
      `/api/v1/run-batches/${completed.id}/export?scope=final&template=${template}&outcomes=failed`,
    );
    expect(exported.status(), exported.ok() ? undefined : await exported.text()).toBe(200);
    const files = unzipSync(new Uint8Array(await exported.body()));
    const worksheet = new TextDecoder().decode(files["xl/worksheets/sheet1.xml"]);
    const strings = new TextDecoder().decode(
      files["xl/sharedStrings.xml"] ?? files["xl/worksheets/sheet1.xml"],
    );
    expect(strings).toContain(className);
    expect(worksheet).toContain('row r="2"');
    const relationships = new TextDecoder().decode(files["xl/worksheets/_rels/sheet1.xml.rels"]);
    const logUrl = relationships.match(
      /Target="([^"]+\/share\/attempt-log\/[A-Za-z0-9_-]+)"/u,
    )?.[1];
    expect(logUrl).toBeDefined();
    exportedLogUrls.push(logUrl!);
  }
  const anonymous = await browser.newPage();
  for (const logUrl of [new URL(share.body.shareUrl, page.url()).toString(), ...exportedLogUrls]) {
    await anonymous.goto(logUrl);
    await expect(anonymous.locator(".execution-log")).toContainText(marker);
  }
  await anonymous.close();
  await page.goto(`/run-batches/${completed.id}`);
  await expect(page.locator(".page-hero")).toContainText(`拉起人：${E2E_ADMIN_USERNAME}`);
  await expect(page.getByRole("button", { name: "再次执行", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "批次操作", exact: true })).toContainText(
    "本批次的执行记录与配置快照已保留",
  );
  await expect(page.getByRole("button", { name: "以失败用例创建任务", exact: true })).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
      ]);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", theme);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.getByRole("region", { name: "批次操作", exact: true }).scrollIntoViewIfNeeded();
      await expectUiIntegrity(page);
      await captureUi(page, `task-delete-preserved-execution-${theme}-${width}`);
    }
  }
  await page.getByRole("button", { name: "以失败用例创建任务", exact: true }).click();
  const copyDialog = page.getByRole("dialog", { name: "以失败用例创建任务", exact: true });
  const copiedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/run-batches/${completed.id}/failure-case-suite`),
  );
  await copyDialog.getByRole("button", { name: "创建任务", exact: true }).click();
  const copied = await copiedResponse;
  expect(copied.status()).toBe(201);
  const recreated = (await copied.json()) as {
    id: string;
    caseCount: number;
    policy: { concurrency: number };
  };
  expect(recreated).toMatchObject({ caseCount: 1, policy: { concurrency: 1 } });
  await expect(page).toHaveURL(new RegExp(`/case-suites/${recreated.id}$`));
  await page.goto(`/case-suites/${suite.id}`);
  await expect(page.getByRole("heading", { name: "页面不存在", exact: true })).toBeVisible();

  // Exercise deletion from the details of a newly created, never-executed task as well.
  const emptyName = `空任务 ${suffix}`;
  const empty = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId: project.id, projectVersionId: project.versionId, name: emptyName },
  });
  expect(empty.status).toBe(201);
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
      ]);
    await page.goto(`/case-suites/${empty.body.id}`);
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", theme);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      const detailAction = page.getByRole("button", { name: `删除任务 ${emptyName}`, exact: true });
      await detailAction.scrollIntoViewIfNeeded();
      await expect(detailAction).toBeEnabled();
      await expectUiIntegrity(page);
      await captureUi(page, `task-delete-detail-${theme}-${width}`);
    }
  }
  await page.getByRole("button", { name: `删除任务 ${emptyName}`, exact: true }).click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page).toHaveURL(/\/case-suites$/u);
  await expect(page.getByRole("article", { name: `任务 ${emptyName}`, exact: true })).toHaveCount(
    0,
  );
  expect((await browserJson(page, `/api/v1/case-suites/${empty.body.id}`)).status).toBe(404);
});

test("newly created tasks can be deleted immediately without reappearing after refresh", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("delete-new-task");
  const project = await createProject(page, suffix);
  await selectProjectContext(page, project.id, project.versionId, project.stageId);
  await page.goto("/case-suites");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  const creationDialog = page.getByRole("dialog", { name: "创建用例任务", exact: true });
  await creationDialog.getByLabel("任务名称", { exact: true }).fill(suffix);
  const creationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/case-suites",
  );
  await creationDialog.getByRole("button", { name: "创建任务", exact: true }).click();
  const created = await creationResponse;
  expect(created.status()).toBe(201);
  const suite = (await created.json()) as { id: string };
  const card = page.getByRole("article", { name: `任务 ${suffix}`, exact: true });
  await card.getByRole("button", { name: `删除任务 ${suffix}`, exact: true }).click();
  await page
    .getByRole("dialog", { name: "删除任务", exact: true })
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(card).toHaveCount(0);
  expect((await browserJson(page, `/api/v1/case-suites/${suite.id}`)).status).toBe(404);
});

type DeletionClaim = { assignment: { attemptId: string }; lease: { token: string } };
type DeletionRunner = { id: string; credential: string };

async function claimDeletionAttempt(page: Page, runner: DeletionRunner): Promise<DeletionClaim> {
  let claim: DeletionClaim | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`/api/v1/runner-agents/${runner.id}/claims`, {
          headers: { authorization: `Bearer ${runner.credential}` },
          data: {
            schemaVersion: 1,
            requestId: uniqueName("delete-claim"),
            availableSlots: 1,
            waitSeconds: 0,
            labels: ["linux", "java", "testng"],
            capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
          },
        });
        expect(response.status()).toBe(200);
        claim = ((await response.json()) as { assignments: DeletionClaim[] }).assignments[0];
        return Boolean(claim);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return claim!;
}

async function uploadDeletionLog(
  page: Page,
  runner: DeletionRunner,
  claim: DeletionClaim,
  content: string,
): Promise<void> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${claim.assignment.attemptId}/logs`,
    {
      headers: { authorization: `Bearer ${runner.credential}`, "x-autoforge-runner-id": runner.id },
      data: {
        schemaVersion: 1,
        requestId: uniqueName("delete-log"),
        leaseToken: claim.lease.token,
        chunks: [{ stream: "stdout", sequence: 0, content, recordedAt: new Date().toISOString() }],
      },
    },
  );
  expect(response.status()).toBe(200);
}

async function completeDeletionAttempt(
  page: Page,
  runner: DeletionRunner,
  claim: DeletionClaim,
  status: "succeeded" | "failed",
): Promise<void> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${claim.assignment.attemptId}/complete`,
    {
      headers: { authorization: `Bearer ${runner.credential}`, "x-autoforge-runner-id": runner.id },
      data: {
        schemaVersion: 1,
        completionId: uniqueName("delete-complete"),
        leaseToken: claim.lease.token,
        result: {
          status,
          resultCode: status === "succeeded" ? "TESTNG_SUCCEEDED" : "TESTNG_ASSERTIONS_FAILED",
          summary: status,
          durationMs: 100,
          logWatermarks: { stdout: 0, stderr: -1, agent: -1 },
          artifacts: [],
        },
      },
    },
  );
  expect(response.status()).toBe(200);
}

test("personal task pins persist across browsers, sort naturally and recover after failed changes", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("task-pins");
  const project = await createProject(page, suffix);
  await selectProjectContext(page, project.id, project.versionId, project.stageId);
  const tasks = new Map<
    string,
    { id: string; revision: number; version: number; updatedAt: string }
  >();
  for (const name of ["任务 10", "任务 2", "任务 1"]) {
    const created = await browserJson<{
      id: string;
      revision: number;
      version: number;
      updatedAt: string;
    }>(page, "/api/v1/case-suites", {
      method: "POST",
      body: { projectId: project.id, projectVersionId: project.versionId, name },
    });
    expect(created.status).toBe(201);
    tasks.set(name, created.body);
  }
  await page.goto("/case-suites");
  const titles = page.locator(".suite-list .suite-title-line > strong");
  const pin = (name: string) => page.getByRole("checkbox", { name: `置顶 ${name}`, exact: true });
  await expect(titles).toHaveText(["任务 1", "任务 2", "任务 10"]);
  await pin("任务 10").check();
  await expect(titles).toHaveText(["任务 10", "任务 1", "任务 2"]);
  await expect(pin("任务 2")).toBeEnabled();
  await pin("任务 2").check();
  await expect(titles).toHaveText(["任务 2", "任务 10", "任务 1"]);
  await expect(pin("任务 2")).toBeEnabled();
  await page.reload();
  await expect(titles).toHaveText(["任务 2", "任务 10", "任务 1"]);
  await expect(pin("任务 2")).toBeChecked();

  // A new browser context has no local preferences; persistence comes from the user's account.
  const otherContext = await browser.newContext();
  try {
    await otherContext.addCookies(await page.context().cookies());
    const otherPage = await otherContext.newPage();
    await otherPage.goto(new URL("/case-suites", page.url()).toString());
    await expect(otherPage.locator(".suite-list .suite-title-line > strong")).toHaveText([
      "任务 2",
      "任务 10",
      "任务 1",
    ]);
    await expect(
      otherPage.getByRole("checkbox", { name: "置顶 任务 10", exact: true }),
    ).toBeChecked();
  } finally {
    await otherContext.close();
  }

  const readerName = uniqueName("task-pin-reader");
  const readerPassword = "TaskReader!Password123";
  const reader = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: {
      username: readerName,
      displayName: readerName,
      password: readerPassword,
      forcePasswordChange: false,
    },
  });
  expect(reader.status).toBe(201);
  const role = await browserJson<{ id: string }>(page, "/api/v1/roles", {
    method: "POST",
    body: {
      key: uniqueName("task-pin-reader-role"),
      name: "任务只读与个人置顶",
      scope: "project",
      permissions: ["project.read", "case_suite.read"],
    },
  });
  expect(role.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/users/${reader.body.id}/project-roles`, {
        method: "POST",
        body: { projectId: project.id, roleId: role.body.id },
      })
    ).status,
  ).toBe(204);
  const readerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const readerPage = await readerContext.newPage();
    await login(readerPage, readerName, readerPassword);
    await selectProjectContext(readerPage, project.id, project.versionId, project.stageId);
    await readerPage.goto("/case-suites");
    const readerPin = readerPage.getByRole("checkbox", { name: "置顶 任务 10", exact: true });
    await expect(readerPin).not.toBeChecked();
    await expect(readerPage.getByRole("button", { name: "创建任务", exact: true })).toHaveCount(0);
    await readerPin.check();
    await expect(readerPin).toBeEnabled();
    await readerPage.reload();
    await expect(readerPage.locator(".suite-list .suite-title-line > strong")).toHaveText([
      "任务 10",
      "任务 1",
      "任务 2",
    ]);
    await expect(
      readerPage.getByRole("checkbox", { name: "置顶 任务 2", exact: true }),
    ).not.toBeChecked();
  } finally {
    await readerContext.close();
  }
  await page.reload();
  await expect(titles).toHaveText(["任务 2", "任务 10", "任务 1"]);

  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  const create = page.getByRole("dialog", { name: "创建用例任务", exact: true });
  await create.getByLabel("任务名称", { exact: true }).fill("任务 100");
  await create.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(titles).toHaveText(["任务 2", "任务 10", "任务 100", "任务 1"]);
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      const card = page.getByRole("article", { name: "任务 任务 2", exact: true });
      await expectHorizontalIntegrity(card.locator(".suite-card-actions"));
      await captureUi(page, `task-pins-${theme}-${width}`);
    }
  }
  const original = tasks.get("任务 10")!;
  const summary = await browserJson<{ revision: number; version: number; updatedAt: string }>(
    page,
    `/api/v1/case-suites/${original.id}?view=summary`,
  );
  expect(summary.status).toBe(200);
  expect(summary.body).toMatchObject({
    revision: original.revision,
    version: original.version,
    updatedAt: original.updatedAt,
  });
  await page.route(
    `**/api/v1/case-suites/${original.id}/pin`,
    (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: {
            code: "PLATFORM_BUSY",
            message: "置顶保存暂时不可用，请重试。",
            requestId: "pin-change",
          },
        },
      }),
    { times: 1 },
  );
  await pin("任务 10").uncheck();
  await expect(page.getByRole("region", { name: "用例任务列表" }).getByRole("alert")).toContainText(
    "置顶保存暂时不可用",
  );
  await expect(pin("任务 10")).toBeEnabled();
  await expect(pin("任务 10")).toBeChecked();
  await expect(titles).toHaveText(["任务 2", "任务 10", "任务 100", "任务 1"]);
  let releaseSave: () => void = () => {};
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    `**/api/v1/case-suites/${original.id}/pin`,
    async (route) => {
      await saveGate;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await pin("任务 10").uncheck();
    await expect(titles).toHaveText(["任务 2", "任务 100", "任务 1", "任务 10"]);
    await expect(pin("任务 10")).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(pin("任务 2")).toBeEnabled();
  await pin("任务 2").focus();
  await pin("任务 2").press("Space");
  await expect(pin("任务 2")).not.toBeChecked();
  await expect(titles).toHaveText(["任务 100", "任务 1", "任务 2", "任务 10"]);
  await page.reload();
  await expect(titles).toHaveText(["任务 100", "任务 1", "任务 2", "任务 10"]);
});

test("task adapter names default to project, version and stage without replacing saved names", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("adapter-defaults");
  const project = await createProject(page, suffix);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.id}/versions/${project.versionId}/stages`,
    { method: "POST", body: { name: "SIT", description: "Adapter default scope" } },
  );
  expect(stage.status).toBe(201);
  const versionWithoutStage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.id}/versions`,
    { method: "POST", body: { name: "2.0" } },
  );
  expect(versionWithoutStage.status).toBe(201);
  await selectProjectContext(page, project.id, project.versionId, stage.body.id);
  await page.goto("/case-suites");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "创建用例任务", exact: true });
  await expect(dialog.getByLabel("使用 CoTest TestNG Adapter")).toBeChecked();
  await expect(dialog.getByLabel("TestNG Suite Name", { exact: true })).toHaveValue(project.name);
  await expect(dialog.getByLabel("TestNG Test Name", { exact: true })).toHaveValue(
    "Lifecycle version - SIT",
  );
  await dialog.getByLabel("任务名称", { exact: true }).fill(`Adapter defaults ${suffix}`);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await dialog.getByLabel("TestNG Test Name", { exact: true }).scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await captureUi(page, `adapter-defaults-create-${width}`);
  }
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/case-suites",
  );
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const suite = (await created.json()) as {
    id: string;
    policy: { adapter: { suiteName: string; testName: string } };
  };
  expect(suite.policy.adapter).toMatchObject({
    enabled: true,
    suiteName: project.name,
    testName: "Lifecycle version - SIT",
  });
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(dialog.getByLabel("使用 CoTest TestNG Adapter")).toBeChecked();
  await dialog.getByLabel("使用 CoTest TestNG Adapter").uncheck();
  await dialog.getByLabel("任务名称", { exact: true }).fill(`Direct execution ${suffix}`);
  const directCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/case-suites",
  );
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  const directResponse = await directCreated;
  expect(directResponse.status()).toBe(201);
  const directSuite = (await directResponse.json()) as {
    id: string;
    policy: { adapter: { enabled: boolean } };
  };
  expect(directSuite.policy.adapter.enabled).toBe(false);
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(dialog.getByLabel("使用 CoTest TestNG Adapter")).toBeChecked();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  const directCopy = await browserJson<{ id: string; policy: { adapter: { enabled: boolean } } }>(
    page,
    `/api/v1/case-suites/${directSuite.id}/copy`,
    { method: "POST", body: { name: `Direct copy ${suffix}`, includeCases: false } },
  );
  expect(directCopy.status).toBe(201);
  expect(directCopy.body.policy.adapter.enabled).toBe(false);
  await page.goto(`/case-suites/${directCopy.body.id}`);
  await expect(page.locator('input[name="adapterEnabled"]')).not.toBeChecked();
  const runner = await registerRunner(page, suffix);
  await configureTaskExecution(page, suite.id, runner.id);

  // A saved task keeps its own version and names even if the top bar points elsewhere.
  await selectProjectContext(page, project.id, versionWithoutStage.body.id);
  await page.goto(`/case-suites/${suite.id}`);
  await expect(page.getByLabel("Adapter Suite Name", { exact: true })).toHaveValue(project.name);
  await expect(page.getByLabel("Adapter Test Name", { exact: true })).toHaveValue(
    "Lifecycle version - SIT",
  );
  await page.getByLabel("Adapter Suite Name", { exact: true }).fill("Custom suite");
  await page.getByLabel("Adapter Test Name", { exact: true }).fill("Custom test");
  await page.locator('select[name="projectVersionId"]').selectOption(versionWithoutStage.body.id);
  await expect(page.getByLabel("Adapter Test Name", { exact: true })).toHaveValue("Custom test");
  await page.locator('select[name="projectVersionId"]').selectOption(project.versionId);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(".toast-viewport").getByRole("status")).toContainText("用例任务已更新");
  await page.reload();
  await expect(page.getByLabel("Adapter Suite Name", { exact: true })).toHaveValue("Custom suite");
  await expect(page.getByLabel("Adapter Test Name", { exact: true })).toHaveValue("Custom test");
  const copy = await browserJson<{ id: string }>(page, `/api/v1/case-suites/${suite.id}/copy`, {
    method: "POST",
    body: { name: `Adapter copy ${suffix}`, includeCases: false },
  });
  expect(copy.status).toBe(201);
  await page.goto(`/case-suites/${copy.body.id}`);
  await expect(page.getByLabel("Adapter Suite Name", { exact: true })).toHaveValue("Custom suite");
  await expect(page.getByLabel("Adapter Test Name", { exact: true })).toHaveValue("Custom test");

  // Older tasks created without adapter names get defaults in the editor, persisted on save.
  const legacy = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: project.id,
      projectVersionId: project.versionId,
      name: `Legacy adapter ${suffix}`,
    },
  });
  expect(legacy.status).toBe(201);
  await configureTaskExecution(page, legacy.body.id, runner.id);
  await selectProjectContext(page, project.id, project.versionId, stage.body.id);
  await page.goto(`/case-suites/${legacy.body.id}`);
  await expect(page.getByText("任务配置有未保存的修改", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Adapter Suite Name", { exact: true })).toHaveValue(project.name);
  await expect(page.getByLabel("Adapter Test Name", { exact: true })).toHaveValue(
    "Lifecycle version - SIT",
  );
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await page.getByLabel("Adapter Test Name", { exact: true }).scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await captureUi(page, `adapter-defaults-edit-${width}`);
  }
  await page.locator('select[name="projectVersionId"]').selectOption(versionWithoutStage.body.id);
  await expect(page.getByLabel("Adapter Test Name", { exact: true })).toHaveValue("2.0");
  await page.locator('select[name="projectVersionId"]').selectOption(project.versionId);
  await expect(page.getByLabel("Adapter Test Name", { exact: true })).toHaveValue(
    "Lifecycle version - SIT",
  );
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(".toast-viewport").getByRole("status")).toContainText("用例任务已更新");
  await selectProjectContext(page, project.id, project.versionId, project.stageId);
  await page.reload();
  await expect(page.getByLabel("Adapter Test Name", { exact: true })).toHaveValue(
    "Lifecycle version - SIT",
  );

  await page.goto("/case-suites");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await dialog.getByLabel("使用 CoTest TestNG Adapter").check();
  await expect(dialog.getByLabel("TestNG Suite Name", { exact: true })).toHaveValue(project.name);
  await expect(dialog.getByLabel("TestNG Test Name", { exact: true })).toHaveValue(
    "Lifecycle version - Lifecycle stage",
  );
});

test("tasks and execution history follow the selected project version", async ({ page }) => {
  test.setTimeout(240_000);
  await ensureAdministrator(page);
  const suffix = uniqueName("version-scoped-suite");
  const project = await createProject(page, suffix);
  const secondVersion = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(project.id)}/versions`,
    { method: "POST", body: { name: "Lifecycle version 2" } },
  );
  expect(secondVersion.status).toBe(201);
  const secondStage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(secondVersion.body.id)}/stages`,
    { method: "POST", body: { name: "Lifecycle stage 2", description: "Version scope" } },
  );
  expect(secondStage.status).toBe(201);

  const firstClassName = `com.example.VersionOne${Date.now()}Test`;
  const unassignedClassName = firstClassName.replace(/Test$/u, "UnassignedTest");
  await importJar(
    page,
    project,
    `${suffix}-one.jar`,
    firstClassName,
    ["versionOne"],
    [{ className: unassignedClassName, methodNames: ["notYetInTask"] }],
  );
  await selectProjectContext(page, project.id, secondVersion.body.id, secondStage.body.id);
  const secondProjectContext = {
    ...project,
    versionId: secondVersion.body.id,
    stageId: secondStage.body.id,
  };
  const secondClassName = `com.example.VersionTwo${Date.now()}Test`;
  await importJar(page, secondProjectContext, `${suffix}-two.jar`, secondClassName, ["versionTwo"]);

  const firstDefinition = await findVersionCase(
    page,
    project.id,
    project.versionId,
    project.stageId,
    firstClassName,
  );
  const secondDefinition = await findVersionCase(
    page,
    project.id,
    secondVersion.body.id,
    secondStage.body.id,
    secondClassName,
  );
  const firstSuiteName = `Version one suite ${suffix}`;
  const secondSuiteName = `Version two suite ${suffix}`;
  const firstSuite = await createVersionSuite(
    page,
    project.id,
    project.versionId,
    firstSuiteName,
    firstDefinition.id,
  );
  const secondSuite = await createVersionSuite(
    page,
    project.id,
    secondVersion.body.id,
    secondSuiteName,
    secondDefinition.id,
  );
  const crossVersionAdd = await browserJson<{ error?: { code?: string } }>(
    page,
    `/api/v1/case-suites/${encodeURIComponent(firstSuite.id)}/cases`,
    { method: "POST", body: { caseDefinitionIds: [secondDefinition.id] } },
  );
  expect(crossVersionAdd.status).toBe(400);
  expect(crossVersionAdd.body.error?.code).toBe("CASE_DEFINITION_VERSION_MISMATCH");

  await selectProjectContext(page, project.id, project.versionId, project.stageId);
  await page.goto("/cases");
  await page.locator('select[aria-label="目标用例任务"]').selectOption(firstSuite.id);
  await page.getByRole("button", { name: "筛选未加入" }).click();
  await expect(page.getByLabel(`选择 ${unassignedClassName.split(".").at(-1)!}`)).toBeVisible();
  await expect(page.getByLabel(`选择 ${firstClassName.split(".").at(-1)!}`)).toHaveCount(0);
  await page.getByLabel(`选择 ${unassignedClassName.split(".").at(-1)!}`).check();
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByText("已将 1 个用例加入任务。")).toBeVisible();

  const runner = await registerRunner(page, suffix);
  await configureTaskExecution(page, firstSuite.id, runner.id);
  await configureTaskExecution(page, secondSuite.id, runner.id);
  const firstBatch = await createTaskRun(page, firstSuite.id);
  await createTaskRun(page, secondSuite.id);

  await selectProjectContext(page, project.id, project.versionId, project.stageId);
  await page.goto("/case-suites");
  await expect(page.getByText(firstSuiteName, { exact: true })).toBeVisible();
  await expect(page.getByText(secondSuiteName, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/当前版本「Lifecycle version」共 1 个任务/u)).toBeVisible();
  const suiteCard = page.getByRole("article", { name: `任务 ${firstSuiteName}`, exact: true });
  await expect(suiteCard.getByLabel("近 7 天执行统计")).toContainText("7 天执行次数");
  await expect(suiteCard.locator(".suite-statistics dd").first()).toHaveText("1次");
  await expect(suiteCard.getByRole("region", { name: "最近执行记录" })).toHaveCount(0);
  const recentExecutionsRoute = `**/api/v1/case-suites/${firstSuite.id}/executions?*`;
  await page.route(
    recentExecutionsRoute,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "UNAVAILABLE",
            message: "执行记录暂时不可用",
            requestId: "suite-history-fixture",
          },
        }),
      }),
    { times: 1 },
  );
  await suiteCard.getByRole("button", { name: "最近执行", exact: true }).click();
  await expect(suiteCard.getByRole("alert")).toContainText("执行记录暂时不可用");
  await suiteCard.getByRole("button", { name: "重试", exact: true }).click();
  const recentExecutions = suiteCard.getByRole("region", { name: "最近执行记录" });
  await expect(recentExecutions.locator(".suite-history-record")).toHaveCount(1);
  await expect(recentExecutions).toContainText("第 1 / 1 轮");
  await expect(recentExecutions.getByRole("link", { name: "全部记录" })).toHaveAttribute(
    "href",
    new RegExp(`suiteId=${firstSuite.id}`),
  );
  const crossVersionHistory = await page.request.get(
    `/api/v1/case-suites/${firstSuite.id}/executions?projectId=${project.id}&projectVersionId=${secondVersion.body.id}`,
  );
  expect(crossVersionHistory.status()).toBe(404);
  const historyToggle = suiteCard.getByRole("button", { name: "最近执行", exact: true });
  await historyToggle.focus();
  await historyToggle.press("Enter");
  await expect(historyToggle).toHaveAttribute("aria-expanded", "false");
  await expect(recentExecutions).toHaveCount(0);
  await historyToggle.press("Enter");
  await expect(recentExecutions.locator(".suite-history-record")).toHaveCount(1);
  const suiteExportDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: `导出 ${firstSuiteName} 用例` }).click();
  const downloadedWorkbook = await suiteExportDownload;
  expect(downloadedWorkbook.suggestedFilename()).toMatch(/-用例\.xlsx$/u);
  const workbookPath = await downloadedWorkbook.path();
  expect(workbookPath).not.toBeNull();
  const workbookFiles = unzipSync(new Uint8Array(await readFile(workbookPath!)));
  const worksheetXml = new TextDecoder().decode(workbookFiles["xl/worksheets/sheet1.xml"]);
  expect(worksheetXml).toContain("用例编号（类路径）");
  expect(worksheetXml).toContain("用例名称");
  expect(worksheetXml).toContain(firstClassName);
  expect(worksheetXml).toContain(unassignedClassName);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `version-scoped-case-suites-${viewport.width}`);
  }
  await recentExecutions.locator(".suite-history-record").first().click();
  await expect(page).toHaveURL(new RegExp(`/run-batches/${firstBatch.id}$`));
  await page.goBack();
  await expect(suiteCard.getByRole("button", { name: "最近执行", exact: true })).toBeVisible();
  await page.goto(`/case-suites/${encodeURIComponent(firstSuite.id)}`);
  await expect(page.locator(".execution-detail-hero, .page-hero").first()).toContainText(
    "项目版本「Lifecycle version」",
  );

  await page.goto("/execution-records");
  await expect(page.getByLabel("执行记录范围")).toContainText("Lifecycle version");
  const firstVersionRecords = page.locator(".execution-records-table");
  await expect(firstVersionRecords).toContainText(firstSuiteName);
  await expect(firstVersionRecords).not.toContainText(secondSuiteName);
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  const runDialog = page.getByRole("dialog", { name: "开始执行" });
  const suiteOptions = runDialog.locator('select[aria-label="执行用例任务"] option');
  await expect(suiteOptions.filter({ hasText: firstSuiteName })).toHaveCount(1);
  await expect(suiteOptions.filter({ hasText: secondSuiteName })).toHaveCount(0);
  await runDialog.locator('select[aria-label="执行用例任务"]').selectOption(firstSuite.id);
  await runDialog.getByRole("radio", { name: "倒计时执行", exact: true }).locator("..").click();
  await runDialog.getByLabel("倒计时分钟").fill("0");
  await runDialog.getByLabel("倒计时秒").fill("30");
  await expect(runDialog.getByText("30 秒", { exact: true })).toBeVisible();
  const delayedResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/v1/run-batches",
  );
  await runDialog.getByRole("button", { name: "确认倒计时执行" }).click();
  const delayedCreated = await delayedResponse;
  expect(delayedCreated.status()).toBe(201);
  const delayedBatch = (await delayedCreated.json()) as {
    id: string;
    scheduledFor: string;
    createdAt: string;
    assignedRuns: number;
  };
  expect(Date.parse(delayedBatch.scheduledFor) - Date.parse(delayedBatch.createdAt)).toBe(30_000);
  expect(delayedBatch.assignedRuns).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/run-batches/${delayedBatch.id}$`));
  await expect(page.locator(".batch-metrics-band")).toContainText("倒计时");
  await expect(page.locator(".batch-metrics-band")).toContainText("距离开始");
  await page.goto(`/run-batches/${encodeURIComponent(firstBatch.id)}`);
  await expect(page.locator(".execution-detail-hero")).toContainText(
    "项目版本「Lifecycle version」",
  );

  await selectProjectContext(page, project.id, secondVersion.body.id, secondStage.body.id);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/execution-records");
    await expect(page.getByLabel("执行记录范围")).toContainText("Lifecycle version 2");
    const secondVersionRecords = page.locator(".execution-records-table");
    await expect(secondVersionRecords).toContainText(secondSuiteName);
    await expect(secondVersionRecords).not.toContainText(firstSuiteName);
    await expectUiIntegrity(page);
    await captureUi(page, `version-scoped-execution-records-${viewport.width}`);
  }
});

test("Jenkins recovery credentials support current-task and cross-task reuse without exposing saved keys", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("recovery-key");
  const project = await createProject(page, suffix);
  const runner = await registerRunner(page, suffix);
  const sharedKey = "e2e-user:shared-recovery-token";
  const localKey = "e2e-user:local-recovery-token";
  const callbackHost = process.env.E2E_JENKINS_CALLBACK_HOST ?? "127.0.0.1";
  const inspectedCredentials: string[] = [];
  let buildRequests = 0;
  const jenkins = createServer((request, response) => {
    if (request.method !== "GET") {
      buildRequests++;
      response.writeHead(405).end();
      return;
    }
    const credential = Buffer.from(
      (request.headers.authorization ?? "").replace(/^Basic /u, ""),
      "base64",
    ).toString("utf8");
    if (![sharedKey, localKey].includes(credential)) {
      response.writeHead(401).end();
      return;
    }
    inspectedCredentials.push(credential);
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const name = url.pathname.split("/")[2]!;
    const jobUrl = `${url.origin}/job/${name}/`;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name,
        url: jobUrl,
        buildable: true,
        inQueue: false,
        lastBuild: {
          number: 8,
          url: `${jobUrl}8/`,
          building: false,
          result: "SUCCESS",
          timestamp: 0,
          duration: 100,
        },
      }),
    );
  });
  await new Promise<void>((resolve) =>
    jenkins.listen(0, callbackHost === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0", resolve),
  );
  const address = jenkins.address();
  if (!address || typeof address === "string")
    throw new Error("Jenkins test server did not bind a TCP port.");
  const base = `http://${callbackHost}:${address.port}`;
  try {
    const create = async (name: string) => {
      const created = await browserJson<{ id: string; revision: number }>(
        page,
        "/api/v1/case-suites",
        {
          method: "POST",
          body: { projectId: project.id, projectVersionId: project.versionId, name },
        },
      );
      expect(created.status).toBe(201);
      return created.body;
    };
    const sourceName = `可复用 Jenkins 密钥 ${suffix}`;
    const source = await create(sourceName);
    const sourceRule = {
      id: "source-key",
      afterRound: 1,
      jenkinsJobUrl: `${base}/job/source/`,
      waitMinutes: 0,
      apiKey: sharedKey,
    };
    const configured = await browserJson<{ revision: number }>(
      page,
      `/api/v1/case-suites/${source.id}`,
      {
        method: "PATCH",
        body: {
          expectedRevision: source.revision,
          policy: { runnerIds: [runner.id], retryLimit: 2, roundRecoveryRules: [sourceRule] },
        },
      },
    );
    expect(configured.status).toBe(200);
    expect(JSON.stringify(configured.body)).not.toContain(sharedKey);
    const target = await create(`密钥复用目标 ${suffix}`);
    await configureTaskExecution(page, target.id, runner.id, { retryLimit: 2 });
    await page.goto(`/case-suites/${target.id}`);
    await page.getByRole("button", { name: "添加恢复步骤" }).click();
    await page.getByLabel("恢复步骤 1 Jenkins 任务链接").fill(`${base}/job/first/`);
    await page.getByLabel("恢复步骤 1 API 密钥").fill(localKey);
    await page.getByRole("button", { name: "添加恢复步骤" }).click();
    await page.getByLabel("恢复步骤 2 Jenkins 任务链接").fill(`${base}/job/second/`);
    const picker = page.getByRole("dialog", { name: "复用 Jenkins 密钥", exact: true });
    await page.getByRole("button", { name: "复用恢复步骤 2 Jenkins 密钥" }).click();
    await picker.getByRole("button", { name: /本任务 · 步骤 1/u }).click();
    await expect(page.getByLabel("恢复步骤 2 API 密钥")).toHaveValue("");
    await expect(page.getByLabel("恢复步骤 2 API 密钥")).toHaveAttribute(
      "placeholder",
      /复用：本任务/u,
    );
    await page.getByRole("button", { name: "测试恢复步骤 2 Jenkins 配置" }).click();
    await expect(page.getByText("连接成功 · second", { exact: true })).toBeVisible();
    expect(inspectedCredentials.at(-1)).toBe(localKey);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page
        .getByRole("button", { name: "复用恢复步骤 2 Jenkins 密钥" })
        .scrollIntoViewIfNeeded();
      await expectUiIntegrity(page);
      await captureUi(page, `recovery-credential-local-${width}`);
      await page.getByRole("button", { name: "复用恢复步骤 2 Jenkins 密钥" }).click();
      await expectUiIntegrity(page);
      await captureUi(page, `recovery-credential-picker-local-${width}`);
      await picker.getByRole("button", { name: "取消", exact: true }).click();
    }
    const firstSave = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/v1/case-suites/${target.id}`,
    );
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    const saved = await firstSave;
    expect(saved.status()).toBe(200);
    expect(await saved.text()).not.toContain(localKey);
    await expect(page.getByLabel("恢复步骤 1 API 密钥")).toHaveValue("");
    await expect(page.getByLabel("恢复步骤 2 API 密钥")).toHaveAttribute(
      "placeholder",
      "已配置；留空保持不变",
    );
    await page.getByRole("button", { name: "复用恢复步骤 2 Jenkins 密钥" }).click();
    await picker.getByRole("button", { name: /本任务 · 步骤 1/u }).click();
    await page.getByRole("button", { name: "测试恢复步骤 2 Jenkins 配置" }).click();
    await expect(page.getByText("连接成功 · second", { exact: true })).toBeVisible();
    expect(inspectedCredentials.at(-1)).toBe(localKey);
    await page.getByRole("button", { name: "取消恢复步骤 2 密钥复用" }).click();
    await expect(page.getByLabel("恢复步骤 2 API 密钥")).toHaveAttribute(
      "placeholder",
      "已配置；留空保持不变",
    );

    for (const theme of ["light", "dark"]) {
      await page
        .context()
        .addCookies([{ name: "autoforge-color-mode", value: theme, url: page.url() }]);
      await page.reload();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await page.getByRole("button", { name: "复用恢复步骤 2 Jenkins 密钥" }).click();
        if (theme === "light" && width === 1024)
          await page.route(
            `**/api/v1/case-suites/${target.id}/round-recovery/credentials?**`,
            async (route) =>
              route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ error: { message: "密钥来源查询暂不可用，请重试。" } }),
              }),
            { times: 1 },
          );
        await picker.getByText("其他任务", { exact: true }).click();
        if (theme === "light" && width === 1024) {
          await expect(picker.getByRole("alert")).toContainText("密钥来源查询暂不可用");
          await expect(picker.locator(".ant-segmented-thumb")).toHaveCount(0);
          await captureUi(page, "recovery-credential-picker-query-error-1024");
        }
        await picker.getByLabel("查找密钥来源任务").fill(sourceName);
        await picker.getByRole("button", { name: "查询", exact: true }).click();
        const choice = picker.getByRole("button", { name: new RegExp(sourceName) });
        await expect(choice).toBeVisible();
        await expect(picker).not.toContainText(sharedKey);
        await expectUiIntegrity(page);
        await captureUi(page, `recovery-credential-picker-other-${theme}-${width}`);
        if (theme === "dark" && width === 1536) await choice.click();
        else await picker.getByRole("button", { name: "取消", exact: true }).click();
      }
    }
    await page.getByRole("button", { name: "测试恢复步骤 2 Jenkins 配置" }).click();
    await expect(page.getByText("连接成功 · second", { exact: true })).toBeVisible();
    expect(inspectedCredentials.at(-1)).toBe(sharedKey);
    const secondSave = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/v1/case-suites/${target.id}`,
    );
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    expect((await secondSave).status()).toBe(200);
    expect(
      (
        await browserJson(page, `/api/v1/case-suites/${source.id}`, {
          method: "PATCH",
          body: { expectedRevision: configured.body.revision, policy: { roundRecoveryRules: [] } },
        })
      ).status,
    ).toBe(200);
    await page.reload();
    await page.getByRole("button", { name: "测试恢复步骤 2 Jenkins 配置" }).click();
    await expect(page.getByText("连接成功 · second", { exact: true })).toBeVisible();
    expect(inspectedCredentials.at(-1)).toBe(sharedKey);
    expect(buildRequests).toBe(0);
  } finally {
    jenkins.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      jenkins.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("terminal execution failures create a reusable task with the execution configuration", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("failure-task");
  const project = await createProject(page, suffix);
  await selectProjectContext(page, project.id, project.versionId, project.stageId);
  const classes = ["Failed", "Timeout", "Passed"].map((name) => `example.failuretask.${name}`);
  await importJar(
    page,
    project,
    `failures-${suffix}.jar`,
    classes[0]!,
    ["test"],
    classes.slice(1).map((className) => ({ className, methodNames: ["test"] })),
  );
  const definitions = await Promise.all(
    classes.map((className) =>
      findVersionCase(page, project.id, project.versionId, project.stageId, className),
    ),
  );
  const name = `失败范围任务 ${suffix} ${"长名称检查".repeat(8)}`;
  const suite = await createVersionSuite(
    page,
    project.id,
    project.versionId,
    name,
    definitions[0]!.id,
  );
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suite.id}/cases`, {
        method: "POST",
        body: { caseDefinitionIds: definitions.slice(1).map((entry) => entry.id) },
      })
    ).status,
  ).toBe(200);
  const runner = await registerRunner(page, suffix);
  await configureTaskExecution(page, suite.id, runner.id, {
    concurrency: 2,
    retryLimit: 0,
    adapter: { enabled: false, suiteName: "", testName: "", environmentAddresses: [] },
  });
  const batch = await createTaskRun(page, suite.id);
  const endpoint = `/api/v1/run-batches/${batch.id}/failure-case-suite`;
  expect(
    (await browserJson(page, endpoint, { method: "POST", body: { name: "Too early" } })).status,
  ).toBe(400);
  await page.goto(`/run-batches/${batch.id}`);
  await expect(page.getByRole("button", { name: "以失败用例创建任务", exact: true })).toHaveCount(
    0,
  );
  let completed = 0;
  while (completed < 3) {
    const response = await page.request.post(`/api/v1/runner-agents/${runner.id}/claims`, {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        requestId: `failure-task-${suffix}-${completed}`,
        availableSlots: 2,
        waitSeconds: 0,
        labels: ["linux", "java", "testng"],
        capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
      },
    });
    expect(response.status()).toBe(200);
    const claims = (await response.json()) as {
      assignments: Array<{
        assignment: { attemptId: string; executionSpec: { className: string } };
        lease: { token: string };
      }>;
    };
    expect(claims.assignments.length).toBeGreaterThan(0);
    for (const claim of claims.assignments) {
      const className = claim.assignment.executionSpec.className;
      const status = className.endsWith("Passed")
        ? "succeeded"
        : className.endsWith("Timeout")
          ? "timed_out"
          : "failed";
      const result = await page.request.post(
        `/api/v1/run-attempts/${claim.assignment.attemptId}/complete`,
        {
          headers: {
            authorization: `Bearer ${runner.credential}`,
            "x-autoforge-runner-id": runner.id,
          },
          data: {
            schemaVersion: 1,
            completionId: `complete-${claim.assignment.attemptId}`,
            leaseToken: claim.lease.token,
            result: {
              status,
              resultCode: status === "timed_out" ? "EXECUTION_TIMEOUT" : "TESTNG_RESULT",
              summary: status,
              durationMs: 100,
              logWatermarks: { stdout: -1, stderr: -1, agent: -1 },
              artifacts: [],
            },
          },
        },
      );
      expect(result.status()).toBe(200);
      completed++;
    }
  }
  await configureTaskExecution(page, suite.id, runner.id, { concurrency: 13 });
  const suggestion = await browserJson<{ name: string }>(page, endpoint);
  expect(suggestion.status).toBe(200);
  expect(suggestion.body.name).toMatch(/ Rerun-\d{8}$/u);
  const defaultName = suggestion.body.name;
  expect(defaultName.startsWith(`${name} Rerun-`)).toBe(true);
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: theme, url: page.url() }]);
    await page.reload();
    const action = page.getByRole("button", { name: "以失败用例创建任务", exact: true });
    await expect(action).toBeVisible();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.getByRole("region", { name: "批次操作" }).scrollIntoViewIfNeeded();
      await expectUiIntegrity(page);
      await captureUi(page, `failure-task-actions-${theme}-${width}`);
      await action.click();
      const dialog = page.getByRole("dialog", { name: "以失败用例创建任务", exact: true });
      await expect(dialog).toContainText("最终失败或超时的 2 个用例");
      await expect(dialog.getByLabel("任务名称", { exact: true })).toHaveValue(defaultName);
      await expect(dialog.getByRole("button", { name: "创建任务", exact: true })).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "创建并立即执行", exact: true }),
      ).toBeVisible();
      await expectUiIntegrity(page);
      await captureUi(page, `failure-task-dialog-${theme}-${width}`);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toBeHidden();
    }
  }
  // An open dialog may have an outdated suggestion after another window creates a task.
  await page.getByRole("button", { name: "以失败用例创建任务", exact: true }).click();
  const defaultDialog = page.getByRole("dialog", { name: "以失败用例创建任务", exact: true });
  await expect(defaultDialog.getByLabel("任务名称", { exact: true })).toHaveValue(defaultName);
  const concurrentCopy = await browserJson<{ name: string }>(page, endpoint, {
    method: "POST",
    body: {},
  });
  expect(concurrentCopy.status).toBe(201);
  expect(concurrentCopy.body.name).toBe(defaultName);
  const defaultCreationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === endpoint,
  );
  await defaultDialog.getByRole("button", { name: "创建任务", exact: true }).click();
  const defaultCopy = (await (await defaultCreationResponse).json()) as {
    id: string;
    name: string;
    caseCount: number;
  };
  expect(defaultCopy).toMatchObject({ name: `${defaultName}01`, caseCount: 2 });
  await expect(page).toHaveURL(new RegExp(`/case-suites/${defaultCopy.id}$`));
  await page.goto(`/run-batches/${batch.id}`);
  let releaseSuggestion!: () => void;
  const delayedSuggestion = new Promise<void>((resolve) => {
    releaseSuggestion = resolve;
  });
  const nameRoute = `**${endpoint}`;
  await page.route(nameRoute, async (route) => {
    if (route.request().method() === "GET") await delayedSuggestion;
    await route.continue();
  });
  await page.getByRole("button", { name: "以失败用例创建任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "以失败用例创建任务", exact: true });
  await dialog.getByLabel("任务名称", { exact: true }).fill(" ");
  const suggestionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === endpoint,
  );
  releaseSuggestion();
  await suggestionResponse;
  await expect(dialog.getByLabel("任务名称", { exact: true })).toHaveValue(" ");
  await page.unroute(nameRoute);
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("请填写任务名称");
  await dialog.getByLabel("任务名称", { exact: true }).fill(`失败新任务 ${suffix}`);
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === endpoint,
  );
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const copied = (await created.json()) as {
    id: string;
    caseCount: number;
    policy: { concurrency: number };
  };
  expect(copied).toMatchObject({ caseCount: 2, policy: { concurrency: 2 } });
  await expect(page).toHaveURL(new RegExp(`/case-suites/${copied.id}$`));
  const members = await browserJson<{ items: Array<{ caseDefinition: { id: string } }> }>(
    page,
    `/api/v1/case-suites/${copied.id}/members?limit=100`,
  );
  expect(members.body.items.map((item) => item.caseDefinition.id).sort()).toEqual(
    definitions
      .slice(0, 2)
      .map((item) => item.id)
      .sort(),
  );
  await expectUiIntegrity(page);
  await captureUi(page, "failure-task-created-1536");

  await page.goto(`/run-batches/${batch.id}`);
  await page.route(nameRoute, async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "名称服务暂不可用，请填写任务名称。" } }),
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "以失败用例创建任务", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("名称服务暂不可用");
  await dialog.getByLabel("任务名称", { exact: true }).fill(`手动命名恢复 ${suffix}`);
  await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page).toHaveURL(/\/case-suites\/[^/]+$/u);
  await page.unroute(nameRoute);

  const username = uniqueName("failure-task-manager");
  const password = "TaskManager!Password123";
  const restrictedUser = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: username, password, forcePasswordChange: false },
  });
  expect(restrictedUser.status).toBe(201);
  const restrictedRole = await browserJson<{ id: string }>(page, "/api/v1/roles", {
    method: "POST",
    body: {
      key: uniqueName("failure-task-manager-role"),
      name: "失败任务管理（无执行权限）",
      scope: "project",
      permissions: ["project.read", "run.read", "case_suite.read", "case_suite.manage"],
    },
  });
  expect(restrictedRole.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/users/${restrictedUser.body.id}/project-roles`, {
        method: "POST",
        body: { projectId: project.id, roleId: restrictedRole.body.id },
      })
    ).status,
  ).toBe(204);
  const restrictedContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const restrictedPage = await restrictedContext.newPage();
    await login(restrictedPage, username, password);
    await restrictedPage.goto(`/run-batches/${batch.id}`);
    await restrictedPage.getByRole("button", { name: "以失败用例创建任务", exact: true }).click();
    const restrictedDialog = restrictedPage.getByRole("dialog", {
      name: "以失败用例创建任务",
      exact: true,
    });
    await expect(
      restrictedDialog.getByRole("button", { name: "创建任务", exact: true }),
    ).toBeEnabled();
    await expect(
      restrictedDialog.getByRole("button", { name: "创建并立即执行", exact: true }),
    ).toBeDisabled();
    await expect(restrictedDialog).toContainText("没有此项目的执行权限");
    expect(
      (
        await browserJson(restrictedPage, "/api/v1/run-batches", {
          method: "POST",
          body: { suiteId: copied.id, delaySeconds: 0 },
        })
      ).status,
    ).toBe(403);
    await restrictedDialog.getByLabel("任务名称", { exact: true }).fill(`仅创建任务 ${suffix}`);
    await restrictedDialog.getByRole("button", { name: "创建任务", exact: true }).click();
    await expect(restrictedPage).toHaveURL(/\/case-suites\/[^/]+$/u);
  } finally {
    await restrictedContext.close();
  }

  await page.goto(`/run-batches/${batch.id}`);
  expect(
    (
      await browserJson(page, `/api/v1/runners/${runner.id}`, {
        method: "PATCH",
        body: { state: "disabled" },
      })
    ).status,
  ).toBe(200);
  await page.getByRole("button", { name: "以失败用例创建任务", exact: true }).click();
  await expect(dialog.getByLabel("任务名称", { exact: true })).toHaveValue(`${defaultName}02`);
  const immediateCreationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === endpoint,
  );
  let creations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === endpoint) creations++;
  });
  await dialog.getByRole("button", { name: "创建并立即执行", exact: true }).click();
  const immediateCreation = await immediateCreationResponse;
  expect(immediateCreation.status()).toBe(201);
  const immediateSuite = (await immediateCreation.json()) as { id: string; name: string };
  expect(immediateSuite.name).toBe(`${defaultName}02`);
  await expect(dialog.getByRole("alert")).toContainText("任务已创建，但立即执行失败");
  await expect(dialog.getByLabel("任务名称", { exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "查看任务", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "重试执行", exact: true })).toBeEnabled();
  await expectUiIntegrity(page);
  await captureUi(page, "failure-task-execution-blocked-1536");
  expect(
    (
      await browserJson(page, `/api/v1/runners/${runner.id}`, {
        method: "PATCH",
        body: { state: "active" },
      })
    ).status,
  ).toBe(200);
  const immediateExecutionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/run-batches",
  );
  await dialog.getByRole("button", { name: "重试执行", exact: true }).click();
  const immediateExecution = await immediateExecutionResponse;
  expect(immediateExecution.status()).toBe(201);
  expect(immediateExecution.request().postDataJSON()).toEqual({
    suiteId: immediateSuite.id,
    delaySeconds: 0,
  });
  const immediateBatch = (await immediateExecution.json()) as {
    id: string;
    suiteId: string;
    totalRuns: number;
    policy: { concurrency: number };
  };
  expect(immediateBatch).toMatchObject({
    suiteId: immediateSuite.id,
    totalRuns: 2,
    policy: { concurrency: 2 },
  });
  expect(creations).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/run-batches/${immediateBatch.id}$`));
  await expectUiIntegrity(page);
  await captureUi(page, "failure-task-executed-1536");
});

async function captureUi(page: Page, name: string): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  const absoluteDirectory = resolve(screenshotDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  await page.screenshot({ path: resolve(absoluteDirectory, `${name}.png`), fullPage: false });
}

async function expectHorizontalIntegrity(locator: Locator): Promise<void> {
  const dimensions = await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(dimensions.left, "card escapes the left viewport boundary").toBeGreaterThanOrEqual(0);
  expect(dimensions.right, "card escapes the right viewport boundary").toBeLessThanOrEqual(
    dimensions.viewportWidth,
  );
  expect(dimensions.scrollWidth, "card has horizontal content overflow").toBeLessThanOrEqual(
    dimensions.clientWidth + 2,
  );
}

test("case metadata, immutable versions and suite policy survive lifecycle changes", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    // 容器 IP 的普通 HTTP 不暴露 randomUUID；覆盖该真实离线部署边界。
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
  await ensureAdministrator(page);
  const suffix = uniqueName("lifecycle");
  const project = await createProject(page, suffix);
  const className = `com.example.Lifecycle${Date.now()}Test`;
  const companionClassName = className.replace(/Test$/u, "CompanionTest");
  const initialSourceName = `${suffix}-v1.jar`;
  const candidateSourceName = `${suffix}-v2.jar`;
  await importJar(
    page,
    project,
    initialSourceName,
    className,
    ["createsVersion"],
    [{ className: companionClassName, methodNames: ["staysInTree"] }],
  );
  await setAuthoritativeSource(page, project.id, initialSourceName);

  const definitions = await browserJson<{
    items: Array<{ id: string; className: string; revision: number }>;
  }>(
    page,
    `/api/v1/case-definitions?projectId=${encodeURIComponent(project.id)}&query=${encodeURIComponent(className)}`,
  );
  const definition = definitions.body.items.find((item) => item.className === className);
  expect(definition).toBeTruthy();

  const firstUpdate = await browserJson<{ revision: number }>(
    page,
    `/api/v1/case-definitions/${definition!.id}`,
    {
      method: "PATCH",
      body: {
        displayName: `Lifecycle display ${suffix}`,
        description: "first accepted metadata revision",
        tags: ["lifecycle", "accepted"],
        enabled: true,
        archived: false,
        expectedRevision: definition!.revision,
      },
    },
  );
  expect(firstUpdate.status).toBe(200);
  const staleUpdate = await browserJson<{ error?: { code?: string } }>(
    page,
    `/api/v1/case-definitions/${definition!.id}`,
    {
      method: "PATCH",
      body: {
        displayName: `Stale ${suffix}`,
        expectedRevision: definition!.revision,
      },
    },
  );
  expect(staleUpdate.status).toBe(409);
  expect(staleUpdate.body.error?.code).toMatch(/REVISION_CONFLICT/);

  await importJar(
    page,
    project,
    candidateSourceName,
    className,
    ["createsVersion", "browserAdded"],
    [{ className: companionClassName, methodNames: ["staysInTree"] }],
  );
  const sources = await browserJson<{
    items: Array<{ id: string; originalFileName: string }>;
  }>(page, `/api/v1/case-sources?projectId=${encodeURIComponent(project.id)}&limit=200`);
  const candidateSource = sources.body.items.find(
    (source) => source.originalFileName === candidateSourceName,
  );
  expect(candidateSource).toBeTruthy();
  await page.goto(`/case-sources/${encodeURIComponent(candidateSource!.id)}`);
  await page.getByRole("button", { name: "对比权威来源" }).click();
  await expect(page.getByText(/对比结果：新增 0、变更 1、消失 0、冲突 0/)).toBeVisible();
  await page.getByRole("button", { name: "确认同步为权威来源" }).click();
  await expect(page.getByText(/已同步为权威来源；匹配用例已生成不可变版本/)).toBeVisible();

  await page.goto(`/cases/${encodeURIComponent(definition!.id)}`);
  await expect(page.getByRole("heading", { name: `Lifecycle display ${suffix}` })).toBeVisible();
  await page.getByRole("button", { name: "匿名分享", exact: true }).click();
  const permanentShareLink = page.getByRole("link", { name: "在新窗口打开永久分享链接" });
  await expect(permanentShareLink).toBeVisible();
  const shareUrl = await permanentShareLink.getAttribute("href");
  expect(shareUrl).toContain("/share/case/");
  const anonymousContext = await browser.newContext();
  const sharedCasePage = await anonymousContext.newPage();
  const sharedCaseResponse = await sharedCasePage.goto(shareUrl!);
  expect(sharedCaseResponse?.status()).toBe(200);
  expect(new URL(sharedCasePage.url()).pathname).not.toBe("/login");
  await expect(
    sharedCasePage.getByRole("heading", { name: `Lifecycle display ${suffix}` }),
  ).toBeVisible();
  await expect(sharedCasePage.getByText(className, { exact: true })).toBeVisible();
  await expect(sharedCasePage.getByText("永久只读链接", { exact: true })).toBeVisible();
  await expect(sharedCasePage.locator(".app-shell, .app-sidebar, .topbar")).toHaveCount(0);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await sharedCasePage.setViewportSize(viewport);
    await expectUiIntegrity(sharedCasePage);
    await captureUi(sharedCasePage, `shared-case-${viewport.width}`);
  }
  await anonymousContext.close();
  await page.getByLabel("标签（逗号分隔）").fill("lifecycle, browser-update");
  await page.getByLabel(/启用（禁用后/).uncheck();
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("用例已更新。", { exact: true })).toBeVisible();
  await expect(page.getByText("版本历史（2）")).toBeVisible();
  await page.getByLabel("基准版本").and(page.locator("select")).selectOption("1");
  await page.getByLabel("对比版本").and(page.locator("select")).selectOption("2");
  await expect(
    page.locator(".version-diff-list").getByText(/方法新增：.*browserAdded/),
  ).toBeVisible();
  await page.getByRole("button", { name: "从该版本创建" }).last().click();
  await acceptSystemDialog(page, /从 v\d+ 恢复用例/, "创建新版本");
  await expect(page.getByText("版本历史（3）")).toBeVisible();

  const suiteName = `Lifecycle suite ${suffix}`;
  const suite = await browserJson<{ id: string; revision: number }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: project.id,
      projectVersionId: project.versionId,
      name: suiteName,
      description: "lifecycle E2E suite",
    },
  });
  expect(suite.status).toBe(201);
  const companionDefinitions = await browserJson<{
    items: Array<{ id: string; className: string }>;
  }>(
    page,
    `/api/v1/case-definitions?projectId=${encodeURIComponent(project.id)}&query=${encodeURIComponent(companionClassName)}`,
  );
  const companionDefinition = companionDefinitions.body.items.find(
    (item) => item.className === companionClassName,
  );
  expect(companionDefinition).toBeTruthy();
  const addCase = await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
    method: "POST",
    body: { caseDefinitionIds: [definition!.id, companionDefinition!.id] },
  });
  expect(addCase.status).toBe(200);
  const runner = await registerRunner(page, suffix);

  await page.goto(`/case-suites/${encodeURIComponent(suite.body.id)}`);
  await page.route(
    `**/api/v1/case-suites/${encodeURIComponent(suite.body.id)}/round-recovery/inspect`,
    async (route) => {
      const body = route.request().postDataJSON() as {
        jenkinsJobUrl: string;
        apiKey?: string;
      };
      expect(route.request().method()).toBe("POST");
      expect(body).toMatchObject({
        jenkinsJobUrl: "https://jenkins.internal/job/environment-reset/",
        apiKey: "e2e-user:e2e-api-token",
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          name: "environment-reset",
          fullName: "platform/environment-reset",
          url: "https://jenkins.internal/job/environment-reset/",
          buildable: true,
          inQueue: false,
          lastBuild: {
            number: 73,
            url: "https://jenkins.internal/job/environment-reset/73/",
            building: false,
            result: "SUCCESS",
            startedAt: "2026-08-24T02:00:00.000Z",
            durationMs: 12_000,
          },
        }),
      });
    },
  );
  await page.getByLabel("任务名称").fill(`${suiteName} updated`);
  await page.getByLabel("优先级（-100 到 100）").fill("42");
  await page.getByLabel("并发度（同时在途执行数）").fill("3");
  await expect(page.locator('select[name="retryMode"]')).toHaveValue("round");
  await expect(page.getByLabel("重试次数上限")).toHaveValue("0");
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("combobox", { name: "失败重跑方式" }).scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await captureUi(page, `case-suite-default-round-${viewport.width}`);
  }
  await page.getByLabel("重试次数上限").fill("2");
  await page.getByRole("button", { name: "添加规则" }).click();
  await expect(page.getByText(/命中后从本轮起持续生效/u)).toBeVisible();
  await expect(page.getByText(/每条规则只在指定轮次内判断/u)).toBeVisible();
  await page.getByLabel("规则 1 判断轮次").fill("2");
  await page.getByLabel("规则 1 上轮通过率上限").fill("20");
  await page.getByLabel("规则 1 剩余用例下限").fill("50");
  await page.getByLabel("规则 1 命中并发").fill("10");
  await page.getByRole("button", { name: "添加恢复步骤" }).click();
  await page.getByLabel("恢复步骤 1 暂停轮次").fill("1");
  await page
    .getByLabel("恢复步骤 1 Jenkins 任务链接")
    .fill("https://jenkins.internal/job/environment-reset/");
  await page.getByLabel("恢复步骤 1 API 密钥").fill("e2e-user:e2e-api-token");
  await page.getByLabel("恢复步骤 1 成功后等待分钟").fill("3");
  await page.getByRole("button", { name: "测试恢复步骤 1 Jenkins 配置" }).click();
  await expect(page.getByText("连接成功 · platform/environment-reset")).toBeVisible();
  await expect(page.getByText(/上一构建 #73 成功/u)).toBeVisible();
  await expect(page.getByText(/只读取任务与上一构建信息，不会触发构建/u)).toBeVisible();
  await page.getByRole("button", { name: "添加恢复步骤" }).click();
  await page.getByLabel("恢复步骤 2 暂停轮次").fill("1");
  await page
    .getByLabel("恢复步骤 2 Jenkins 任务链接")
    .fill("https://jenkins.internal/job/database-reset/");
  await page.getByLabel("恢复步骤 2 API 密钥").fill("e2e-user:second-api-token");
  await page.getByLabel("恢复步骤 2 成功后等待分钟").fill("7");
  await expect(page.getByText("同一轮可配置多个环境并行 Rebuild")).toBeVisible();
  await page.getByLabel("排队超时（分钟）").fill("7");
  await page
    .locator(".global-run-runner", { hasText: runner.name })
    .locator('input[type="checkbox"]')
    .check();
  await page.getByLabel("Runner 标签（逗号分隔）").fill("linux, lifecycle");
  await expect(page.getByText("参数模板")).toHaveCount(0);
  await expect(page.locator('[name="parameters"]')).toHaveCount(0);
  const adapterToggle = page.getByLabel("使用 CoTest TestNG Adapter");
  const retryOrchestrationCards = page.locator(".retry-orchestration-card");
  for (const viewport of [
    { width: 1536, height: 1024 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectUiIntegrity(page);
    await retryOrchestrationCards.first().scrollIntoViewIfNeeded();
    await expectHorizontalIntegrity(retryOrchestrationCards.first());
    await captureUi(page, `case-suite-dynamic-concurrency-${viewport.width}`);
    await retryOrchestrationCards.nth(1).scrollIntoViewIfNeeded();
    await expectHorizontalIntegrity(retryOrchestrationCards.nth(1));
    await captureUi(page, `case-suite-round-recovery-${viewport.width}`);
    await adapterToggle.scrollIntoViewIfNeeded();
    await captureUi(page, `case-suite-execution-policy-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.getByLabel("产物规则（每行一个相对路径 glob）").fill("reports/**/*.xml");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.locator(".toast-viewport").getByRole("status")).toContainText("用例任务已更新");
  const retryPolicy = await browserJson<{
    policy: {
      retryConcurrencyRules: Array<{ concurrency: number; remainingRunsMinimum?: number }>;
      roundRecoveryRules: Array<{ apiKeyConfigured: boolean; apiKey?: string }>;
    };
  }>(page, `/api/v1/case-suites/${suite.body.id}`);
  expect(retryPolicy.body.policy.retryConcurrencyRules).toEqual([
    expect.objectContaining({ concurrency: 10, remainingRunsMinimum: 50 }),
  ]);
  expect(retryPolicy.body.policy.roundRecoveryRules).toEqual([
    expect.objectContaining({ apiKeyConfigured: true }),
    expect.objectContaining({ apiKeyConfigured: true }),
  ]);
  expect(retryPolicy.body.policy.roundRecoveryRules[0]).not.toHaveProperty("apiKey");
  expect(retryPolicy.body.policy.roundRecoveryRules[1]).not.toHaveProperty("apiKey");
  expect(JSON.stringify(retryPolicy.body)).not.toContain("e2e-api-token");
  expect(JSON.stringify(retryPolicy.body)).not.toContain("second-api-token");

  const suiteMutationUrl = `**/api/v1/case-suites/${encodeURIComponent(suite.body.id)}`;
  await page.route(suiteMutationUrl, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "CASE_SUITE_REVISION_CONFLICT",
          message: "用例任务已被他人修改，请刷新后重试。",
          requestId: "case-suite-conflict-e2e",
        },
      }),
    });
  });
  const suiteDescription = page.getByLabel("任务说明");
  await suiteDescription.fill("尚未保存的本地修改");
  await page.getByRole("button", { name: "保存修改" }).click();
  const conflictDialog = page.getByRole("dialog", { name: "用例任务已被其他人修改" });
  await expect(conflictDialog).toBeVisible();
  await expect(conflictDialog).toContainText("为避免覆盖其他人的修改");
  await expect(conflictDialog.getByRole("button", { name: "重新加载最新内容" })).toBeVisible();
  await expectUiIntegrity(page);
  await captureUi(page, "case-suite-concurrent-modification-dialog");
  await conflictDialog.getByRole("button", { name: "暂不重新加载" }).click();
  await expect(suiteDescription).toHaveValue("尚未保存的本地修改");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(conflictDialog).toBeVisible();
  const reloaded = page.waitForNavigation();
  await conflictDialog.getByRole("button", { name: "重新加载最新内容" }).click();
  await reloaded;
  await expect(page.getByLabel("任务说明")).toHaveValue("lifecycle E2E suite");
  await page.unroute(suiteMutationUrl);

  await page.getByLabel("Cron（分 时 日 月 周）").fill("17 8 * * 1-5");
  await page.getByLabel("IANA 时区").fill("Asia/Shanghai");
  await page.getByLabel("错过触发").and(page.locator("select")).selectOption("skip");
  await page.getByRole("button", { name: "保存计划" }).click();
  await expect(page.locator(".toast-viewport").getByRole("status")).toContainText("计划触发已保存");

  const copyName = `${suiteName} copy`;
  await page.goto("/case-suites");
  await page.getByRole("button", { name: "创建任务" }).click();
  const copyDialog = page.getByRole("dialog", { name: "创建用例任务" });
  await copyDialog.getByText("复制任务", { exact: true }).click();
  await expect(copyDialog.getByRole("radio", { name: "复制任务", exact: true })).toBeChecked();
  await copyDialog.locator('select[aria-label="来源任务"]').selectOption(suite.body.id);
  await copyDialog.getByLabel("新任务名称").fill(copyName);
  await expect(copyDialog.getByText(/新任务使用独立 ID 和成员记录/u)).toBeVisible();
  const configurationOnly = copyDialog.getByLabel("仅复制配置，不复制用例", { exact: true });
  await expect(configurationOnly).not.toBeChecked();
  await configurationOnly.check();
  await expect(copyDialog.getByLabel("任务复制范围")).toContainText("不包含普通或 DDT 用例");

  for (const viewport of [
    { width: 1536, height: 1024 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(copyDialog).toBeVisible();
    await expect(configurationOnly).toBeChecked();
    expect(
      await copyDialog
        .locator(".suite-copy-scope")
        .evaluate((element) => getComputedStyle(element).flexDirection),
    ).toBe("row");
    expect(
      (await copyDialog.locator(".suite-copy-scope").boundingBox())!.height,
    ).toBeLessThanOrEqual(40);
    await expectUiIntegrity(page);
    await captureUi(page, `case-suite-copy-dialog-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  await configurationOnly.uncheck();
  await copyDialog.getByRole("button", { name: "复制并编辑" }).click();
  await expect(page.getByRole("heading", { name: copyName })).toBeVisible();
  await expect(page.getByRole("heading", { name: "2 个用例", exact: true })).toBeVisible();
  const copiedSuiteId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByRole("button", { name: "复制任务", exact: true }).click();
  const configurationDialog = page.getByRole("dialog", { name: "复制用例任务", exact: true });
  await expect(
    configurationDialog.getByLabel("仅复制配置，不复制用例", { exact: true }),
  ).not.toBeChecked();
  await configurationDialog.getByLabel("仅复制配置，不复制用例", { exact: true }).check();
  const configurationName = `${suiteName} configuration`;
  await configurationDialog.getByLabel("复制为新任务").fill(configurationName);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `case-suite-configuration-copy-${viewport.width}`);
  }
  const configurationRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith(`/case-suites/${copiedSuiteId}/copy`),
  );
  await configurationDialog.getByRole("button", { name: "复制任务", exact: true }).click();
  expect((await configurationRequest).postDataJSON()).toMatchObject({ includeCases: false });
  await expect(page.getByRole("heading", { name: configurationName, exact: true })).toBeVisible();
  await expect(page.getByText("任务中还没有用例", { exact: true })).toBeVisible();
  const configurationCopyId = new URL(page.url()).pathname.split("/").at(-1)!;
  const configurationCopy = await browserJson<{
    caseCount: number;
    items: unknown[];
    ddtItems: unknown[];
    policy: { concurrency: number; roundRecoveryRules: Array<{ apiKeyConfigured: boolean }> };
  }>(page, `/api/v1/case-suites/${configurationCopyId}`);
  expect(configurationCopy.body).toMatchObject({
    caseCount: 0,
    items: [],
    ddtItems: [],
    policy: {
      concurrency: 3,
      roundRecoveryRules: [
        expect.objectContaining({ apiKeyConfigured: true }),
        expect.objectContaining({ apiKeyConfigured: true }),
      ],
    },
  });
  // Hold the directory in its legitimate unsynchronized state while editing
  // configuration, so this regression does not depend on worker timing.
  const copiedDirectoryRequests = "**/api/v1/read-models/*/directory?**";
  let deferCopiedDirectory = true;
  let deferredDirectoryReads = 0;
  await page.route(copiedDirectoryRequests, async (route) => {
    const response = await route.fetch();
    if (!deferCopiedDirectory || !response.ok()) {
      await route.fulfill({ response });
      return;
    }
    deferredDirectoryReads += 1;
    const projection = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...projection, synchronized: false } });
  });
  await page.goto(`/case-suites/${copiedSuiteId}`);
  await expect.poll(() => deferredDirectoryReads).toBeGreaterThan(0);
  await expect(page.getByText("正在准备目录，任务配置可直接编辑。", { exact: true })).toBeVisible();

  await page.getByLabel("并发度（同时在途执行数）").fill("5");
  await page.getByLabel("任务说明").fill("independently edited task copy");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.locator(".toast-viewport").getByRole("status")).toContainText("用例任务已更新");
  const [copiedDetails, unchangedSource] = await Promise.all([
    browserJson<{ description: string; policy: { concurrency: number } }>(
      page,
      `/api/v1/case-suites/${encodeURIComponent(copiedSuiteId)}`,
    ),
    browserJson<{ description: string; policy: { concurrency: number } }>(
      page,
      `/api/v1/case-suites/${encodeURIComponent(suite.body.id)}`,
    ),
  ]);
  expect(copiedDetails.body).toMatchObject({
    description: "independently edited task copy",
    policy: { concurrency: 5 },
  });
  expect(unchangedSource.body).toMatchObject({
    description: "lifecycle E2E suite",
    policy: { concurrency: 3 },
  });
  deferCopiedDirectory = false;
  await page.unroute(copiedDirectoryRequests);
  const caseTree = page.getByRole("tree", { name: "任务用例树" });
  // Saving configuration commits before the copied task's background directory
  // snapshot is ready. Use the same bounded wait as the other snapshot checks.
  await expect(caseTree).toBeVisible({ timeout: 30_000 });
  // Large tasks keep package contents out of the DOM until the user expands one package. This is a
  // performance contract: rendering every small package eagerly can create tens of thousands of
  // rows and make the directory disclosure block the browser main thread.
  await expect(caseTree.locator(".suite-tree-case")).toHaveCount(0);
  await caseTree.locator(".ui-disclosure-label").first().click();
  await expect(caseTree.locator(".suite-tree-case")).toHaveCount(2);
  // A new snapshot remounts directory groups. Their controlled disclosure state must match the
  // remembered expansion so the next click closes the group and releases its rendered rows.
  const expandedPackage = await caseTree.locator(".ui-disclosure").first().elementHandle();
  expect(expandedPackage).not.toBeNull();
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect
    .poll(() => expandedPackage!.evaluate((element) => element.isConnected), { timeout: 30_000 })
    .toBe(false);
  await expect(caseTree.locator(".ui-disclosure").first()).toHaveAttribute("data-open", "true");
  await expect(caseTree.locator(".suite-tree-case")).toHaveCount(2);
  await expandedPackage!.dispose();
  await caseTree.locator(".ui-disclosure-label").first().click();
  await expect(caseTree.locator(".suite-tree-case")).toHaveCount(0);
  await caseTree.getByLabel(/^选择包 /u).check();
  await expect(page.getByRole("button", { name: "批量移除（2）" })).toBeVisible();
  await caseTree.scrollIntoViewIfNeeded();
  await captureUi(page, "case-suite-folder-selected-1536");
  await page.setViewportSize({ width: 1024, height: 768 });
  await caseTree.scrollIntoViewIfNeeded();
  await captureUi(page, "case-suite-folder-selected-1024");
  await page.setViewportSize({ width: 1536, height: 1024 });
  // Keep the directory snapshot stale while the authoritative DELETE response advances the
  // task revision. Empty state feedback must not wait for background statistics to catch up.
  const directoryRequests = "**/api/v1/read-models/*/directory?*";
  let releaseDirectory: () => void = () => {};
  const directoryGate = new Promise<void>((resolve) => {
    releaseDirectory = resolve;
  });
  await page.route(directoryRequests, async (route) => {
    await directoryGate;
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "批量移除（2）" }).click();
    await acceptSystemDialog(page, "移除任务用例", "确认移除");
    await expect(page.getByText("任务中还没有用例")).toBeVisible();
  } finally {
    releaseDirectory();
    await page.unrouteAll({ behavior: "wait" });
  }

  // Removing members must advance the editor revision without a page reload.
  await page.getByLabel("任务说明").fill("saved after removing members");
  const savedAfterRemoval = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/v1/case-suites/${copiedSuiteId}`,
  );
  await page.getByRole("button", { name: "保存修改" }).click();
  expect((await savedAfterRemoval).status()).toBe(200);
  const savedCopy = await browserJson<{ description: string; caseCount: number }>(
    page,
    `/api/v1/case-suites/${copiedSuiteId}`,
  );
  expect(savedCopy.body).toMatchObject({
    description: "saved after removing members",
    caseCount: 0,
  });

  await page.goto(`/case-suites/${encodeURIComponent(suite.body.id)}`);
  await page.getByLabel(/启用（停用后/).uncheck();
  await page.getByLabel(/归档（保留历史记录/).check();
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.locator(".toast-viewport").getByRole("status")).toContainText("用例任务已更新");
  const disabledSuite = await browserJson<{
    enabled: boolean;
    status: string;
    policy: {
      priority: number;
      concurrency: number;
      retryLimit: number;
      retryConcurrencyRules: Array<{ concurrency: number }>;
      roundRecoveryRules: Array<{ apiKeyConfigured: boolean }>;
    };
  }>(page, `/api/v1/case-suites/${suite.body.id}`);
  expect(disabledSuite.body).toMatchObject({
    enabled: false,
    status: "archived",
    policy: {
      priority: 42,
      concurrency: 3,
      retryLimit: 2,
      retryConcurrencyRules: [expect.objectContaining({ concurrency: 10 })],
      roundRecoveryRules: [
        expect.objectContaining({ apiKeyConfigured: true }),
        expect.objectContaining({ apiKeyConfigured: true }),
      ],
    },
  });
  expect(disabledSuite.body.policy).not.toHaveProperty("parameters");

  const schedule = await browserJson<{
    items: Array<{ suiteId: string; missedRunPolicy: string }>;
  }>(page, "/api/v1/schedules");
  expect(schedule.body.items).toContainEqual(
    expect.objectContaining({ suiteId: suite.body.id, missedRunPolicy: "skip" }),
  );
});

test("source comparison, promotion, archive recovery and guarded deletion are observable", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureAdministrator(page);
  const suffix = uniqueName("source-lifecycle");
  const project = await createProject(page, suffix);
  const className = `com.example.SourceLifecycle${Date.now()}Test`;
  const originalName = `${suffix}-v1.jar`;
  const candidateName = `${suffix}-v2.jar`;
  await importJar(page, project, originalName, className, ["original"]);
  await setAuthoritativeSource(page, project.id, originalName);
  await importJar(page, project, candidateName, className, ["original", "addedByCandidate"]);

  const sources = await browserJson<{
    items: Array<{
      id: string;
      originalFileName: string;
      authoritative: boolean;
      lifecycleStatus: string;
      revision: number;
    }>;
  }>(page, `/api/v1/case-sources?projectId=${encodeURIComponent(project.id)}&limit=200`);
  const original = sources.body.items.find((source) => source.originalFileName === originalName);
  const candidate = sources.body.items.find((source) => source.originalFileName === candidateName);
  expect(original).toBeTruthy();
  expect(candidate).toBeTruthy();
  expect(original!.authoritative).toBe(true);
  expect(candidate!.authoritative).toBe(false);

  await page.goto(`/case-sources/${encodeURIComponent(candidate!.id)}`);
  await page.getByRole("button", { name: "归档来源" }).click();
  await expect(page.getByText("来源已归档。")).toBeVisible();
  await page.getByRole("button", { name: "恢复为活跃" }).click();
  await expect(page.getByText("来源已恢复为活跃状态。")).toBeVisible();
  await page.getByRole("button", { name: "对比权威来源" }).click();
  await expect(page.getByText(/对比结果：新增 0、变更 1、消失 0、冲突 0/)).toBeVisible();
  await page.getByRole("button", { name: "确认同步为权威来源" }).click();
  await expect(page.getByText(/已同步为权威来源；匹配用例已生成不可变版本/)).toBeVisible();

  const promoted = await browserJson<{ source: { authoritative: boolean } }>(
    page,
    `/api/v1/case-sources/${candidate!.id}`,
  );
  expect(promoted.body.source.authoritative).toBe(true);
  const refreshedOriginal = await browserJson<{ source: { revision: number } }>(
    page,
    `/api/v1/case-sources/${original!.id}`,
  );
  const guardedDelete = await browserJson<{ error?: { code?: string } }>(
    page,
    `/api/v1/case-sources/${original!.id}`,
    { method: "DELETE", body: { expectedRevision: refreshedOriginal.body.source.revision } },
  );
  expect(guardedDelete.status).toBe(409);
  expect(guardedDelete.body.error?.code).toBe("CASE_SOURCE_IN_USE");
});

async function importJar(
  page: Page,
  project: { id: string; name: string; versionId: string; stageId: string },
  fileName: string,
  className: string,
  methodNames: string[],
  additionalClasses: Array<{ className: string; methodNames: string[] }> = [],
): Promise<void> {
  const classes = [{ className, methodNames }, ...additionalClasses];
  const jar = zipSync(
    Object.fromEntries(
      classes.map((fixture) => [
        `${fixture.className.replaceAll(".", "/")}.class`,
        buildClassFile({
          className: fixture.className,
          methods: fixture.methodNames.map((name) => ({
            name,
            annotations: [{ type: "Test" as const, values: { groups: ["lifecycle"] } }],
          })),
        }),
      ]),
    ),
  );
  await page.goto(
    `/cases/import?${new URLSearchParams({
      projectId: project.id,
      projectVersionId: project.versionId,
      testStageId: project.stageId,
    }).toString()}`,
  );
  await expect(page.locator(".global-project-switcher")).toContainText(project.name);
  await selectJarForInspection(page, {
    name: fileName,
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText(className)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
}

async function findVersionCase(
  page: Page,
  projectId: string,
  projectVersionId: string,
  testStageId: string,
  className: string,
): Promise<{ id: string }> {
  const response = await browserJson<{ items: Array<{ id: string; className: string }> }>(
    page,
    `/api/v1/case-definitions?${new URLSearchParams({
      projectId,
      projectVersionId,
      testStageId,
      query: className,
      limit: "100",
    }).toString()}`,
  );
  expect(response.status).toBe(200);
  const definition = response.body.items.find((item) => item.className === className);
  expect(definition).toBeTruthy();
  return definition!;
}

async function createVersionSuite(
  page: Page,
  projectId: string,
  projectVersionId: string,
  name: string,
  caseDefinitionId: string,
): Promise<{ id: string }> {
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId, projectVersionId, name },
  });
  expect(suite.status).toBe(201);
  const cases = await browserJson(
    page,
    `/api/v1/case-suites/${encodeURIComponent(suite.body.id)}/cases`,
    { method: "POST", body: { caseDefinitionIds: [caseDefinitionId] } },
  );
  expect(cases.status).toBe(200);
  return suite.body;
}

async function registerRunner(
  page: Page,
  suffix: string,
): Promise<{ id: string; name: string; credential: string }> {
  const name = `Lifecycle runner ${suffix}`;
  const capabilities = ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"];
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name,
      labels: ["linux", "java", "testng"],
      capabilities,
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.9.0-e2e",
      protocolVersion: 1,
      terminalEnabled: false,
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
        busySlots: 0,
        labels: ["linux", "java", "testng"],
        capabilities,
        maxConcurrency: 2,
        agentVersion: "0.9.0-e2e",
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
  return { id: identity.runnerId, name, credential: identity.credential };
}

async function createProject(
  page: Page,
  suffix: string,
): Promise<{ id: string; name: string; versionId: string; stageId: string }> {
  const name = `Lifecycle project ${suffix}`;
  const response = await browserJson<{ id: string; name: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name, slug: `lifecycle-${suffix}` },
  });
  expect(response.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(response.body.id)}/versions`,
    { method: "POST", body: { name: "Lifecycle version" } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(response.body.id)}/versions/${encodeURIComponent(version.body.id)}/stages`,
    {
      method: "POST",
      body: { name: "Lifecycle stage", description: "Case suite lifecycle hierarchy" },
    },
  );
  expect(stage.status).toBe(201);
  await selectProjectContext(page, response.body.id);
  return {
    ...response.body,
    versionId: version.body.id,
    stageId: stage.body.id,
  };
}

async function setAuthoritativeSource(
  page: Page,
  projectId: string,
  originalFileName: string,
): Promise<void> {
  const sources = await browserJson<{
    items: Array<{ id: string; originalFileName: string }>;
  }>(page, `/api/v1/case-sources?projectId=${encodeURIComponent(projectId)}&limit=200`);
  const source = sources.body.items.find(
    (candidate) => candidate.originalFileName === originalFileName,
  );
  expect(source).toBeTruthy();
  const result = await browserJson(page, `/api/v1/case-sources/${source!.id}/authoritative`, {
    method: "PUT",
    body: { authoritative: true },
  });
  expect(result.status).toBe(200);
}
