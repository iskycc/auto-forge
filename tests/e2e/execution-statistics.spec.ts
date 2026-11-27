import {
  openExecutionCaseDetails,
  closeExecutionCaseDetails,
  selectExecutionRound,
} from "./support/execution-details";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { readModelKey } from "../../packages/application/src/read-model-snapshots";
import { createPostgresDatabase } from "@autoforge/db/postgres";
import { createSqliteDatabase } from "@autoforge/db/sqlite";
import { seedLargeExecutionOverview } from "../../packages/db/test/fixtures/large-execution-overview";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("execution detail rates retain precision from the pass counts in both viewers", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const fixture = await database();
  const anonymous = await browser.newContext();
  const batchId = randomUUID();
  const runnerId = randomUUID();
  const recordedAt = new Date().toISOString();
  try {
    await seedLargeExecutionOverview(fixture.execute, {
      dialect: fixture.dialect,
      batchId,
      runnerId,
      suiteId: randomUUID(),
      projectId: DEFAULT_PROJECT_ID,
      caseCount: 643,
      roundCount: 1,
      recordedAt,
    });
    await fixture.execute(`
      UPDATE execution_runs SET status='failed',terminal_outcome='failed'
      WHERE id IN (SELECT id FROM execution_runs WHERE batch_id='${batchId}' ORDER BY id LIMIT 15);
      UPDATE run_attempts SET status='failed',outcome='failed'
      WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id='${batchId}' AND status='failed');
    `);
    const share = await browserJson<{ shareUrl: string }>(
      page,
      `/api/v1/run-batches/${batchId}/share`,
      { method: "POST" },
    );
    expect(share.status).toBe(200);
    const visitor = await anonymous.newPage();
    for (const [target, width, height, url] of [
      [page, 1024, 768, `/run-batches/${batchId}`],
      [visitor, 1536, 960, share.body.shareUrl],
    ] as const) {
      await target.setViewportSize({ width, height });
      await target.goto(url);
      await expect(target.getByRole("region", { name: "批次概览" })).toContainText("97.67%", {
        timeout: 30_000,
      });
      await expect(
        target.getByRole("region", { name: "执行结果图表" }).getByText("97.67%", { exact: true }),
      ).toBeVisible();
      const rows = target.getByRole("region", { name: "轮次列表" });
      await expect(rows.getByRole("cell", { name: "97.67%", exact: true })).toHaveCount(4);
      await expectUiIntegrity(target);
      await target.screenshot({
        path: testInfo.outputPath(`execution-percent-${width}.png`),
        animations: "disabled",
      });
    }
  } finally {
    await anonymous.close();
    await fixture.execute(
      `DELETE FROM read_model_snapshots WHERE query_json LIKE '%${batchId}%'; DELETE FROM run_batches WHERE id='${batchId}'; DELETE FROM runners WHERE id='${runnerId}'`,
    );
    await fixture.close();
  }
});

test("live summary and open case details follow a retry without reloading either viewer", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const fixture = await database();
  const anonymous = await browser.newContext();
  const batchId = randomUUID();
  const runnerId = randomUUID();
  const recordedAt = new Date().toISOString();
  const retriedRun = `${batchId}-run-2`;
  try {
    await seedLargeExecutionOverview(fixture.execute, {
      dialect: fixture.dialect,
      batchId,
      runnerId,
      suiteId: randomUUID(),
      projectId: DEFAULT_PROJECT_ID,
      caseCount: 3,
      roundCount: 2,
      recordedAt,
    });
    await fixture.execute(`
      UPDATE run_batches SET status='running' WHERE id='${batchId}';
      DELETE FROM run_attempts WHERE id='${retriedRun}-2';
      UPDATE execution_runs SET status='queued',terminal_outcome=NULL,attempt_count=1 WHERE id='${retriedRun}';
      UPDATE run_attempts SET status='running',outcome=NULL,finished_at=NULL WHERE id='${batchId}-run-3-2';
      UPDATE execution_runs SET status='running',terminal_outcome=NULL WHERE id='${batchId}-run-3';
    `);
    const share = await browserJson<{ shareUrl: string }>(
      page,
      `/api/v1/run-batches/${batchId}/share`,
      { method: "POST" },
    );
    expect(share.status).toBe(200);
    const visitor = await anonymous.newPage();
    await page.goto(`/run-batches/${batchId}`);
    await visitor.goto(share.body.shareUrl);
    const summaryRow = (target: typeof page) =>
      target.getByLabel("轮次列表", { exact: true }).getByRole("row", { name: /总结/u });
    const retryRow = (target: typeof page) =>
      target.locator(".execution-case-table tbody tr").filter({ hasText: "Case 2" });
    for (const target of [page, visitor]) {
      await target.bringToFront();
      await expect(summaryRow(target).locator("td").nth(6)).toHaveText("1", { timeout: 30_000 });
      await openExecutionCaseDetails(target);
      await expect(retryRow(target).getByText("失败", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    }

    // The result changes while the batch status, version and updated_at remain the same.
    await fixture.execute(`
      INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,outcome,scheduling_score,created_at,started_at,finished_at,duration_ms)
      VALUES('${retriedRun}-2','${retriedRun}','${runnerId}',2,2,'succeeded','succeeded',1,'${recordedAt}','${recordedAt}','${recordedAt}',1);
      UPDATE execution_runs SET status='succeeded',terminal_outcome='succeeded',attempt_count=2 WHERE id='${retriedRun}';
    `);
    for (const [target, name, width, height] of [
      [page, "console", 1024, 768],
      [visitor, "public", 1536, 960],
    ] as const) {
      await target.bringToFront();
      await expect(retryRow(target).getByText("通过", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await target.setViewportSize({ width, height });
      await expectUiIntegrity(target);
      await target.screenshot({
        path: testInfo.outputPath(`live-summary-cases-${name}-${width}.png`),
      });
      await closeExecutionCaseDetails(target);
      await expect(summaryRow(target).locator("td").nth(6)).toHaveText("2");
      await expectUiIntegrity(target);
      await target.screenshot({ path: testInfo.outputPath(`live-summary-${name}-${width}.png`) });
    }

    await fixture.execute(`
      UPDATE run_attempts SET status='succeeded',outcome='succeeded',finished_at='${recordedAt}' WHERE id='${batchId}-run-3-2';
      UPDATE execution_runs SET status='succeeded',terminal_outcome='succeeded' WHERE id='${batchId}-run-3';
      UPDATE run_batches SET status='succeeded',version=version+1 WHERE id='${batchId}';
    `);
    for (const target of [page, visitor]) {
      await target.bringToFront();
      await expect(summaryRow(target).locator("td").nth(6)).toHaveText("3", { timeout: 30_000 });
      await expect(summaryRow(target).getByText("已完成", { exact: true })).toBeVisible();
      await expect(summaryRow(target).locator("td").nth(4)).toHaveText("100%");
    }
  } finally {
    await page.goto("about:blank");
    await anonymous.close();
    await fixture.execute(`
      DELETE FROM read_model_snapshots WHERE query_json LIKE '%${batchId}%';
      DELETE FROM run_attempts WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id='${batchId}');
      DELETE FROM execution_runs WHERE batch_id='${batchId}';
      DELETE FROM run_batches WHERE id='${batchId}';
      DELETE FROM runners WHERE id='${runnerId}';
    `);
    await fixture.close();
  }
});

test("completed 13001-case ten-round tasks recover failed and delayed statistics without rerunning cases", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    {
      method: "POST",
      body: { name: uniqueName("large-overview") },
    },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      name: uniqueName("large-overview-suite"),
    },
  });
  expect(suite.status).toBe(201);
  const fixture = await database();
  const batchId = randomUUID();
  const runnerId = randomUUID();
  const recordedAt = new Date().toISOString();
  const query = {
    kind: "execution_overview" as const,
    snapshotVersion: 3 as const,
    projectId: DEFAULT_PROJECT_ID,
    batchId,
    terminalVersion: 1,
  };
  const snapshotId = readModelKey(query);
  try {
    await seedLargeExecutionOverview(fixture.execute, {
      dialect: fixture.dialect,
      batchId,
      runnerId,
      suiteId: suite.body.id,
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      caseCount: 13_001,
      roundCount: 10,
      recordedAt,
    });
    const progress = await browserJson(page, `/api/v1/run-batches/${batchId}/progress`);
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({
      totalCases: 13_001,
      completedCases: 13_001,
      totalPassed: 13_001,
      finalFailed: 0,
    });
    expect(
      await fixture.scalar(`SELECT COUNT(*) AS total FROM read_model_snapshots
        WHERE query_json LIKE '%${batchId}%' AND query_json LIKE '%"snapshotVersion":2%'
          AND query_json LIKE '%"kind":"execution_overview"%'`),
    ).toBe(0);
    // Persist exhausted state atomically so background builders cannot race the fixture.
    await fixture.execute(`INSERT INTO read_model_snapshots(id,project_id,query_json,accessed_at,refresh_after,failed)
      VALUES('${snapshotId}','${DEFAULT_PROJECT_ID}','${JSON.stringify(query)}','${recordedAt}','${recordedAt}',5)
      ON CONFLICT(id) DO UPDATE SET generation=NULL,payload_json=NULL,generated_at=NULL,failed=5,
        lease_token=NULL,lease_expires_at=NULL`);
    await page.goto(`/run-batches/${batchId}`);
    const retry = page.getByRole("button", { name: /重新生成统计/ });
    await expect(retry).toBeVisible();
    await expect(
      page.getByText("后台正在准备轮次统计，执行控制仍可使用。", { exact: true }),
    ).toHaveCount(0);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`statistics-failed-${width}.png`),
        animations: "disabled",
      });
    }
    await page.route(
      "**/api/v1/read-models/status",
      (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 503,
              json: { error: { code: "PLATFORM_BUSY", message: "暂时不可用" } },
            })
          : route.continue(),
      { times: 1 },
    );
    await retry.click();
    await expect(page.getByText("请求更新失败，请稍后重试。", { exact: true })).toBeVisible();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.locator(".execution-round-table tbody tr")).toHaveCount(12, {
      timeout: 60_000,
    });
    await openExecutionCaseDetails(page);
    await expect(page.locator(".execution-case-table tbody tr")).toHaveCount(50, {
      timeout: 60_000,
    });
    const rounds = page.getByLabel("轮次列表", { exact: true });
    await selectExecutionRound(page, "初始轮次");
    await expect(page.getByLabel("轮次详情：初始轮次", { exact: true })).toBeVisible();
    await expect(page.locator(".execution-case-table tbody tr")).toHaveCount(50, {
      timeout: 30_000,
    });
    await selectExecutionRound(page, "全部轮次");
    await expect(page.getByLabel("轮次详情：全部轮次", { exact: true })).toBeVisible();
    await expect(page.locator(".execution-case-table tbody tr")).toHaveCount(50, {
      timeout: 30_000,
    });
    await expect(rounds.locator("tbody tr").filter({ hasText: "全部轮次" })).toContainText(
      "130010",
    );
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`statistics-ready-${width}.png`),
        animations: "disabled",
      });
    }
    await closeExecutionCaseDetails(page);
    await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    await openExecutionCaseDetails(page);
    await page.screenshot({
      path: testInfo.outputPath("statistics-ready-dark-1536.png"),
      animations: "disabled",
    });

    const heldUntil = new Date(Date.now() + 3_600_000).toISOString();
    await fixture.execute(
      `UPDATE read_model_snapshots SET generation=NULL,payload_json=NULL,generated_at=NULL,failed=0,lease_token='held-for-ui-test',lease_expires_at='${heldUntil}' WHERE id='${snapshotId}'`,
    );
    await page.clock.install();
    await page.reload();
    await expect(
      page.getByText("后台正在准备轮次统计，执行控制仍可使用。", { exact: true }),
    ).toBeVisible();
    // The server-rendered notice precedes hydration; advance only after client effects mount.
    await expect(page.getByRole("button", { name: "再次执行", exact: true })).toBeEnabled();
    await page.clock.fastForward(125_000);
    await expect(retry).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "轮次统计准备时间较长" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("statistics-delayed-dark-1536.png"),
      animations: "disabled",
    });
    await fixture.execute(
      `UPDATE read_model_snapshots SET lease_token=NULL,lease_expires_at=NULL WHERE id='${snapshotId}'`,
    );
    await retry.click();
    await expect(page.locator(".execution-round-table tbody tr")).toHaveCount(12, {
      timeout: 60_000,
    });
    await expect(retry).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".execution-round-table tbody tr")).toHaveCount(12);
    // A retained page alone does not prove a timed-out refresh recovered. Wait for
    // every requested projection of this batch to publish its current revision.
    await expect
      .poll(
        () =>
          fixture.scalar(`SELECT COUNT(*) AS total FROM read_model_snapshots
            WHERE query_json LIKE '%${batchId}%'
              AND (failed>0 OR generated_at IS NULL OR generated_revision<>requested_revision)`),
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe(0);
    expect(
      await fixture.scalar(
        `SELECT COUNT(*) AS total FROM run_attempts WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id='${batchId}')`,
      ),
    ).toBe(130010);
    await page.goto("about:blank");
  } finally {
    // Large synthetic histories must be removed in bounded transactions, like production retention.
    await deleteFixturePages(
      () =>
        fixture.deletePage(`DELETE FROM run_attempts WHERE id IN (
      SELECT attempt.id FROM run_attempts attempt JOIN execution_runs run ON run.id=attempt.execution_run_id
      WHERE run.batch_id='${batchId}' LIMIT 1000
    )`),
      130010,
    );
    await deleteFixturePages(
      () =>
        fixture.deletePage(`DELETE FROM execution_runs WHERE id IN (
      SELECT id FROM execution_runs WHERE batch_id='${batchId}' LIMIT 1000
    )`),
      13001,
    );
    await fixture.execute(
      `DELETE FROM read_model_snapshots WHERE query_json LIKE '%${batchId}%' OR query_json LIKE '%${version.body.id}%'; DELETE FROM run_batches WHERE id='${batchId}'; DELETE FROM runners WHERE id='${runnerId}'; DELETE FROM case_suites WHERE id='${suite.body.id}'; DELETE FROM project_versions WHERE id='${version.body.id}'`,
    );
    await fixture.close();
  }
});

async function deleteFixturePages(
  removePage: () => Promise<number>,
  maximumRows: number,
): Promise<void> {
  for (let remaining = maximumRows; remaining > 0;) {
    const removed = await removePage();
    if (removed === 0) return;
    remaining -= removed;
  }
}

async function database() {
  const postgresUrl = process.env.AUTOFORGE_E2E_POSTGRES_URL;
  if (postgresUrl) {
    const handle = createPostgresDatabase({
      connectionString: postgresUrl,
      migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      poolMax: 1,
    });
    await handle.ready;
    return {
      dialect: "postgres" as const,
      execute: (statement: string) => handle.pool.query(statement),
      deletePage: async (statement: string) => (await handle.pool.query(statement)).rowCount ?? 0,
      scalar: async (statement: string) =>
        Number((await handle.pool.query<{ total: string }>(statement)).rows[0]!.total),
      close: () => handle.close(),
    };
  }
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("The statistics fixture requires its deployed data directory.");
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "db/autoforge.sqlite"),
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
  });
  return {
    dialect: "sqlite" as const,
    execute: async (statement: string) => {
      handle.client.exec(statement);
    },
    deletePage: async (statement: string) => Number(handle.client.prepare(statement).run().changes),
    scalar: async (statement: string) =>
      Number((handle.client.prepare(statement).get() as { total: number }).total),
    close: async () => handle.close(),
  };
}
