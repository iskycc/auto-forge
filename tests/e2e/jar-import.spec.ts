import { expect, test, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { selectJarForInspection } from "./support/jar-import";
import {
  configureTaskExecution,
  createTaskRun,
  startTaskFromTopbar,
} from "./support/task-execution";
import {
  appAlert,
  browserJson,
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  ensureAdministrator,
  selectProjectContext,
} from "./support/session";

async function captureUi(page: Page, name: string): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  const absoluteDirectory = resolve(screenshotDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  await page.screenshot({ path: resolve(absoluteDirectory, `${name}.png`), fullPage: true });
}

function caseListXlsx(rows: string[][]): Uint8Array {
  const encoder = new TextEncoder();
  const sheetRows = rows
    .map(
      (cells, rowIndex) =>
        `<row r="${rowIndex + 1}">${cells
          .map(
            (value, columnIndex) =>
              `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  return zipSync({
    "[Content_Types].xml": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "_rels/.rels": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    "xl/workbook.xml": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="用例列表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

test("imports TestNG methods from a JAR into the case library", async ({ page }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const jar = zipSync({
    "com/example/CheckoutTest.class": buildClassFile({
      className: "com.example.CheckoutTest",
      methods: [
        {
          name: "checkout",
          annotations: [{ type: "Test", values: { groups: ["smoke", "checkout"] } }],
        },
      ],
    }),
    "testng.xml": new TextEncoder().encode('<suite name="AutoForge fixture" />'),
  });
  const jarV2 = zipSync({
    "com/example/CheckoutTest.class": buildClassFile({
      className: "com.example.CheckoutTest",
      methods: [
        {
          name: "checkout",
          annotations: [{ type: "Test", values: { groups: ["smoke", "checkout", "v2"] } }],
        },
        {
          name: "refund",
          annotations: [{ type: "Test", values: { groups: ["regression"] } }],
        },
      ],
    }),
  });
  const javaSource = `package com.example;

import org.testng.annotations.Test;

public class SourceVisibleTest {
  @Test(groups = {"source-view"}, description = "source JAR case")
  public void displaysSource() {
    String visibleMarker = "AUTOFORGE_SOURCE_VIEW_E2E";
  }
}
`;
  const sourcesJar = zipSync({
    "com/example/SourceVisibleTest.java": new TextEncoder().encode(javaSource),
  });
  const mixedSource = `package com.example;

import org.testng.annotations.Test;

public class MixedVisibleTest {
  @Test
  public void executesAndDisplaysSource() {
    String marker = "AUTOFORGE_MIXED_SOURCE_E2E";
  }
}
`;
  const mixedJar = zipSync({
    "com/example/MixedVisibleTest.class": buildClassFile({
      className: "com.example.MixedVisibleTest",
      methods: [
        {
          name: "executesAndDisplaysSource",
          annotations: [{ type: "Test", values: { groups: ["mixed"] } }],
        },
      ],
    }),
    "com/example/MixedVisibleTest.java": new TextEncoder().encode(mixedSource),
    "com/example/Damaged.class": new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00]),
  });

  const setupStatus = await page.request.get("/api/v1/auth/setup-status");
  const setup = (await setupStatus.json()) as { setupRequired: boolean };
  if (setup.setupRequired) {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /汇聚到一个可信控制面/ })).toBeVisible();
    await expect(page.getByText("平台数据实时同步")).toBeVisible();
    await expectDesktopLayoutFits(page, 1024, 768);
    await expectUiConsistency(page);

    await page.goto("/setup");
    await page.getByRole("button", { name: /^Full/ }).click();
    await expect(page.getByLabel("PostgreSQL URL")).toBeVisible();
    await expectUiConsistency(page);
    await page.getByRole("button", { name: /^Lite/ }).click();
  }
  const publicStatistics = await page.request.get("/api/v1/public/statistics");
  expect(publicStatistics.status()).toBe(200);
  expect(await publicStatistics.json()).not.toHaveProperty("secrets");

  await ensureAdministrator(page);
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByRole("link", { name: "工作概览", exact: true })).toHaveClass(
    /nav-item-active/,
  );
  await expect(page.getByRole("banner").getByText("E2E Administrator", { exact: true })).toHaveText(
    "E2E Administrator",
  );

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("用户名").fill(E2E_ADMIN_USERNAME);
  await page.getByLabel("密码").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByRole("link", { name: "工作概览", exact: true })).toHaveClass(
    /nav-item-active/,
  );
  await expect(page.getByRole("banner").getByText("E2E Administrator", { exact: true })).toHaveText(
    "E2E Administrator",
  );
  await selectProjectContext(page, DEFAULT_PROJECT_ID);
  await ensureProjectHierarchy(page);

  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await expect(page.getByRole("heading", { name: "导入 TestNG JAR" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "平台配置" })).toBeVisible();
  await expectUiConsistency(page);

  const largeUploadBoundary = await page.evaluate(
    async (sizeBytes) => {
      const formData = new FormData();
      formData.set(
        "file",
        new File([new Uint8Array(sizeBytes)], "48-mib-boundary.jar", {
          type: "application/java-archive",
        }),
      );
      const response = await fetch("/api/v1/case-sources/jar/inspect", {
        method: "POST",
        body: formData,
      });
      return {
        status: response.status,
        payload: (await response.json()) as { error?: { code?: string } },
      };
    },
    48 * 1024 * 1024,
  );
  expect(largeUploadBoundary.status).toBe(400);
  expect(largeUploadBoundary.payload.error?.code).toBe("INVALID_JAR");

  const largeClassName = `com.example.LargeBoundary${Date.now()}Test`;
  const validLargeJar = zipSync(
    {
      [`${largeClassName.replaceAll(".", "/")}.class`]: buildClassFile({
        className: largeClassName,
        methods: [{ name: "validBeyondLegacyLimit", annotations: [{ type: "Test", values: {} }] }],
      }),
      "fixtures/incompressible.bin": randomBytes(48 * 1024 * 1024),
    },
    { level: 0 },
  );
  expect(validLargeJar.byteLength).toBeGreaterThan(40 * 1024 * 1024);
  const validLargeResponse = await page.request.post("/api/v1/case-sources/jar/inspect", {
    headers: { origin: new URL(page.url()).origin },
    multipart: {
      file: {
        name: "valid-48-mib-tests.jar",
        mimeType: "application/java-archive",
        buffer: Buffer.from(validLargeJar),
      },
    },
  });
  expect(validLargeResponse.status()).toBe(200);
  expect(await validLargeResponse.json()).toMatchObject({
    classes: [{ className: largeClassName }],
  });

  const manyEntryClassName = `com.example.ManyEntries${Date.now()}Test`;
  const manyEntryJarEntries: Record<string, Uint8Array> = Object.fromEntries(
    Array.from({ length: 20_001 }, (_, index) => [`padding/entry-${index}.txt`, new Uint8Array()]),
  );
  manyEntryJarEntries[`${manyEntryClassName.replaceAll(".", "/")}.class`] = buildClassFile({
    className: manyEntryClassName,
    methods: [{ name: "scansBeyondLegacyEntryLimit", annotations: [{ type: "Test" }] }],
  });
  const manyEntryJar = zipSync(manyEntryJarEntries, { level: 0 });
  expect(Object.keys(unzipSync(manyEntryJar))).toHaveLength(20_002);
  const manyEntryResponse = await page.request.post("/api/v1/case-sources/jar/inspect", {
    headers: { origin: new URL(page.url()).origin },
    multipart: {
      file: {
        name: "more-than-20000-entries.jar",
        mimeType: "application/java-archive",
        buffer: Buffer.from(manyEntryJar),
      },
    },
  });
  expect(manyEntryResponse.status()).toBe(200);
  expect(await manyEntryResponse.json()).toMatchObject({
    classFileCount: 1,
    classes: [{ className: manyEntryClassName }],
  });

  await selectJarForInspection(page, {
    name: "valid-48-mib-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(validLargeJar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText(largeClassName)).toBeVisible({ timeout: 60_000 });
  const largeImportResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/case-sources/jar/import",
  );
  await page.getByRole("button", { name: "确认导入" }).click();
  expect((await largeImportResponse).status()).toBe(202);
  await page.getByRole("button", { name: "取消导入" }).click();
  const retryLargeImport = page.getByRole("button", { name: "幂等重试" });
  await expect
    .poll(
      async () => {
        if (await retryLargeImport.isVisible()) return "cancelled";
        const statuses = await page.getByRole("status").allTextContents();
        return statuses.some((status) => status.includes("已导入")) ? "succeeded" : "pending";
      },
      { timeout: 120_000 },
    )
    .toMatch(/^(cancelled|succeeded)$/);
  if (await retryLargeImport.isVisible()) {
    await expect(appAlert(page)).toContainText("导入任务已取消");
    await retryLargeImport.click();
    await expect(page.getByRole("status")).toContainText("已导入", { timeout: 120_000 });
  }

  await selectJarForInspection(page, {
    name: "checkout-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();

  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".method-row code")).toHaveText("checkout");
  await expect(page.locator(".method-row .method-signature")).toHaveText("入参：空，返回值：空");
  await expect(page.locator(".method-row")).not.toContainText("()V");
  await expect(page.getByText("smoke", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });

  await page.getByRole("link", { name: "查看用例管理" }).click();
  await expect(page.locator(".case-tree-directory").first()).toHaveAttribute("open", "");
  const folderCheckbox = page
    .locator('.case-tree-directory summary input[type="checkbox"]')
    .first();
  await folderCheckbox.check();
  await expect(folderCheckbox).toBeChecked();
  await expect(page.locator(".case-selection-toolbar")).toContainText(/已选 [1-9]\d*/);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await captureUi(page, "case-library-folder-selected-1536");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectDesktopLayoutFits(page, 1024, 768);
  await captureUi(page, "case-library-folder-selected-1024");
  await page.setViewportSize({ width: 1536, height: 1024 });
  await folderCheckbox.uncheck();
  await page.getByLabel("页内搜索用例").fill("CheckoutTest");
  await expect(page.getByRole("button", { name: "查看 CheckoutTest" })).toBeVisible();
  await expectUiConsistency(page);
  await captureUi(page, "case-library");

  const checkoutWorkspaceResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/case-definitions/") && response.url().endsWith("/workspace"),
  );
  await page.getByRole("button", { name: "查看 CheckoutTest" }).click();
  const checkoutWorkspace = (await (await checkoutWorkspaceResponse).json()) as {
    definition: { id: string };
  };
  await expect(
    page.locator(".case-inspector-header").getByRole("heading", { name: "CheckoutTest" }),
  ).toBeVisible();
  await expect(page.locator(".case-inspector-meta > div")).toHaveCount(5);
  await expect(page.locator(".case-inspector-meta-wide")).toHaveCount(1);
  await expect(page.locator(".case-inspector-pane .method-signature")).toHaveText(
    "入参：空，返回值：空",
  );
  await expect(page).toHaveURL(/\/cases(?:\?.*)?$/);
  await expectUiConsistency(page);
  const checkoutCaseUrl = new URL(
    `/cases/${encodeURIComponent(checkoutWorkspace.definition.id)}`,
    page.url(),
  ).toString();

  await page.goto(`/objects?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  const checkoutSourceRow = page.getByRole("row", { name: /checkout-tests\.jar/ });
  await checkoutSourceRow.getByRole("button", { name: "设为全量来源" }).click();
  await expect(checkoutSourceRow.getByRole("button", { name: "当前全量来源" })).toBeVisible();

  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await selectJarForInspection(page, {
    name: "mixed-visible-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(mixedJar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.MixedVisibleTest")).toBeVisible();
  await expect(page.getByText("这是混合 JAR")).toBeVisible();
  await expect(page.getByText("可查看源码", { exact: true })).toBeVisible();
  await expect(page.getByText(/Damaged\.class/)).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.locator(".alert-success")).toContainText("已导入", { timeout: 60_000 });

  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await selectJarForInspection(page, {
    name: "mixed-visible-tests-copy.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(mixedJar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.locator(".alert-success")).toContainText("已返回现有用例", {
    timeout: 60_000,
  });
  await page.getByRole("link", { name: "查看用例管理" }).click();
  await page.getByLabel("页内搜索用例").fill("MixedVisibleTest");
  await page.getByRole("button", { name: "查看 MixedVisibleTest" }).click();
  await page.locator(".case-inspector-section").getByText("用例源码", { exact: true }).click();
  await expect(page.locator(".case-inspector-pane .source-code-viewer").first()).toContainText(
    "AUTOFORGE_MIXED_SOURCE_E2E",
  );
  await expect(
    page.locator(".case-inspector-section summary").getByText("立即执行", { exact: true }),
  ).toBeVisible();

  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await selectJarForInspection(page, {
    name: "checkout-tests-v2.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jarV2),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
  await page.goto(`/objects?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  const checkoutV2SourceRow = page.getByRole("row", { name: /checkout-tests-v2\.jar/ });
  await checkoutV2SourceRow.getByRole("link", { name: "预览" }).click();
  await expect(page.getByRole("heading", { name: "checkout-tests-v2.jar" })).toBeVisible();
  await page.getByRole("button", { name: "对比权威来源" }).click();
  await expect(page.getByText(/对比结果：新增 0、变更 1、消失 0、冲突 0/)).toBeVisible();
  await page.getByRole("button", { name: "确认同步为权威来源" }).click();
  await expect(page.getByText(/已同步为权威来源；匹配用例已生成不可变版本/)).toBeVisible();
  await page.goto(checkoutCaseUrl);
  await expect(page.getByRole("columnheader", { name: "方法签名" })).toBeVisible();
  await expect(page.locator(".data-table .method-signature").first()).toHaveText(
    "入参：空，返回值：空",
  );
  await expect(page.getByText("()V", { exact: true })).toHaveCount(0);
  await expect(page.getByText("版本历史（2）")).toBeVisible();
  const versionDiff = page.locator(".version-diff-list");
  await expect(versionDiff.getByText(/方法(?:新增|移除)：refund/)).toBeVisible();
  await expect(versionDiff).toContainText("refund（入参：空，返回值：空）");
  await expect(versionDiff).not.toContainText("()V");
  await page.locator(".role-action-summary").first().click();
  const versionSnapshot = page.locator(".version-snapshot-details").first();
  await expect(versionSnapshot).toContainText('"methodSignature": "入参：空，返回值：空"');
  await expect(versionSnapshot).not.toContainText('"descriptor"');
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "从该版本创建" }).last().click();
  await expect(page.getByText("版本历史（3）")).toBeVisible({ timeout: 20_000 });

  const executionCases = await browserJson<{
    items: Array<{
      id: string;
      className: string;
      displayName: string;
      enabled: boolean;
      archived: boolean;
      revision: number;
      projectVersionId: string;
      testStageId: string;
    }>;
  }>(
    page,
    `/api/v1/case-definitions?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}&limit=100`,
  );
  expect(executionCases.status).toBe(200);
  const executionCandidate = executionCases.body.items.at(0);
  if (!executionCandidate) throw new Error("JAR 导入后应至少存在一个已绑定版本和阶段的用例。");
  const activatedCase = await browserJson<typeof executionCandidate>(
    page,
    `/api/v1/case-definitions/${encodeURIComponent(executionCandidate.id)}`,
    {
      method: "PATCH",
      body: {
        enabled: true,
        archived: false,
        expectedRevision: executionCandidate.revision,
      },
    },
  );
  expect(activatedCase.status).toBe(200);
  const taskCase = activatedCase.body;
  expect(taskCase).toMatchObject({ enabled: true, archived: false });
  await selectProjectContext(
    page,
    DEFAULT_PROJECT_ID,
    taskCase.projectVersionId,
    taskCase.testStageId,
  );

  await page.goto(`/case-suites?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await expect(page.locator('select[name="projectId"]')).toHaveCount(0);
  await page.locator(".project-picker-trigger").click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: "默认项目" }).click();
  await page.getByRole("button", { name: "创建任务" }).click();
  const createSuiteDialog = page.getByRole("dialog", { name: "创建用例任务" });
  await createSuiteDialog.getByLabel("任务名称").fill("每日冒烟测试");
  await createSuiteDialog.getByLabel("说明").fill("E2E 创建的可复用任务");
  await createSuiteDialog.getByRole("button", { name: "创建任务" }).click();
  const dailySuiteLink = page.getByRole("link", { name: /每日冒烟测试/ });
  await expect(dailySuiteLink).toBeVisible();
  const dailySuiteHref = await dailySuiteLink.getAttribute("href");
  expect(dailySuiteHref).toBeTruthy();
  const dailySuiteId = new URL(dailySuiteHref!, page.url()).pathname.split("/").at(-1)!;
  await page.keyboard.press("Control+K");
  const globalSearch = page.getByLabel("全局搜索");
  await expect(globalSearch).toBeFocused();
  await globalSearch.fill("每日冒烟");
  await expect(page.getByRole("option", { name: /每日冒烟测试/ })).toBeVisible();
  await globalSearch.press("ArrowDown");
  await expect(page.getByRole("option", { name: /每日冒烟测试/ })).toBeFocused();
  await expectUiConsistency(page);

  await page.goto("/cases");
  await page.getByLabel("页内搜索用例").fill(taskCase.displayName);
  await page.getByLabel(`选择 ${taskCase.displayName}`).check();
  await page.getByRole("button", { name: "目标用例任务", exact: true }).click();
  await page.getByRole("option", { name: "每日冒烟测试", exact: true }).click();
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.locator(".inline-feedback")).toContainText("已将 1 个用例加入任务");

  await page.goto(`/case-suites/${encodeURIComponent(dailySuiteId)}`);
  await expectUiConsistency(page);
  await expect(page.getByRole("heading", { name: "1 个用例" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: `移除 ${taskCase.displayName}`, exact: true }).click();
  await expect(page.getByText("任务中还没有用例")).toBeVisible({ timeout: 20_000 });

  await page.goto("/cases");
  await page.getByRole("button", { name: "导入用例" }).click();
  const caseImportDialog = page.getByLabel("导入用例", { exact: true });
  await expect(caseImportDialog).toBeVisible();
  await caseImportDialog.getByLabel("选择用例表格文件").setInputFiles({
    name: "cases.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `用例路径\n${taskCase.className.replaceAll(".", "/")}\ncom/example/NoSuchCase\n`,
      "utf8",
    ),
  });
  await caseImportDialog.getByRole("button", { name: "解析并预览" }).click();
  await expect(caseImportDialog.locator(".case-import-result")).toContainText(
    "匹配 1 个 · 未匹配 1 个",
  );
  await expect(caseImportDialog.getByText("com/example/NoSuchCase")).toBeVisible();
  await caseImportDialog.getByRole("button", { name: "勾选匹配用例" }).click();
  await expect(caseImportDialog).toHaveCount(0);
  await expect(page.locator(".selection-toolbar")).toContainText("已选 1");
  await expect(page.locator(".inline-feedback")).toContainText("已从表格勾选 1 个用例");
  await expect(page.getByLabel(`选择 ${taskCase.displayName}`)).toBeChecked();

  await page.getByLabel(`选择 ${taskCase.displayName}`).uncheck();
  await page.getByRole("button", { name: "导入用例" }).click();
  const xlsxImportDialog = page.getByLabel("导入用例", { exact: true });
  await xlsxImportDialog.getByLabel("选择用例表格文件").setInputFiles({
    name: "中文用例列表.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(
      caseListXlsx([
        ["用例路径", "备注"],
        [taskCase.className, "中文备注"],
        ["com.example.不存在的用例", "应显示为未匹配"],
      ]),
    ),
  });
  await expect(xlsxImportDialog.getByText(/已读取 中文用例列表\.xlsx，共 2 条路径/)).toBeVisible();
  await xlsxImportDialog.getByRole("button", { name: "解析并预览" }).click();
  await expect(xlsxImportDialog.locator(".case-import-result")).toContainText(
    "匹配 1 个 · 未匹配 1 个",
  );
  await expect(xlsxImportDialog.getByText("com.example.不存在的用例")).toBeVisible();
  await captureUi(page, "case-list-xlsx-import");
  await xlsxImportDialog.getByRole("button", { name: "勾选匹配用例" }).click();
  await expect(page.getByLabel(`选择 ${taskCase.displayName}`)).toBeChecked();

  await page.getByRole("button", { name: "导入用例" }).click();
  const pasteImportDialog = page.getByLabel("导入用例", { exact: true });
  await expect(pasteImportDialog).toBeVisible();
  await pasteImportDialog.getByLabel("粘贴用例路径").fill(taskCase.className);
  await pasteImportDialog.getByRole("button", { name: "解析并预览" }).click();
  await expect(pasteImportDialog.getByRole("status")).toContainText("匹配 1 个");
  await pasteImportDialog.getByRole("button", { name: "勾选匹配用例" }).click();
  await expect(pasteImportDialog).toHaveCount(0);
  await expect(page.locator(".selection-toolbar")).toContainText("已选 1");

  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: "E2E Runner",
      labels: ["linux", "java", "testng"],
      capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.2.0",
      protocolVersion: 1,
      terminalEnabled: true,
    },
  });
  expect(registration.status()).toBe(201);
  const identity = (await registration.json()) as { runnerId: string; credential: string };
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${identity.credential}` },
      data: {
        schemaVersion: 1,
        busySlots: 1,
        labels: ["linux", "java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: true,
        resourceSnapshot: {
          cpuUtilizationPercent: 24,
          memoryUtilizationPercent: 38,
          loadAverage1m: 0.6,
          logicalCpuCount: 4,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(heartbeat.status()).toBe(200);
  const heartbeatResult = (await heartbeat.json()) as { terminalConnectionToken: string };
  expect(heartbeatResult.terminalConnectionToken).toBeTruthy();

  await page.goto("/cases");
  await page.getByLabel("页内搜索用例").fill(taskCase.displayName);
  await page.getByLabel(`选择 ${taskCase.displayName}`).check();
  await page.getByRole("button", { name: "目标用例任务", exact: true }).click();
  await page.getByRole("option", { name: "每日冒烟测试", exact: true }).click();
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.locator(".inline-feedback")).toContainText("已将 1 个用例加入任务");

  await configureTaskExecution(page, dailySuiteId, identity.runnerId, { retryLimit: 2 });
  const batch = await startTaskFromTopbar(page, dailySuiteId);
  await expect(page).toHaveURL(new RegExp(`/run-batches/${batch.id}$`));
  await captureUi(page, "run-batch-details");

  const firstClaim = await claimAssignment(page, identity);
  const firstAttemptId = firstClaim.assignment.attemptId;
  const testJarInput = firstClaim.assignment.executionSpec.inputs.find(
    (input) => input.kind === "test-jar",
  );
  expect(testJarInput).toBeTruthy();
  const downloadedInput = await page.request.get(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/inputs/${encodeURIComponent(testJarInput!.inputId)}`,
    { headers: runnerHeaders(identity, firstClaim.lease.token) },
  );
  expect(downloadedInput.status()).toBe(200);
  const downloadedJar = await downloadedInput.body();
  expect(downloadedJar.byteLength).toBe(testJarInput!.sizeBytes);
  expect(createHash("sha256").update(downloadedJar).digest("hex")).toBe(testJarInput!.sha256);

  const rawFailureSummary =
    "java.lang.AssertionError: 中文断言失败\n第二行错误详情：" +
    "预期值与实际值不一致；".repeat(40);
  const expectedFailureSummary = rawFailureSummary.replace(/\s+/g, " ");
  const encodedFailureSummary = Buffer.from(rawFailureSummary, "utf8").toString("base64");
  const firstLog = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/logs`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: "e2e-log-first",
        leaseToken: firstClaim.lease.token,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content:
              "INFO testng runner started\nWARN flaky selector detected\n\u001b[31mERROR first attempt assertion failed\u001b[0m\n" +
              `Stack Trace:\n${rawFailureSummary}\n\tat com.example.CheckoutCase.checkout(CheckoutCase.java:42)\n\n` +
              `TestCase Run Failed Stack Base64: [${encodedFailureSummary}]\n`,
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  expect(firstLog.status()).toBe(200);
  expect(await firstLog.json()).toMatchObject({ acknowledgedSequence: { stdout: 0 } });

  const report = Buffer.from("AutoForge E2E report\n", "utf8");
  const reportDeclaration = {
    artifactId: "e2e-report",
    relativePath: "reports/testng/e2e-report.txt",
    mediaType: "text/plain",
    sizeBytes: report.byteLength,
    sha256: createHash("sha256").update(report).digest("hex"),
    required: false,
  };
  const artifactDeclaration = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/artifacts`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: "e2e-artifact-declare",
        leaseToken: firstClaim.lease.token,
        artifacts: [reportDeclaration],
      },
    },
  );
  expect(artifactDeclaration.status()).toBe(200);
  const declaredArtifact = (
    (await artifactDeclaration.json()) as {
      artifacts: Array<{ uploadPath: string; uploadMethod: string; finalizePath?: string }>;
    }
  ).artifacts[0]!;
  if (declaredArtifact.uploadMethod === "control-plane") {
    const artifactUpload = await page.request.put(declaredArtifact.uploadPath, {
      headers: runnerHeaders(identity, firstClaim.lease.token),
      data: report,
    });
    expect(artifactUpload.status()).toBe(200);
  } else {
    expect(declaredArtifact.uploadMethod).toBe("direct");
    expect(declaredArtifact.finalizePath).toBeTruthy();
    const directUpload = await page.request.put(declaredArtifact.uploadPath, { data: report });
    expect([200, 204]).toContain(directUpload.status());
    const finalize = await page.request.post(declaredArtifact.finalizePath!, {
      headers: runnerHeaders(identity, firstClaim.lease.token),
    });
    expect(finalize.status()).toBe(200);
  }

  const failedCompletion = await completeAttempt(page, identity, firstClaim, {
    completionId: "e2e-completion-failed",
    status: "failed",
    resultCode: "TEST_ASSERTION_FAILED",
    summary: "E2E intentional failure",
    durationMs: 200,
    testNg: testNgResult("failed"),
    artifacts: [reportDeclaration],
  });
  expect(failedCompletion).toMatchObject({
    disposition: "accepted",
    retryScheduled: true,
  });

  const retryHeartbeat = await postHeartbeat(page, identity, 0);
  expect(retryHeartbeat.status()).toBe(200);
  const secondClaim = await claimAssignment(page, identity);
  expect(secondClaim.assignment.attemptId).not.toBe(firstAttemptId);
  expect(secondClaim.assignment.executionSpec.executionRunId).toBe(
    firstClaim.assignment.executionSpec.executionRunId,
  );
  const secondLog = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(secondClaim.assignment.attemptId)}/logs`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: "e2e-log-retry",
        leaseToken: secondClaim.lease.token,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "retry passed\n",
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  expect(secondLog.status()).toBe(200);
  const successfulCompletion = await completeAttempt(page, identity, secondClaim, {
    completionId: "e2e-completion-succeeded",
    status: "succeeded",
    resultCode: "TESTNG_SUCCEEDED",
    summary: "E2E retry passed",
    durationMs: 120,
    testNg: testNgResult("succeeded"),
    artifacts: [],
  });
  expect(successfulCompletion).toMatchObject({
    disposition: "accepted",
    retryScheduled: false,
  });

  const userHeaders = await browserSessionHeaders(page);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/run-batches/${encodeURIComponent(batch.id)}`,
        { headers: userHeaders },
      );
      expect(response.status()).toBe(200);
      return (await response.json()) as {
        status: string;
        succeededRuns: number;
        attempts: Array<{ id: string; attemptNumber: number }>;
      };
    })
    .toMatchObject({ status: "succeeded", succeededRuns: 1, attempts: [{}, {}] });

  const completedBatch = (await (
    await page.request.get(`/api/v1/run-batches/${encodeURIComponent(batch.id)}`, {
      headers: userHeaders,
    })
  ).json()) as {
    attempts: Array<{ attemptNumber: number; resultSummary?: string }>;
    runs: Array<{ caseDefinitionId: string }>;
  };
  // 失败摘要应取 adapter 标记行（"Stack Trace:" 后第一行），而不是日志尾部启发式匹配到的
  // ANSI 着色 ERROR 行；摘要只保留堆栈行本身，不拼接类路径前缀。
  expect(
    completedBatch.attempts.find((attempt) => attempt.attemptNumber === 1)?.resultSummary,
  ).toBe(expectedFailureSummary);

  // 分析闭环必须使用 TestNG 方法计数与权威错误描述：一次失败、一次成功即 50%，
  // 成功码和断言分类码都不能再冒充“失败原因”。该断言通过真实 HTTP 完成协议写入数据，
  // 随根级 test:e2e 在 CI 运行，防止只在展示层伪装修复。
  const analyticsCaseId = completedBatch.runs[0]!.caseDefinitionId;
  await page.goto(
    `/insights?suiteId=${encodeURIComponent(dailySuiteId)}&caseDefinitionId=${encodeURIComponent(analyticsCaseId)}`,
  );
  await expect(page.locator(".insight-metric-success")).toContainText("50.0%");
  await expect(page.locator(".insight-metric-danger")).toContainText("50.0%");
  const failureReasonCard = page.locator(".insight-failure-card");
  await expect(failureReasonCard).toContainText("java.lang.AssertionError: 中文断言失败");
  await expect(failureReasonCard).not.toContainText("TESTNG_SUCCEEDED");
  await expect(failureReasonCard).not.toContainText("TEST_ASSERTION_FAILED");
  const trendRow = page.locator(".insight-data-table tbody tr").first();
  await expect(trendRow.locator("td").nth(1)).toHaveText("2");
  await expect(trendRow.locator("td").nth(2)).toHaveText("1");
  await expect(trendRow.locator("td").nth(3)).toHaveText("1");
  await expect(trendRow.locator("td").nth(4)).toHaveText("0");

  await page.goto("/");
  await expect(page.locator(".quality-score-row > strong")).toHaveText("50.0");
  await expect(page.locator(".design-failure-card")).toContainText(
    "java.lang.AssertionError: 中文断言失败",
  );
  await expect(page.locator(".design-failure-card")).not.toContainText("TESTNG_SUCCEEDED");

  const artifactDownload = await page.request.get(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/artifacts/e2e-report`,
    { headers: userHeaders },
  );
  expect(artifactDownload.status()).toBe(200);
  expect(artifactDownload.headers()["content-disposition"]).toContain("attachment");
  expect(await artifactDownload.body()).toEqual(report);

  await page.goto(`/run-batches/${encodeURIComponent(batch.id)}`);
  await expect(page.getByText("执行完成", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "初始轮次", exact: true }).click();
  // 失败用例的堆栈摘要直接显示在状态列，无需展开详情。
  const failureHint = page.locator(".attempt-failure-line").first();
  await expect(failureHint).toBeVisible();
  expect(await failureHint.textContent()).toBe(expectedFailureSummary);
  // 总体调度日志必须能定位用例之外/失败的异常：原因码与精简摘要都要出现在事件里。
  await page.getByRole("button", { name: "总体调度日志" }).click();
  await expect(page.locator(".scheduling-log")).toContainText("TEST_ASSERTION_FAILED");
  await expect(page.locator(".scheduling-log")).toContainText("中文断言失败");
  await page.keyboard.press("Escape");
  await expect(page.locator(".scheduling-log")).toHaveCount(0);
  await page.getByRole("button", { name: "查看日志" }).click();
  await expect(page.locator(".execution-log")).toContainText("first attempt assertion failed");
  await expect(page.locator(".execution-log")).toHaveClass(/execution-log-dark/);
  await expect(
    page.locator(".execution-log .ansi-red").filter({ hasText: "first attempt assertion failed" }),
  ).toContainText("first attempt assertion failed");
  await expect(page.locator(".execution-log .log-level-info")).toContainText("INFO");
  await expect(page.locator(".execution-log .log-level-warn")).toContainText("WARN");
  await expect(page.locator(".execution-log .log-level-error").first()).toContainText("ERROR");
  await expect(page.locator(".execution-log")).not.toContainText(
    "TestCase Run Failed Stack Base64",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".execution-log")).toHaveCount(0);
  // 需求5后单用例不再自动展开，需显式点击详情才能看到产物列表。
  await page
    .getByRole("row", { name: taskCase.displayName })
    .getByRole("button", { name: "详情" })
    .click();
  await expect(page.getByText("reports/testng/e2e-report.txt")).toBeVisible();
  await expect(page.getByLabel("下载 reports/testng/e2e-report.txt")).toBeVisible();
  await expectUiConsistency(page);

  // 执行结果导出：弹窗默认失败+阻塞，补选成功后当前轮次两次尝试都应进入 Excel。
  await page.getByRole("button", { name: "导出结果" }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出执行结果" });
  await expect(exportDialog).toBeVisible();
  await exportDialog.getByLabel("成功", { exact: true }).check();
  // 弹窗通过 anchor[download] 触发浏览器下载，Playwright 会把响应体转交给 download
  // 事件（response.body() 此时为空），因此从 download 事件读取实际文件内容。
  const downloadPromise = page.waitForEvent("download");
  const exportResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/export"),
  );
  await exportDialog.getByRole("button", { name: "导出 Excel" }).click();
  const exportResponse = await exportResponsePromise;
  expect(exportResponse.status()).toBe(200);
  expect(exportResponse.headers()["content-type"]).toContain("spreadsheetml");
  expect(exportResponse.headers()["content-disposition"]).toContain("attachment");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain(".xlsx");
  const exportBody = new Uint8Array(await readFile(await download.path()));
  // xlsx 即 zip，首 4 字节必须是 PK\x03\x04 本地文件头。
  expect(Array.from(exportBody.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  const sharedStrings = new TextDecoder("utf-8").decode(
    unzipSync(exportBody)["xl/sharedStrings.xml"],
  );
  const sharePath = /\/share\/attempt-log\/[\w-]+/.exec(sharedStrings)?.[0];
  expect(sharePath).toBeTruthy();
  const failureShareResponse = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(firstAttemptId)}/log-share`,
    { headers: { ...userHeaders, origin: new URL(page.url()).origin } },
  );
  expect(failureShareResponse.status()).toBe(200);
  const failureSharePath = new URL(
    ((await failureShareResponse.json()) as { shareUrl: string }).shareUrl,
    page.url(),
  ).pathname;
  // 下载成功后弹窗自动关闭。
  await expect(page.getByRole("dialog", { name: "导出执行结果" })).toHaveCount(0);

  // 日志公开访问链接必须免登录可访问，且展示 adapter 完整日志；无效 token 显示失效提示而非跳登录。
  const anonymousContext = await page.context().browser()!.newContext();
  try {
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto(sharePath!);
    expect(anonymousPage.url()).toContain("/share/attempt-log/");
    await expect(anonymousPage.getByText("用例路径", { exact: true }).first()).toBeVisible();
    await expect(anonymousPage.locator(".share-log-output")).toContainText(
      /first attempt assertion failed|retry passed/,
    );
    await anonymousPage.goto(failureSharePath);
    const sharedSummary = anonymousPage.locator(".share-log-summary");
    await expect(sharedSummary).toBeVisible();
    expect(await sharedSummary.textContent()).toBe(expectedFailureSummary);
    await expect(anonymousPage.locator(".share-log-output")).not.toContainText(
      "TestCase Run Failed Stack Base64",
    );
    await anonymousPage.goto("/share/attempt-log/e2e-invalid-token");
    await expect(anonymousPage.getByRole("heading", { name: "链接无效" })).toBeVisible();
  } finally {
    await anonymousContext.close();
  }

  const cancellationBatch = await createTaskRun(page, dailySuiteId);
  await page.goto(`/run-batches/${encodeURIComponent(cancellationBatch.id)}`);
  page.once("dialog", (dialog) => dialog.accept("E2E single run cancellation"));
  await page.getByRole("button", { name: "取消该用例" }).click();
  await expect(page.getByText("已取消", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const cancelledBatchDetails = (await (
    await page.request.get(`/api/v1/run-batches/${encodeURIComponent(cancellationBatch.id)}`, {
      headers: userHeaders,
    })
  ).json()) as { attempts: Array<{ id: string }> };
  const expectedSampleCount =
    completedBatch.attempts.length + cancelledBatchDetails.attempts.length;

  await page.goto(
    `/insights?suiteId=${encodeURIComponent(dailySuiteId)}&caseDefinitionId=${encodeURIComponent(taskCase.id)}`,
  );
  await expect(
    page
      .getByText("执行样本")
      .locator("..")
      .getByText(String(expectedSampleCount), { exact: true }),
  ).toBeVisible();
  const filteredFailureReasons = page.locator(".failure-signature-list");
  await expect(filteredFailureReasons).toContainText("java.lang.AssertionError: 中文断言失败");
  await expect(filteredFailureReasons).not.toContainText("TEST_ASSERTION_FAILED");
  await expect(filteredFailureReasons).not.toContainText("TESTNG_SUCCEEDED");
  await expectUiConsistency(page);

  await page.goto(
    `/insights?outcome=succeeded&leftBatchId=${encodeURIComponent(batch.id)}&rightBatchId=${encodeURIComponent(cancellationBatch.id)}`,
  );
  await expect(page.getByLabel("结果")).toHaveValue("succeeded");
  await expect(page.getByText(/共同用例 1 个/)).toBeVisible();
  await page.getByRole("button", { name: "导出当前范围" }).click();
  const exportLink = page.getByRole("link", { name: /下载 \d+ 行/ });
  await expect(exportLink).toBeVisible({ timeout: 30_000 });
  const exportHref = await exportLink.getAttribute("href");
  expect(exportHref).toBeTruthy();
  const exportDownload = await page.request.get(exportHref!);
  expect(exportDownload.status()).toBe(200);
  expect(exportDownload.headers()["content-type"]).toContain("text/csv");
  expect(await exportDownload.text()).toContain("case_definition_id");

  const jsonExport = await page.evaluate(async (idempotencyKey) => {
    const response = await fetch("/api/v1/analytics/exports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ filter: { outcome: "succeeded" }, format: "json" }),
    });
    return {
      status: response.status,
      job: (await response.json()) as { id: string; status: string },
    };
  }, randomUUID());
  expect(jsonExport.status).toBe(202);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/v1/analytics/exports/${encodeURIComponent(jsonExport.job.id)}`,
        );
        expect(response.status()).toBe(200);
        return ((await response.json()) as { status: string }).status;
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe("succeeded");
  const jsonDownload = await page.request.get(
    `/api/v1/analytics/exports/${encodeURIComponent(jsonExport.job.id)}/download`,
  );
  expect(jsonDownload.status()).toBe(200);
  expect(jsonDownload.headers()["content-type"]).toContain("application/json");
  const jsonRows = (await jsonDownload.json()) as Array<Record<string, unknown>>;
  expect(jsonRows.length).toBeGreaterThan(0);
  expect(jsonRows.every((row) => row.outcome === "succeeded")).toBe(true);

  expect(await searchKinds(page, taskCase.displayName)).toContain("case");
  expect(await searchKinds(page, "每日冒烟测试")).toEqual(
    expect.arrayContaining(["suite", "batch"]),
  );
  expect(await searchKinds(page, "E2E Runner")).toContain("runner");

  const agentSocket = new WebSocket(terminalStreamUrl(), "autoforge-runner-terminal-v1", {
    headers: { authorization: `Bearer ${heartbeatResult.terminalConnectionToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    agentSocket.once("open", resolve);
    agentSocket.once("error", reject);
  });

  await page.goto("/runners");
  const e2eRunnerRow = page
    .getByRole("row")
    .filter({ has: page.getByText("E2E Runner", { exact: true }) });
  await expect(e2eRunnerRow).toBeVisible();
  await expectUiConsistency(page);
  await e2eRunnerRow.getByRole("button", { name: "终端浮窗" }).click();

  const openCommand = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Agent did not receive terminal open command")),
      10_000,
    );
    agentSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "open") {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
  await page.getByRole("button", { name: "连接终端" }).click();
  const command = await openCommand;
  const sessionId = String(command.sessionId);
  agentSocket.send(JSON.stringify({ schemaVersion: 1, type: "ready", sessionId }));
  agentSocket.send(
    JSON.stringify({
      schemaVersion: 1,
      type: "output",
      sessionId,
      data: Buffer.from("direct-terminal-ready\r\n").toString("base64"),
    }),
  );
  await expect(page.locator(".terminal-viewport")).toContainText("direct-terminal-ready");
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expectUiConsistency(page);
  await captureUi(page, "runner-terminal");
  await page.getByRole("button", { name: "关闭终端" }).click();
  agentSocket.close();

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /E2E Administrator/ })).toBeVisible();
  await expectDesktopLayoutFits(page, 1024, 768);
  await expectDesktopLayoutFits(page, 1920, 1080);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect(page.getByRole("heading", { level: 1, name: /E2E Administrator/ })).toBeVisible();
  await expect(page.getByLabel("全局搜索")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await expectDesktopLayoutFits(page, 1920, 1080);
  await expectUiConsistency(page);
  await captureUi(page, "dashboard");

  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/v1/notifications?unreadOnly=false&limit=30");
        if (!response.ok()) return false;
        const body = (await response.json()) as { items: Array<{ title: string }> };
        return body.items.some((notification) => notification.title === "执行批次已完成");
      },
      { timeout: 40_000, intervals: [500, 1_000] },
    )
    .toBe(true);
  await page.getByRole("button", { name: "通知" }).click();
  await expect(page.getByText("通知中心")).toBeVisible();
  const completionNotification = page
    .locator(".notification-item")
    .filter({ hasText: "执行批次已完成" })
    .first();
  await expect(completionNotification).toBeVisible();
  await completionNotification.click();
  await expect(completionNotification).toHaveClass(/read/);
  await expectUiConsistency(page);
  await page.getByRole("button", { name: "关闭通知" }).click();
  await page.reload();
  await page.getByRole("button", { name: "通知" }).click();
  await expect(
    page.locator(".notification-item.read").filter({ hasText: "执行批次已完成" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭通知" }).click();

  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await selectJarForInspection(page, {
    name: "source-visible-tests-sources.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(sourcesJar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.SourceVisibleTest")).toBeVisible();
  await expect(page.getByText("这是 sources JAR")).toBeVisible();
  await expect(page.getByText("可查看源码", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.locator(".alert-success")).toContainText("已导入 1 个测试类、1 个测试方法", {
    timeout: 60_000,
  });
  await page.getByRole("link", { name: "查看用例管理" }).click();
  await page.getByLabel("页内搜索用例").fill("SourceVisibleTest");
  await page.getByRole("button", { name: "查看 SourceVisibleTest" }).click();
  await page.locator(".case-inspector-section").getByText("用例源码", { exact: true }).click();
  await expect(page.locator(".case-inspector-pane .source-code-viewer").first()).toContainText(
    "AUTOFORGE_SOURCE_VIEW_E2E",
  );
  await expect(page.getByText(/不能直接执行/)).toBeVisible();
  await expect(page.getByRole("button", { name: "立即执行" })).toHaveCount(0);

  await page.goto("/settings/access?section=users");
  await expect(page.getByRole("heading", { name: "用户管理" }).first()).toBeVisible();
  await expect(page.locator(".settings-stack > .settings-section")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "身份权限模块" })).toHaveCount(0);
  await page.goto("/settings/access?section=ldap");
  await expect(page.getByRole("heading", { name: "LDAP 目录" })).toBeVisible();
  await expect(page.locator(".settings-stack > .settings-section")).toHaveCount(1);

  await page.goto("/audit");
  const operationsNavigation = page.getByRole("navigation", { name: "运维审计" });
  await expect(operationsNavigation).toBeVisible();
  await operationsNavigation.getByRole("link", { name: "运维计划" }).click();
  await expect(page.getByRole("heading", { name: "计划与目录作业" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "运维审计" })).toBeVisible();

  for (const route of ["/settings/platform", "/settings/access"]) {
    await page.goto(route);
    await expect(page.getByRole("navigation", { name: "管理中心模块" })).toHaveCount(0);
    await expectUiConsistency(page);
    if (route === "/settings/platform") {
      await expect(page.getByLabel("JAR 大小上限（MiB）")).toHaveValue("256");
    }
  }

  await page.goto("/forbidden");
  await expect(page.getByText("没有访问权限")).toBeVisible();
  await expectUiConsistency(page);

  const secondaryBaseUrl = process.env.E2E_SECONDARY_BASE_URL;
  if (secondaryBaseUrl) {
    await page.goto(new URL("/", secondaryBaseUrl).toString());
    await expect(page.getByRole("heading", { level: 1, name: /E2E Administrator/ })).toBeVisible();
    const secondaryReadiness = await page.request.get(
      new URL("/api/v1/health/ready", secondaryBaseUrl).toString(),
    );
    expect(secondaryReadiness.status()).toBe(200);
  }

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expectUiConsistency(page);

  const loginUsername = page.getByLabel("用户名");
  await loginUsername.focus();
  const focusStyles = await loginUsername.evaluate((input) => {
    const label = input.closest("label");
    return {
      inputBoxShadow: window.getComputedStyle(input).boxShadow,
      labelOutlineStyle: label ? window.getComputedStyle(label).outlineStyle : "missing",
    };
  });
  expect(focusStyles.labelOutlineStyle).toBe("none");
  expect(focusStyles.inputBoxShadow).not.toBe("none");

  await loginUsername.fill(E2E_ADMIN_USERNAME);
  await page.getByLabel("密码").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /E2E Administrator/ })).toBeVisible();
  const authenticatedSession = await page.request.get("/api/v1/auth/session");
  expect(authenticatedSession.status()).toBe(200);
});

function terminalStreamUrl(): string {
  const url = new URL(
    "/api/v1/terminal-stream",
    process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function ensureProjectHierarchy(page: Page): Promise<void> {
  const structureResponse = await page.request.get(
    `/api/v1/projects/${encodeURIComponent(DEFAULT_PROJECT_ID)}/structure`,
  );
  expect(structureResponse.status()).toBe(200);
  const structure = (await structureResponse.json()) as {
    versions: Array<{ id: string; stages: Array<{ id: string }> }>;
  };
  let version = structure.versions[0];
  const headers = { origin: new URL(page.url()).origin };
  if (!version) {
    const versionResponse = await page.request.post(
      `/api/v1/projects/${encodeURIComponent(DEFAULT_PROJECT_ID)}/versions`,
      { data: { name: "E2E 版本" }, headers },
    );
    expect(versionResponse.status()).toBe(201);
    version = { ...(await versionResponse.json()), stages: [] } as {
      id: string;
      stages: Array<{ id: string }>;
    };
  }
  if (version.stages.length > 0) return;
  const stageResponse = await page.request.post(
    `/api/v1/projects/${encodeURIComponent(DEFAULT_PROJECT_ID)}/versions/${encodeURIComponent(version.id)}/stages`,
    { data: { name: "E2E 测试阶段", description: "端到端测试层级" }, headers },
  );
  expect(stageResponse.status()).toBe(201);
}

type RunnerIdentity = { runnerId: string; credential: string };

type ClaimedAssignment = {
  assignment: {
    attemptId: string;
    executionSpec: {
      executionRunId: string;
      inputs: Array<{ inputId: string; kind: string; sizeBytes: number; sha256: string }>;
    };
  };
  lease: { token: string };
};

async function claimAssignment(page: Page, identity: RunnerIdentity): Promise<ClaimedAssignment> {
  const deadline = Date.now() + 15_000;
  let requestNumber = 0;
  while (Date.now() < deadline) {
    requestNumber += 1;
    const response = await page.request.post(
      `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/claims`,
      {
        headers: { authorization: `Bearer ${identity.credential}` },
        data: {
          schemaVersion: 1,
          requestId: `e2e-claim-${requestNumber}-${randomUUID()}`,
          availableSlots: 1,
          labels: ["linux", "java", "testng"],
          capabilities: [
            "executor:testng-v1",
            "isolation:cgroup-v2",
            "java:21.0.8",
            "testng:7.11.0",
          ],
          waitSeconds: 0,
        },
      },
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { assignments: ClaimedAssignment[] };
    if (body.assignments[0]) return body.assignments[0];
    await page.waitForTimeout(250);
  }
  throw new Error("Runner did not receive an assignment within 15 seconds.");
}

async function completeAttempt(
  page: Page,
  identity: RunnerIdentity,
  claim: ClaimedAssignment,
  result: {
    completionId: string;
    status: "succeeded" | "failed" | "timed_out" | "cancelled";
    resultCode: string;
    summary: string;
    durationMs: number;
    testNg?: ReturnType<typeof testNgResult>;
    artifacts: Array<Record<string, unknown>>;
  },
): Promise<Record<string, unknown>> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(claim.assignment.attemptId)}/complete`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        completionId: result.completionId,
        leaseToken: claim.lease.token,
        result: {
          status: result.status,
          resultCode: result.resultCode,
          summary: result.summary,
          durationMs: result.durationMs,
          ...(result.testNg ? { testNg: result.testNg } : {}),
          logWatermarks: { stdout: 0, stderr: -1, agent: -1 },
          artifacts: result.artifacts,
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function testNgResult(outcome: "succeeded" | "failed") {
  return {
    total: 1,
    passed: outcome === "succeeded" ? 1 : 0,
    failed: outcome === "failed" ? 1 : 0,
    skipped: 0,
    configurationFailures: 0,
    detailsTruncated: true,
    suites: [],
  };
}

async function postHeartbeat(page: Page, identity: RunnerIdentity, busySlots: number) {
  return page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${identity.credential}` },
      data: {
        schemaVersion: 1,
        busySlots,
        labels: ["linux", "java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: true,
        resourceSnapshot: {
          cpuUtilizationPercent: 24,
          memoryUtilizationPercent: 38,
          loadAverage1m: 0.6,
          logicalCpuCount: 4,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
}

function runnerHeaders(identity: RunnerIdentity, leaseToken?: string): Record<string, string> {
  return {
    authorization: `Bearer ${identity.credential}`,
    "x-autoforge-runner-id": identity.runnerId,
    ...(leaseToken ? { "x-autoforge-lease-token": leaseToken } : {}),
  };
}

async function browserSessionHeaders(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  return { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; ") };
}

async function searchKinds(page: Page, query: string): Promise<string[]> {
  const response = await page.request.get(`/api/v1/search?query=${encodeURIComponent(query)}`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<{ kind: string }> };
  return body.items.map((item) => item.kind);
}

async function expectDesktopLayoutFits(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      })),
    )
    .toEqual({ viewportWidth: width, documentWidth: width });
}

async function expectUiConsistency(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const minimumFontSize = 12;
    const minimumControlSize = 32;
    const isVisible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    };
    const label = (element: HTMLElement) =>
      (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 80);
    const hasDirectText = (element: HTMLElement) =>
      Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );

    const fontViolations = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .filter((element) => isVisible(element) && hasDirectText(element))
      .map((element) => ({
        element: element.tagName.toLowerCase(),
        fontSize: Number.parseFloat(window.getComputedStyle(element).fontSize),
        label: label(element),
      }))
      .filter(({ fontSize }) => fontSize > 0 && fontSize < minimumFontSize)
      .slice(0, 20);

    const controlSelector = [
      "button",
      'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"])',
      "select",
      "textarea",
      "a.button",
      "a.primary-button",
      "a.secondary-button",
      "a.icon-button",
    ].join(",");
    const controlViolations = Array.from(
      document.body.querySelectorAll<HTMLElement>(controlSelector),
    )
      .filter(isVisible)
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          element: element.tagName.toLowerCase(),
          height: Math.round(bounds.height * 10) / 10,
          label: label(element),
        };
      })
      .filter(({ height }) => height < minimumControlSize)
      .slice(0, 20);

    return {
      controlViolations,
      documentWidth: document.documentElement.scrollWidth,
      fontViolations,
      viewportWidth: window.innerWidth,
    };
  });

  expect(report.fontViolations, "visible text smaller than 12px").toEqual([]);
  expect(report.controlViolations, "visible controls shorter than 32px").toEqual([]);
  expect(report.documentWidth, "page-level horizontal overflow").toBe(report.viewportWidth);
}
