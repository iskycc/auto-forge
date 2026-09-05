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
import { expectUiIntegrity } from "./support/ui-guard";

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
