import { DEFAULT_PROJECT_ID, builtInRoleDefinitions } from "@autoforge/domain";
import { expect, test, type Page } from "@playwright/test";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import {
  browserJson,
  ensureAdministrator,
  login,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity, waitForUiTransitions } from "./support/ui-guard";

test("analysis starts from execution history and detail, and project administrators assign existing users", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("analysis-assignment");
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: suffix } },
  );
  expect(version.status).toBe(201);
  const versionId = version.body.id;
  await selectProjectContext(page, DEFAULT_PROJECT_ID, versionId);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("AUTOFORGE_E2E_DATA_DIR is required");
  const first = insertFailureAnalysisFixture(directory, versionId, `${suffix}-first`);
  const second = insertFailureAnalysisFixture(directory, versionId, `${suffix}-second`);
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: versionId,
    batchId: first.batchId,
  };

  await page.goto("/execution-records");
  const row = page.getByRole("row").filter({ hasText: first.suiteName });
  await row.getByRole("button", { name: "开始分析" }).click();
  await expectToastAtTopRight(page, "已开始分析");
  await page.goto(`/run-batches/${second.batchId}`);
  await page.getByRole("button", { name: "开始分析" }).click();
  await expectToastAtTopRight(page, "已开始分析");
  await page.reload();
  await page.getByRole("button", { name: "开始分析" }).click();
  await expectToastAtTopRight(page, "该执行已开始分析");
  await page.goto("/case-analysis");
  await expect(page.locator(".failure-analysis-batch-card")).toHaveCount(2);

  const password = "Analysis-test-only-Strong-2026!";
  const analyst = await createUser(page, suffix, "execution-operator", password);
  const projectAdmin = await createUser(page, suffix, "project-admin", password);
  const viewer = await createUser(page, suffix, "viewer", password);
  const contexts = await Promise.all([
    browser.newContext({ baseURL: new URL(page.url()).origin }),
    browser.newContext({ baseURL: new URL(page.url()).origin }),
    browser.newContext({ baseURL: new URL(page.url()).origin }),
  ]);
  try {
    const [adminPage, analystPage, viewerPage] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    for (const [rolePage, user] of [
      [adminPage!, projectAdmin],
      [analystPage!, analyst],
      [viewerPage!, viewer],
    ] as const) {
      await rolePage.goto("/login");
      await login(rolePage, user.username, password);
      await selectProjectContext(rolePage, DEFAULT_PROJECT_ID, versionId);
    }
    await adminPage!.goto(`/case-analysis/${first.batchId}`);
    await adminPage!.getByLabel(`认领 ${first.failedNames[0]}`).check();
    await adminPage!.getByRole("button", { name: "分配给用户" }).click();
    const dialog = adminPage!.getByRole("dialog", { name: "分配用例分析" });
    await dialog.getByLabel("搜索分析人员").fill(analyst.username);
    await dialog.getByRole("button", { name: "搜索", exact: true }).click();
    await dialog.getByRole("radio", { name: new RegExp(analyst.username) }).check();
    await expect(dialog.getByRole("button", { name: "确认分配" })).toBeEnabled();
    await expectUiIntegrity(adminPage!);
    await adminPage!.screenshot({ path: test.info().outputPath("analysis-assignment-1536.png") });
    await dialog.getByRole("button", { name: "确认分配" }).click();
    await expectToastAtTopRight(adminPage!, "已分配 1 个用例");
    await expect(
      adminPage!.getByRole("row").filter({ hasText: first.failedNames[0] }),
    ).toContainText(analyst.username);

    await analystPage!.goto(`/case-analysis/${first.batchId}?view=workbench`);
    await expect(analystPage!.getByRole("heading", { name: first.failedNames[0] })).toBeVisible();
    const forbidden = await browserJson(analystPage!, "/api/v1/failure-analysis/assignments", {
      method: "POST",
      body: { ...scope, assigneeId: analyst.id, executionRunIds: [`run-failed-1-${suffix}-first`] },
    });
    expect(forbidden.status).toBe(403);
    const invalidTarget = await browserJson(adminPage!, "/api/v1/failure-analysis/assignments", {
      method: "POST",
      body: { ...scope, assigneeId: viewer.id, executionRunIds: [`run-failed-1-${suffix}-first`] },
    });
    expect(invalidTarget.status).toBe(400);
    const stats = await browserJson<{ summary: { total: number } }>(
      adminPage!,
      `/api/v1/failure-analysis/statistics?projectId=${DEFAULT_PROJECT_ID}&projectVersionId=${versionId}&batchId=${second.batchId}`,
    );
    expect(stats.status).toBe(200);
    expect(stats.body.summary.total).toBe(0);

    await viewerPage!.goto("/case-analysis");
    await expect(viewerPage!.locator(".failure-analysis-batch-card")).toHaveCount(2);
    await expect(viewerPage!.getByRole("button", { name: "新建分析任务" })).toHaveCount(0);
    await viewerPage!.goto(`/case-analysis/${first.batchId}`);
    await expect(
      viewerPage!.getByRole("row").filter({ hasText: first.failedNames[0] }),
    ).toContainText(analyst.username);
    await expect(viewerPage!.getByRole("link", { name: "分析统计" })).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

async function createUser(page: Page, suffix: string, roleKey: string, password: string) {
  const username = `${suffix}-${roleKey}`;
  const created = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: username, password, forcePasswordChange: false },
  });
  expect(created.status).toBe(201);
  const role = builtInRoleDefinitions.find((role) => role.key === roleKey)!;
  const assigned = await browserJson(page, `/api/v1/users/${created.body.id}/project-roles`, {
    method: "POST",
    body: { projectId: DEFAULT_PROJECT_ID, roleId: role.id },
  });
  expect(assigned.status).toBe(204);
  return { id: created.body.id, username };
}

async function expectToastAtTopRight(page: Page, text: string) {
  const toast = page.locator(".toast-viewport");
  await expect(toast).toContainText(text);
  const bounds = await toast.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeLessThan(120);
  expect(bounds!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
}

test("analysis tasks close only before progress and archives remain readable without accepting writes", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("analysis-lifecycle");
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: suffix } },
  );
  expect(version.status).toBe(201);
  const projectVersionId = version.body.id;
  await selectProjectContext(page, DEFAULT_PROJECT_ID, projectVersionId);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("AUTOFORGE_E2E_DATA_DIR is required");
  const untouched = insertFailureAnalysisFixture(
    directory,
    projectVersionId,
    `${suffix}-untouched`,
  );
  const worked = insertFailureAnalysisFixture(directory, projectVersionId, `${suffix}-worked`, {
    caseNameSuffix: "长用例名称验证分析归档内容保留".repeat(8),
  });
  const scope = (batchId: string) => ({ projectId: DEFAULT_PROJECT_ID, projectVersionId, batchId });
  for (const fixture of [untouched, worked]) {
    expect(
      (
        await browserJson(page, "/api/v1/failure-analysis/batches", {
          method: "POST",
          body: scope(fixture.batchId),
        })
      ).status,
    ).toBe(201);
  }
  await page.goto("/case-analysis");
  const cards = page.locator(".failure-analysis-batch-card");
  await expect(cards).toHaveCount(2);
  const workedCard = cards.filter({
    has: page.getByRole("heading", { name: worked.suiteName, exact: true }),
  });
  const untouchedCard = cards.filter({
    has: page.getByRole("heading", { name: untouched.suiteName, exact: true }),
  });
  await workedCard.getByRole("button", { name: "关闭分析任务", exact: true }).click();
  const closeDialog = page.getByRole("dialog", { name: "关闭分析任务", exact: true });

  // Keep the confirmation open while another client makes analysis progress.
  const claimed = await browserJson<{ claimed: Array<{ id: string }> }>(
    page,
    "/api/v1/failure-analysis/claims",
    {
      method: "POST",
      body: {
        ...scope(worked.batchId),
        executionRunIds: [`run-failed-0-${suffix}-worked`, `run-failed-1-${suffix}-worked`],
      },
    },
  );
  expect(claimed.status).toBe(201);
  const completedId = claimed.body.claimed[0]!.id;
  const pendingId = claimed.body.claimed[1]!.id;
  const completion = {
    projectId: DEFAULT_PROJECT_ID,
    analysisIds: [completedId],
    category: "code_issue_filed",
    issueDescription: "归档前已经定位的实现问题",
    ticketReference: "BUG-ARCHIVE-2026",
    remark: "归档后仍可查阅的结论",
    caseIssueConfirmed: false,
  };
  expect(
    (
      await browserJson(page, "/api/v1/failure-analysis/claims/complete", {
        method: "POST",
        body: completion,
      })
    ).status,
  ).toBe(200);
  await closeDialog.getByRole("button", { name: "确认关闭", exact: true }).click();
  await expect(closeDialog).toContainText("已有分析进展");
  await closeDialog.getByRole("button", { name: "取消", exact: true }).click();

  await untouchedCard.getByRole("button", { name: "关闭分析任务", exact: true }).click();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await waitForUiTransitions(page);
    await expectUiIntegrity(page);
    await page.screenshot({ path: test.info().outputPath(`analysis-close-${width}.png`) });
  }
  await closeDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(untouchedCard).toBeVisible();
  await untouchedCard.getByRole("button", { name: "关闭分析任务", exact: true }).click();
  await closeDialog.getByRole("button", { name: "确认关闭", exact: true }).click();
  await expect(closeDialog).not.toBeVisible();
  await expectToastAtTopRight(page, "分析任务已关闭");
  await expect(untouchedCard).toHaveCount(0);
  expect((await browserJson(page, `/api/v1/run-batches/${untouched.batchId}`)).status).toBe(200);
  expect(
    (
      await browserJson(page, "/api/v1/failure-analysis/batches", {
        method: "POST",
        body: scope(untouched.batchId),
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await browserJson(
        page,
        `/api/v1/failure-analysis/batches?projectId=${DEFAULT_PROJECT_ID}&projectVersionId=${projectVersionId}`,
      )
    ).status,
  ).toBe(200);
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(untouchedCard).toBeVisible();

  // Wait for the invalidated snapshot before inspecting refreshed actions.
  expect(
    (
      await browserJson(
        page,
        `/api/v1/failure-analysis/batches?projectId=${DEFAULT_PROJECT_ID}&projectVersionId=${projectVersionId}`,
      )
    ).status,
  ).toBe(200);
  await page.reload();
  await workedCard.getByRole("button", { name: "归档分析任务", exact: true }).click();
  const archiveDialog = page.getByRole("dialog", { name: "归档分析任务", exact: true });
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await waitForUiTransitions(page);
    await expectUiIntegrity(page);
    await page.screenshot({ path: test.info().outputPath(`analysis-archive-${width}.png`) });
  }
  await archiveDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(workedCard).toBeVisible();
  await workedCard.getByRole("button", { name: "归档分析任务", exact: true }).click();
  await archiveDialog.getByRole("button", { name: "确认归档", exact: true }).click();
  await expect(archiveDialog).not.toBeVisible();
  await expectToastAtTopRight(page, "分析任务已归档");
  await expect(workedCard).toHaveCount(0);
  await page.getByRole("tab", { name: "已归档", exact: true }).click();
  await expect(page).toHaveURL(/view=archived/);
  await expect(workedCard).toBeVisible();
  await expect(workedCard.getByRole("button", { name: "归档分析任务", exact: true })).toHaveCount(
    0,
  );
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expectUiIntegrity(page);
    await page.screenshot({
      path: test.info().outputPath(`analysis-archived-list-${width}.png`),
      fullPage: true,
    });
  }
  await page
    .context()
    .addCookies([{ name: "autoforge-color-mode", value: "dark", url: new URL(page.url()).origin }]);
  await page.reload();
  await expect(workedCard).toBeVisible();
  await waitForUiTransitions(page);
  await page.screenshot({
    path: test.info().outputPath("analysis-archived-list-dark-1536.png"),
    fullPage: true,
  });
  await workedCard.getByRole("link", { name: "查看用例分析详情" }).click();
  await expect(page.getByText("已归档 · 只读", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "查看分析详情", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("问题单链接或问题单号")).toHaveValue(
    "BUG-ARCHIVE-2026",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expectUiIntegrity(page);
    await page.screenshot({
      path: test.info().outputPath(`analysis-archived-detail-${width}.png`),
      fullPage: true,
    });
  }
  const staleSave = await browserJson<{ error: { code: string } }>(
    page,
    "/api/v1/failure-analysis/claims/complete",
    { method: "POST", body: { ...completion, analysisIds: [pendingId] } },
  );
  expect(staleSave.status).toBe(409);
  expect(staleSave.body.error.code).toBe("FAILURE_ANALYSIS_ARCHIVED_CONFLICT");
  expect(
    (
      await browserJson(page, "/api/v1/failure-analysis/batches", {
        method: "POST",
        body: scope(worked.batchId),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await browserJson(page, "/api/v1/failure-analysis/batches", {
        method: "POST",
        body: scope(untouched.batchId),
      })
    ).status,
  ).toBe(200);

  const password = "Archive-test-only-Strong-2026!";
  const viewer = await createUser(page, suffix, "viewer", password);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const viewerPage = await context.newPage();
    await viewerPage.goto("/login");
    await login(viewerPage, viewer.username, password);
    await selectProjectContext(viewerPage, DEFAULT_PROJECT_ID, projectVersionId);
    await viewerPage.goto("/case-analysis?view=archived");
    await expect(viewerPage.locator(".failure-analysis-batch-card")).toContainText(
      worked.suiteName,
    );
    await expect(viewerPage.getByRole("button", { name: /^(关闭|归档)分析任务$/ })).toHaveCount(0);
    const denied = await browserJson(viewerPage, "/api/v1/failure-analysis/batches", {
      method: "PATCH",
      body: { ...scope(untouched.batchId), action: "close" },
    });
    expect(denied.status).toBe(403);
  } finally {
    await context.close();
  }
});
