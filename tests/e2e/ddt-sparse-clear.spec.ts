import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { DdtCaseData } from "@autoforge/domain";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { buildExportWorkbook } from "../../packages/ddt-import/src";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { openHistoryFixtureConnection } from "./support/history-fixture-connection";
import { expectUiIntegrity } from "./support/ui-guard";

async function createScope(page: Page) {
  await ensureAdministrator(page);
  const name = uniqueName("ddt-clear");
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name, slug: name },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions`,
    { method: "POST", body: { name: "宽表清理验收" } },
  );
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "当前阶段" } },
  );
  const other = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "保留阶段" } },
  );
  const scope = {
    projectId: project.body.id,
    projectVersionId: version.body.id,
    testStageId: stage.body.id,
  };
  await selectProjectContext(page, scope.projectId, scope.projectVersionId, scope.testStageId);
  return { scope, otherStageId: other.body.id };
}

async function expectClearPreview(dialog: Locator) {
  await expect(async () => {
    const retry = dialog.getByRole("button", { name: "重新核对范围", exact: true });
    if (await retry.isVisible()) {
      await expect(dialog).toContainText("平台正在处理高优先级工作");
      await retry.click();
    }
    await expect(dialog).toContainText("8100", { timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });
}

test("DDT wide details stay bounded and scoped clearing preserves tasks, other stages and execution records before sparse reimport", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { scope, otherStageId } = await createScope(page);
  const endpoint = (path: string, stage = scope.testStageId) =>
    `/api/v1/ddt/${path}?${new URLSearchParams({ ...scope, testStageId: stage })}`;
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      name: "保留的混合任务",
    },
  });
  expect(suite.status).toBe(201);
  const db = await openHistoryFixtureConnection({
    directory: process.env.AUTOFORGE_E2E_DATA_DIR,
    postgresUrl: process.env.AUTOFORGE_E2E_POSTGRES_URL,
  });
  const caseCount = 8100;
  const wideId = randomUUID(),
    otherCaseId = randomUUID(),
    normalId = randomUUID(),
    sourceId = randomUUID(),
    batchId = randomUUID();
  const now = new Date().toISOString();
  const wide = {
    CaseID: "CASE-00000",
    srNum: "Wallet",
    zero: 0,
    flag: false,
    ...Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`有效字段_${index}`, `字段值 ${index}`]),
    ),
    ...Object.fromEntries(Array.from({ length: 2048 }, (_, index) => [`空列_${index}`, ""])),
    目标字段: "完整中文报文".repeat(5000),
  };
  try {
    for (let start = 0; start < caseCount; start += 64) {
      const count = Math.min(64, caseCount - start);
      const values: Array<string | number | null> = [];
      const members: Array<string | number | null> = [];
      for (let offset = 0; offset < count; offset++) {
        const index = start + offset,
          id = index === 0 ? wideId : randomUUID(),
          caseId = `CASE-${String(index).padStart(5, "0")}`;
        values.push(
          id,
          scope.projectId,
          scope.projectVersionId,
          scope.testStageId,
          caseId,
          caseId.toLowerCase(),
          "Wallet",
          "wallet",
          JSON.stringify(index === 0 ? wide : { CaseID: caseId, srNum: "Wallet", value: index }),
          now,
          now,
        );
        members.push(randomUUID(), suite.body.id, id, now);
      }
      await db.execute(
        `INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES ${Array.from({ length: count }, () => "(?,?,?,?,?,?,?,?,'standard',?,?,?)").join(",")}`,
        values,
      );
      await db.execute(
        `INSERT INTO case_suite_ddt_items(id,suite_id,ddt_case_id,added_at) VALUES ${Array.from({ length: count }, () => "(?,?,?,?)").join(",")}`,
        members,
      );
    }
    await db.execute(
      "INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?,'CASE-00000','case-00000','Other','other','standard',?,?,?)",
      [
        otherCaseId,
        scope.projectId,
        scope.projectVersionId,
        otherStageId,
        JSON.stringify({ CaseID: "CASE-00000", srNum: "Other", value: "保留" }),
        now,
        now,
      ],
    );
    await db.execute(
      "INSERT INTO case_suite_ddt_items(id,suite_id,ddt_case_id,added_at) VALUES (?,?,?,?)",
      [randomUUID(), suite.body.id, otherCaseId, now],
    );
    await db.execute(
      "INSERT INTO case_sources(id,project_id,project_version_id,test_stage_id,display_name,original_file_name,object_key,sha256,size_bytes,class_count,method_count,status,warnings_json,inspection_json,created_at,updated_at) VALUES (?,?,?,?,'保留普通用例','fixture.jar',?, ?,1,1,0,'ready','[]','{}',?,?)",
      [
        sourceId,
        scope.projectId,
        scope.projectVersionId,
        scope.testStageId,
        `fixtures/${sourceId}.jar`,
        sourceId.replaceAll("-", "").repeat(2),
        now,
        now,
      ],
    );
    await db.execute(
      "INSERT INTO case_definitions(id,project_id,project_version_id,test_stage_id,source_id,class_name,package_name,display_name,enabled,groups_json,current_version,created_at,updated_at) VALUES (?,?,?,?,?,'example.PreservedTest','example','保留普通用例',TRUE,'[]',1,?,?)",
      [normalId, scope.projectId, scope.projectVersionId, scope.testStageId, sourceId, now, now],
    );
    await db.execute(
      "INSERT INTO case_suite_items(id,suite_id,case_definition_id,added_at) VALUES (?,?,?,?)",
      [randomUUID(), suite.body.id, normalId, now],
    );
    await db.execute(
      `INSERT INTO run_batches(id,project_id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,sequence_number,created_at,updated_at) VALUES (?,?,?,'保留执行记录',1,'failed',0,1,'{}',${db.nextBatchSequence},?,?)`,
      [batchId, scope.projectId, suite.body.id, now, now],
    );
    await db.execute(
      "INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,case_type,class_data_json,status,created_at,updated_at) VALUES (?,?,?,1,'CASE-00000','example.Ddt','ddt',?,'failed',?,?)",
      [randomUUID(), batchId, wideId, JSON.stringify(wide), now, now],
    );
    await db.execute(
      "INSERT INTO ddt_deleted_cases(id,ddt_case_id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,source_name,case_created_at,case_updated_at,deleted_at) VALUES (?,?,?,?,?,'OLD','old','Wallet','wallet','standard','{}','fixture',?,?,?)",
      [
        randomUUID(),
        randomUUID(),
        scope.projectId,
        scope.projectVersionId,
        scope.testStageId,
        now,
        now,
        now,
      ],
    );
  } finally {
    await db.close();
  }

  const start = performance.now();
  const body = await page.request.get(endpoint("cases/CASE-00000"));
  const caseBody = (await body.json()) as { data: Record<string, unknown> };
  const detailProfile = {
    durationMs: performance.now() - start,
    fieldCount: Object.keys(caseBody.data).length,
  };
  await testInfo.attach("body-read", {
    body: JSON.stringify(detailProfile),
    contentType: "application/json",
  });
  expect(body.status()).toBe(200);
  await page.goto("/cases?tab=ddt&ddtView=cases");
  const cards = page.locator(".ddt-field-card");
  await expect(cards.first()).toBeVisible();
  await testInfo.attach("initial-dom", {
    body: JSON.stringify({ fieldCards: await cards.count() }),
    contentType: "application/json",
  });
  await expect(cards).toHaveCount(48);
  await writeFile(
    testInfo.outputPath("detail-profile.json"),
    JSON.stringify({ ...detailProfile, fieldCards: await cards.count() }, null, 2),
  );
  const search = page.getByRole("textbox", { name: "搜索用例字段", exact: true });
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`wide-ddt-fields-initial-${width}.png`) });
  }
  await search.fill("空列_");
  await expect(cards).toHaveCount(0);
  await expect(
    page.getByText("没有可显示的字段，请调整搜索条件或勾选显示空字段。", { exact: true }),
  ).toBeVisible();
  const showEmpty = page.getByRole("checkbox", { name: "显示空字段（2048）", exact: true });
  await showEmpty.check();
  await expect(cards).toHaveCount(48);
  await showEmpty.uncheck();
  await expect(cards).toHaveCount(0);
  await search.fill("zero");
  await expect(cards.locator("pre")).toHaveText("0");
  await search.fill("flag");
  await expect(cards.locator("pre")).toHaveText("false");
  await search.fill("目标字段");
  await expect(cards).toHaveCount(1);
  expect((await cards.locator("pre").innerText()).length).toBe(8192);
  await expect(cards.getByRole("button", { name: /显示更多内容/ })).toBeVisible();
  await page.getByRole("button", { name: "编辑字段 目标字段", exact: true }).click();
  await cards.locator("textarea").fill("修改后的有效值");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(cards.locator("pre")).toHaveText("修改后的有效值");
  await search.fill("");
  await expect(cards).toHaveCount(48);
  await page.locator(".ant-pagination-next").last().click();
  await expect(cards).toHaveCount(48);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`wide-ddt-fields-${width}.png`) });
  }
  await page.getByRole("button", { name: "清空 DDT 用例", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "清空当前范围 DDT 用例", exact: true });
  await expectClearPreview(dialog);
  await expect(dialog.getByRole("button", { name: "确认永久清空", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect((await page.request.get(endpoint("cases/CASE-00000"))).status()).toBe(200);
  await page.getByRole("button", { name: "清空 DDT 用例", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "清空当前范围 DDT 用例", exact: true });
  await expectClearPreview(dialog);
  await expect(dialog.getByRole("textbox", { name: "清空确认文字" })).toBeVisible();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`clear-ddt-confirm-${width}.png`) });
  }
  let deleteRequests = 0;
  await page.route("**/api/v1/ddt/clear?**", async (route) => {
    if (route.request().method() === "DELETE" && ++deleteRequests === 2) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "PLATFORM_BUSY",
            message: "模拟短暂竞争，请继续清理",
            requestId: "clear-test",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await dialog.getByRole("textbox", { name: "清空确认文字" }).fill("清空DDT用例");
  await dialog.getByRole("button", { name: "确认永久清空", exact: true }).click();
  await expect(dialog).toContainText("模拟短暂竞争");
  await dialog.getByRole("button", { name: "继续清空", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "完成", exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await expect(dialog).toContainText("已删除用例 8100 条");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`clear-ddt-complete-${width}.png`) });
  }
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator(".ddt-case-list-row")).toHaveCount(0);
  expect((await page.request.get(endpoint("cases/CASE-00000"))).status()).toBe(404);
  expect((await page.request.get(endpoint("cases/CASE-00000", otherStageId))).status()).toBe(200);
  const preserved = await browserJson<{ caseCount: number }>(
    page,
    `/api/v1/case-suites/${suite.body.id}?view=summary`,
  );
  expect(preserved.body.caseCount).toBe(2);
  expect((await page.request.get(`/api/v1/run-batches/${batchId}/overview`)).status()).toBe(200);

  const empty = Object.fromEntries(
    Array.from({ length: 1024 }, (_, index) => [`无关字段_${index}`, ""]),
  );
  const rows: DdtCaseData[] = [
    {
      CaseID: "新钱包-1",
      srNum: "Wallet",
      value: " 中文 ",
      zero: 0,
      flag: false,
      spaces: "  ",
      ...empty,
    },
    { CaseID: "新钱包-2", srNum: "Other", other: "第二条", ...empty },
  ];
  const preview = await page.request.post(endpoint("imports/preview"), {
    headers: { origin: new URL(page.url()).origin },
    multipart: {
      files: {
        name: "sparse.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: buildExportWorkbook(rows),
      },
    },
  });
  expect(preview.status()).toBe(201);
  const job = (await preview.json()) as { id: string; totalRows: number };
  expect(job.totalRows).toBe(2);
  expect(
    (
      await page.request.post(endpoint(`imports/${job.id}/confirm`), {
        headers: { origin: new URL(page.url()).origin },
        data: { conflictStrategy: "overwrite" },
      })
    ).status(),
  ).toBe(200);
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(endpoint(`imports/${job.id}`))).json()) as {
            status: string;
          }
        ).status,
      { timeout: 60_000 },
    )
    .toBe("succeeded");
  const saved = await browserJson<{ data: Record<string, unknown> }>(
    page,
    endpoint("cases/新钱包-1"),
  );
  expect(Object.keys(saved.body.data).sort()).toEqual(
    ["CaseID", "srNum", "value", "zero", "flag"].sort(),
  );
  expect(saved.body.data.value).toBe(" 中文 ");
  expect(String(saved.body.data.zero)).toBe("0");
  expect(String(saved.body.data.flag).toLowerCase()).toBe("false");
  expect(
    (
      await browserJson<{ caseCount: number }>(
        page,
        `/api/v1/case-suites/${suite.body.id}?view=summary`,
      )
    ).body.caseCount,
  ).toBe(2);
});
