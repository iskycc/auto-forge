import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page, type Request, type Route } from "@playwright/test";
import { zipSync } from "fflate";

import { buildExportWorkbook } from "../../packages/ddt-import/src";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { selectJarForInspection } from "./support/jar-import";
import {
  acceptSystemDialog,
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("DDT import resolves duplicate column names before background import", async ({ page }) => {
  test.setTimeout(120_000);
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);
  await page.goto("/cases?tab=testng");
  await page.getByRole("link", { name: "DDT 管理" }).click();

  await page.getByRole("button", { name: "导入表格" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入 DDT 用例" });
  const fileName = `ddt-duplicate-columns-${hierarchy.suffix}.csv`;
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `CaseID,srNum,环境,环境\nDUPLICATE-${hierarchy.suffix},CORE,test,production\n`,
      "utf8",
    ),
  });
  await importDialog.getByRole("button", { name: "开始预检" }).click();

  const conflictDialog = page.getByRole("dialog", { name: "解决重复列名" });
  await expect(conflictDialog).toBeVisible();
  await expect(conflictDialog).toContainText("检测到 1 组冲突");
  const columnChoices = conflictDialog.locator(".ddt-column-choice");
  await expect(columnChoices).toHaveCount(2);
  await expect(columnChoices.nth(0)).toContainText("test");
  await expect(columnChoices.nth(1)).toContainText("production");
  await expect(columnChoices.nth(0)).toContainText("1 个非空单元格");
  await expect(columnChoices.nth(1)).toContainText("1 个非空单元格");
  const firstColumn = conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 第 3 列的新列名`);
  const secondColumn = conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 第 4 列的新列名`);
  await expect(firstColumn).toHaveValue("环境");
  await expect(secondColumn).toHaveValue("环境_2");

  await secondColumn.fill("环境");
  await conflictDialog.getByRole("button", { name: "应用并重新预检" }).click();
  await expect(conflictDialog.getByRole("alert")).toContainText("仍然重复");
  const firstDelete = conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 删除第 3 列 环境`);
  const secondDelete = conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 删除第 4 列 环境`);
  await firstDelete.check();
  await secondDelete.check();
  await conflictDialog.getByRole("button", { name: "应用并重新预检" }).click();
  await expect(conflictDialog.getByRole("alert")).toContainText("至少需要保留一列");
  await firstDelete.uncheck();
  await expect(secondDelete).toBeChecked();
  await expect(secondColumn).toBeDisabled();
  await expect(columnChoices.nth(1)).toContainText("该列将在导入时忽略");
  await expect(conflictDialog.getByRole("alert")).toBeHidden();
  await captureDdtUi(page, "ddt-duplicate-column-resolution-1536");
  await page.setViewportSize({ width: 1024, height: 768 });
  await captureDdtUi(page, "ddt-duplicate-column-resolution-1024");
  await expectUiIntegrity(page);
  await conflictDialog.getByRole("button", { name: "应用并重新预检" }).click();

  await expect(conflictDialog).toBeHidden();
  await expect(importDialog.locator(".ddt-preview-summary")).toContainText("1 / 1");
  await expect(importDialog.locator(".ddt-preview-files")).toContainText("可导入");
  await expect(importDialog.getByRole("button", { name: "确认并后台导入" })).toBeEnabled();
  await importDialog.getByRole("button", { name: "确认并后台导入" }).click();

  await expect(page.locator(".ddt-status.succeeded", { hasText: "已完成" })).toBeVisible({
    timeout: 30_000,
  });
  const importJobs = await browserJson<{
    items: Array<{
      uploads: Array<{
        columnResolutions?: Array<{
          sheetName: string;
          columnIndex: number;
          resolvedName: string;
          deleteColumn?: boolean;
        }>;
      }>;
    }>;
  }>(page, ddtPath(hierarchy, "imports"));
  expect(importJobs.status).toBe(200);
  expect(importJobs.body.items).toHaveLength(1);
  expect(importJobs.body.items[0]?.uploads[0]?.columnResolutions).toContainEqual({
    sheetName: "Sheet1",
    columnIndex: 3,
    resolvedName: "环境",
    deleteColumn: true,
  });
  const imported = await browserJson<{
    caseId: string;
    data: Record<string, unknown>;
  }>(page, ddtPath(hierarchy, `cases/${encodeURIComponent(`DUPLICATE-${hierarchy.suffix}`)}`));
  expect(imported.status).toBe(200);
  expect(imported.body.data).toMatchObject({ 环境: "test" });
  expect(imported.body.data).not.toHaveProperty("目标环境");
  expect(Object.values(imported.body.data)).not.toContain("production");
});

test("DDT workspace imports, edits, validates and recovers version-scoped cases", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);
  const executionClassName = `com.example.DdtExecution${Date.now()}Test`;
  const executionClass = await importExecutionClass(page, hierarchy, executionClassName);
  const suite = await createDdtSuite(page, hierarchy, executionClass.id);

  await page.goto("/cases?tab=testng");
  const testngSearch = page.getByLabel("页内搜索用例");
  await testngSearch.fill(executionClassName);
  await expect(testngSearch).toHaveValue(executionClassName);
  const casePageDocumentRequests: string[] = [];
  const observeCasePageReload = (request: Request) => {
    if (new URL(request.url()).pathname === "/cases" && request.resourceType() === "document") {
      casePageDocumentRequests.push(request.url());
    }
  };
  page.on("request", observeCasePageReload);
  await page.getByRole("link", { name: "DDT 管理" }).click();
  await expect(page.getByText("CaseID 在当前项目版本与测试阶段内唯一")).toBeVisible();
  await page.getByRole("link", { name: "TestNG 用例" }).click();
  await expect(testngSearch).toHaveValue(executionClassName);
  await page.getByRole("link", { name: "DDT 管理" }).click();
  page.off("request", observeCasePageReload);
  expect(casePageDocumentRequests).toEqual([]);
  await expect(page.getByRole("link", { name: "DDT 管理" })).toHaveClass(/active/u);
  await expect(page.getByText("CaseID 在当前项目版本与测试阶段内唯一")).toBeVisible();

  await page.getByRole("button", { name: "导入表格" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入 DDT 用例" });
  const workbook = buildExportWorkbook([
    {
      CaseID: `LOGIN-${hierarchy.suffix}`,
      srNum: "AUTH",
      username: "alice",
      expected: "success",
    },
    {
      CaseID: `ORDER-${hierarchy.suffix}`,
      srNum: "ORDER",
      用户旅程: {
        step1: {
          CaseID: `ORDER-${hierarchy.suffix}`,
          srNum: "ORDER",
          action: "create",
        },
        step2: {
          CaseID: `ORDER-${hierarchy.suffix}`,
          srNum: "ORDER",
          action: "pay",
        },
      },
    },
  ]);
  const workbookFile = {
    name: `ddt-${hierarchy.suffix}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  };
  const dropzone = importDialog.locator(".ddt-dropzone");
  await dispatchFileDrag(dropzone, "dragenter", workbookFile);
  await expect(dropzone).toHaveClass(/drag-active/u);
  await expect(dropzone.getByText("松开即可添加文件")).toBeVisible();
  await dispatchFileDrag(dropzone, "drop", workbookFile);
  await expect(dropzone).not.toHaveClass(/drag-active/u);
  await expect(importDialog.getByText(`ddt-${hierarchy.suffix}.xlsx`)).toBeVisible();
  const previewRoute = "**/api/v1/ddt/imports/preview?**";
  const delayPreview = async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  };
  await page.route(previewRoute, delayPreview);
  await importDialog.getByRole("button", { name: "开始预检" }).click();
  await expect(importDialog.getByRole("progressbar")).toBeVisible();
  await expect(importDialog.locator(".ui-operation-progress")).toContainText(/上传|解析并预检/u);
  await expect(importDialog.getByText("2", { exact: true }).first()).toBeVisible();
  await page.unroute(previewRoute, delayPreview);
  await expect(importDialog.getByText("覆盖并保留历史")).toBeVisible();
  await importDialog.getByRole("button", { name: "确认并后台导入" }).click();

  await expect(page.locator(".ddt-status.succeeded", { hasText: "已完成" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: "用例" }).click();
  await expect(
    page.getByRole("button", { name: `LOGIN-${hierarchy.suffix}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("用户旅程", { exact: true })).toBeVisible();

  const orderCaseId = `ORDER-${hierarchy.suffix}`;
  await page.getByLabel(`选择 ${orderCaseId}`).check();
  await page.getByRole("button", { name: "设置执行类" }).click();
  const executionClassDialog = page.getByRole("dialog", { name: /设置 1 条 DDT 用例的执行类/u });
  await executionClassDialog.getByLabel(executionClassName, { exact: false }).check();
  await executionClassDialog.getByRole("button", { name: "保存执行类" }).click();
  await expect(
    page.getByText(`已将 1 条 DDT 用例的执行类设置为 ${executionClassName}。`),
  ).toBeVisible();

  await page.getByLabel(`选择 ${orderCaseId}`).check();
  await page.getByRole("button", { name: "加入用例任务" }).click();
  const suiteDialog = page.getByRole("dialog", { name: /将 1 条 DDT 用例加入任务/u });
  await suiteDialog.getByLabel("目标用例任务").selectOption(suite.id);
  await suiteDialog.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByText(`已将 1 条 DDT 用例加入任务“${suite.name}”。`)).toBeVisible();

  const suiteDetails = await browserJson<{
    caseCount: number;
    items: Array<{ caseDefinition: { className: string } }>;
    ddtItems: Array<{
      ddtCase: { caseId: string; srNum: string; executionClass?: { className: string } };
    }>;
  }>(page, `/api/v1/case-suites/${encodeURIComponent(suite.id)}`);
  expect(suiteDetails.status).toBe(200);
  expect(suiteDetails.body).toMatchObject({
    caseCount: 2,
    items: [{ caseDefinition: { className: executionClassName } }],
    ddtItems: [
      {
        ddtCase: {
          caseId: orderCaseId,
          srNum: "ORDER",
          executionClass: { className: executionClassName },
        },
      },
    ],
  });
  await page.goto(`/case-suites/${encodeURIComponent(suite.id)}`);
  await expect(page.getByText("普通用例", { exact: true })).toBeVisible();
  await expect(page.getByText("DDT 用例", { exact: true })).toBeVisible();
  await page.getByText("com.example", { exact: true }).click();
  await page.getByText("SR · ORDER", { exact: true }).click();
  await expect(page.getByText(orderCaseId, { exact: true })).toBeVisible();
  await expect(page.getByText(executionClassName, { exact: true })).toHaveCount(2);

  await page.goto("/cases?tab=ddt");
  await page.getByRole("tab", { name: "用例" }).click();

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
  }

  await page.getByRole("button", { name: `LOGIN-${hierarchy.suffix}`, exact: true }).click();
  const caseDrawer = page.getByRole("dialog", { name: `LOGIN-${hierarchy.suffix}` });
  await expect(caseDrawer.getByText("username", { exact: true })).toBeVisible();
  await caseDrawer.getByRole("button", { name: "编辑动态字段" }).click();
  await caseDrawer.getByLabel("用例数据 JSON").fill(
    JSON.stringify(
      {
        CaseID: `LOGIN-${hierarchy.suffix}`,
        srNum: "AUTH",
        username: "alice",
        expected: "success",
        owner: "quality-team",
      },
      null,
      2,
    ),
  );
  const ddtCaseMutationUrl = `**/api/v1/ddt/cases/${encodeURIComponent(`LOGIN-${hierarchy.suffix}`)}?**`;
  let conflictServed = false;
  await page.route(ddtCaseMutationUrl, async (route) => {
    if (route.request().method() !== "PATCH" || conflictServed) {
      await route.fallback();
      return;
    }
    conflictServed = true;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "DDT_CASE_REVISION_CONFLICT",
          message: "DDT 用例已被他人修改，请刷新后重试。",
          requestId: "ddt-case-conflict-e2e",
        },
      }),
    });
  });
  await caseDrawer.getByRole("button", { name: "保存修改" }).click();
  const conflictDialog = page.getByRole("dialog", { name: "DDT 用例已被其他人修改" });
  await expect(conflictDialog).toBeVisible();
  await expectUiIntegrity(page);
  await conflictDialog.getByRole("button", { name: "暂不重新加载" }).click();
  await expect(caseDrawer.getByLabel("用例数据 JSON")).toHaveValue(/quality-team/u);
  await caseDrawer.getByRole("button", { name: "保存修改" }).click();
  await page.unroute(ddtCaseMutationUrl);
  await expect(page.getByText(`已保存 LOGIN-${hierarchy.suffix}`)).toBeVisible();
  await expect(caseDrawer.getByText("quality-team", { exact: true })).toBeVisible();
  await expect(caseDrawer.getByText("人工编辑", { exact: true })).toBeVisible();
  await caseDrawer.getByRole("button", { name: "关闭用例详情" }).click();

  await page.getByRole("tab", { name: "字段模板" }).click();
  await page.getByRole("button", { name: "新建模板" }).click();
  const templateDialog = page.getByRole("dialog", { name: "新建字段模板" });
  await templateDialog.getByLabel("srNum").fill("AUTH");
  await templateDialog.getByLabel("模板名称").fill("认证用例字段");
  await templateDialog.getByLabel("字段 1 名称").fill("owner");
  await templateDialog.getByLabel("必填").check();
  await templateDialog.getByRole("button", { name: "创建模板" }).click();
  await expect(page.getByText("认证用例字段", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "用例" }).click();
  await page.getByLabel(`选择 LOGIN-${hierarchy.suffix}`).check();
  await page.getByRole("button", { name: "批量修改" }).click();
  const bulkDialog = page.getByRole("dialog", { name: /批量修改 1 条用例/u });
  await bulkDialog.getByLabel("字段名").fill("owner");
  await bulkDialog.getByLabel("新值").fill("release-team");
  await bulkDialog.getByRole("button", { name: "应用修改" }).click();
  await expect(bulkDialog).toBeHidden();

  await page.getByLabel(`选择 LOGIN-${hierarchy.suffix}`).check();
  const deleteRoute = "**/api/v1/ddt/cases/bulk-delete?**";
  const delayDelete = async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  };
  await page.route(deleteRoute, delayDelete);
  await page.getByRole("button", { name: "移入回收站" }).click();
  await acceptSystemDialog(page, "删除 DDT 用例", "移入回收站");
  await expect(page.getByRole("progressbar", { name: "正在移入回收站进度" })).toBeVisible();
  await expect(page.getByText("已处理 0 / 1 条用例")).toBeVisible();
  await expect(page.getByText(`已将 1 条用例移入回收站。`)).toBeVisible();
  await page.unroute(deleteRoute, delayDelete);
  await page.getByRole("tab", { name: /回收站/u }).click();
  const deletedRow = page.getByRole("row", { name: new RegExp(`LOGIN-${hierarchy.suffix}`) });
  await expect(deletedRow).toBeVisible();
  await deletedRow.getByRole("button", { name: "恢复" }).click();
  await page.getByRole("tab", { name: "用例" }).click();
  await expect(
    page.getByRole("button", { name: `LOGIN-${hierarchy.suffix}`, exact: true }),
  ).toBeVisible();

  const apiResult = await browserJson<{
    caseId: string;
    revision: number;
    data: Record<string, unknown> & { owner?: string };
  }>(page, ddtPath(hierarchy, `cases/${encodeURIComponent(`LOGIN-${hierarchy.suffix}`)}`));
  expect(apiResult.status).toBe(200);
  expect(apiResult.body.data.owner).toBe("release-team");

  const apiToken = await issueDdtApiToken(page, hierarchy.projectId);
  const tokenHeaders = { authorization: `Bearer ${apiToken}` };
  const tokenRead = await page.request.get(
    ddtPath(hierarchy, `cases/${encodeURIComponent(`LOGIN-${hierarchy.suffix}`)}`),
    { headers: tokenHeaders },
  );
  expect(tokenRead.status()).toBe(200);
  const tokenUpdate = await page.request.patch(
    ddtPath(hierarchy, `cases/${encodeURIComponent(`LOGIN-${hierarchy.suffix}`)}`),
    {
      headers: tokenHeaders,
      data: {
        expectedRevision: apiResult.body.revision,
        data: { ...apiResult.body.data, owner: "api-automation" },
      },
    },
  );
  expect(tokenUpdate.status()).toBe(200);

  const isolatedVersion = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${hierarchy.projectId}/versions`,
    { method: "POST", body: { name: "DDT isolated version" } },
  );
  expect(isolatedVersion.status).toBe(201);
  const isolatedStage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${hierarchy.projectId}/versions/${isolatedVersion.body.id}/stages`,
    { method: "POST", body: { name: "DDT isolated stage", description: "scope guard" } },
  );
  expect(isolatedStage.status).toBe(201);
  const isolatedRead = await page.request.get(
    ddtPath(
      { ...hierarchy, versionId: isolatedVersion.body.id, stageId: isolatedStage.body.id },
      `cases/${encodeURIComponent(`LOGIN-${hierarchy.suffix}`)}`,
    ),
    { headers: tokenHeaders },
  );
  expect(isolatedRead.status()).toBe(404);
});

async function dispatchFileDrag(
  dropzone: Locator,
  eventType: "dragenter" | "drop",
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await dropzone.evaluate(
    (element, payload) => {
      const binary = window.atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], payload.name, { type: payload.mimeType }));
      element.dispatchEvent(
        new DragEvent(payload.eventType, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    },
    {
      eventType,
      name: file.name,
      mimeType: file.mimeType,
      base64: file.buffer.toString("base64"),
    },
  );
}

async function issueDdtApiToken(page: Page, projectId: string): Promise<string> {
  const permissions = ["case.read", "case.manage"];
  const account = await browserJson<{ id: string }>(page, "/api/v1/service-accounts", {
    method: "POST",
    body: {
      name: uniqueName("ddt-api"),
      description: "DDT authenticated API E2E",
      projectPermissions: { [projectId]: permissions },
    },
  });
  expect(account.status).toBe(201);
  const token = await browserJson<{ token: string }>(
    page,
    `/api/v1/service-accounts/${encodeURIComponent(account.body.id)}/tokens`,
    {
      method: "POST",
      body: {
        name: "ddt-api-e2e",
        scopes: permissions,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  );
  expect(token.status).toBe(201);
  expect(token.body.token).toMatch(/^af_api_/u);
  return token.body.token;
}

async function createHierarchy(page: Page) {
  const suffix = uniqueName("ddt");
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: `DDT project ${suffix}`, slug: suffix },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions`,
    { method: "POST", body: { name: "DDT 1.1" } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "DDT 验收", description: "DDT E2E" } },
  );
  expect(stage.status).toBe(201);
  return { suffix, projectId: project.body.id, versionId: version.body.id, stageId: stage.body.id };
}

async function importExecutionClass(
  page: Page,
  hierarchy: { projectId: string; versionId: string; stageId: string; suffix: string },
  className: string,
): Promise<{ id: string }> {
  const jar = zipSync({
    [`${className.replaceAll(".", "/")}.class`]: buildClassFile({
      className,
      methods: [
        {
          name: "executeDdtCase",
          annotations: [{ type: "Test", values: { groups: ["ddt"] } }],
        },
      ],
    }),
  });
  await page.goto(
    `/cases/import?${new URLSearchParams({
      projectId: hierarchy.projectId,
      projectVersionId: hierarchy.versionId,
      testStageId: hierarchy.stageId,
    }).toString()}`,
  );
  const fileName = `ddt-execution-${hierarchy.suffix}.jar`;
  await selectJarForInspection(page, {
    name: fileName,
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText(className)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/u, {
    timeout: 60_000,
  });
  const sources = await browserJson<{
    items: Array<{ id: string; originalFileName: string }>;
  }>(
    page,
    `/api/v1/case-sources?${new URLSearchParams({
      projectId: hierarchy.projectId,
      projectVersionId: hierarchy.versionId,
      testStageId: hierarchy.stageId,
      limit: "200",
    }).toString()}`,
  );
  const source = sources.body.items.find((item) => item.originalFileName === fileName);
  expect(source).toBeTruthy();
  const authoritative = await browserJson(
    page,
    `/api/v1/case-sources/${encodeURIComponent(source!.id)}/authoritative`,
    { method: "PUT", body: { authoritative: true } },
  );
  expect(authoritative.status).toBe(200);
  const definitions = await browserJson<{
    items: Array<{ id: string; className: string }>;
  }>(
    page,
    `/api/v1/case-definitions?${new URLSearchParams({
      projectId: hierarchy.projectId,
      projectVersionId: hierarchy.versionId,
      testStageId: hierarchy.stageId,
      query: className,
      limit: "100",
    }).toString()}`,
  );
  const definition = definitions.body.items.find((item) => item.className === className);
  expect(definition).toBeTruthy();
  return definition!;
}

async function createDdtSuite(
  page: Page,
  hierarchy: { projectId: string; versionId: string; suffix: string },
  caseDefinitionId: string,
): Promise<{ id: string; name: string }> {
  const name = `DDT mixed suite ${hierarchy.suffix}`;
  const suite = await browserJson<{ id: string; name: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: hierarchy.projectId,
      projectVersionId: hierarchy.versionId,
      name,
    },
  });
  expect(suite.status).toBe(201);
  const addition = await browserJson(
    page,
    `/api/v1/case-suites/${encodeURIComponent(suite.body.id)}/cases`,
    { method: "POST", body: { caseDefinitionIds: [caseDefinitionId] } },
  );
  expect(addition.status).toBe(200);
  return { id: suite.body.id, name };
}

function ddtPath(
  hierarchy: { projectId: string; versionId: string; stageId: string },
  path: string,
): string {
  const query = new URLSearchParams({
    projectId: hierarchy.projectId,
    projectVersionId: hierarchy.versionId,
    testStageId: hierarchy.stageId,
  });
  return `/api/v1/ddt/${path}?${query.toString()}`;
}

async function captureDdtUi(page: Page, name: string): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  const directory = resolve(screenshotDirectory);
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${name}.png`),
    fullPage: false,
    animations: "disabled",
  });
}
