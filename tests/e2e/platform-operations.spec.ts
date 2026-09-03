import { expect, test } from "@playwright/test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";

import {
  acceptSystemDialog,
  ensureAdministrator,
  expandAdministrationGroup,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

const SQLITE_FIXTURE_LATEST_MODIFIED_AT = "2026-09-01T02:00:00.000Z";
const SQLITE_FIXTURE_BATCH_ID = "e2e-storage-batch";

test("configuration conflicts, diagnostics and retention controls remain observable", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const concurrentPage = await page.context().newPage();
  await Promise.all([page.goto("/settings/platform"), concurrentPage.goto("/settings/platform")]);

  await page.getByLabel("公开大盘刷新间隔（秒）").fill("6");
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(page.locator(".toast-card", { hasText: /平台配置已保存/ }).last()).toBeVisible();

  await concurrentPage.getByLabel("公开大盘刷新间隔（秒）").fill("7");
  await concurrentPage.getByRole("button", { name: "保存平台配置" }).click();
  const conflictDialog = concurrentPage.getByRole("dialog", {
    name: "平台配置已被其他人修改",
  });
  await expect(conflictDialog).toContainText(/避免覆盖|重新加载|尚未保存/);
  await expectUiIntegrity(concurrentPage);
  await conflictDialog.getByRole("button", { name: "暂不重新加载" }).click();
  await expect(concurrentPage.getByLabel("公开大盘刷新间隔（秒）")).toHaveValue("7");

  await page.getByLabel("公开大盘刷新间隔（秒）").fill("8");
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(page.locator(".toast-card", { hasText: /平台配置已保存/ }).last()).toBeVisible();
  await concurrentPage.close();

  const timeZone = page.getByLabel("平台时区");
  const originalTimeZone = await timeZone.inputValue();
  const testTimeZone = originalTimeZone === "UTC" ? "Asia/Shanghai" : "UTC";
  await timeZone.fill(testTimeZone);
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(page.getByText(/平台时区已立即生效.*无需重启/)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-time-zone", testTimeZone);
  await page.reload();
  await expect(page.getByLabel("平台时区")).toHaveValue(testTimeZone);
  await page.getByLabel("平台时区").fill(originalTimeZone);
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(page.getByText(/平台时区已立即生效.*无需重启/)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-time-zone", originalTimeZone);

  const publicBaseUrl = page.getByLabel("外部访问地址");
  const originalPublicBaseUrl = await publicBaseUrl.inputValue();
  const testPublicBaseUrl =
    originalPublicBaseUrl === "http://127.0.0.1:3199"
      ? "http://127.0.0.1:3197"
      : "http://127.0.0.1:3199";
  const artifactCollection = page.getByLabel(/启用产物收集/);
  const originalArtifactCollection = await artifactCollection.isChecked();
  await publicBaseUrl.fill(testPublicBaseUrl);
  await artifactCollection.setChecked(!originalArtifactCollection);
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(page.getByText(/外部访问地址、产物收集已立即生效.*无需重启/)).toBeVisible();
  await publicBaseUrl.fill(originalPublicBaseUrl);
  await artifactCollection.setChecked(originalArtifactCollection);
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(page.getByText(/外部访问地址、产物收集已立即生效.*无需重启/)).toBeVisible();

  await expandAdministrationGroup(page, "平台运维");
  await page.getByRole("link", { name: "系统诊断" }).click();
  await expect(page.getByRole("heading", { name: "系统诊断" })).toBeVisible();
  await expect(page.locator(".diagnostic-summary")).toContainText(/LITE|FULL/);
  await page.getByRole("button", { name: "刷新诊断" }).click();
  await expect(page.locator(".diagnostic-grid")).toContainText("就绪");
  const diagnostic = await page.request.get("/api/v1/settings/diagnostics?download=1");
  expect(diagnostic.status()).toBe(200);
  expect(diagnostic.headers()["content-disposition"]).toContain("attachment");
  const diagnosticBody = (await diagnostic.json()) as Record<string, unknown>;
  expect(diagnosticBody).toHaveProperty("deadLetters");
  expect(Array.isArray(diagnosticBody.deadLetters)).toBe(true);
  expect(diagnosticBody).not.toHaveProperty("secrets");
  expect(JSON.stringify(diagnosticBody)).not.toContain("adminBootstrapToken");
  expect(JSON.stringify(diagnosticBody)).not.toContain("databaseUrl");

  const liteDataDirectory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (diagnosticBody.mode === "lite" && liteDataDirectory) {
    insertLiteDeadLetterFixture(liteDataDirectory);
    insertSqliteStorageFixture(liteDataDirectory);
    await page.getByRole("button", { name: "刷新诊断" }).click();
    const deadLetterPanel = page.locator(".diagnostic-dead-letters");
    await expect(deadLetterPanel).toContainText("对象清理");
    await expect(deadLetterPanel).toContainText("E2E_DEAD_LETTER");
    await expect(deadLetterPanel).toContainText("模拟可恢复死信");
    await deadLetterPanel.getByRole("button", { name: "重新投递全部" }).click();
    await acceptSystemDialog(page, "重新投递死信任务", "重新投递");
    await expect(page.locator(".toast-card", { hasText: "已重新投递 1 个死信任务" })).toBeVisible();
    await expect(deadLetterPanel).toHaveCount(0);
  }

  await page.getByRole("link", { name: "存储空间" }).click();
  await expect(page.getByRole("heading", { name: "存储空间" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "空间概览" })).toBeVisible();
  await expect(page.locator(".storage-summary-grid")).toContainText("平台实际占用");
  const storageTree = page.locator(".storage-inventory-tree");
  await expect(storageTree).toBeVisible();
  await expect(storageTree.getByRole("treeitem").first()).toContainText(/数据目录|对象存储/);
  await expect(page.locator(".storage-pagination")).toHaveCount(0);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectUiIntegrity(page);
  const storageResponse = await page.request.get("/api/v1/settings/storage?limit=1");
  expect(storageResponse.status()).toBe(200);
  const storageBody = (await storageResponse.json()) as {
    items: Array<{
      logicalPath: string;
      storagePath: string;
      sizeBytes: number;
      createdAt?: string;
      modifiedAt?: string;
      runBatchId?: string;
    }>;
    nextCursor?: string;
    summary: { fileCount: number; allocatedBytes: number; dataDirectory: string };
  };
  expect(storageBody.items).toHaveLength(1);
  expect(storageBody.summary.fileCount).toBeGreaterThan(0);
  expect(storageBody.summary.allocatedBytes).toBeGreaterThan(0);
  expect(storageBody.items[0]?.storagePath).toContain(storageBody.summary.dataDirectory);
  expect(storageBody.items[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(storageBody.items[0]?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  if (diagnosticBody.mode === "lite") {
    await page.getByRole("button", { name: "按文件类型筛选" }).click();
    await page.getByRole("option", { name: "用例日志库" }).click();
    await page.getByLabel("搜索文件名称或路径").fill(SQLITE_FIXTURE_BATCH_ID);
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page).toHaveURL(
      new RegExp(`section=storage.*category=execution-log.*query=${SQLITE_FIXTURE_BATCH_ID}`, "u"),
    );
    const sqliteGroup = storageTree
      .locator("details.storage-tree-sqlite-group")
      .filter({ hasText: `${SQLITE_FIXTURE_BATCH_ID}.sqlite` });
    await expect(sqliteGroup).toHaveCount(1);
    await expect(sqliteGroup).not.toHaveAttribute("open", "");
    const sqliteSummary = sqliteGroup.locator(":scope > summary");
    await expect(sqliteSummary).toContainText("3 个文件");
    await expect(sqliteSummary).toContainText("23 B");
    await expect(sqliteSummary).toContainText(`任务批次号 ${SQLITE_FIXTURE_BATCH_ID}`);
    await expect(
      sqliteSummary.locator(`time[datetime="${SQLITE_FIXTURE_LATEST_MODIFIED_AT}"]`),
    ).toHaveCount(1);
    await sqliteSummary.click();
    const sqliteComponents = sqliteGroup.locator(".storage-sqlite-components");
    await expect(sqliteComponents).toContainText("已合并计入上方大小");
    await expect(sqliteComponents.locator("li")).toHaveCount(3);
    await expect(sqliteComponents.locator(".storage-sqlite-component-role")).toHaveText([
      "主文件",
      "WAL",
      "SHM",
    ]);
    await expect(sqliteGroup.locator(".storage-tree-file-detail")).toContainText("创建时间");
    await expect(sqliteGroup.locator(".storage-tree-file-detail")).toContainText("最新修改时间");
    await expect(sqliteGroup.locator(".storage-tree-file-detail")).toContainText(
      `关联任务批次号${SQLITE_FIXTURE_BATCH_ID}`,
    );
    const logInventoryResponse = await page.request.get(
      `/api/v1/settings/storage?category=execution-log&query=${SQLITE_FIXTURE_BATCH_ID}&limit=3`,
    );
    expect(logInventoryResponse.status()).toBe(200);
    const logInventory = (await logInventoryResponse.json()) as {
      items: Array<{ runBatchId?: string }>;
    };
    expect(logInventory.items).toHaveLength(3);
    expect(logInventory.items.every((item) => item.runBatchId === SQLITE_FIXTURE_BATCH_ID)).toBe(
      true,
    );
    await expectUiIntegrity(page);
  }

  await page.getByRole("link", { name: "数据保留" }).click();
  const logRetention = page.locator(".retention-policy-grid form").filter({ hasText: "日志" });
  await logRetention.getByRole("button", { name: "影响预览" }).click();
  await expect(logRetention).toContainText(/当前将影响 \d+ 条/);
  await logRetention.getByLabel("保留天数").fill("31");
  await logRetention.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("保留策略已更新。")).toBeVisible();

  await logRetention.getByRole("button", { name: "影响预览" }).click();
  await logRetention.getByRole("button", { name: "执行清理" }).click();
  await acceptSystemDialog(page, /清理/, "确认清理");
  await expect(page.getByText(/清理已完成：删除 \d+ 条记录/)).toBeVisible();
  const cleanupAudit = await page.request.get(
    "/api/v1/audit-events?action=retention.execute&limit=10",
  );
  expect(cleanupAudit.status()).toBe(200);
  expect(await cleanupAudit.json()).toMatchObject({
    items: [expect.objectContaining({ action: "retention.execute", resourceId: "log" })],
  });
});

function insertLiteDeadLetterFixture(dataDirectory: string): void {
  const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO queue_jobs
          (message_id, run_id, attempt, schema_version, kind, payload_json, priority,
           deduplication_key, status, available_at, delivery_attempts, maximum_deliveries,
           last_error_code, last_error_summary, created_at, updated_at)
         VALUES (?, ?, 1, 1, 'object-cleanup', ?, 0, ?, 'dead_letter', ?, 8, 8, ?, ?, ?, ?)`,
      )
      .run(
        "e2e-diagnostic-dead-letter",
        "e2e-cleanup-missing",
        JSON.stringify({ cleanupJobId: "e2e-cleanup-missing" }),
        "e2e-dead-letter-fixture",
        now,
        "E2E_DEAD_LETTER",
        "模拟可恢复死信",
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function insertSqliteStorageFixture(dataDirectory: string): void {
  const mainPath = resolve(dataDirectory, "attempt-logs", `${SQLITE_FIXTURE_BATCH_ID}.sqlite`);
  const files = [
    { path: mainPath, bytes: 11, modifiedAt: "2026-09-01T00:00:00.000Z" },
    { path: `${mainPath}-wal`, bytes: 7, modifiedAt: "2026-09-01T01:00:00.000Z" },
    { path: `${mainPath}-shm`, bytes: 5, modifiedAt: SQLITE_FIXTURE_LATEST_MODIFIED_AT },
  ];
  mkdirSync(dirname(mainPath), { recursive: true });
  for (const file of files) {
    writeFileSync(file.path, Buffer.alloc(file.bytes, 1));
    const timestamp = new Date(file.modifiedAt);
    utimesSync(file.path, timestamp, timestamp);
  }
}
