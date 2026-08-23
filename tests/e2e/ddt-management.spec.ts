import { expect, test, type Page } from "@playwright/test";

import { buildExportWorkbook } from "../../packages/ddt-import/src";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("DDT workspace imports, edits, validates and recovers version-scoped cases", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureAdministrator(page);
  const hierarchy = await createHierarchy(page);
  await selectProjectContext(page, hierarchy.projectId, hierarchy.versionId, hierarchy.stageId);

  await page.goto("/cases?tab=ddt");
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
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: `ddt-${hierarchy.suffix}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });
  await expect(importDialog.getByText(`ddt-${hierarchy.suffix}.xlsx`)).toBeVisible();
  await importDialog.getByRole("button", { name: "开始预检" }).click();
  await expect(importDialog.getByText("2", { exact: true }).first()).toBeVisible();
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
  await caseDrawer.getByRole("button", { name: "保存修改" }).click();
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
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "移入回收站" }).click();
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
