import { expect, test, type Locator, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { selectJarForInspection } from "./support/jar-import";
import { configureTaskExecution, createTaskRun } from "./support/task-execution";
import { expectUiIntegrity } from "./support/ui-guard";

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
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `version-scoped-case-suites-${viewport.width}`);
  }
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
  await runDialog.getByRole("button", { name: "倒计时执行", exact: true }).click();
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
  await page.getByLabel("基准版本").selectOption("1");
  await page.getByLabel("对比版本").selectOption("2");
  await expect(
    page.locator(".version-diff-list").getByText(/方法新增：.*browserAdded/),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "从该版本创建" }).last().click();
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
  await page.getByLabel("重试次数上限").fill("2");
  await page.getByLabel("失败重跑方式").selectOption("round");
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
  await expect(page.getByRole("status")).toContainText("用例任务已更新");
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

  await page.getByLabel("Cron（分 时 日 月 周）").fill("17 8 * * 1-5");
  await page.getByLabel("IANA 时区").fill("Asia/Shanghai");
  await page.getByLabel("错过触发").selectOption("skip");
  await page.getByRole("button", { name: "保存计划" }).click();
  await expect(page.getByRole("status")).toContainText("计划触发已保存");

  const copyName = `${suiteName} copy`;
  await page.goto("/case-suites");
  await page.getByRole("button", { name: "创建任务" }).click();
  const copyDialog = page.getByRole("dialog", { name: "创建用例任务" });
  await copyDialog.getByLabel("复制已有任务", { exact: false }).check();
  await copyDialog.locator('select[aria-label="来源任务"]').selectOption(suite.body.id);
  await copyDialog.getByLabel("新任务名称").fill(copyName);
  await expect(copyDialog.getByText(/新任务使用独立 ID 和成员记录/u)).toBeVisible();
  for (const viewport of [
    { width: 1536, height: 1024 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(copyDialog).toBeVisible();
    await captureUi(page, `case-suite-copy-dialog-${viewport.width}`);
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  await copyDialog.getByRole("button", { name: "复制并编辑" }).click();
  await expect(page.getByRole("heading", { name: copyName })).toBeVisible();
  await expect(page.getByRole("heading", { name: "2 个用例", exact: true })).toBeVisible();
  const copiedSuiteId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByLabel("并发度（同时在途执行数）").fill("5");
  await page.getByLabel("任务说明").fill("independently edited task copy");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例任务已更新");
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
  const caseTree = page.getByRole("tree", { name: "任务用例树" });
  await expect(caseTree).toBeVisible();
  // Large tasks keep package contents out of the DOM until the user expands one package. This is a
  // performance contract: rendering every small package eagerly can create tens of thousands of
  // rows and make the native details arrow block the browser main thread.
  await expect(caseTree.locator(".suite-tree-case")).toHaveCount(0);
  await caseTree.locator("summary").first().click();
  await expect(caseTree.locator(".suite-tree-case")).toHaveCount(2);
  await caseTree.locator("summary").first().click();
  await expect(caseTree.locator(".suite-tree-case")).toHaveCount(0);
  await caseTree.getByLabel(/^选择包 /u).check();
  await expect(page.getByRole("button", { name: "批量移除（2）" })).toBeVisible();
  await caseTree.scrollIntoViewIfNeeded();
  await captureUi(page, "case-suite-folder-selected-1536");
  await page.setViewportSize({ width: 1024, height: 768 });
  await caseTree.scrollIntoViewIfNeeded();
  await captureUi(page, "case-suite-folder-selected-1024");
  await page.setViewportSize({ width: 1536, height: 1024 });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "批量移除（2）" }).click();
  await expect(page.getByText("任务中还没有用例")).toBeVisible();

  await page.goto(`/case-suites/${encodeURIComponent(suite.body.id)}`);
  await page.getByLabel(/启用（停用后/).uncheck();
  await page.getByLabel(/归档（保留历史记录/).check();
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例任务已更新");
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

async function registerRunner(page: Page, suffix: string): Promise<{ id: string; name: string }> {
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
  return { id: identity.runnerId, name };
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
