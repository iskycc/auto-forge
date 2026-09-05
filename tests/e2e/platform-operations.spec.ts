import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
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
const SQLITE_FIXTURE_BATCH_SEQUENCE_NUMBER = 918_273;
const STORAGE_JDK_ASSET_ID = "e2e-storage-jdk-delete";
const STORAGE_JDK_FILE_NAME = "e2e-removable-jdk.zip";
const STORAGE_JDK_KEEPER_ASSET_ID = "e2e-storage-jdk-keeper";
const STORAGE_JDK_KEEPER_FILE_NAME = "e2e-removable-jdk-keeper.zip";
const STORAGE_DEPENDENCY_ASSET_ID = "e2e-storage-dependency-delete";
const STORAGE_DEPENDENCY_FILE_NAME = "e2e-removable-dependencies.tar.gz";
const STORAGE_DEPENDENCY_ASSET_ID_SECOND = "e2e-storage-dependency-delete-second";
const STORAGE_DEPENDENCY_FILE_NAME_SECOND = "e2e-removable-dependencies-second.tar.gz";

test("configuration conflicts, diagnostics and retention controls remain observable", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const concurrentPage = await page.context().newPage();
  await Promise.all([page.goto("/settings/platform"), concurrentPage.goto("/settings/platform")]);

  await page.getByRole("button", { name: "搜索配置" }).click();
  const configurationSearch = page.getByRole("dialog", { name: "配置搜索" });
  await configurationSearch.getByLabel("搜索配置项").fill("内部访问地址");
  await captureUi(page, "configuration-search-1536");
  await configurationSearch.getByRole("link", { name: /内部访问地址/u }).click();
  await expect(page).toHaveURL(/section=configuration&focus=runnerBaseUrl/u);
  await expect(page.locator('input[name="runnerBaseUrl"]')).toBeFocused();

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

  const publicBaseUrl = page.locator('input[name="publicBaseUrl"]');
  const runnerBaseUrl = page.locator('input[name="runnerBaseUrl"]');
  const originalPublicBaseUrl = await publicBaseUrl.inputValue();
  const originalRunnerBaseUrl = await runnerBaseUrl.inputValue();
  const testPublicBaseUrl =
    originalPublicBaseUrl === "http://127.0.0.1:3199"
      ? "http://127.0.0.1:3197"
      : "http://127.0.0.1:3199";
  const testRunnerBaseUrl =
    originalRunnerBaseUrl === "http://10.20.30.40:3000"
      ? "http://10.20.30.41:3000"
      : "http://10.20.30.40:3000";
  const artifactCollection = page.getByLabel(/启用产物收集/);
  const originalArtifactCollection = await artifactCollection.isChecked();
  await publicBaseUrl.fill(testPublicBaseUrl);
  await runnerBaseUrl.fill(testRunnerBaseUrl);
  await artifactCollection.setChecked(!originalArtifactCollection);
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(
    page.getByText(/外部访问地址、内部访问地址、产物收集已立即生效.*无需重启/),
  ).toBeVisible();
  const savedConfiguration = await page.request.get("/api/v1/settings/platform");
  expect(savedConfiguration.status()).toBe(200);
  expect(await savedConfiguration.json()).toMatchObject({
    web: { publicBaseUrl: testPublicBaseUrl, runnerBaseUrl: testRunnerBaseUrl },
  });
  await page.goto("/runners");
  await page.getByRole("button", { name: "打开自动安装" }).click();
  const installerDialog = page.getByRole("dialog", { name: "自动安装执行机 Agent" });
  await expect(installerDialog.locator(".runner-control-url code")).toHaveText(testRunnerBaseUrl);
  await installerDialog.getByRole("button", { name: "关闭自动安装执行机 Agent" }).click();
  await expect(installerDialog).toHaveCount(0);
  await page.goto("/settings/platform");
  await page.locator('input[name="publicBaseUrl"]').fill(originalPublicBaseUrl);
  await page.locator('input[name="runnerBaseUrl"]').fill(originalRunnerBaseUrl);
  await artifactCollection.setChecked(originalArtifactCollection);
  await page.getByRole("button", { name: "保存平台配置" }).click();
  await expect(
    page.getByText(/外部访问地址、内部访问地址、产物收集已立即生效.*无需重启/),
  ).toBeVisible();

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
      runBatchSequenceNumber?: number;
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
    await expect(sqliteSummary).toContainText(`任务批次 #${SQLITE_FIXTURE_BATCH_SEQUENCE_NUMBER}`);
    await expect(sqliteSummary.locator(".storage-tree-file-batch")).not.toContainText(
      SQLITE_FIXTURE_BATCH_ID,
    );
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
      `关联任务批次查看任务批次 #${SQLITE_FIXTURE_BATCH_SEQUENCE_NUMBER}`,
    );
    const batchLink = sqliteGroup.getByRole("link", {
      name: `查看任务批次 #${SQLITE_FIXTURE_BATCH_SEQUENCE_NUMBER}`,
    });
    await expect(batchLink).toHaveAttribute(
      "href",
      `/run-batches/${encodeURIComponent(SQLITE_FIXTURE_BATCH_ID)}`,
    );
    const logInventoryResponse = await page.request.get(
      `/api/v1/settings/storage?category=execution-log&query=${SQLITE_FIXTURE_BATCH_ID}&limit=3`,
    );
    expect(logInventoryResponse.status()).toBe(200);
    const logInventory = (await logInventoryResponse.json()) as {
      items: Array<{ runBatchId?: string; runBatchSequenceNumber?: number }>;
    };
    expect(logInventory.items).toHaveLength(3);
    expect(logInventory.items.every((item) => item.runBatchId === SQLITE_FIXTURE_BATCH_ID)).toBe(
      true,
    );
    expect(
      logInventory.items.every(
        (item) => item.runBatchSequenceNumber === SQLITE_FIXTURE_BATCH_SEQUENCE_NUMBER,
      ),
    ).toBe(true);
    await expectUiIntegrity(page);
    await batchLink.click();
    await expect(page).toHaveURL(`/run-batches/${encodeURIComponent(SQLITE_FIXTURE_BATCH_ID)}`);
    await expect(
      page.getByText(`批次 #${SQLITE_FIXTURE_BATCH_SEQUENCE_NUMBER}`, { exact: false }).first(),
    ).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "存储空间" })).toBeVisible();
    await expect(storageTree).toBeVisible();

    if (liteDataDirectory) {
      const jdkObjectPath = runtimeAssetObjectPath(liteDataDirectory, STORAGE_JDK_ASSET_ID, "zip");
      await verifyRuntimeAssetDeletion({
        page,
        storageTree,
        category: "JDK 包",
        fileName: STORAGE_JDK_FILE_NAME,
        objectPath: jdkObjectPath,
      });
      const dependencyObjectPaths = [
        runtimeAssetObjectPath(liteDataDirectory, STORAGE_DEPENDENCY_ASSET_ID, "tar.gz"),
        runtimeAssetObjectPath(liteDataDirectory, STORAGE_DEPENDENCY_ASSET_ID_SECOND, "tar.gz"),
      ];
      await verifyRuntimeAssetBatchDeletion({
        page,
        storageTree,
        assetIds: [STORAGE_DEPENDENCY_ASSET_ID, STORAGE_DEPENDENCY_ASSET_ID_SECOND],
        fileNames: [STORAGE_DEPENDENCY_FILE_NAME, STORAGE_DEPENDENCY_FILE_NAME_SECOND],
        objectPaths: dependencyObjectPaths,
      });
      const deletionAudit = await page.request.get(
        "/api/v1/audit-events?action=storage.runtime_asset_delete&limit=10",
      );
      expect(deletionAudit.status()).toBe(200);
      expect(await deletionAudit.json()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            action: "storage.runtime_asset_delete",
            resourceId: STORAGE_JDK_ASSET_ID,
          }),
          expect.objectContaining({
            action: "storage.runtime_asset_delete",
            resourceId: STORAGE_DEPENDENCY_ASSET_ID,
          }),
          expect.objectContaining({
            action: "storage.runtime_asset_delete",
            resourceId: STORAGE_DEPENDENCY_ASSET_ID_SECOND,
          }),
        ]),
      });
    }
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

  const runtimeAssets = [
    {
      id: STORAGE_JDK_ASSET_ID,
      kind: "jdk",
      fileName: STORAGE_JDK_FILE_NAME,
      archiveFormat: "zip",
      bytes: 19,
    },
    {
      id: STORAGE_JDK_KEEPER_ASSET_ID,
      kind: "jdk",
      fileName: STORAGE_JDK_KEEPER_FILE_NAME,
      archiveFormat: "zip",
      bytes: 17,
    },
    {
      id: STORAGE_DEPENDENCY_ASSET_ID,
      kind: "jar-bundle",
      fileName: STORAGE_DEPENDENCY_FILE_NAME,
      archiveFormat: "tar.gz",
      bytes: 23,
    },
    {
      id: STORAGE_DEPENDENCY_ASSET_ID_SECOND,
      kind: "jar-bundle",
      fileName: STORAGE_DEPENDENCY_FILE_NAME_SECOND,
      archiveFormat: "tar.gz",
      bytes: 29,
    },
  ] as const;
  const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database
      .prepare(
        `INSERT INTO run_batches
          (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
           environment_json, secret_bindings_json, total_runs, project_id, created_at, updated_at)
         VALUES (?, ?, 'e2e-storage-suite', '存储空间关联任务', 1, 'succeeded', 0,
                 '[]', '[]', 1, '00000000-0000-7000-8000-000000000001', ?, ?)`,
      )
      .run(
        SQLITE_FIXTURE_BATCH_ID,
        SQLITE_FIXTURE_BATCH_SEQUENCE_NUMBER,
        "2026-09-01T02:30:00.000Z",
        "2026-09-01T02:30:00.000Z",
      );
    const insert = database.prepare(
      `INSERT INTO project_runtime_assets
       (id, project_id, kind, source_type, file_name, object_key, sha256, size_bytes,
        archive_format, created_at)
       VALUES (?, '00000000-0000-7000-8000-000000000001', ?, 'upload', ?, ?, ?, ?, ?, ?)`,
    );
    for (const asset of runtimeAssets) {
      const objectKey = runtimeAssetObjectKey(asset.id, asset.archiveFormat);
      const objectPath = resolve(dataDirectory, "objects", objectKey);
      mkdirSync(dirname(objectPath), { recursive: true });
      writeFileSync(objectPath, Buffer.alloc(asset.bytes, 2));
      insert.run(
        asset.id,
        asset.kind,
        asset.fileName,
        objectKey,
        asset.kind === "jdk" ? "e".repeat(64) : "f".repeat(64),
        asset.bytes,
        asset.archiveFormat,
        "2026-09-01T03:00:00.000Z",
      );
    }
  } finally {
    database.close();
  }
}

async function verifyRuntimeAssetDeletion(input: {
  page: Page;
  storageTree: Locator;
  category: "JDK 包" | "依赖包";
  fileName: string;
  objectPath: string;
}): Promise<void> {
  await input.page.getByRole("button", { name: "按文件类型筛选" }).click();
  await input.page.getByRole("option", { name: input.category, exact: true }).click();
  await input.page
    .getByLabel("搜索文件名称或路径")
    .fill(input.category === "JDK 包" ? "e2e-removable-jdk" : input.fileName);
  if (input.category === "JDK 包") {
    await applyStorageFilterWithDelayedPage(input.page);
  } else {
    await input.page.getByRole("button", { name: "应用筛选" }).click();
  }
  const file = input.storageTree
    .locator("details.storage-tree-file")
    .filter({ hasText: input.fileName });
  await expect(file).toHaveCount(1);
  if (input.category === "JDK 包") {
    await expect(
      input.storageTree.getByText(STORAGE_JDK_KEEPER_FILE_NAME, { exact: true }),
    ).toBeVisible();
  }
  await file.locator(":scope > summary").click();
  const deleteButton = file.getByRole("button", { name: `删除${input.category}` });
  await deleteButton.click();
  const preservedTreeState = await input.storageTree.evaluate((tree) => ({
    openNodeIds: Array.from(
      tree.querySelectorAll<HTMLElement>("details[data-tree-node-id][open]"),
      (element) => element.dataset.treeNodeId,
    ),
    scrollY: window.scrollY,
  }));
  const confirmation = input.page.getByRole("dialog", { name: `删除${input.category}` });
  await expect(confirmation).toContainText(input.fileName);
  await expect(confirmation).toContainText("无法恢复");
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(file).toHaveCount(1);
  expect(existsSync(input.objectPath)).toBe(true);

  await deleteButton.click();
  const inventoryGetRequests: string[] = [];
  const observeInventoryReads = (request: Request) => {
    if (request.url().includes("/api/v1/settings/storage?") && request.method() === "GET") {
      inventoryGetRequests.push(request.url());
    }
  };
  input.page.on("request", observeInventoryReads);
  const deleteResponsePromise = input.page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/settings/storage") &&
      response.request().method() === "DELETE",
  );
  await acceptSystemDialog(input.page, `删除${input.category}`, "确认永久删除");
  expect((await deleteResponsePromise).status()).toBe(200);
  await expect(
    input.page.locator(".toast-card", { hasText: new RegExp(`${input.category}已永久删除`, "u") }),
  ).toBeVisible();
  await expect(file).toHaveCount(0);
  for (const nodeId of preservedTreeState.openNodeIds) {
    await expect(
      input.storageTree.locator(`details[data-tree-node-id="${nodeId}"]`),
    ).toHaveAttribute("open", "");
  }
  const scrollPosition = await input.page.evaluate(() => ({
    current: window.scrollY,
    maximum: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  }));
  expect(scrollPosition.current).toBeCloseTo(
    Math.min(preservedTreeState.scrollY, scrollPosition.maximum),
    -1,
  );
  expect(scrollPosition.current).toBeGreaterThan(0);
  await captureUi(
    input.page,
    input.category === "JDK 包"
      ? "storage-after-jdk-deletion-1536"
      : "storage-after-dependency-deletion-1536",
  );
  expect(existsSync(input.objectPath)).toBe(false);
  await input.page.waitForTimeout(100);
  input.page.off("request", observeInventoryReads);
  expect(inventoryGetRequests).toEqual([]);
}

async function captureUi(page: Page, name: string): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDirectory, `${name}.png`), fullPage: false });
}

async function applyStorageFilterWithDelayedPage(page: Page): Promise<void> {
  let releasePage: () => void = () => undefined;
  let requestedNextPage = false;
  const nextPageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  const matchesInventory = (url: URL) =>
    url.pathname === "/api/v1/settings/storage" &&
    url.searchParams.get("query") === "e2e-removable-jdk";
  await page.route(matchesInventory, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("limit", "1");
    if (url.searchParams.has("cursor")) {
      requestedNextPage = true;
      await nextPageGate;
    }
    await route.continue({ url: url.toString() });
  });
  try {
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect.poll(() => requestedNextPage).toBe(true);
    await expect(page.locator(".storage-inventory")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByLabel("选择当前结果中的全部可删除资源")).toBeDisabled();
  } finally {
    releasePage();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(page.locator(".storage-inventory")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByLabel("选择当前结果中的全部可删除资源")).toBeEnabled();
}

async function verifyRuntimeAssetBatchDeletion(input: {
  page: Page;
  storageTree: Locator;
  assetIds: readonly string[];
  fileNames: readonly string[];
  objectPaths: readonly string[];
}): Promise<void> {
  await input.page.getByRole("button", { name: "按文件类型筛选" }).click();
  await input.page.getByRole("option", { name: "依赖包", exact: true }).click();
  await input.page.getByLabel("搜索文件名称或路径").fill("e2e-removable-dependencies");
  await input.page.getByRole("button", { name: "应用筛选" }).click();
  const files = input.storageTree.locator("details.storage-tree-file");
  await expect(files).toHaveCount(input.fileNames.length);
  for (const [index, fileName] of input.fileNames.entries()) {
    await input.page.getByLabel(`选择依赖包 ${fileName}`).check();
    await expect(files.nth(index)).not.toHaveAttribute("open", "");
  }

  const floatingAction = input.page.getByRole("region", { name: "批量删除存储资源" });
  await expect(floatingAction).toBeVisible();
  await expect(floatingAction).toContainText(`已选择 ${input.fileNames.length} 项`);
  const priorToastDismiss = input.page.getByRole("button", { name: "关闭通知" });
  if (await priorToastDismiss.isVisible()) await priorToastDismiss.click();
  await expectUiIntegrity(input.page);
  await floatingAction.getByRole("button", { name: "批量删除" }).click();
  const confirmation = input.page.getByRole("dialog", { name: "批量删除存储资源" });
  await expect(confirmation).toContainText(`${input.fileNames.length} 项`);
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(files).toHaveCount(input.fileNames.length);

  await floatingAction.getByRole("button", { name: "批量删除" }).click();
  const inventoryGetRequests: string[] = [];
  const observeInventoryReads = (request: Request) => {
    if (request.url().includes("/api/v1/settings/storage?") && request.method() === "GET") {
      inventoryGetRequests.push(request.url());
    }
  };
  input.page.on("request", observeInventoryReads);
  const deleteResponsePromise = input.page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/settings/storage") &&
      response.request().method() === "DELETE",
  );
  await acceptSystemDialog(input.page, "批量删除存储资源", `永久删除 ${input.fileNames.length} 项`);
  const deleteResponse = await deleteResponsePromise;
  expect(deleteResponse.status()).toBe(200);
  expect(deleteResponse.request().postDataJSON()).toEqual({ runtimeAssetIds: input.assetIds });
  expect(await deleteResponse.json()).toMatchObject({
    deletedCount: input.fileNames.length,
    failedCount: 0,
  });
  await expect(
    input.page.locator(".toast-card", {
      hasText: `已永久删除 ${input.fileNames.length} 项`,
    }),
  ).toBeVisible();
  await expect(files).toHaveCount(0);
  await expect(floatingAction).toHaveCount(0);
  for (const objectPath of input.objectPaths) expect(existsSync(objectPath)).toBe(false);
  await input.page.waitForTimeout(100);
  input.page.off("request", observeInventoryReads);
  expect(inventoryGetRequests).toEqual([]);
}

function runtimeAssetObjectPath(
  dataDirectory: string,
  assetId: string,
  archiveFormat: "zip" | "tar.gz",
): string {
  return resolve(dataDirectory, "objects", runtimeAssetObjectKey(assetId, archiveFormat));
}

function runtimeAssetObjectKey(assetId: string, archiveFormat: "zip" | "tar.gz"): string {
  return `projects/00000000-0000-7000-8000-000000000001/runtime-assets/${assetId}.${archiveFormat}`;
}
