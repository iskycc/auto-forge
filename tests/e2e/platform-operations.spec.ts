import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import {
  acceptSystemDialog,
  ensureAdministrator,
  expandAdministrationGroup,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

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
    items: Array<{ logicalPath: string; storagePath: string; sizeBytes: number }>;
    nextCursor?: string;
    summary: { fileCount: number; allocatedBytes: number; dataDirectory: string };
  };
  expect(storageBody.items).toHaveLength(1);
  expect(storageBody.summary.fileCount).toBeGreaterThan(0);
  expect(storageBody.summary.allocatedBytes).toBeGreaterThan(0);
  expect(storageBody.items[0]?.storagePath).toContain(storageBody.summary.dataDirectory);
  if (diagnosticBody.mode === "lite") {
    await page.getByRole("button", { name: "按文件类型筛选" }).click();
    await page.getByRole("option", { name: "平台数据库" }).click();
    await page.getByLabel("搜索文件名称或路径").fill("autoforge.sqlite");
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page).toHaveURL(/section=storage.*category=database.*query=autoforge\.sqlite/u);
    await expect(storageTree).toContainText("autoforge.sqlite");
    const databaseFile = storageTree
      .locator(".storage-tree-file > summary")
      .filter({ hasText: "autoforge.sqlite" })
      .first();
    await databaseFile.click();
    await expect(storageTree.locator(".storage-tree-file-detail").first()).toContainText(
      "平台 SQLite 主文件",
    );
    await expect(storageTree.locator(".storage-tree-file-detail").first()).toContainText(
      "实际位置",
    );
    await expect(storageTree.locator(".storage-tree-file-detail").first()).toContainText(
      "实际占用",
    );
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
