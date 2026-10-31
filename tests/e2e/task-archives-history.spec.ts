import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  browserJson,
  ensureAdministrator,
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
  try {
    for (const suite of suites.slice(1))
      await db.execute("UPDATE case_suites SET is_rerun=TRUE WHERE id=?", [suite.id]);
  } finally {
    await db.close();
  }
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
  const current = await browserJson<{ revision: number }>(
    page,
    `/api/v1/case-suites/${suites[1]!.id}?view=summary`,
  );
  const restored = await browserJson(page, `/api/v1/case-suites/${suites[1]!.id}`, {
    method: "PATCH",
    body: { expectedRevision: current.body.revision, archived: false },
  });
  expect(restored.status).toBe(200);
  await page.getByRole("link", { name: "活动任务", exact: true }).click();
  await expect(
    page.getByRole("article", { name: `任务 ${suites[1]!.name}`, exact: true }),
  ).toBeVisible();
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
