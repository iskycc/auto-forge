import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  browserJson,
  ensureAdministrator,
  login,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { openHistoryFixtureConnection } from "./support/history-fixture-connection";
import { insertExecutionRecordsFixture } from "./support/execution-records-fixture";
import { expectUiIntegrity } from "./support/ui-guard";

async function hierarchy(page: Parameters<typeof ensureAdministrator>[0]) {
  await ensureAdministrator(page);
  const name = uniqueName("task-history");
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name, slug: name },
  });
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions`,
    { method: "POST", body: { name: "任务归档验收" } },
  );
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "测试" } },
  );
  await selectProjectContext(page, project.body.id, version.body.id, stage.body.id);
  return {
    projectId: project.body.id,
    projectVersionId: version.body.id,
    testStageId: stage.body.id,
  };
}

test("one-click Rerun archiving preserves ordinary tasks and supports browsing and restoring archives", async ({
  page,
}, testInfo) => {
  const scope = await hierarchy(page);
  const suites: Array<{ id: string; name: string }> = [];
  for (const name of ["主任务", "未通过用例 Rerun-2026103101", "未通过用例 Rerun-2026103102"]) {
    const created = await browserJson<{ id: string; name: string }>(page, "/api/v1/case-suites", {
      method: "POST",
      body: { projectId: scope.projectId, projectVersionId: scope.projectVersionId, name },
    });
    expect(created.status).toBe(201);
    suites.push(created.body);
  }
  const db = await openHistoryFixtureConnection({
    directory: process.env.AUTOFORGE_E2E_DATA_DIR,
    postgresUrl: process.env.AUTOFORGE_E2E_POSTGRES_URL,
  });
  const ddtId = randomUUID();
  try {
    for (const suite of suites.slice(1))
      await db.execute("UPDATE case_suites SET is_rerun=TRUE WHERE id=?", [suite.id]);
    await db.execute(
      "INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?, '归档-CASE','归档-case','Wallet','wallet','standard',?,?,?)",
      [
        ddtId,
        scope.projectId,
        scope.projectVersionId,
        scope.testStageId,
        JSON.stringify({ CaseID: "归档-CASE", srNum: "Wallet", amount: 42 }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  } finally {
    await db.close();
  }
  const suiteUrl = `/api/v1/case-suites/${suites[1]!.id}`;
  const added = await browserJson(page, `${suiteUrl}/ddt-cases`, {
    method: "POST",
    body: { testStageId: scope.testStageId, caseIds: ["归档-CASE"] },
  });
  expect(added.status).toBe(200);
  await page.goto("/case-suites");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`rerun-list-${width}.png`) });
  }
  await page.getByRole("button", { name: "一键归档 Rerun", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "归档 Rerun 任务", exact: true });
  await expect(dialog).toContainText("保留任务配置、用例及全部执行历史");
  await dialog.getByRole("button", { name: "确认归档", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("article", { name: "任务 主任务", exact: true })).toBeVisible();
  await expect(
    page.getByRole("article", { name: `任务 ${suites[1]!.name}`, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "已归档任务", exact: true }).click();
  await expect(
    page.getByRole("article", { name: `任务 ${suites[1]!.name}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article", { name: "任务 主任务", exact: true })).toHaveCount(0);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`rerun-archives-${width}.png`) });
  }
  const current = await browserJson<{ revision: number; caseCount: number }>(
    page,
    `${suiteUrl}?view=summary`,
  );
  expect(current.body.caseCount).toBe(1);
  for (const request of [
    {
      path: "/ddt-cases",
      method: "POST",
      body: { testStageId: scope.testStageId, caseIds: ["归档-CASE"] },
    },
    { path: "/ddt-cases", method: "DELETE", body: { ddtCaseIds: [ddtId] } },
    { path: "/cases", method: "POST", body: { caseDefinitionIds: [randomUUID()] } },
    { path: "/cases", method: "DELETE", body: { caseDefinitionIds: [randomUUID()] } },
    {
      path: "",
      method: "PATCH",
      body: { expectedRevision: current.body.revision, name: "不应生效" },
    },
    {
      path: "",
      method: "PATCH",
      body: { expectedRevision: current.body.revision, archived: false, enabled: false },
    },
    { path: "/webhooks", method: "PUT", body: { webhookIds: [] } },
  ]) {
    const rejected = await browserJson<{ error: { code: string; message: string } }>(
      page,
      `${suiteUrl}${request.path}`,
      request,
    );
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("CASE_SUITE_ARCHIVED");
    expect(rejected.body.error.message).toContain("恢复任务");
  }
  const unchanged = await browserJson(page, `${suiteUrl}?view=summary`);
  expect(unchanged.body).toEqual(current.body);
  await page.goto(`/cases?tab=ddt&ddtView=cases&targetSuiteId=${suites[1]!.id}`);
  await page.getByLabel("选择 归档-CASE", { exact: true }).check();
  await page.getByRole("button", { name: "加入用例任务", exact: true }).click();
  const addDialog = page.getByRole("dialog", { name: "将 1 条 DDT 用例加入任务", exact: true });
  await expect(addDialog.locator(`option[value="${suites[1]!.id}"]`)).toHaveCount(0);
  await expect(addDialog.locator(`option[value="${suites[0]!.id}"]`)).toHaveCount(1);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`active-task-selection-${width}.png`) });
  }
  await addDialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto(`/case-suites/${suites[1]!.id}`);
  await expect(page.getByRole("link", { name: "添加 DDT 用例", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "添加普通用例", exact: true })).toHaveCount(0);
  await expect(page.locator('input[name="name"]')).toBeDisabled();
  await expect(page.locator(".suite-save-actions")).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
      ]);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", theme);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: 960 });
      await page.locator("#suite-settings").scrollIntoViewIfNeeded();
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`archived-read-only-${theme}-${width}.png`),
      });
    }
  }
  await page.getByRole("button", { name: `恢复任务 ${suites[1]!.name}`, exact: true }).click();
  await expect(page.getByRole("link", { name: "添加 DDT 用例", exact: true })).toBeVisible();
  await expect(page.locator('input[name="name"]')).toBeEnabled();
  await expect(page.locator('input[name="archived"]')).not.toBeChecked();
  const removed = await browserJson(page, `${suiteUrl}/ddt-cases`, {
    method: "DELETE",
    body: { ddtCaseIds: [ddtId] },
  });
  expect(removed.status).toBe(200);
  const readded = await browserJson(page, `${suiteUrl}/ddt-cases`, {
    method: "POST",
    body: { testStageId: scope.testStageId, caseIds: ["归档-CASE"] },
  });
  expect(readded.status).toBe(200);
  await page.goto("/case-suites");
  await expect(
    page.getByRole("article", { name: `任务 ${suites[1]!.name}`, exact: true }),
  ).toBeVisible();
});

test("manual task archiving and restoring preserves DDT members from list and detail actions", async ({
  page,
}, testInfo) => {
  const scope = await hierarchy(page);
  const name = "Wallet 回归任务 · 手动归档与恢复验证（保留全部用例和执行历史）";
  const created = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId: scope.projectId, projectVersionId: scope.projectVersionId, name },
  });
  expect(created.status).toBe(201);
  const suiteId = created.body.id;
  const db = await openHistoryFixtureConnection({ directory: process.env.AUTOFORGE_E2E_DATA_DIR });
  try {
    await db.execute(
      "INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?, '手动归档-CASE','手动归档-case','Wallet','wallet','standard',?,?,?)",
      [
        randomUUID(),
        scope.projectId,
        scope.projectVersionId,
        scope.testStageId,
        JSON.stringify({ CaseID: "手动归档-CASE", srNum: "Wallet", amount: 42 }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  } finally {
    await db.close();
  }
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suiteId}/ddt-cases`, {
        method: "POST",
        body: { testStageId: scope.testStageId, caseIds: ["手动归档-CASE"] },
      })
    ).status,
  ).toBe(200);
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
      ]);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto("/case-suites");
      const card = page.getByRole("article", { name: `任务 ${name}`, exact: true });
      const trigger = card.getByRole("button", { name: `归档任务 ${name}`, exact: true });
      await expect(trigger).toBeEnabled();
      await expectUiIntegrity(page);
      await page.screenshot({ path: testInfo.outputPath(`manual-active-${theme}-${width}.png`) });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "归档任务", exact: true });
      await expect(dialog).toContainText("可随时恢复为活动任务");
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`manual-archive-dialog-${theme}-${width}.png`),
      });
      if (theme === "light" && width === 1024) {
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await expect(dialog).not.toBeVisible();
        await expect(card).toBeVisible();
        await trigger.click();
      }
      await dialog.getByRole("button", { name: "确认归档", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(card).toHaveCount(0);
      await page.getByRole("link", { name: "已归档任务", exact: true }).click();
      const archived = page.getByRole("article", { name: `任务 ${name}`, exact: true });
      await expect(archived.getByText("已归档", { exact: true })).toBeVisible();
      await expectUiIntegrity(page);
      await page.screenshot({ path: testInfo.outputPath(`manual-archived-${theme}-${width}.png`) });
      await archived.getByRole("button", { name: `恢复任务 ${name}`, exact: true }).click();
      await expect(archived).toHaveCount(0);
      await page.getByRole("link", { name: "活动任务", exact: true }).click();
      await expect(card).toBeVisible();
      const restored = await browserJson(page, `/api/v1/case-suites/${suiteId}?view=summary`);
      expect(restored.body).toMatchObject({
        id: suiteId,
        status: "active",
        caseCount: 1,
        isRerun: false,
      });
    }
  }
  await page.goto(`/case-suites/${suiteId}`);
  await page.locator('input[name="name"]').fill("不会保存的草稿");
  await page.getByRole("button", { name: `归档任务 ${name}`, exact: true }).click();
  await page
    .getByRole("dialog", { name: "归档任务", exact: true })
    .getByRole("button", { name: "确认归档", exact: true })
    .click();
  await expect(page.locator('input[name="name"]')).toBeDisabled();
  await expect(page.locator('input[name="name"]')).toHaveValue(name);
  await page.getByRole("button", { name: `恢复任务 ${name}`, exact: true }).click();
  await expect(page.locator('input[name="name"]')).toBeEnabled();
  await expect(page.locator('input[name="archived"]')).not.toBeChecked();
});

test("execution history reuses per-batch database snapshots through pagination and keeps live batches fresh", async ({
  page,
}, testInfo) => {
  const scope = await hierarchy(page);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory)
    throw new Error("This snapshot inspection scenario requires the Lite fixture directory");
  await insertExecutionRecordsFixture(directory, scope, 12);
  const url = `/api/v1/run-batches?executionKind=task&projectId=${scope.projectId}&projectVersionId=${scope.projectVersionId}&limit=10`;
  const first = await browserJson<{
    items: Array<{ id: string; succeededRuns: number; statisticsPending: boolean }>;
    nextCursor: string;
  }>(page, url);
  expect(first.status).toBe(200);
  expect(first.body.items).toHaveLength(10);
  expect(
    first.body.items.every((batch) => batch.succeededRuns === 1 && !batch.statisticsPending),
  ).toBe(true);
  const next = await browserJson<{ items: unknown[] }>(
    page,
    `${url}&cursor=${encodeURIComponent(first.body.nextCursor)}`,
  );
  expect(next.status).toBe(200);
  expect(next.body.items).toHaveLength(2);
  const sqlite = new DatabaseSync(resolve(directory, "db/autoforge.sqlite"), { readOnly: true });
  try {
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM run_batch_history_snapshots s JOIN run_batches b ON b.id=s.batch_id WHERE b.project_id=?",
        )
        .get(scope.projectId),
    ).toEqual({ count: 12 });
  } finally {
    sqlite.close();
  }
  const changedLimit = await browserJson<{ items: Array<{ statisticsPending: boolean }> }>(
    page,
    url.replace("limit=10", "limit=5"),
  );
  expect(changedLimit.status).toBe(200);
  expect(changedLimit.body.items.every((batch) => !batch.statisticsPending)).toBe(true);
  const liveId = randomUUID(),
    recordedAt = new Date().toISOString();
  const db = await openHistoryFixtureConnection({ directory });
  try {
    await db.execute(
      "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,project_id,policy_json,created_at,updated_at) VALUES (?,?,?,1,'running',0,1,'[]',?,?,?,?)",
      [
        liveId,
        liveId,
        "实时批次",
        scope.projectId,
        JSON.stringify({ projectVersionId: scope.projectVersionId }),
        recordedAt,
        recordedAt,
      ],
    );
  } finally {
    await db.close();
  }
  const live = await browserJson<{ items: Array<{ id: string; status: string }> }>(
    page,
    `${url}&status=running`,
  );
  expect(live.status).toBe(200);
  expect(live.body.items[0]).toMatchObject({ id: liveId, status: "running" });
  await page.goto("/execution-records");
  await expect(page.getByRole("heading", { name: "执行记录", exact: true })).toBeVisible();
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: testInfo.outputPath(`history-snapshots-${width}.png`) });
  }
});

test("task locks persist and allow only the locking user to mutate configuration and lifecycle", async ({
  page,
  browser,
}, testInfo) => {
  const scope = await hierarchy(page);
  const name = uniqueName("锁定任务长名称与成员配置保护");
  const created = await browserJson<{ id: string; revision: number }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { ...scope, name },
  });
  expect(created.status).toBe(201);
  const suiteId = created.body.id;
  const username = uniqueName("task-edit-peer");
  const password = "TaskPeer!Password123";
  const peer = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: username, password, forcePasswordChange: false },
  });
  expect(peer.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/users/${peer.body.id}/project-roles`, {
        method: "POST",
        body: { projectId: scope.projectId, roleId: "00000000-0000-7000-8100-000000000002" },
      })
    ).status,
  ).toBe(204);
  await page.goto("/case-suites");
  const card = page.getByRole("article", { name: `任务 ${name}`, exact: true });
  await card.getByRole("button", { name: `锁定任务 ${name}`, exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "锁定任务", exact: true });
  await expect(confirmation).not.toHaveClass(/ant-zoom-(?:appear|enter)/u);
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await expectUiIntegrity(page);
    await page.screenshot({ path: resolve(screenshots, `task-lock-dialog-light-${width}.png`) });
  }
  await confirmation.getByRole("button", { name: "确认锁定任务", exact: true }).click();
  await expect(card).toContainText("已锁定 · e2e-admin");
  const locked = await browserJson<{ revision: number; lockedBy: string }>(
    page,
    `/api/v1/case-suites/${suiteId}?view=summary`,
  );
  expect(locked.body.revision).toBe(created.body.revision + 1);
  for (const theme of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: theme, url: "http://127.0.0.1:3100" }]);
    await page.goto("/case-suites");
    await expect(card).toContainText("已锁定 · e2e-admin");
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await page.screenshot({ path: resolve(screenshots, `task-lock-card-${theme}-${width}.png`) });
    }
  }
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3100" });
  try {
    const other = await context.newPage();
    await login(other, username, password);
    await selectProjectContext(other, scope.projectId, scope.projectVersionId, scope.testStageId);
    for (const theme of ["light", "dark"]) {
      await context.addCookies([
        { name: "autoforge-color-mode", value: theme, url: "http://127.0.0.1:3100" },
      ]);
      await other.goto(`/case-suites/${suiteId}`);
      await expect(other.getByText("任务已由 e2e-admin 锁定。", { exact: false })).toBeVisible();
      await expect(other.getByRole("button", { name: "保存任务配置", exact: true })).toHaveCount(0);
      await expect(other.getByRole("button", { name: /^(解除锁定|归档任务)/u })).toHaveCount(0);
      await expect(other.getByRole("link", { name: "添加 DDT 用例", exact: true })).toHaveCount(0);
      for (const width of [1024, 1536]) {
        await other.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await expectUiIntegrity(other);
        await other.screenshot({
          path: resolve(screenshots, `task-locked-peer-${theme}-${width}.png`),
        });
      }
    }
    for (const [method, suffix, body] of [
      ["PATCH", "", { expectedRevision: locked.body.revision, name: "不应修改" }],
      ["PATCH", "", { expectedRevision: locked.body.revision, archived: true }],
      ["DELETE", "", { expectedRevision: locked.body.revision }],
      ["PUT", "/lock", { expectedRevision: locked.body.revision, locked: false }],
      [
        "POST",
        "/ddt-cases",
        { testStageId: scope.testStageId, caseIds: Array.of("不存在也不能绕过锁") },
      ],
    ] as const) {
      const denied = await browserJson<{ error: { code: string } }>(
        other,
        `/api/v1/case-suites/${suiteId}${suffix}`,
        { method, body },
      );
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("CASE_SUITE_LOCKED");
    }
    await page.goto(`/case-suites/${suiteId}`);
    await page.getByRole("button", { name: `解除锁定 ${name}`, exact: true }).click();
    const unlock = page.getByRole("dialog", { name: "解除锁定", exact: true });
    await expect(unlock).not.toHaveClass(/ant-zoom-(?:appear|enter)/u);
    await unlock.getByRole("button", { name: "确认解除锁定", exact: true }).click();
    await expect(unlock).toBeHidden();
    const unlocked = await browserJson<{ revision: number }>(
      page,
      `/api/v1/case-suites/${suiteId}?view=summary`,
    );
    expect(
      (
        await browserJson(other, `/api/v1/case-suites/${suiteId}`, {
          method: "PATCH",
          body: { expectedRevision: unlocked.body.revision, name: "解除后其他管理人可编辑" },
        })
      ).status,
    ).toBe(200);
  } finally {
    await context.close();
  }
});
