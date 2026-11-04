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
    // Insert already exhausted state atomically so background builders cannot race the fixture.
    await fixture.execute(`INSERT INTO read_model_snapshots(id,project_id,query_json,accessed_at,refresh_after,failed)
      VALUES('${snapshotId}','${DEFAULT_PROJECT_ID}','${JSON.stringify(query)}','${recordedAt}','${recordedAt}',5)`);
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
    await expect(page.locator(".execution-case-table tbody tr")).toHaveCount(50, {
      timeout: 60_000,
    });
    const rounds = page.getByLabel("轮次列表", { exact: true });
    await rounds.getByRole("button", { name: "初始轮次", exact: true }).click();
    await expect(page.getByLabel("轮次详情：初始轮次", { exact: true })).toBeVisible();
    await expect(page.locator(".execution-case-table tbody tr")).toHaveCount(50, {
      timeout: 30_000,
    });
    await rounds.getByRole("button", { name: "全部轮次", exact: true }).click();
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
    await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
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
    expect(
      await fixture.scalar(
        `SELECT COUNT(*) AS total FROM run_attempts WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id='${batchId}')`,
      ),
    ).toBe(130010);
  } finally {
    await fixture.execute(
      `DELETE FROM read_model_snapshots WHERE query_json LIKE '%${batchId}%' OR query_json LIKE '%${version.body.id}%'; DELETE FROM run_batches WHERE id='${batchId}'; DELETE FROM runners WHERE id='${runnerId}'; DELETE FROM case_suites WHERE id='${suite.body.id}'; DELETE FROM project_versions WHERE id='${version.body.id}'`,
    );
    await fixture.close();
  }
});

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
    scalar: async (statement: string) =>
      Number((handle.client.prepare(statement).get() as { total: number }).total),
    close: async () => handle.close(),
  };
}
