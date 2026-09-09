import { randomUUID } from "node:crypto";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { configureTaskExecution } from "./support/task-execution";
import { associateDdtSr } from "./support/ddt-associations";
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
  await expect(conflictDialog).toContainText("1 个文件 · 1 组冲突 · 2 个重复列");
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
  await expect(conflictDialog.getByRole("alert")).toContainText("仍然重复");
  await expectBelow(
    conflictDialog.locator(".ddt-column-conflict-list"),
    conflictDialog.getByRole("alert"),
  );
  await expect(conflictDialog.locator(".ddt-column-resolution-summary")).toBeHidden();
  await expect(conflictDialog.getByRole("button", { name: "应用并重新预检" })).toBeDisabled();
  await firstColumn.fill("测试环境");
  await columnChoices.nth(0).getByRole("button", { name: "仅保留此列" }).click();
  await expect(firstColumn).toHaveValue("测试环境");
  const firstDelete = conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 删除第 3 列 环境`);
  const secondDelete = conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 删除第 4 列 环境`);
  await firstDelete.check();
  await secondDelete.check();
  await expect(conflictDialog.getByRole("alert")).toContainText("至少需要保留一列");
  await firstDelete.uncheck();
  await expect(secondDelete).toBeChecked();
  await expect(secondColumn).toBeDisabled();
  await expect(columnChoices.nth(1)).toContainText("该列将在导入时忽略");
  await expect(conflictDialog.getByRole("alert")).toBeHidden();

  await conflictDialog.getByRole("button", { name: "暂不处理" }).click();
  await expect(conflictDialog).toBeHidden();
  await expect(importDialog.getByRole("button", { name: "确认并后台导入" })).toBeDisabled();
  await expectBelow(
    importDialog.locator(".ddt-preview-files"),
    importDialog.locator(".ddt-column-conflict-notice"),
  );
  for (const width of [1536, 1024]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-import-conflict-notice-${width}`);
  }
  await importDialog.getByRole("button", { name: "处理重复列名" }).click();
  await expect(firstColumn).toHaveValue("测试环境");
  await expect(secondDelete).toBeChecked();
  await page.setViewportSize({ width: 1536, height: 960 });
  await captureDdtUi(page, "ddt-duplicate-column-resolution-1536");
  await page.setViewportSize({ width: 1024, height: 768 });
  await captureDdtUi(page, "ddt-duplicate-column-resolution-1024");
  await expectUiIntegrity(page);

  let releaseResolution!: () => void;
  const resolutionMayFinish = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  await page.route(
    "**/imports/*/resolve-columns?*",
    async (route) => {
      await resolutionMayFinish;
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "PLATFORM_BUSY",
            message: "平台暂时繁忙，请重试。",
            requestId: "ddt-resolution-retry",
          },
        },
      });
    },
    { times: 1 },
  );
  try {
    await conflictDialog.getByRole("button", { name: "应用并重新预检" }).click();
    await expect(conflictDialog.locator(".ui-operation-progress")).toContainText(
      "正在应用并重新预检",
    );
    await expect(firstColumn).toBeDisabled();
    await expect(firstDelete).toBeDisabled();
    await expect(conflictDialog.getByRole("button", { name: "关闭弹窗" })).toBeDisabled();
    await expect(conflictDialog.getByRole("button", { name: "全部按建议改名" })).toBeDisabled();
  } finally {
    releaseResolution();
  }
  await expect(conflictDialog.getByRole("alert")).toContainText("平台暂时繁忙，请重试。");
  await expectBelow(
    conflictDialog.locator(".ddt-column-conflict-list"),
    conflictDialog.getByRole("alert"),
  );
  await expect(firstColumn).toHaveValue("测试环境");
  await expect(firstColumn).toBeEnabled();
  await expect(secondDelete).toBeChecked();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-column-resolution-retry-${width}`);
  }
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
  expect(imported.body.data).toEqual({
    CaseID: `DUPLICATE-${hierarchy.suffix}`,
    srNum: "CORE",
    测试环境: "test",
  });
});

test("DDT ZIP import resolves conflicts in multiple archive entries", async ({ page }) => {
  test.setTimeout(120_000);
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);
  await page.goto("/cases?tab=ddt");

  await page.getByRole("button", { name: "导入表格" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入 DDT 用例" });
  const archiveName = `ddt-column-conflicts-${hierarchy.suffix}.zip`;
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: archiveName,
    mimeType: "application/zip",
    buffer: Buffer.from(
      zipSync({
        "支付/冲突一.csv": new TextEncoder().encode(
          `CaseID,srNum,环境,环境\nZIP-A-${hierarchy.suffix},PAY,test,production\n`,
        ),
        "订单/冲突二.csv": new TextEncoder().encode(
          `CaseID,srNum,负责人,负责人\nZIP-B-${hierarchy.suffix},ORDER,alice,bob\n`,
        ),
        "正常.csv": new TextEncoder().encode(
          `CaseID,srNum,场景\nZIP-C-${hierarchy.suffix},CORE,健康检查\n`,
        ),
      }),
    ),
  });
  await importDialog.getByRole("button", { name: "开始预检" }).click();

  const conflictDialog = page.getByRole("dialog", { name: "解决重复列名" });
  await expect(conflictDialog).toBeVisible();
  await expect(conflictDialog).toContainText("2 个文件 · 2 组冲突 · 4 个重复列");
  await expect(conflictDialog).toContainText("支付/冲突一.csv");
  await expect(conflictDialog).toContainText("订单/冲突二.csv");
  await expect(conflictDialog.getByText(archiveName, { exact: false }).first()).toBeVisible();
  for (const viewport of [
    { width: 1536, height: 960 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-zip-column-resolution-${viewport.width}`);
  }
  const lastGroup = conflictDialog.locator(".ddt-column-conflict-list > section").last();
  const lastColumnName = lastGroup.getByRole("textbox").last();
  await lastColumnName.scrollIntoViewIfNeeded();
  await expect(lastColumnName).toBeInViewport();
  await expect(conflictDialog.getByRole("button", { name: "应用并重新预检" })).toBeInViewport();
  await captureDdtUi(page, "ddt-zip-column-resolution-last-group-1024");
  await conflictDialog.getByRole("button", { name: "应用并重新预检" }).click();

  await expect(conflictDialog).toBeHidden();
  await expect(importDialog.locator(".ddt-preview-summary")).toContainText("3 / 3");
  await expect(importDialog.locator(".ddt-preview-files")).toContainText("支付/冲突一.csv");
  await expect(importDialog.locator(".ddt-preview-files")).toContainText("订单/冲突二.csv");
  await expect(importDialog.locator(".ddt-preview-files")).toContainText("正常.csv");
  await importDialog.getByRole("button", { name: "确认并后台导入" }).click();

  await expect(page.locator(".ddt-status.succeeded", { hasText: "已完成" })).toBeVisible({
    timeout: 30_000,
  });
  const expectedImportedData = new Map<string, Record<string, unknown>>([
    ["ZIP-A", { 环境: "test", 环境_2: "production" }],
    ["ZIP-B", { 负责人: "alice", 负责人_2: "bob" }],
    ["ZIP-C", { 场景: "健康检查" }],
  ]);
  for (const [caseId, expectedData] of expectedImportedData) {
    const imported = await browserJson<{ data: Record<string, unknown> }>(
      page,
      ddtPath(hierarchy, `cases/${encodeURIComponent(`${caseId}-${hierarchy.suffix}`)}`),
    );
    expect(imported.status).toBe(200);
    expect(imported.body.data).toMatchObject(expectedData);
  }
});

test("DDT conflict resolution preserves identity choices when renaming reveals another conflict", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);
  await page.goto("/cases?tab=ddt");
  await page.getByRole("button", { name: "导入表格" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入 DDT 用例" });
  const fileName = `identity-conflicts-${hierarchy.suffix}.csv`;
  const caseId = `IDENTITY-${hierarchy.suffix}`;
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `CaseID,caseid,srNum,srnum,环境,环境,负责人\nwrong-id,${caseId},wrong-sr,CORE,test,production,alice\n`,
      "utf8",
    ),
  });
  await importDialog.getByRole("button", { name: "开始预检" }).click();
  const conflictDialog = page.getByRole("dialog", { name: "解决重复列名" });
  const groups = conflictDialog.locator(".ddt-column-conflict-list > section");
  await expect(groups).toHaveCount(3);
  const identityGroup = groups.filter({ has: page.getByText("“CaseID”重复", { exact: false }) });
  const srGroup = groups.filter({ has: page.getByText("“srNum”重复", { exact: false }) });
  await identityGroup
    .locator(".ddt-column-choice")
    .nth(1)
    .getByRole("button", { name: "仅保留此列" })
    .click();
  await srGroup
    .locator(".ddt-column-choice")
    .nth(1)
    .getByRole("button", { name: "仅保留此列" })
    .click();
  await expect(conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 第 2 列的新列名`)).toHaveValue(
    "CaseID",
  );
  const srName = conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 第 4 列的新列名`);
  await expect(srName).toHaveValue("srNum");
  await srName.fill("业务组");
  await expect(conflictDialog.getByRole("alert")).toContainText("必须保留一列名为 srNum");
  await expect(conflictDialog.getByRole("button", { name: "应用并重新预检" })).toBeDisabled();
  await srName.fill("srNum");
  await conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 第 6 列的新列名`).fill("负责人");
  await conflictDialog.getByRole("button", { name: "应用并重新预检" }).click();
  await expect(groups).toHaveCount(1);
  await expect(groups).toContainText("负责人");
  await expect(conflictDialog.getByLabel(`${fileName} Sheet1 Sheet 第 7 列的新列名`)).toHaveValue(
    "负责人_2",
  );
  await conflictDialog.getByRole("button", { name: "应用并重新预检" }).click();
  await expect(conflictDialog).toBeHidden();
  await expect(importDialog.locator(".ddt-preview-summary")).toContainText("1 / 1");
  await importDialog.getByRole("button", { name: "确认并后台导入" }).click();
  await expect(page.locator(".ddt-status.succeeded", { hasText: "已完成" })).toBeVisible({
    timeout: 30_000,
  });
  const imported = await browserJson<{ data: Record<string, unknown> }>(
    page,
    ddtPath(hierarchy, `cases/${encodeURIComponent(caseId)}`),
  );
  expect(imported.status).toBe(200);
  expect(imported.body.data).toEqual({
    CaseID: caseId,
    srNum: "CORE",
    环境: "test",
    负责人: "production",
    负责人_2: "alice",
  });
  const jobs = await browserJson<{ items: Array<{ id: string }> }>(
    page,
    ddtPath(hierarchy, "imports"),
  );
  expect(jobs.body.items).toHaveLength(1);
});

test("DDT CaseID conflict strategies preserve existing data and report the outcome", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);
  await page.goto("/cases?tab=ddt");
  const existingCaseId = `EXISTING-${hierarchy.suffix}`;
  const addedCaseId = `ADDED-${hierarchy.suffix}`;
  const originalData = { CaseID: existingCaseId, srNum: "CORE", 环境: "original" };

  const submitImport = async (fileName: string, csv: string, strategy: string) => {
    await page.getByRole("button", { name: "导入表格", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "导入 DDT 用例" });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
    });
    await dialog.getByRole("button", { name: "开始预检" }).click();
    if (fileName !== "original.csv") {
      const conflicts = page.getByRole("dialog", { name: "解决重复列名" });
      await conflicts.getByRole("button", { name: "应用并重新预检" }).click();
      await expect(conflicts).toBeHidden();
      await expect(dialog.locator(".ddt-preview-summary")).toContainText("预计更新1");
    }
    await dialog.getByRole("radio", { name: strategy, exact: true }).check();
    const confirmation = page.waitForResponse(
      (response) => response.url().includes("/confirm?") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "确认并后台导入" }).click();
    const response = await confirmation;
    expect(response.status()).toBe(200);
    const job = (await response.json()) as { id: string };
    await expect(dialog).toBeHidden();
    return job.id;
  };
  const waitForImport = async (id: string, status: "succeeded" | "failed") => {
    await expect
      .poll(
        async () => {
          const response = await browserJson<{ status: string }>(
            page,
            ddtPath(hierarchy, `imports/${id}`),
          );
          expect(response.status).toBe(200);
          return response.body.status;
        },
        { timeout: 30_000 },
      )
      .toBe(status);
  };
  const readCase = (caseId: string) =>
    browserJson<{ data: Record<string, unknown> }>(
      page,
      ddtPath(hierarchy, `cases/${encodeURIComponent(caseId)}`),
    );
  const originalJob = await submitImport(
    "original.csv",
    `CaseID,srNum,环境\n${existingCaseId},CORE,original\n`,
    "覆盖并保留历史",
  );
  await waitForImport(originalJob, "succeeded");
  const replacementCsv = `CaseID,srNum,环境,环境\n${addedCaseId},CORE,new,secondary\n${existingCaseId},CORE,replaced,production\n`;

  const rejectedJob = await submitImport("conflict-error.csv", replacementCsv, "遇到冲突终止");
  await waitForImport(rejectedJob, "failed");
  expect((await readCase(existingCaseId)).body.data).toEqual(originalData);
  expect((await readCase(addedCaseId)).status).toBe(404);
  const failedCard = page
    .locator(".ddt-job")
    .filter({ has: page.getByText("conflict-error.csv", { exact: true }) });
  await expect(failedCard).toContainText("当前范围已存在相同 CaseID");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-case-id-conflict-${width}`);
  }

  const skippedJob = await submitImport("conflict-skip.csv", replacementCsv, "跳过已有用例");
  await waitForImport(skippedJob, "succeeded");
  expect((await readCase(existingCaseId)).body.data).toEqual(originalData);
  expect((await readCase(addedCaseId)).body.data).toEqual({
    CaseID: addedCaseId,
    srNum: "CORE",
    环境: "new",
    环境_2: "secondary",
  });
  const skippedCard = page
    .locator(".ddt-job")
    .filter({ has: page.getByText("conflict-skip.csv", { exact: true }) });
  await expect(skippedCard.locator(".ddt-job-results")).toContainText("跳过 1");

  const replacedJob = await submitImport(
    "conflict-overwrite.csv",
    `CaseID,srNum,环境,环境\n${existingCaseId},CORE,replaced,production\n`,
    "覆盖并保留历史",
  );
  await waitForImport(replacedJob, "succeeded");
  const replacementData = {
    CaseID: existingCaseId,
    srNum: "CORE",
    环境: "replaced",
    环境_2: "production",
  };
  expect((await readCase(existingCaseId)).body.data).toEqual(replacementData);
  const history = await browserJson<{
    items: Array<{
      changeType: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>;
  }>(page, ddtPath(hierarchy, `cases/${encodeURIComponent(existingCaseId)}/history`));
  expect(history.status).toBe(200);
  expect(history.body.items).toHaveLength(1);
  expect(history.body.items[0]).toMatchObject({
    changeType: "import_overwrite",
    before: originalData,
    after: replacementData,
  });
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
  await associateDdtSr(page, "ORDER", executionClassName);

  await page.getByLabel(`选择 ${orderCaseId}`).check();
  // Returning to the browser must not poll a hidden TestNG panel or clear DDT selection.
  const hiddenPanelRequests: string[] = [];
  const observeHiddenPanelRequest = (request: Request) => {
    if (new URL(request.url()).pathname === "/api/v1/read-models/status")
      hiddenPanelRequests.push(request.url());
  };
  page.on("request", observeHiddenPanelRequest);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(hiddenPanelRequests).toEqual([]);
  page.off("request", observeHiddenPanelRequest);
  await expect(page.getByLabel(`选择 ${orderCaseId}`)).toBeChecked();
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
  const caseDetail = page.getByRole("region", { name: "DDT 用例详情" });
  await expect(page.locator(".ddt-case-browser")).toBeVisible();
  await expect(page.locator(".ddt-case-navigation")).toBeVisible();
  await expect(page.getByRole("dialog", { name: `LOGIN-${hierarchy.suffix}` })).toHaveCount(0);
  await expect(caseDetail.getByText("username", { exact: true })).toBeVisible();
  await caseDetail.getByRole("button", { name: "编辑动态字段" }).click();
  await caseDetail.getByLabel("用例数据 JSON").fill(
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
  await caseDetail.getByRole("button", { name: "保存修改" }).click();
  const conflictDialog = page.getByRole("dialog", { name: "DDT 用例已被其他人修改" });
  await expect(conflictDialog).toBeVisible();
  await expectUiIntegrity(page);
  await conflictDialog.getByRole("button", { name: "暂不重新加载" }).click();
  await expect(caseDetail.getByLabel("用例数据 JSON")).toHaveValue(/quality-team/u);
  await caseDetail.getByRole("button", { name: "保存修改" }).click();
  await page.unroute(ddtCaseMutationUrl);
  await expect(page.getByText(`已保存 LOGIN-${hierarchy.suffix}`)).toBeVisible();
  await expect(caseDetail.getByText("quality-team", { exact: true })).toBeVisible();
  await expect(caseDetail.getByText("人工编辑", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: orderCaseId, exact: true }).click();
  await expect(caseDetail.getByRole("heading", { name: orderCaseId, exact: true })).toBeVisible();
  await caseDetail.getByRole("tab", { name: "step2", exact: true }).click();
  await expect(caseDetail.locator(".ddt-field-card", { hasText: "action" })).toContainText("pay");
  await caseDetail.getByRole("button", { name: "编辑字段 action", exact: true }).click();
  await caseDetail.getByLabel("action 的值").fill("paid");
  await caseDetail.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(caseDetail.locator(".ddt-field-card", { hasText: "action" })).toContainText("paid");
  await caseDetail.getByRole("button", { name: "编辑字段 srNum", exact: true }).click();
  await caseDetail.getByLabel("srNum 的值").fill("ORDER-UPDATED");
  await caseDetail.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    caseDetail.getByRole("button", { name: "编辑字段 srNum", exact: true }),
  ).toBeEnabled();
  const journey = await browserJson<{
    data: { srNum: string; 用户旅程: Record<string, { srNum: string; action: string }> };
  }>(page, ddtPath(hierarchy, `cases/${encodeURIComponent(orderCaseId)}`));
  expect(journey.body.data).toMatchObject({
    srNum: "ORDER-UPDATED",
    用户旅程: {
      step1: { srNum: "ORDER-UPDATED", action: "create" },
      step2: { srNum: "ORDER-UPDATED", action: "paid" },
    },
  });
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await page.locator(".ddt-case-browser").scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-case-workspace-journey-${width}`);
    const navigation = await page.locator(".ddt-case-navigation").boundingBox();
    const detail = await caseDetail.boundingBox();
    expect(navigation!.x + navigation!.width).toBeLessThanOrEqual(detail!.x);
  }

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

test("DDT split workspace loads details on demand and keeps field edits and navigation consistent", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);
  await page.goto("/cases?tab=ddt");
  await page.getByRole("button", { name: "导入表格" }).click();
  const dialog = page.getByRole("dialog", { name: "导入 DDT 用例" });
  const rows = Array.from({ length: 62 }, (_, index) => ({
    CaseID: `CASE-${String(index).padStart(3, "0")}`,
    srNum: index === 61 ? "PAYMENT" : "AUTH",
    描述:
      index === 0
        ? "验证登录后能够查看用户资料。预期返回完整的姓名、角色与访问权限。"
        : `用例 ${index}`,
    enabled: true,
    retries: 2,
  }));
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "workspace-cases.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: buildExportWorkbook(rows),
  });
  await dialog.getByRole("button", { name: "开始预检" }).click();
  await expect(dialog.getByRole("button", { name: "确认并后台导入" })).toBeEnabled();
  await dialog.getByRole("button", { name: "确认并后台导入" }).click();
  await expect(page.locator(".ddt-status.succeeded")).toBeVisible({ timeout: 30_000 });

  const numericCase = await browserJson<{ revision: number; data: Record<string, string> }>(
    page,
    ddtPath(hierarchy, "cases/CASE-000"),
  );
  const typedUpdate = await browserJson(page, ddtPath(hierarchy, "cases/CASE-000"), {
    method: "PATCH",
    body: {
      expectedRevision: numericCase.body.revision,
      data: { ...numericCase.body.data, retries: 2, enabled: true },
    },
  });
  expect(typedUpdate.status).toBe(200);

  const detailRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/ddt\/cases\/CASE-/u.test(new URL(request.url()).pathname))
      detailRequests.push(new URL(request.url()).pathname);
  });
  await page.getByRole("tab", { name: "用例", exact: true }).click();
  const workspace = page.locator(".ddt-case-browser");
  const details = page.getByRole("region", { name: "DDT 用例详情" });
  const navigation = page.getByRole("region", { name: "DDT 用例导航" });
  await expect(details.getByRole("heading", { name: "CASE-000", exact: true })).toBeVisible();
  await expect(navigation.locator(".ddt-case-list-row")).toHaveCount(60);
  expect(detailRequests).toHaveLength(2);
  expect(detailRequests.every((path) => path.includes("CASE-000"))).toBe(true);
  await expect(workspace.getByRole("table")).toHaveCount(0);
  await expectResponsiveDdtSidebar(page);
  expect(detailRequests).toHaveLength(2);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await workspace.scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-case-workspace-fields-${width}`);
  }

  await details.getByRole("button", { name: "编辑字段 描述", exact: true }).click();
  await details.getByLabel("描述 的值").fill("保存前切换用例仍应保留此草稿");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(details.getByLabel("描述 的值")).toHaveValue("保存前切换用例仍应保留此草稿");
  await page.setViewportSize({ width: 1536, height: 1024 });
  await navigation.getByRole("button", { name: "CASE-001", exact: true }).click();
  const discard = page.getByRole("dialog", { name: "放弃未保存的修改" });
  await discard.getByRole("button", { name: "继续编辑" }).click();
  await expect(details.getByLabel("描述 的值")).toHaveValue("保存前切换用例仍应保留此草稿");
  let releaseStatistics!: () => void;
  const statisticsMayFinish = new Promise<void>((resolve) => {
    releaseStatistics = resolve;
  });
  await page.route(
    "**/ddt/dashboard?*",
    async (route) => {
      await statisticsMayFinish;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await details.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(
      details.getByRole("button", { name: "编辑字段 retries", exact: true }),
    ).toBeEnabled();
    await expect(details.locator(".ddt-field-card", { hasText: "描述" })).toContainText(
      "保存前切换用例仍应保留此草稿",
    );
  } finally {
    releaseStatistics();
  }
  await details.getByRole("button", { name: "编辑字段 retries", exact: true }).click();
  await details.getByLabel("retries 的值").fill("not-a-number");
  await details.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(details.getByRole("alert")).toContainText("请输入有效的数字");
  await details.getByLabel("retries 的值").fill("4");
  await details.getByRole("button", { name: "保存修改", exact: true }).click();
  const stored = await browserJson<{ data: { retries: number; enabled: boolean; 描述: string } }>(
    page,
    ddtPath(hierarchy, "cases/CASE-000"),
  );
  expect(stored.body.data).toMatchObject({
    retries: 4,
    enabled: true,
    描述: "保存前切换用例仍应保留此草稿",
  });

  await details
    .locator(".ddt-history article")
    .last()
    .getByRole("button", { name: "恢复此版本" })
    .click();
  await expect(
    details.locator(".ddt-field-card", { hasText: "retries" }).locator("pre"),
  ).toHaveText("2");

  // A delayed response for an older selection must never replace the newer detail.
  let releaseOld!: () => void;
  const oldMayFinish = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldRequested = false;
  await page.route(
    "**/ddt/cases/CASE-001?*",
    async (route) => {
      const response = await route.fetch();
      oldRequested = true;
      await oldMayFinish;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await navigation.getByRole("button", { name: "CASE-001", exact: true }).click();
    await expect.poll(() => oldRequested).toBe(true);
    await navigation.getByRole("button", { name: "CASE-002", exact: true }).click();
    await expect(details.getByRole("heading", { name: "CASE-002", exact: true })).toBeVisible();
  } finally {
    releaseOld();
  }
  await expect(details.getByRole("heading", { name: "CASE-002", exact: true })).toBeVisible();
  await page.route(
    "**/ddt/cases/CASE-004?*",
    async (route) => {
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "PLATFORM_BUSY",
            message: "平台暂时繁忙，请重试。",
            requestId: "ddt-detail-retry",
          },
        },
      });
    },
    { times: 1 },
  );
  await navigation.getByRole("button", { name: "CASE-004", exact: true }).click();
  await expect(details.getByRole("alert")).toContainText("平台暂时繁忙");
  await expect(details.getByRole("heading", { name: "CASE-002", exact: true })).toHaveCount(0);
  await details.getByRole("button", { name: "重试读取用例" }).click();
  await expect(details.getByRole("heading", { name: "CASE-004", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "CASE-002", exact: true }).click();
  await navigation.getByRole("button", { name: "CASE-002", exact: true }).press("ArrowDown");
  await expect(details.getByRole("heading", { name: "CASE-003", exact: true })).toBeVisible();

  await navigation.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(navigation.locator(".ddt-case-list-row")).toHaveCount(62);
  await expect(navigation.getByRole("button", { name: "加载更多", exact: true })).toBeHidden();
  await selectDdtGroup(navigation, "PAYMENT");
  await expect(navigation.locator(".ddt-case-list-row")).toHaveCount(1);
  await expect(details.getByRole("heading", { name: "CASE-061", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/ddtGroup=PAYMENT/u);
  await page.reload();
  await expect(details.getByRole("heading", { name: "CASE-061", exact: true })).toBeVisible();
  await selectDdtGroup(navigation, "AUTH");
  await expect(details.getByRole("heading", { name: "CASE-000", exact: true })).toBeVisible();
  await details.getByRole("button", { name: "编辑字段 描述", exact: true }).click();
  await details.getByLabel("描述 的值").fill("浏览器后退保留草稿");
  await page.goBack();
  await page
    .getByRole("dialog", { name: "放弃未保存的修改" })
    .getByRole("button", { name: "继续编辑" })
    .click();
  await expect(details.getByLabel("描述 的值")).toHaveValue("浏览器后退保留草稿");
  await expect(page).toHaveURL(/ddtGroup=AUTH/u);
  await details.getByRole("button", { name: "取消", exact: true }).click();
  await selectDdtGroup(navigation, "PAYMENT");
  await selectDdtGroup(navigation, "AUTH");
  await page.goBack();
  await expect(details.getByRole("heading", { name: "CASE-061", exact: true })).toBeVisible();
  await navigation.getByLabel("搜索 DDT 用例").fill("DOES-NOT-EXIST");
  await expect(navigation.locator(".ddt-case-list-row")).toHaveCount(0);
  await expect(details.getByText("选择用例查看详情", { exact: true })).toBeVisible();
  await navigation.getByLabel("搜索 DDT 用例").fill("");
  await expect(details.getByRole("heading", { name: "CASE-061", exact: true })).toBeVisible();

  await navigation.locator(".ddt-advanced-filters > summary").click();
  await navigation.getByLabel("DDT 动态字段", { exact: true }).fill("描述");
  await navigation.getByLabel("动态字段值", { exact: true }).fill("用例 61");
  await expect(details.getByRole("heading", { name: "CASE-061", exact: true })).toBeVisible();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await workspace.scrollIntoViewIfNeeded();
    // The filter popover intentionally covers navigation rows; check its own bounds.
    const filterBounds = await navigation.locator(".ddt-advanced-filter-fields").boundingBox();
    const workspaceBounds = await workspace.boundingBox();
    expect(filterBounds!.x).toBeGreaterThanOrEqual(workspaceBounds!.x);
    expect(filterBounds!.x + filterBounds!.width).toBeLessThanOrEqual(
      workspaceBounds!.x + workspaceBounds!.width,
    );
    expect(filterBounds!.y + filterBounds!.height).toBeLessThanOrEqual(
      workspaceBounds!.y + workspaceBounds!.height,
    );
    await captureDdtUi(page, `ddt-case-workspace-filter-${width}`);
    await navigation.getByRole("button", { name: "动态字段匹配方式", exact: true }).click();
    await navigation.getByRole("option", { name: "小于等于", exact: true }).click();
    await navigation.getByRole("button", { name: "动态字段匹配方式", exact: true }).click();
    await navigation.getByRole("option", { name: "包含", exact: true }).click();
  }
  await navigation.getByLabel("DDT 动态字段", { exact: true }).fill("");
  await navigation.locator(".ddt-advanced-filters > summary").click();
  const resizer = workspace.getByRole("separator", { name: "调整 CaseID 列表宽度" });
  await resizer.focus();
  const previousWidth = Number(await resizer.getAttribute("aria-valuenow"));
  await resizer.press("ArrowRight");
  await expect(resizer).toHaveAttribute("aria-valuenow", String(previousWidth + 20));
  await navigation.getByRole("button", { name: "收起 CaseID 列表" }).click();
  await expect(navigation.locator(".ddt-case-navigation-content")).toBeHidden();
  await expect(details.getByRole("heading", { name: "CASE-061", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "展开 CaseID 列表" }).click();
  await navigation.getByLabel("选择 CASE-061", { exact: true }).check();
  await expect(details.getByRole("heading", { name: "已选择 1 条用例" })).toBeVisible();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await workspace.scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-case-workspace-selection-${width}`);
  }
  await details.getByRole("button", { name: "清空选择" }).click();
  await expect(details.getByRole("heading", { name: "CASE-061", exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

async function selectDdtGroup(navigation: Locator, group: string): Promise<void> {
  await navigation.getByRole("button", { name: "DDT 业务分组", exact: true }).click();
  await navigation.getByRole("option", { name: group, exact: true }).click();
}

async function expectResponsiveDdtSidebar(page: Page): Promise<void> {
  const workspace = page.locator(".ddt-case-browser");
  const navigation = page.getByRole("region", { name: "DDT 用例导航" });
  const sizes: Array<{ width: number; height: number }> = [];
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-responsive-sidebar-${viewport.width}`);
    const bounds = await workspace.boundingBox();
    expect(bounds).not.toBeNull();
    expect(
      bounds!.y + bounds!.height,
      "DDT workspace must fit the available viewport height",
    ).toBeLessThanOrEqual(viewport.height);
    const sidebar = await navigation.boundingBox();
    sizes.push({ width: sidebar!.width, height: sidebar!.height });
  }
  expect(sizes[1]!.width, "DDT sidebar must grow with its workspace").toBeGreaterThan(
    sizes[0]!.width + 40,
  );
  expect(sizes[2]!.width).toBeGreaterThan(sizes[1]!.width);
  expect(sizes[1]!.height).toBeGreaterThan(sizes[0]!.height);
  await page.setViewportSize({ width: 1536, height: 1024 });
  const resizer = workspace.getByRole("separator", { name: "调整 CaseID 列表宽度" });
  await expect(resizer).toHaveAttribute("aria-valuenow", String(Math.round(sizes[1]!.width)));
  const beforeDrag = Number(await resizer.getAttribute("aria-valuenow"));
  const handle = await resizer.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 20);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 60, handle!.y + 20);
  await page.mouse.up();
  await expect
    .poll(async () => Number(await resizer.getAttribute("aria-valuenow")))
    .toBeGreaterThan(beforeDrag + 40);
  const expandedWidth = Number(await resizer.getAttribute("aria-valuenow"));
  const expandedWorkspaceWidth = await workspace.evaluate((element) => element.clientWidth);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect
    .poll(async () => Number(await resizer.getAttribute("aria-valuenow")))
    .toBeLessThan(expandedWidth);
  const reducedWorkspaceWidth = await workspace.evaluate((element) => element.clientWidth);
  const reducedWidth = Number(await resizer.getAttribute("aria-valuenow"));
  expect(reducedWidth / reducedWorkspaceWidth).toBeCloseTo(
    expandedWidth / expandedWorkspaceWidth,
    2,
  );
  expect((await navigation.boundingBox())!.width).toBeCloseTo(reducedWidth, 0);
  await navigation.getByRole("button", { name: "收起 CaseID 列表" }).click();
  await page.setViewportSize({ width: 1536, height: 1024 });
  await expect(navigation.locator(".ddt-case-navigation-content")).toBeHidden();
  await navigation.getByRole("button", { name: "展开 CaseID 列表" }).click();
  await expect
    .poll(async () => Number(await resizer.getAttribute("aria-valuenow")))
    .toBe(expandedWidth);
  await resizer.press("Home");
  await expect
    .poll(async () => Number(await resizer.getAttribute("aria-valuenow")))
    .toBe(beforeDrag);
  await page
    .getByRole("navigation", { name: "用例类型" })
    .getByRole("link", { name: "TestNG 用例" })
    .click();
  await expect(workspace).toBeHidden();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page
    .getByRole("navigation", { name: "用例类型" })
    .getByRole("link", { name: "DDT 管理" })
    .click();
  await expect(workspace).toBeVisible();
  await expect.poll(async () => (await navigation.boundingBox())!.width).toBe(sizes[0]!.width);
  await page.setViewportSize({ width: 1536, height: 768 });
  await expect
    .poll(async () => (await workspace.boundingBox())!.height)
    .toBeLessThan(sizes[1]!.height - 200);
  await page.setViewportSize({ width: 1536, height: 1024 });
}

async function issueDdtApiToken(
  page: Page,
  projectId: string,
  permissions = ["case.read", "case.manage"],
): Promise<string> {
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

test("SR associations restrict candidates and automatically cover imported and moved DDT cases", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);
  const className = `com.example.SrExecution${Date.now()}Test`;
  const definition = await importExecutionClass(page, hierarchy, className);
  const caseIds = [`SR-A-${hierarchy.suffix}`, `SR-B-${hierarchy.suffix}`];
  const importRows = async (ids: string[]) => {
    await page.goto("/cases?tab=ddt");
    await page.getByRole("button", { name: "导入表格" }).click();
    const dialog = page.getByRole("dialog", { name: "导入 DDT 用例", exact: true });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: `sr-${ids.length}-${Date.now()}.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildExportWorkbook(
        ids.map((CaseID) => ({ CaseID, srNum: "PAYMENTS", description: "支付场景" })),
      ),
    });
    await dialog.getByRole("button", { name: "开始预检" }).click();
    await dialog.getByRole("button", { name: "确认并后台导入" }).click();
    await expect(page.locator(".ddt-status.succeeded").first()).toBeVisible({ timeout: 30_000 });
  };
  await importRows(caseIds);
  const rejected = await browserJson<{ error: { code: string } }>(
    page,
    ddtPath(hierarchy, "sr-mappings"),
    { method: "POST", body: { srNum: "PAYMENTS", className, expectedRevision: 0 } },
  );
  expect(rejected.status).toBe(400);
  expect(rejected.body.error.code).toBe("DDT_EXECUTION_CLASS_OUT_OF_RANGE");
  const oldEndpoint = await browserJson<{ error: { code: string } }>(
    page,
    ddtPath(hierarchy, "cases/execution-class"),
    { method: "POST", body: { caseIds: [caseIds[0]!], className } },
  );
  expect(oldEndpoint.body.error.code).toBe("DDT_SR_MAPPING_REQUIRED");
  await associateDdtSr(page, "PAYMENTS", className);
  await page.goto("/cases?tab=ddt&ddtView=cases");
  await page.getByRole("button", { name: `快速预览 ${caseIds[0]}`, exact: true }).click();
  const inspector = page.locator(".ddt-execution-inspector");
  await expect(inspector.getByRole("heading", { name: caseIds[0]!, exact: true })).toBeVisible();
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectUiIntegrity(page);
    const bounds = await inspector.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await captureDdtUi(page, `ddt-responsive-inspector-${viewport.width}`);
  }
  const readerToken = await issueDdtApiToken(page, hierarchy.projectId, ["case.read"]);
  const readerHeaders = { authorization: `Bearer ${readerToken}` };
  expect(
    (
      await page.request.get(ddtPath(hierarchy, "requirement-categories"), {
        headers: readerHeaders,
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.post(ddtPath(hierarchy, "requirement-categories"), {
        headers: readerHeaders,
        data: { name: "未授权分类", className, expectedRevision: 0 },
      })
    ).status(),
  ).toBe(403);
  const firstCasePath = `cases/${encodeURIComponent(caseIds[0]!)}`;
  const previewResponse = await page.request.get(ddtPath(hierarchy, `${firstCasePath}/workspace`), {
    headers: readerHeaders,
  });
  expect(previewResponse.status()).toBe(200);
  const preview = await previewResponse.json();
  expect(preview.item.data).toBeUndefined();
  expect(preview.executionDetail).toMatchObject({
    definition: { id: definition.id },
    canRun: false,
    canManage: false,
    canReadLogs: false,
    canReadSource: false,
    executionHistory: { items: [] },
    failureAnalysisHistory: { items: [] },
  });
  for (const endpoint of ["summary", "executions", "failure-analyses"]) {
    expect(
      (
        await page.request.get(ddtPath(hierarchy, `${firstCasePath}/${endpoint}`), {
          headers: readerHeaders,
        })
      ).status(),
    ).toBe(200);
  }
  expect(
    (
      await page.request.post(ddtPath(hierarchy, `${firstCasePath}/execute`), {
        headers: readerHeaders,
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.get(ddtPath(hierarchy, "sr-mappings"), { headers: readerHeaders })
    ).status(),
  ).toBe(200);
  for (const [path, body] of [
    ["sr-mappings", { srNum: "PAYMENTS", className: null, expectedRevision: 1 }],
    [
      "execution-range",
      { caseDefinitionId: definition.id, className, included: false, expectedRevision: 1 },
    ],
  ] as const) {
    expect(
      (
        await page.request.post(ddtPath(hierarchy, path), { headers: readerHeaders, data: body })
      ).status(),
    ).toBe(403);
  }
  const getCase = (id: string) =>
    browserJson<{
      revision: number;
      data: Record<string, string>;
      executionClass?: { caseDefinitionId: string };
    }>(page, ddtPath(hierarchy, `cases/${encodeURIComponent(id)}`));
  for (const id of caseIds)
    expect((await getCase(id)).body).toMatchObject({
      revision: 1,
      executionClass: { caseDefinitionId: definition.id },
    });
  const newCaseId = `SR-LATER-${hierarchy.suffix}`;
  await importRows([newCaseId]);
  await expect
    .poll(async () => (await getCase(newCaseId)).body.executionClass?.caseDefinitionId)
    .toBe(definition.id);
  const newCase = (await getCase(newCaseId)).body;
  const moved = await browserJson(
    page,
    ddtPath(hierarchy, `cases/${encodeURIComponent(newCaseId)}`),
    {
      method: "PATCH",
      body: { expectedRevision: newCase.revision, data: { ...newCase.data, srNum: "OTHER" } },
    },
  );
  expect(moved.status).toBe(200);
  expect((await getCase(newCaseId)).body.executionClass).toBeUndefined();
  await page.goto("/cases/ddt-associations");
  const srRow = page.locator('.ddt-sr-row[data-sr="PAYMENTS"]');
  await expect(srRow).toContainText(className);
  await page.getByLabel("搜索 SR", { exact: true }).fill("PAY");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL(/query=PAY/);
  await expect(page.locator('.ddt-sr-row[data-sr="OTHER"]')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel("搜索 SR", { exact: true })).toHaveValue("");
  await expect(page.locator('.ddt-sr-row[data-sr="OTHER"]')).toBeVisible();
  await page.route("**/api/v1/ddt/sr-mappings?**", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as {
      items: Array<{ srNum: string; executionClass?: unknown }>;
    };
    for (const item of snapshot.items) if (item.srNum === "PAYMENTS") delete item.executionClass;
    await route.fulfill({ response, json: snapshot });
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(srRow).toContainText("分类执行类已删除");
  await expect(
    page.getByRole("button", { name: "解除 PAYMENTS 的关联", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/v1/ddt/sr-mappings?**");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(srRow).toContainText(className);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 1024 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-sr-associations-${width}`);
  }
  await page.getByRole("button", { name: "配置需求分类", exact: true }).click();
  const categoryDialog = page.getByRole("dialog", { name: "需求分类", exact: true });
  await categoryDialog.getByRole("button", { name: "删除分类 PAYMENTS 分类", exact: true }).click();
  await acceptSystemDialog(page, "删除分类“PAYMENTS 分类”", "删除分类");
  await expect(categoryDialog.getByRole("alert")).toContainText("仍使用此分类");
  await categoryDialog.getByRole("button", { name: "编辑分类 PAYMENTS 分类", exact: true }).click();
  await categoryDialog.getByLabel("分类名称", { exact: true }).fill("钱包与支付");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-category-editor-${width}`);
  }
  await categoryDialog.getByRole("button", { name: "保存分类", exact: true }).click();
  await expect(
    categoryDialog.getByRole("button", { name: "编辑分类 钱包与支付", exact: true }),
  ).toBeVisible();
  await categoryDialog.getByRole("button", { name: "新建分类", exact: true }).click();
  await categoryDialog.getByLabel("分类名称", { exact: true }).fill("钱包与支付");
  await categoryDialog.getByRole("radio", { name: className, exact: true }).check();
  await categoryDialog.getByRole("button", { name: "保存分类", exact: true }).click();
  await expect(categoryDialog.getByRole("alert")).toContainText("同名需求分类");
  await categoryDialog.getByRole("button", { name: "返回分类列表", exact: true }).click();
  await categoryDialog.getByRole("button", { name: "编辑分类 钱包与支付", exact: true }).click();
  await categoryDialog.getByLabel("分类名称", { exact: true }).fill("PAYMENTS 分类");
  await categoryDialog.getByRole("button", { name: "保存分类", exact: true }).click();
  await expect(
    categoryDialog.getByRole("button", { name: "编辑分类 PAYMENTS 分类", exact: true }),
  ).toBeVisible();
  await categoryDialog.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "配置测试类范围" }).click();
  const range = page.getByRole("dialog", { name: "测试类候选范围", exact: true });
  await range.getByRole("button", { name: `移除 ${className}`, exact: true }).click();
  await expect(range.getByRole("alert")).toContainText("仍使用此测试类");
  await expect(page.locator(".toast-viewport")).toContainText("仍使用此测试类");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 1024 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-sr-range-${width}`);
  }
  await range.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "设置 PAYMENTS 的分类", exact: true }).click();
  const mapping = page.getByRole("dialog", { name: "设置 SR PAYMENTS 的分类", exact: true });
  await mapping.getByRole("radio", { name: "PAYMENTS 分类", exact: true }).check();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-sr-category-choice-${width}`);
  }
  const concurrent = await browserJson(page, ddtPath(hierarchy, "sr-mappings"), {
    method: "POST",
    body: { srNum: "PAYMENTS", className, expectedRevision: 1 },
  });
  expect(concurrent.status).toBe(200);
  await mapping.getByRole("button", { name: "保存 SR 分类" }).click();
  await expect(mapping.getByRole("alert")).toContainText("已被修改");
  await mapping.getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("button", { name: "解除 PAYMENTS 的关联", exact: true }).click();
  await acceptSystemDialog(page, "解除 PAYMENTS 的关联", "解除关联");
  await expect(srRow).toContainText("未关联");
  for (const id of caseIds) expect((await getCase(id)).body.executionClass).toBeUndefined();
  await page.getByRole("button", { name: "配置需求分类", exact: true }).click();
  const categories = page.getByRole("dialog", { name: "需求分类", exact: true });
  await categories.getByRole("button", { name: "删除分类 PAYMENTS 分类", exact: true }).click();
  await acceptSystemDialog(page, "删除分类“PAYMENTS 分类”", "删除分类");
  await expect(
    categories.getByRole("button", { name: "删除分类 PAYMENTS 分类", exact: true }),
  ).toHaveCount(0);
  await categories.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "配置测试类范围" }).click();
  await range.getByRole("button", { name: `移除 ${className}`, exact: true }).click();
  await expect(range.getByRole("button", { name: `移除 ${className}`, exact: true })).toHaveCount(
    0,
  );
  await expect(range.getByRole("region", { name: "候选测试类范围" })).toContainText("候选范围为空");
});

test("mixed and DDT-only tasks share execution and reject unbound members", async ({ page }) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);
  const className = `com.example.Mixed${Date.now()}Test`;
  const definition = await importExecutionClass(page, hierarchy, className);
  const mixed = await createDdtSuite(page, hierarchy, definition.id);
  const caseIds = [`DDT-A-${hierarchy.suffix}`, `DDT-B-${hierarchy.suffix}`];
  await page.goto("/cases?tab=ddt");
  await page.getByRole("button", { name: "导入表格" }).click();
  const importer = page.getByRole("dialog", { name: "导入 DDT 用例", exact: true });
  await importer.locator('input[type="file"]').setInputFiles({
    name: "mixed.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `CaseID,srNum,value\n${caseIds[0]},MIXED,first\n${caseIds[1]},MIXED,second\n`,
    ),
  });
  await importer.getByRole("button", { name: "开始预检" }).click();
  await importer.getByRole("button", { name: "确认并后台导入" }).click();
  await expect(page.locator(".ddt-status.succeeded").first()).toBeVisible({ timeout: 30_000 });

  await page.goto(`/case-suites/${mixed.id}`);
  await page.getByRole("link", { name: "添加普通用例", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`targetSuiteId=${mixed.id}`));
  await expect(page.locator('select[aria-label="目标用例任务"]')).toHaveValue(mixed.id);
  await page.goto(`/case-suites/${mixed.id}`);
  await page.getByRole("link", { name: "添加 DDT 用例", exact: true }).click();
  for (const id of caseIds) await page.getByLabel(`选择 ${id}`, { exact: true }).check();
  await page.getByRole("button", { name: "加入用例任务", exact: true }).click();
  const addDialog = page.getByRole("dialog", { name: "将 2 条 DDT 用例加入任务", exact: true });
  await expect(addDialog.locator("select")).toHaveValue(mixed.id);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `mixed-task-add-${width}`);
  }
  await addDialog.getByRole("button", { name: "加入任务", exact: true }).click();
  await expect(addDialog).toBeHidden();
  const rejected = await browserJson<{
    error: { code: string; details: { blockers: Array<{ code: string }> } };
  }>(page, "/api/v1/run-batches", { method: "POST", body: { suiteId: mixed.id } });
  expect(rejected.status).toBe(400);
  expect(rejected.body.error.code).toBe("RUN_BATCH_PREFLIGHT_FAILED");
  expect(
    rejected.body.error.details.blockers.filter(
      (blocker) => blocker.code === "DDT_EXECUTION_CLASS_REQUIRED",
    ),
  ).toHaveLength(2);

  for (const id of caseIds) await page.getByLabel(`选择 ${id}`, { exact: true }).check();
  await page.getByRole("button", { name: "加入用例任务", exact: true }).click();
  await addDialog.locator("select").selectOption("new");
  const pureName = `DDT only ${hierarchy.suffix}`;
  await addDialog.getByLabel("新任务名称").fill(pureName);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await captureDdtUi(page, `ddt-task-create-${width}`);
  }
  let failAddition = true;
  const membershipRoute = "**/api/v1/case-suites/*/ddt-cases";
  await page.route(membershipRoute, async (route) => {
    if (failAddition) {
      failAddition = false;
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "PLATFORM_BUSY",
            message: "添加用例暂时失败，请重试。",
            requestId: "ddt-membership-retry",
          },
        },
      });
    } else await route.continue();
  });
  await addDialog.getByRole("button", { name: "加入任务", exact: true }).click();
  await expect(addDialog).toContainText("添加用例暂时失败，请重试。");
  await expect(addDialog).toContainText(`任务“${pureName}”已创建`);
  await expect(addDialog.getByLabel("新任务名称")).toBeDisabled();
  await captureDdtUi(page, "ddt-task-membership-retry-1536");
  await addDialog.getByRole("button", { name: "加入任务", exact: true }).click();
  await expect(addDialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: pureName })).toBeVisible();
  await page.unroute(membershipRoute);
  const suites = await browserJson<{ items: Array<{ id: string; name: string }> }>(
    page,
    `/api/v1/case-suites?projectId=${hierarchy.projectId}&projectVersionId=${hierarchy.versionId}`,
  );
  expect(suites.body.items.filter((suite) => suite.name === pureName)).toHaveLength(1);
  const pure = suites.body.items.find((suite) => suite.name === pureName)!;
  expect(pure).toBeTruthy();
  await associateDdtSr(page, "MIXED", className);
  await uploadDdtTaskDependencies(page, hierarchy.projectId);
  const runner = await registerDdtTaskRunner(page);
  try {
    for (const suite of [mixed, pure]) {
      await configureTaskExecution(page, suite.id, runner.runnerId, {
        concurrency: 4,
        retryLimit: 0,
        adapter: {
          enabled: true,
          suiteName: "Mixed DDT",
          testName: "Regression",
          environmentAddresses: ["127.0.0.1"],
        },
      });
      const created = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
        method: "POST",
        body: { suiteId: suite.id },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const runCount = suite.id === mixed.id ? 3 : 2;
      const values: string[] = [];
      const ddtAttempts: Array<{ attemptId: string; caseId: string }> = [];
      for (let index = 0; index < runCount; index++) {
        type Assignment = {
          assignment: {
            attemptId: string;
            batchId: string;
            executionSpec: {
              className: string;
              inputs: Array<{ inputId: string; kind: string }>;
            };
          };
          lease: { token: string };
        };
        let claim: Assignment | undefined;
        await expect
          .poll(
            async () => {
              const response = await page.request.post(
                `/api/v1/runner-agents/${runner.runnerId}/claims`,
                {
                  headers: {
                    authorization: `Bearer ${runner.credential}`,
                    "x-autoforge-runner-id": runner.runnerId,
                  },
                  data: {
                    schemaVersion: 1,
                    requestId: randomUUID(),
                    availableSlots: 1,
                    labels: ["linux", "java", "testng"],
                    capabilities: ddtTaskCapabilities,
                    waitSeconds: 0,
                  },
                },
              );
              expect(response.status()).toBe(200);
              claim = ((await response.json()) as { assignments: Assignment[] }).assignments[0];
              return Boolean(claim);
            },
            { timeout: 20_000 },
          )
          .toBe(true);
        expect(claim!.assignment.executionSpec.className).toBe(className);
        const classData = claim!.assignment.executionSpec.inputs.find(
          (input) => input.kind === "class-data",
        );
        if (classData) {
          const response = await page.request.get(
            `/api/v1/run-attempts/${claim!.assignment.attemptId}/inputs/${classData.inputId}`,
            {
              headers: {
                authorization: `Bearer ${runner.credential}`,
                "x-autoforge-runner-id": runner.runnerId,
                "x-autoforge-lease-token": claim!.lease.token,
              },
            },
          );
          expect(response.status()).toBe(200);
          const content = (await response.json()) as { CaseID: string; value: string };
          expect(caseIds).toContain(content.CaseID);
          values.push(content.value);
          ddtAttempts.push({ attemptId: claim!.assignment.attemptId, caseId: content.CaseID });
        }
        const completed = await page.request.post(
          `/api/v1/run-attempts/${claim!.assignment.attemptId}/complete`,
          {
            headers: {
              authorization: `Bearer ${runner.credential}`,
              "x-autoforge-runner-id": runner.runnerId,
            },
            data: {
              schemaVersion: 1,
              completionId: randomUUID(),
              leaseToken: claim!.lease.token,
              result: {
                status: "succeeded",
                resultCode: "TESTNG_SUCCEEDED",
                summary: "Mixed DDT protocol acceptance",
                durationMs: 10,
                artifacts: [],
              },
            },
          },
        );
        expect(completed.status()).toBe(200);
      }
      expect(values.sort()).toEqual(["first", "second"]);
      await expect
        .poll(async () => {
          const batch = await browserJson<{ status: string; totalRuns: number }>(
            page,
            `/api/v1/run-batches/${created.body.id}`,
          );
          expect(batch.body.totalRuns).toBe(runCount);
          return batch.body.status;
        })
        .toBe("succeeded");
      const ddtAttempt = ddtAttempts[0]!;
      const share = await browserJson<{ shareUrl: string }>(
        page,
        `/api/v1/run-attempts/${ddtAttempt.attemptId}/log-share`,
        { method: "POST" },
      );
      expect(share.status).toBe(200);
      const anonymous = await page.context().browser()!.newContext();
      try {
        const publicPage = await anonymous.newPage();
        await publicPage.goto(new URL(share.body.shareUrl, page.url()).toString());
        await expect(
          publicPage.getByRole("heading", { name: ddtAttempt.caseId, exact: true }),
        ).toBeVisible();
        await expect(
          publicPage.locator(".share-log-fact").filter({ hasText: "执行类路径" }),
        ).toContainText(className);
        await expect(
          publicPage.locator(".share-log-fact").filter({ hasText: "用例名称（CaseID）" }),
        ).toContainText(ddtAttempt.caseId);
        for (const width of [1024, 1536]) {
          await publicPage.setViewportSize({ width, height: 960 });
          await expectUiIntegrity(publicPage);
          await captureDdtUi(
            publicPage,
            `ddt-public-log-${suite.id === mixed.id ? "mixed" : "pure"}-${width}`,
          );
        }
      } finally {
        await anonymous.close();
      }
      await page.goto(`/case-suites/${suite.id}`);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: 960 });
        await expectUiIntegrity(page);
        await captureDdtUi(
          page,
          `${suite.id === mixed.id ? "mixed" : "ddt-only"}-task-details-${width}`,
        );
      }
    }
  } finally {
    // Keep this simulated Runner from accepting work after the test.
    await browserJson(page, `/api/v1/runners/${runner.runnerId}`, {
      method: "PATCH",
      body: { state: "disabled" },
    });
  }
});

const ddtTaskCapabilities = [
  "executor:testng-v1",
  "adapter:cotest-testng-v1",
  "runtime:project-assets-v1",
  "isolation:cgroup-v2",
  "java:21.0.8",
  "testng:7.11.0",
];

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

async function expectBelow(list: Locator, feedback: Locator): Promise<void> {
  await expect(feedback).toBeVisible();
  await expect
    .poll(async () => {
      const [listBox, feedbackBox] = await Promise.all([
        list.boundingBox(),
        feedback.boundingBox(),
      ]);
      return listBox && feedbackBox ? feedbackBox.y - (listBox.y + listBox.height) : -1;
    })
    .toBeGreaterThanOrEqual(0);
}

async function registerDdtTaskRunner(
  page: Page,
): Promise<{ runnerId: string; credential: string }> {
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: "E2E DDT Task Runner",
      labels: ["linux", "java", "testng"],
      capabilities: ddtTaskCapabilities,
      maxConcurrency: 4,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.7.2",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const runner = (await registration.json()) as { runnerId: string; credential: string };
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/heartbeat`,
    {
      headers: {
        authorization: `Bearer ${runner.credential}`,
        "x-autoforge-runner-id": runner.runnerId,
      },
      data: {
        schemaVersion: 1,
        busySlots: 0,
        labels: ["linux", "java", "testng"],
        capabilities: ddtTaskCapabilities,
        maxConcurrency: 4,
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
  return runner;
}

async function uploadDdtTaskDependencies(page: Page, projectId: string): Promise<void> {
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
  const uploadForm = page.locator("form", {
    has: page.getByRole("button", { name: "上传并启用" }),
  });
  await uploadForm.getByLabel("资源类型").selectOption("jar-bundle");
  await uploadForm.getByLabel("压缩格式").selectOption("zip");
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
