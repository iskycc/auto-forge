import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { insertRunnerInstallationProfileFixture } from "./support/runner-installation-profile-fixture";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expectUiIntegrity, waitForUiTransitions } from "./support/ui-guard";
import {
  createInitializationProject,
  seedInitializationSource,
  openNewVersionWizard,
  inheritInitializationStep,
} from "./support/version-initialization";
import { insertSuiteProgressFixture } from "./support/suite-progress-fixture";
import { insertExecutionRecordsFixture } from "./support/execution-records-fixture";
import {
  copiedVersionMemberCount,
  insertVersionCopyScaleFixture,
} from "./support/version-copy-scale-fixture";

import {
  acceptSystemDialog,
  browserJson,
  ensureAdministrator,
  login,
  selectProjectContext,
  uniqueName,
} from "./support/session";

test("default project can be renamed in place and keeps its selection after reload", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const projects = await browserJson<
    Array<{ id: string; name: string; slug: string; isDefault: boolean }>
  >(page, "/api/v1/projects");
  const original = projects.body.find((project) => project.id === DEFAULT_PROJECT_ID)!;
  const renamed = uniqueName("默认项目新的展示名称");
  await selectProjectContext(page, DEFAULT_PROJECT_ID);
  try {
    await page.goto("/settings/projects");
    await page.getByRole("button", { name: "修改项目名称", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "修改项目名称", exact: true });
    await expect(dialog.getByRole("button", { name: "保存名称", exact: true })).toBeDisabled();
    await dialog.getByLabel("项目名称", { exact: true }).fill(renamed);
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v1/projects/${DEFAULT_PROJECT_ID}` &&
        response.request().method() === "PATCH",
    );
    await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".project-administration-summary strong")).toHaveText(renamed);
    await page.reload();
    await expect(page.locator(".project-administration-summary strong")).toHaveText(renamed);
    const updated = await browserJson<typeof projects.body>(page, "/api/v1/projects");
    expect(updated.body.find((project) => project.id === DEFAULT_PROJECT_ID)).toMatchObject({
      id: original.id,
      slug: original.slug,
      isDefault: true,
      name: renamed,
    });
    for (const theme of ["light", "dark"]) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
        ]);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await page.reload();
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`project-renamed-${theme}-${width}.png`),
        });
        await page.getByRole("button", { name: "修改项目名称", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "修改项目名称", exact: true })).toBeVisible();
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`project-rename-dialog-${theme}-${width}.png`),
        });
        await page.getByRole("button", { name: "取消", exact: true }).click();
      }
    }
  } finally {
    const restored = await browserJson(page, `/api/v1/projects/${DEFAULT_PROJECT_ID}`, {
      method: "PATCH",
      body: { name: original.name },
    });
    expect(restored.status).toBe(200);
  }
});

test("Agent uninstall requires consent and verified SSH while dialogs fit desktop themes", async ({
  page,
}, testInfo) => {
  test.skip(
    Boolean(process.env.AUTOFORGE_E2E_POSTGRES_URL),
    "Saved connection display fixture uses the Lite database; Full cleanup uses shared adapter contract tests.",
  );
  await ensureAdministrator(page);
  const profile = insertRunnerInstallationProfileFixture(process.env.AUTOFORGE_E2E_DATA_DIR!);
  let runnerId: string | undefined;
  try {
    const registration = await page.request.post("/api/v1/runner-agents/register", {
      headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
      data: {
        schemaVersion: 1,
        name: profile.name,
        labels: [],
        capabilities: ["executor:process"],
        maxConcurrency: 1,
        os: "linux",
        architecture: "amd64",
        agentVersion: "999.0.0",
        protocolVersion: 1,
        terminalEnabled: false,
      },
    });
    expect(registration.status()).toBe(201);
    runnerId = ((await registration.json()) as { runnerId: string }).runnerId;
    let submitted: unknown;
    await page.route(`**/api/v1/runners/${runnerId}/uninstall`, async (route) => {
      submitted = route.request().postDataJSON();
      await route.fulfill({
        status: 502,
        json: {
          error: {
            code: "RUNNER_INSTALLATION_FAILED",
            message: "模拟远端清理失败，请重试。",
            requestId: "uninstall-ui",
          },
        },
      });
    });
    for (const theme of ["light", "dark"]) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
        ]);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await page.goto(`/runners?query=${encodeURIComponent(profile.name)}`);
        const row = page.locator(".runner-list-item").filter({ hasText: profile.name });
        await row.getByText("管理操作", { exact: true }).click();
        await row.getByRole("button", { name: "卸载 Agent", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "卸载执行机 Agent", exact: true });
        const execute = dialog.getByRole("button", { name: "确认卸载并清理", exact: true });
        await expect(execute).toBeDisabled();
        await expect(dialog).toContainText(profile.host);
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`agent-uninstall-stored-${theme}-${width}.png`),
        });
        await dialog.getByLabel("使用已保存的 SSH 连接").uncheck();
        await expect(dialog.getByLabel("SSH / sudo 密码")).toBeVisible();
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`agent-uninstall-manual-${theme}-${width}.png`),
        });
        await dialog.getByLabel("使用已保存的 SSH 连接").check();
        await dialog.getByLabel("我确认卸载并永久删除该执行机的 Agent 本地数据").check();
        await execute.click();
        await expect(dialog.getByRole("alert")).toContainText("模拟远端清理失败");
        expect(submitted).toEqual({ profileId: profile.id, confirm: true });
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
      }
    }
    const node = await page.request.get("/api/v1/runners?limit=500");
    expect(
      ((await node.json()) as { items: Array<{ id: string; deregisteredAt?: string }> }).items.find(
        (item) => item.id === runnerId,
      )?.deregisteredAt,
    ).toBeUndefined();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    profile.dispose();
    if (runnerId) {
      await page.request.post(`/api/v1/runners/${runnerId}/deregister`);
      await page.request.delete(`/api/v1/runners/${runnerId}`);
    }
  }
});

for (const view of ["task", "single"] as const)
  test(`execution record pagination keeps ${view} pages bounded and preserves filters`, async ({
    page,
  }, testInfo) => {
    await ensureAdministrator(page);
    const project = await createInitializationProject(page);
    const version = await browserJson<{ id: string }>(
      page,
      `/api/v1/projects/${project.projectId}/versions`,
      { method: "POST", body: { name: uniqueName("分页版本") } },
    );
    expect(version.status).toBe(201);
    await insertExecutionRecordsFixture(
      process.env.AUTOFORGE_E2E_DATA_DIR!,
      { projectId: project.projectId, projectVersionId: version.body.id },
      23,
      process.env.AUTOFORGE_E2E_POSTGRES_URL,
    );
    await selectProjectContext(page, project.projectId, version.body.id);
    await page.goto(`/execution-records?view=${view}&limit=10&status=succeeded`);
    const pagination = page.getByRole("navigation", { name: "执行记录分页", exact: true });
    const card = page.locator(".execution-records-card");
    const rows = card.getByRole("row").filter({ has: page.getByRole("cell") });
    const keys = async () =>
      view === "task"
        ? card
            .locator('tbody a[href^="/run-batches/"]')
            .evaluateAll((links) => links.map((link) => link.getAttribute("href")))
        : card
            .locator("tbody tr[data-row-key]")
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-row-key")),
            );
    await expect(pagination).toContainText("第 1 页 · 本页 10 条");
    await expect(pagination.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
    await expect(rows).toHaveCount(10);
    const first = await keys();
    expect(first).toHaveLength(10);
    await expect(card).toContainText(view === "task" ? "任务历史" : "单用例历史");
    await expect(card).not.toContainText(view === "task" ? "单用例历史" : "任务历史");
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("cursorPage") === "2", { timeout: 30_000 }),
      pagination.getByRole("link", { name: "下一页", exact: true }).click(),
    ]);
    await expect(pagination).toContainText("第 2 页 · 本页 10 条");
    await expect(rows).toHaveCount(10);
    const second = await keys();
    expect(second.some((key) => first.includes(key))).toBe(false);
    expect(new URL(page.url()).searchParams.get("status")).toBe("succeeded");
    expect(new URL(page.url()).searchParams.get("limit")).toBe("10");
    await page.reload();
    await expect(pagination).toContainText("第 2 页 · 本页 10 条");
    expect(await keys()).toEqual(second);
    for (const appearance of ["light", "dark"]) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: appearance, url: "http://127.0.0.1:3100" },
        ]);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      for (const viewport of [
        { width: 1024, height: 768 },
        { width: 1536, height: 960 },
      ]) {
        await page.setViewportSize(viewport);
        await waitForUiTransitions(page);
        await pagination.scrollIntoViewIfNeeded();
        await expect(pagination).toBeInViewport({ ratio: 1 });
        await page.screenshot({
          path: testInfo.outputPath(`record-pagination-${appearance}-${viewport.width}.png`),
        });
        // Inspect the unobscured page separately: the fixed top bar intentionally
        // covers horizontally sticky table cells while the footer is in view.
        await page
          .locator(".page-hero")
          .evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
        await expectUiIntegrity(page);
      }
    }
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("cursorPage") === "3", { timeout: 30_000 }),
      pagination.getByRole("link", { name: "下一页", exact: true }).click(),
    ]);
    await expect(pagination).toContainText("第 3 页 · 本页 3 条");
    await expect(rows).toHaveCount(3);
    expect(new Set([...first, ...second, ...(await keys())]).size).toBe(23);
    await expect(pagination.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("cursorPage") === "2", { timeout: 30_000 }),
      pagination.getByRole("link", { name: "上一页", exact: true }).click(),
    ]);
    await expect(pagination).toContainText("第 2 页 · 本页 10 条");
    expect(await keys()).toEqual(second);
    await Promise.all([
      page.waitForURL((url) => !url.searchParams.has("cursorPage"), { timeout: 30_000 }),
      pagination.getByRole("link", { name: "第一页", exact: true }).click(),
    ]);
    await expect(pagination).toContainText("第 1 页 · 本页 10 条");
    expect(await keys()).toEqual(first);
    const filter = page.locator(".run-history-filter");
    await filter.locator('select[name="limit"]').selectOption("50", { force: true });
    await filter.getByRole("button", { name: "筛选记录", exact: true }).click();
    await expect(rows).toHaveCount(23);
    await expect(pagination).toContainText("第 1 页 · 本页 23 条");
    await filter.locator('select[name="status"]').selectOption("failed", { force: true });
    await filter.getByRole("button", { name: "筛选记录", exact: true }).click();
    await expect(card).toContainText("暂无符合条件的执行记录");
    await expect(pagination).toContainText("第 1 页 · 本页 0 条");
    await expect(pagination.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  });

for (const targetMode of ["new", "existing"] as const)
  test(`whole-version copy into ${targetMode} version retains historical executions`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: undefined,
        configurable: true,
      });
    });
    await ensureAdministrator(page);
    const sourceProject = await createInitializationProject(page);
    const source = await seedInitializationSource(page, sourceProject.projectId);
    const scale = process.env.E2E_VERSION_COPY_SCALE === "1";
    if (scale) await insertVersionCopyScaleFixture(process.env.AUTOFORGE_E2E_DATA_DIR!, source);
    const targetProject = await createInitializationProject(page);
    await insertSuiteProgressFixture(
      process.env.AUTOFORGE_E2E_DATA_DIR,
      source,
      [{ id: source.suiteId, name: source.suiteName, passedRuns: 0 }],
      process.env.AUTOFORGE_E2E_POSTGRES_URL,
    );
    await selectProjectContext(page, source.projectId, source.projectVersionId, source.testStageId);
    await page.goto("/settings/projects");
    await page.getByRole("button", { name: "复制整个版本", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "复制整个版本", exact: true });
    await expect(dialog.getByRole("button", { name: "开始复制", exact: true })).toBeEnabled();
    const targetName = uniqueName("完整副本");
    let existingVersionId: string | undefined;
    if (targetMode === "existing") {
      const existing = await browserJson<{ id: string }>(
        page,
        `/api/v1/projects/${targetProject.projectId}/versions`,
        { method: "POST", body: { name: targetName } },
      );
      expect(existing.status).toBe(201);
      existingVersionId = existing.body.id;
      const nonempty = await browserJson<{ id: string }>(
        page,
        `/api/v1/projects/${targetProject.projectId}/versions`,
        { method: "POST", body: { name: "不能覆盖的已有版本" } },
      );
      expect(nonempty.status).toBe(201);
      expect(
        (
          await browserJson(
            page,
            `/api/v1/projects/${targetProject.projectId}/versions/${nonempty.body.id}/stages`,
            { method: "POST", body: { name: "已有阶段" } },
          )
        ).status,
      ).toBe(201);
      await dialog.getByRole("radio", { name: "已有空版本", exact: true }).check();
      await expect(dialog.getByRole("button", { name: "开始复制", exact: true })).toBeDisabled();
    } else {
      await dialog.getByLabel("新版本名称", { exact: true }).fill(targetName);
    }
    const target = dialog.getByRole("combobox", { name: "目标项目", exact: true });
    await target.click();
    await page.getByRole("option", { name: targetProject.name, exact: true }).click();
    if (targetMode === "existing") {
      const existingSelector = dialog.getByRole("combobox", { name: "已有空版本", exact: true });
      await expect(existingSelector).toBeEnabled();
      await existingSelector.click();
      await expect(
        page.getByRole("option", { name: "不能覆盖的已有版本（非空）", exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
      await page.getByRole("option", { name: targetName, exact: true }).click();
      await expect(dialog.getByRole("button", { name: "开始复制", exact: true })).toBeEnabled();
    }
    for (const appearance of ["light", "dark"]) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: appearance, url: new URL(page.url()).origin },
        ]);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      for (const viewport of [
        { width: 1024, height: 768 },
        { width: 1536, height: 960 },
      ]) {
        await page.setViewportSize(viewport);
        await waitForUiTransitions(page);
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`version-copy-${appearance}-${viewport.width}.png`),
        });
      }
    }
    await dialog.getByRole("button", { name: "开始复制", exact: true }).click();
    await expect(dialog.getByText("副本已校验并开放使用", { exact: true })).toBeVisible({
      timeout: scale ? 240000 : 60000,
    });
    const jobs = (
      await browserJson<{
        jobs: Array<{ status: string; targetVersionId?: string; targetVersionName: string }>;
      }>(page, `/api/v1/project-version-copies?projectId=${source.projectId}`)
    ).body.jobs;
    const copied = jobs.find((job) => job.targetVersionName === targetName)!;
    expect(copied.status).toBe("completed");
    expect(copied.targetVersionId).toBeTruthy();
    if (existingVersionId) expect(copied.targetVersionId).toBe(existingVersionId);
    const structure = (
      await browserJson<{
        versions: Array<{ id: string; name: string; stages: Array<{ id: string }> }>;
      }>(page, `/api/v1/projects/${targetProject.projectId}/structure`)
    ).body;
    const version = structure.versions.find(
      (candidate) => candidate.id === copied.targetVersionId,
    )!;
    expect(version.name).toBe(targetName);
    expect(version.stages).toHaveLength(1);
    if (scale)
      expect(copiedVersionMemberCount(process.env.AUTOFORGE_E2E_DATA_DIR!, version.id)).toBe(
        100000,
      );
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 960 },
    ]) {
      await page.setViewportSize(viewport);
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`version-copy-completed-${viewport.width}.png`),
      });
    }
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await selectProjectContext(page, targetProject.projectId, version.id, version.stages[0]!.id);
    await page.goto("/execution-records");
    await expect(
      page.locator(".execution-records-table").getByText(source.suiteName, { exact: true }),
    ).toBeVisible();
    await expectUiIntegrity(page);
    await page.goto("/case-suites");
    await expect(
      page
        .getByRole("region", { name: "用例任务列表", exact: true })
        .getByText(source.suiteName, { exact: true }),
    ).toBeVisible();
  });

test("version initialization allows every step to be skipped and can be reopened", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const project = await createInitializationProject(page);
  await selectProjectContext(page, project.projectId);
  await page.goto("/settings/projects");
  const name = uniqueName("empty-version");
  const wizard = await openNewVersionWizard(page, name);
  await expect(wizard.getByText("暂无可继承版本", { exact: true })).toBeVisible();
  await expect(page.locator(".toast-card")).toHaveCount(0);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`empty-${viewport.width}.png`) });
  }
  for (let step = 0; step < 6; step++)
    await wizard.getByRole("button", { name: "跳过此步", exact: true }).click();
  await expect(wizard).toBeHidden();
  const structure = await browserJson<{
    versions: Array<{ id: string; name: string; stages: unknown[] }>;
  }>(page, `/api/v1/projects/${project.projectId}/structure`);
  const version = structure.body.versions.find((item) => item.name === name)!;
  expect(version.stages).toHaveLength(0);
  await page.getByRole("button", { name: "当前项目版本", exact: true }).click();
  await page.getByRole("button", { name: "初始化当前版本", exact: true }).click();
  await expect(wizard).toBeVisible();
  await wizard.getByLabel("新测试阶段名称").fill("稍后补充阶段");
  await wizard.getByRole("button", { name: "添加阶段", exact: true }).click();
  await expect(wizard.getByText("稍后补充阶段", { exact: true })).toBeVisible();
  await wizard.getByRole("button", { name: "稍后配置", exact: true }).click();
  await expect(wizard).toBeHidden();
  await expect(page.locator(".toast-card")).toHaveCount(0);
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  await page.getByRole("button", { name: "当前项目版本", exact: true }).click();
  await page.getByRole("button", { name: "初始化当前版本", exact: true }).click();
  await expect(wizard).toBeVisible();
  await expectUiIntegrity(page);
  await page.screenshot({ path: testInfo.outputPath("initialization-dark-1536.png") });
  await wizard.getByRole("button", { name: "稍后配置", exact: true }).click();
  await expect(wizard).toBeHidden();
});

test("version initialization inherits mapped cases and tasks and preserves progress on a failed request", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const project = await createInitializationProject(page);
  const source = await seedInitializationSource(page, project.projectId);
  await selectProjectContext(page, project.projectId, source.projectVersionId, source.testStageId);
  await page.goto("/settings/projects");
  const name = uniqueName("initialized-version");
  const wizard = await openNewVersionWizard(page, name);
  const sourcePicker = wizard.getByRole("combobox", { name: "继承来源（可选）", exact: true });
  await sourcePicker.click();
  const sourceListId = await sourcePicker.getAttribute("aria-controls");
  expect(sourceListId).toBeTruthy();
  await page
    .locator(`[id="${sourceListId}"]`)
    .getByRole("option", { name: "来源版本_完整支付回归_".repeat(4), exact: true })
    .click();
  const inherit = wizard.getByRole("button", { name: "继承所选内容", exact: true });
  await inheritInitializationStep(page, wizard);
  await expect(wizard.getByText(/本步已处理：新增或匹配/)).toBeVisible();
  await wizard.getByRole("button", { name: "下一步", exact: true }).click();
  await wizard.getByRole("button", { name: "跳过此步", exact: true }).click();
  await page.route(
    "**/versions/*/initialize",
    async (route) => {
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "PLATFORM_BUSY",
            message: "测试暂时繁忙，允许继续。",
            requestId: "initialization-test",
          },
        },
      });
    },
    { times: 1 },
  );
  await inherit.click();
  await expect(wizard.getByText(/测试暂时繁忙，允许继续/)).toBeVisible();
  await inheritInitializationStep(page, wizard);
  await expect(wizard.getByText(/本步已处理：新增或匹配 1 项/)).toBeVisible();
  await wizard.getByRole("button", { name: "下一步", exact: true }).click();
  await inheritInitializationStep(page, wizard);
  await expect(wizard.getByText(/本步已处理：新增或匹配 1 项/)).toBeVisible();
  await wizard.getByRole("button", { name: "下一步", exact: true }).click();
  await inheritInitializationStep(page, wizard);
  await expect(wizard.getByText(/本步已处理：新增或匹配/)).toBeVisible();
  await wizard.getByRole("button", { name: "下一步", exact: true }).click();
  await wizard.getByRole("button", { name: "读取可继承任务", exact: true }).click();
  await wizard.getByRole("checkbox", { name: new RegExp(source.suiteName) }).check();
  await expect(page.locator(".toast-card")).toHaveCount(0);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    expect(await wizard.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`task-inheritance-${viewport.width}.png`) });
  }
  await page.route(
    "**/versions/*/initialize",
    async (route) => {
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: "CASE_SUITE_REVISION_CONFLICT",
            message: "来源任务已变更，请重新读取。",
            requestId: "initialization-conflict",
          },
        },
      });
    },
    { times: 1 },
  );
  await inherit.click();
  const conflict = page.getByRole("dialog", { name: "用例任务已被其他人修改", exact: true });
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "暂不重新加载", exact: true }).click();
  // Exercise real backpressure recovery deterministically after preserving the conflict progress.
  await page.route(
    "**/versions/*/initialize",
    (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: {
            code: "PLATFORM_BUSY",
            message: "平台正在处理高优先级工作，请稍后继续初始化。",
            requestId: "initialization-priority-deferral",
          },
        },
      }),
    { times: 1 },
  );
  await inheritInitializationStep(page, wizard);
  await expect(wizard.getByText(/本步已处理：新增或匹配 2 项/)).toBeVisible();
  await wizard.getByRole("button", { name: "完成并进入版本", exact: true }).click();
  await expect(wizard).toBeHidden();
  const structure = await browserJson<{
    versions: Array<{ id: string; name: string; stages: Array<{ id: string }> }>;
  }>(page, `/api/v1/projects/${project.projectId}/structure`);
  const target = structure.body.versions.find((item) => item.name === name)!;
  const tasks = await browserJson<{
    items: Array<{ id: string; enabled: boolean; caseCount: number }>;
  }>(page, `/api/v1/case-suites?projectId=${project.projectId}&projectVersionId=${target.id}`);
  expect(tasks.body.items).toHaveLength(1);
  expect(tasks.body.items[0]).toMatchObject({ enabled: false, caseCount: 2 });
  const scope = new URLSearchParams({
    projectId: project.projectId,
    projectVersionId: target.id,
    testStageId: target.stages[0]!.id,
  });
  const mappings = await browserJson<{
    items: Array<{ category?: { name: string }; executionClass?: { caseDefinitionId: string } }>;
  }>(page, `/api/v1/ddt/sr-mappings?${scope}`);
  expect(mappings.body.items[0]?.category?.name).toBe("支付");
  expect(mappings.body.items[0]?.executionClass?.caseDefinitionId).not.toBe(source.classId);
});

test("service account lifecycle immediately narrows token access and produces exportable audit", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const accountName = uniqueName("release-automation");
  await page.goto("/settings/platform?section=accounts");
  await page.getByRole("button", { name: "创建账号" }).click();
  const createForm = page.getByRole("dialog", { name: "创建服务账号" });
  await createForm.getByLabel("账号名称").fill(accountName);
  await createForm.getByLabel("用途说明").fill("E2E service account lifecycle");
  await createForm.locator('input[name="permissions"][value="case.read"]').check();
  await createForm.locator('input[name="permissions"][value="audit.read"]').check();
  const projectPermissionGroup = createForm.locator(".project-permission-group").first();
  if ((await projectPermissionGroup.count()) > 0) {
    await projectPermissionGroup.locator('input[value="run.read"]').check();
  }
  const accountResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/v1/service-accounts"),
  );
  await createForm.getByRole("button", { name: "创建服务账号", exact: true }).click();
  const account = (await (await accountResponse).json()) as { id: string };
  const accountCard = page.locator("article", { hasText: accountName });
  await expect(accountCard).toContainText("启用");
  await expect(accountCard).toContainText("查看用例");
  await expect(accountCard).toContainText("查看安全审计");
  await expect(accountCard).not.toContainText("case.read");
  await expect(accountCard).not.toContainText("audit.read");

  await accountCard.getByRole("button", { name: "签发令牌", exact: true }).click();
  const tokenForm = page.getByRole("dialog", { name: `签发令牌：${accountName}` });
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expect(tokenForm).toBeVisible();
    await waitForUiTransitions(page);
    const formBounds = await tokenForm.locator("form").boundingBox();
    const scopesBounds = await tokenForm
      .getByRole("group", { name: "作用域", exact: true })
      .boundingBox();
    expect(scopesBounds!.width).toBeGreaterThan(formBounds!.width * 0.9);
    const footer = tokenForm.locator(".action-dialog-footer");
    await expect(footer.getByRole("button", { name: "签发", exact: true })).toBeVisible();
    await captureManagementDialog(page, `service-token-${width}`);
  }
  await tokenForm.getByLabel("令牌名称").fill("e2e-token");
  await tokenForm
    .locator('input[name="expiresAt"]')
    .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  await tokenForm.locator('input[name="scopes"][value="case.read"]').check();
  await tokenForm.locator('input[name="scopes"][value="audit.read"]').check();
  await tokenForm.getByRole("button", { name: "签发", exact: true }).click();
  const token = await page.locator(".issued-token code").textContent();
  expect(token).toMatch(/^af_api_/);
  const authorized = await page.request.get("/api/v1/case-definitions", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(authorized.status()).toBe(200);

  await accountCard.getByText("编辑账号与权限").click();
  const editor = page.getByRole("dialog", { name: `编辑服务账号：${accountName}` });
  await editor.getByLabel("用途说明").fill("Permissions narrowed by E2E");
  for (const checkbox of await editor.locator('input[name="permissions"]').all()) {
    await checkbox.uncheck();
  }
  await editor.locator('input[name="permissions"][value="audit.read"]').check();
  for (const checkbox of await editor.locator('input[name^="projectPermissions:"]').all()) {
    await checkbox.uncheck();
  }
  await editor.getByRole("button", { name: "保存账号" }).click();
  await expect(page.getByText(/权限缩减.*立即生效/)).toBeVisible();
  const narrowed = await page.request.get("/api/v1/case-definitions", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(narrowed.status()).toBe(403);

  await accountCard.getByRole("button", { name: "编辑账号与权限" }).click();
  await editor.getByRole("button", { name: "禁用账号" }).click();
  await acceptSystemDialog(page, "禁用服务账号", "确认变更");
  await expect(page.getByText("服务账号已禁用。")).toBeVisible();
  const disabled = await page.request.get("/api/v1/audit-events", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(disabled.status()).toBe(401);

  let refreshedCard = page.locator("article", { hasText: accountName });
  await editor.getByRole("button", { name: "启用账号" }).click();
  await acceptSystemDialog(page, "启用服务账号", "确认变更");
  await expect(page.getByText("服务账号已重新启用。")).toBeVisible();
  await editor.getByRole("button", { name: `关闭编辑服务账号：${accountName}` }).click();
  refreshedCard = page.locator("article", { hasText: accountName });
  await refreshedCard.getByRole("button", { name: "令牌", exact: true }).click();
  await refreshedCard.getByRole("button", { name: "撤销 e2e-token" }).click();
  await acceptSystemDialog(page, "撤销 API 令牌", "确认撤销");
  await expect(page.getByText("API 令牌已撤销。")).toBeVisible();
  const revoked = await page.request.get("/api/v1/audit-events", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(revoked.status()).toBe(401);

  refreshedCard = page.locator("article", { hasText: accountName });
  await refreshedCard.getByRole("button", { name: "签发令牌", exact: true }).click();
  const replacementForm = page.getByRole("dialog", { name: `签发令牌：${accountName}` });
  await replacementForm.getByLabel("令牌名称").fill("replacement-token");
  await replacementForm
    .locator('input[name="expiresAt"]')
    .fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  await replacementForm.locator('input[name="scopes"][value="audit.read"]').check();
  await replacementForm.getByRole("button", { name: "签发", exact: true }).click();
  await expect.poll(() => page.locator(".issued-token code").textContent()).not.toBe(token);
  const replacementToken = await page.locator(".issued-token code").textContent();
  expect(replacementToken).toMatch(/^af_api_/);
  const replacementAuthorized = await page.request.get("/api/v1/audit-events", {
    headers: { authorization: `Bearer ${replacementToken}` },
  });
  expect(replacementAuthorized.status()).toBe(200);
  await page.reload();
  await expect(page.locator(".issued-token")).toHaveCount(0);

  await page.goto("/audit?action=service_account.update");
  await expect(page.getByRole("heading", { name: "安全审计" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "修改服务账号 用户与授权" }).first()).toBeVisible();
  const csv = await page.request.get(
    "/api/v1/audit-events/export?action=service_account.update&maximumEvents=100",
  );
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain("修改服务账号");
  expect(account.id).toBeTruthy();
});

test("task details manage their own plan and show execution history in a dialog", async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await ensureAdministrator(page);
  const projectVersionId = await ensureDefaultProjectVersion(page);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, projectVersionId);
  const suiteName = uniqueName("scheduled-suite");
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId,
      name: suiteName,
      description: "Schedule operations E2E",
    },
  });
  expect(suite.status).toBe(201);
  await page.goto(`/case-suites/${suite.body.id}`);
  await expect(
    page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "运维计划" }),
  ).toHaveCount(0);
  const plan = page.getByRole("region", { name: "任务执行计划" });
  await plan.getByLabel("Cron（分 时 日 月 周）").fill("0 9 * * 1-5");
  await plan.getByLabel("IANA 时区").fill("Asia/Shanghai");
  await plan.getByLabel("错过触发").and(plan.locator("select")).selectOption("run-once");
  await plan.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByText("计划触发已保存。", { exact: true })).toBeVisible();
  const openHistory = plan.getByRole("button", { name: "执行历史与计划", exact: true });
  await openHistory.click();
  const dialog = page.getByRole("dialog", { name: "执行历史与计划", exact: true });
  await expect(dialog).toContainText(suiteName);
  await expect(dialog).toContainText("恢复后补跑一次");
  await expect(dialog).toContainText("Asia/Shanghai");
  await expect(dialog).toContainText("下次执行");
  await expect(dialog).toContainText("尚未触发");
  await expect(dialog).toContainText("暂无执行记录");
  await dialog.getByRole("button", { name: "关闭执行历史与计划" }).click();
  await expect(openHistory).toBeFocused();

  await plan.getByRole("button", { name: "暂停计划" }).click();
  await expect(page.getByText("计划已暂停。")).toBeVisible();
  const currentSuite = await browserJson<{ revision: number }>(
    page,
    `/api/v1/case-suites/${suite.body.id}`,
  );
  const refreshedDescription = "Schedule dialog survives background refresh";
  const updatedSuite = await browserJson(page, `/api/v1/case-suites/${suite.body.id}`, {
    method: "PATCH",
    body: { description: refreshedDescription, expectedRevision: currentSuite.body.revision },
  });
  expect(updatedSuite.status).toBe(200);
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const suitePageUrl = (url: URL) => url.pathname === `/case-suites/${suite.body.id}`;
  await page.route(suitePageUrl, async (route) => {
    const response = await route.fetch();
    await refreshGate;
    await route.fulfill({ response });
  });
  try {
    await page.locator(".read-model-status").getByRole("button", { name: "刷新数据" }).click();
    await openHistory.click();
    await expect(dialog).toContainText("计划已暂停，不会自动执行");
    releaseRefresh();
    await expect(page.locator(".page-hero")).toContainText(refreshedDescription);
    await expect(dialog).toContainText("计划已暂停，不会自动执行");
  } finally {
    releaseRefresh();
    await page.unroute(suitePageUrl);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(openHistory).toBeFocused();
  await plan.getByRole("button", { name: "恢复计划" }).click();
  await expect(page.getByText("计划已启用。")).toBeVisible();
  await page.reload();
  await expect(plan.getByRole("button", { name: "暂停计划" })).toBeVisible();

  // Only the history transport is stubbed here; repository contracts verify scoped pagination.
  const historyUrl = `**/api/v1/case-suites/${suite.body.id}/executions?*`;
  let failHistory = true;
  await page.route(historyUrl, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("projectId")).toBe(DEFAULT_PROJECT_ID);
    expect(query.get("projectVersionId")).toBe(projectVersionId);
    if (failHistory) {
      failHistory = false;
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "TEST_UNAVAILABLE",
            message: "执行历史暂时不可用",
            requestId: "history-test",
          },
        },
      });
      return;
    }
    const cursor = query.get("cursor");
    const sequences = cursor ? [1] : [11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
    if (cursor) expect(cursor).toBe("history-page-2");
    await route.fulfill({
      json: {
        items: sequences.map((sequenceNumber) => ({
          id: `history-${sequenceNumber}`,
          sequenceNumber,
          status: "succeeded",
          kind: "standard",
          totalRuns: 1,
          succeededRuns: 1,
          failedRuns: 0,
          timedOutRuns: 0,
          cancelledRuns: 0,
          currentRound: 1,
          retryLimit: 0,
          scheduledFor: "2026-09-05T00:00:00.000Z",
          createdAt: "2026-09-05T00:00:00.000Z",
          updatedAt: "2026-09-05T00:01:00.000Z",
        })),
        ...(!cursor ? { nextCursor: "history-page-2" } : {}),
      },
    });
  });
  await openHistory.click();
  const history = dialog.getByRole("region", { name: "任务执行历史" });
  await expect(history.getByRole("alert")).toContainText("执行历史暂时不可用");
  await history.getByRole("button", { name: "重试", exact: true }).click();
  await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(10);
  await history.getByRole("button", { name: "下一页" }).click();
  await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(1);
  await expect(history.getByRole("button", { name: "下一页" })).toBeDisabled();
  await history.getByRole("button", { name: "上一页" }).click();
  await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(10);
  await dialog.getByRole("button", { name: "刷新计划与历史" }).click();
  await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(10);
  await expect(history.getByRole("button", { name: "上一页" })).toBeDisabled();

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`schedule-history-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await expect(openHistory).toBeFocused();
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`schedule-detail-${viewport.width}.png`) });
    await openHistory.click();
    await expect(history.getByRole("link", { name: /查看执行记录/ })).toHaveCount(10);
  }
  await page.keyboard.press("Escape");
  await page.unroute(historyUrl);

  await plan.getByRole("button", { name: "删除计划" }).click();
  await acceptSystemDialog(page, "删除执行计划", "确认删除");
  await expect(page.getByText("执行计划已删除。")).toBeVisible();
  await expect(plan.getByRole("button", { name: "删除计划" })).toHaveCount(0);
  await openHistory.click();
  await expect(dialog).toContainText("尚未配置自动执行计划");
  await expect(dialog).toContainText("暂无执行记录");
  expect(browserErrors).toEqual([]);
});

test("task schedule dialog keeps read permissions separate from execution history and management", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const projectVersionId = await ensureDefaultProjectVersion(page);
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId: DEFAULT_PROJECT_ID, projectVersionId, name: uniqueName("read-only-plan") },
  });
  expect(suite.status).toBe(201);
  for (const canReadExecutions of [false, true]) {
    const username = uniqueName(canReadExecutions ? "history-reader" : "plan-reader");
    const password = "ScheduleReader!Password123";
    const role = await browserJson<{ id: string }>(page, "/api/v1/roles", {
      method: "POST",
      body: {
        key: username,
        name: username,
        scope: "project",
        permissions: ["case_suite.read", ...(canReadExecutions ? ["run.read"] : [])],
      },
    });
    expect(role.status).toBe(201);
    const user = await browserJson<{ id: string }>(page, "/api/v1/users", {
      method: "POST",
      body: { username, displayName: username, password, forcePasswordChange: false },
    });
    expect(user.status).toBe(201);
    expect(
      (
        await browserJson(page, `/api/v1/users/${user.body.id}/project-roles`, {
          method: "POST",
          body: { projectId: DEFAULT_PROJECT_ID, roleId: role.body.id },
        })
      ).status,
    ).toBe(204);
    const readerContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { width: 1024, height: 768 },
    });
    try {
      const readerPage = await readerContext.newPage();
      await readerPage.goto("/login");
      await login(readerPage, username, password);
      // The legacy login entry opens the home-page dialog and preserves that page.
      await expect(readerPage).toHaveURL(new URL("/", readerPage.url()).href);
      await expect(readerPage.getByRole("navigation", { name: "主导航" })).toBeVisible();
      await readerPage.goto(`/case-suites/${suite.body.id}`);
      const plan = readerPage.getByRole("region", { name: "任务执行计划" });
      await expect(plan.getByRole("button", { name: "保存计划" })).toHaveCount(0);
      await plan.getByRole("button", { name: "执行历史与计划", exact: true }).click();
      const dialog = readerPage.getByRole("dialog", { name: "执行历史与计划", exact: true });
      await expect(dialog).toContainText("尚未配置自动执行计划");
      if (canReadExecutions) await expect(dialog).toContainText("暂无执行记录");
      else {
        await expect(dialog).toContainText("当前账号无执行记录查看权限");
        await expect(dialog.getByRole("region", { name: "任务执行历史" })).toHaveCount(0);
      }
      await expectUiIntegrity(readerPage);
      await readerPage.screenshot({
        path: testInfo.outputPath(`schedule-reader-${canReadExecutions ? "history" : "plan"}.png`),
      });
      const endpoint = `/api/v1/case-suites/${suite.body.id}/schedule`;
      expect(
        (
          await browserJson(readerPage, endpoint, {
            method: "PUT",
            body: {
              cronExpression: "0 9 * * *",
              timeZone: "Asia/Shanghai",
              enabled: true,
              missedRunPolicy: "skip",
            },
          })
        ).status,
      ).toBe(403);
      expect((await browserJson(readerPage, endpoint, { method: "DELETE" })).status).toBe(403);
      const history = await browserJson(
        readerPage,
        `/api/v1/case-suites/${suite.body.id}/executions?projectId=${DEFAULT_PROJECT_ID}&projectVersionId=${projectVersionId}`,
      );
      expect(history.status).toBe(canReadExecutions ? 200 : 403);
    } finally {
      await readerContext.close();
    }
  }
});

test("webhook dialog footers submit create and edit forms and preserve deletion confirmation", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const versionId = await ensureDefaultProjectVersion(page);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, versionId);
  const name = uniqueName("dialog-webhook");
  await page.goto("/settings/webhooks");
  await page.getByRole("button", { name: "新建 Webhook", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建 Webhook", exact: true });
  await create.getByLabel("名称", { exact: true }).fill(name);
  await create
    .getByLabel("目标地址", { exact: true })
    .fill("http://127.0.0.1:3100/webhook-layout-fixture");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await captureManagementDialog(page, `webhook-filled-create-${width}`);
  }
  await create.getByRole("button", { name: "创建端点", exact: true }).click();
  const card = page.locator(".webhook-endpoint-card", { hasText: name });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑 Webhook", exact: true });
  await editor.getByLabel("说明", { exact: true }).fill("通过弹窗底栏保存的通知配置");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await captureManagementDialog(page, `webhook-filled-edit-${width}`);
  }
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(card).toContainText("通过弹窗底栏保存的通知配置");
  await card.getByRole("button", { name: "删除", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "删除 Webhook", exact: true });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "删除", exact: true }).click();
  await confirmation.getByRole("button", { name: "删除", exact: true }).click();
  await expect(card).toHaveCount(0);
});

test("project webhooks support custom POST bodies and task binding", async ({ page }) => {
  const receivedBodies: string[] = [];
  const callbackHost = process.env.E2E_WEBHOOK_CALLBACK_HOST ?? "127.0.0.1";
  const webhookServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    webhookServer.once("error", reject);
    webhookServer.listen(0, "0.0.0.0", resolve);
  });
  const address = webhookServer.address();
  if (!address || typeof address === "string") throw new Error("Webhook test server did not bind.");
  try {
    await ensureAdministrator(page);
    const projectVersionId = await ensureDefaultProjectVersion(page);
    const webhookName = uniqueName("quality-webhook");
    const suiteName = uniqueName("webhook-suite");
    const configuration = await browserJson<{ id: string; method: string }>(
      page,
      "/api/v1/webhooks",
      {
        method: "POST",
        body: {
          projectId: DEFAULT_PROJECT_ID,
          name: webhookName,
          description: "Webhook E2E",
          targetUrl: `http://${callbackHost}:${address.port}/autoforge-completed`,
          method: "POST",
          bodyTemplate:
            '{"batchId":"{{batch.id}}","suite":"{{batch.suiteName}}","status":"{{batch.displayStatus}}","passRate":"{{summary.passRate}}"}',
          enabled: true,
        },
      },
    );
    expect(configuration.status).toBe(201);
    expect(configuration.body.method).toBe("POST");
    const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
      method: "POST",
      body: {
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId,
        name: suiteName,
        description: "Webhook binding E2E",
      },
    });
    expect(suite.status).toBe(201);

    await page.goto("/settings/webhooks");
    const endpointCard = page.locator(".webhook-endpoint-card", { hasText: webhookName });
    await expect(endpointCard).toBeVisible();
    await expect(endpointCard).toContainText("POST");
    await expect(endpointCard).toContainText("已启用");
    await endpointCard.getByRole("button", { name: "测试" }).click();
    await expect(page.getByText(/测试成功.*HTTP 204.*预置通过率 80%/)).toBeVisible();
    await expect.poll(() => receivedBodies.length).toBe(1);
    expect(JSON.parse(receivedBodies[0]!)).toMatchObject({
      batchId: "webhook-test-batch",
      status: "执行完成",
      passRate: "80.0",
    });

    await page.goto(`/case-suites/${suite.body.id}`);
    const bindingCard = page.locator(".case-suite-webhooks-card");
    await expect(bindingCard).toBeVisible();
    const endpointOption = bindingCard.locator("label", { hasText: webhookName });
    await endpointOption.locator('input[type="checkbox"]').check();
    await bindingCard.getByRole("button", { name: "保存通知绑定" }).click();
    await expect(page.locator(".toast-card", { hasText: "Webhook 绑定已保存。" })).toBeVisible();

    const bindings = await browserJson<{ webhookIds: string[] }>(
      page,
      `/api/v1/case-suites/${suite.body.id}/webhooks`,
    );
    expect(bindings.status).toBe(200);
    expect(bindings.body.webhookIds).toContain(configuration.body.id);

    await page.goto("/settings/webhooks");
    await endpointCard.getByRole("button", { name: "编辑" }).click();
    const editor = page.getByRole("dialog", { name: "编辑 Webhook" });
    await expect(editor.getByLabel("JSON 请求体模板")).toContainText("batch.displayStatus");
    await page.keyboard.press("Escape");
  } finally {
    await new Promise<void>((resolve, reject) =>
      webhookServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function ensureDefaultProjectVersion(page: Page): Promise<string> {
  const structure = await browserJson<{
    versions: Array<{ id: string; status: "active" | "archived" }>;
  }>(page, `/api/v1/projects/${DEFAULT_PROJECT_ID}/structure`);
  const activeVersion = structure.body.versions.find((version) => version.status === "active");
  if (activeVersion) return activeVersion.id;
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("management-version") } },
  );
  expect(version.status).toBe(201);
  return version.body.id;
}

test("permission selection supports scoped bulk actions and project-only service accounts", async ({
  page,
}) => {
  await ensureAdministrator(page);
  await page.goto("/settings/platform?section=accounts");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "创建服务账号" });
  await dialog.getByLabel("账号名称", { exact: true }).fill(uniqueName("project-only"));
  const system = dialog.getByRole("group", { name: "系统权限", exact: true });
  await system.getByRole("button", { name: "全选", exact: true }).click();
  expect(await system.locator('input[type="checkbox"]:checked').count()).toBeGreaterThan(20);
  await system.getByRole("button", { name: "取消全选", exact: true }).click();
  await expect(system.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  const project = dialog.locator(".project-permission-group").first();
  await project.locator('input[value="run.read"]').check();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/v1/service-accounts",
  );
  await dialog.getByRole("button", { name: "创建服务账号", exact: true }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  expect((await created.json()).systemPermissions).toEqual([]);
  await expect(dialog).toBeHidden();
});

test("retention previews expire on policy edits and stale manual execution is rejected", async ({
  page,
}) => {
  await ensureAdministrator(page);
  await page.goto("/settings/platform?section=retention");
  const policy = page
    .locator(".retention-policy-grid form")
    .filter({ has: page.getByText("审计", { exact: true }) });
  const days = policy.getByLabel("保留天数");
  const original = await days.inputValue();
  const previewResponse = page.waitForResponse((response) =>
    response.url().endsWith("/retention/audit/preview"),
  );
  await policy.getByRole("button", { name: "影响预览" }).click();
  const preview = (await (await previewResponse).json()) as {
    policyRevision: number;
    cutoffAt: string;
  };
  await expect(policy.getByRole("button", { name: "执行清理" })).toBeEnabled();
  await days.fill(original === "365" ? "366" : "365");
  await expect(policy.getByRole("button", { name: "执行清理" })).toBeDisabled();
  await expect(policy.getByRole("button", { name: "影响预览" })).toBeDisabled();
  await policy.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("保留策略已更新，请重新预览后清理。", { exact: true })).toBeVisible();
  await expect(policy.getByRole("button", { name: "执行清理" })).toBeDisabled();
  const result = await browserJson(page, "/api/v1/settings/retention/audit/execute", {
    method: "POST",
    body: {
      confirmation: "audit",
      expectedRevision: preview.policyRevision,
      previewCutoffAt: preview.cutoffAt,
    },
  });
  expect(result.status).toBe(409);
  await days.fill(original);
  await policy.getByRole("button", { name: "保存", exact: true }).click();
});

test("management drafts require confirmation and candidate search preserves project scope", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  await page.goto("/settings/platform?section=accounts");
  await page.getByRole("button", { name: "创建账号" }).click();
  const dialog = page.getByRole("dialog", { name: "创建服务账号", exact: true });
  await dialog.getByLabel("账号名称", { exact: true }).fill("尚未保存的账号");
  await dialog.getByRole("button", { name: "关闭创建服务账号" }).click();
  await expect(dialog.getByText("放弃未保存的修改？")).toBeVisible();
  await dialog.getByRole("button", { name: "继续编辑" }).click();
  await expect(dialog.getByLabel("账号名称", { exact: true })).toHaveValue("尚未保存的账号");
  await dialog.getByRole("button", { name: "关闭创建服务账号" }).click();
  await dialog.getByRole("button", { name: "放弃修改并关闭" }).click();
  await expect(dialog).toHaveCount(0);
  await page.goto("/settings/platform?section=configuration");
  await page.getByLabel("平台时区").fill("Europe/London");
  await page.getByRole("link", { name: "服务账号", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "放弃未保存的配置？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("平台时区")).toHaveValue("Europe/London");
  await page.getByRole("link", { name: "服务账号", exact: true }).click();
  await confirm.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/section=accounts/);
  await page.goto("/settings/projects?section=members&query=no-matches");
  await page.getByRole("button", { name: "添加成员", exact: true }).click();
  const members = page.getByRole("dialog", { name: "分配用户角色" });
  await members.getByLabel("查找用户").fill("e2e-admin");
  await members.getByRole("button", { name: "查询用户" }).click();
  await expect(members.getByRole("checkbox", { name: /e2e-admin/ })).toBeVisible();
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`member-candidates-${viewport.width}.png`) });
  }
});

async function captureManagementDialog(page: Page, name: string) {
  await expectUiIntegrity(page);
  const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}
