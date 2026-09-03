import { expect, test } from "@playwright/test";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync } from "fflate";

import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("terminal task failures support durable single and batch analysis with evidence", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const suffix = uniqueName("analysis");
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: `分析版本 ${suffix}` } },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const fixture = insertFailureAnalysisFixture(
    requiredEnvironment("AUTOFORGE_E2E_DATA_DIR"),
    version.body.id,
    suffix,
  );

  await page.goto("/case-analysis");
  await expect(page.getByRole("heading", { name: "用例分析" })).toBeVisible();
  const taskCard = page
    .locator(".failure-analysis-batch-card")
    .filter({ hasText: fixture.suiteName });
  await expect(taskCard).toContainText("最终失败");
  await expect(taskCard.getByRole("button", { name: "导出分析结果" })).toBeVisible();
  for (const viewport of [
    { width: 1536, height: 960 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `failure-analysis-task-list-${viewport.width}`);
  }
  let hiddenClaimsRequests = 0;
  let duplicateInitialCandidateRequests = 0;
  const countInitialWorkspaceRequest = (request: import("@playwright/test").Request) => {
    if (request.url().includes("/api/v1/failure-analysis/claims?")) hiddenClaimsRequests += 1;
    if (request.url().includes("/api/v1/failure-analysis/candidates?")) {
      duplicateInitialCandidateRequests += 1;
    }
  };
  page.on("request", countInitialWorkspaceRequest);
  await taskCard.getByRole("link", { name: "查看用例分析详情" }).click();
  await expect(page).toHaveURL(new RegExp(`/case-analysis/${fixture.batchId}`));
  await expect(page.getByText(fixture.failedNames[0], { exact: true })).toBeVisible();
  await expect(page.getByText(fixture.passedName, { exact: true })).toHaveCount(0);
  for (const viewport of [
    { width: 1536, height: 960 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `failure-analysis-claim-${viewport.width}`);
  }
  expect(hiddenClaimsRequests).toBe(0);
  expect(duplicateInitialCandidateRequests).toBe(0);
  expect(
    await page
      .locator(".failure-analysis-table tbody tr")
      .evaluateAll((rows) => Math.max(...rows.map((row) => row.getBoundingClientRect().height))),
  ).toBeLessThanOrEqual(58);
  page.off("request", countInitialWorkspaceRequest);

  let claimsRequestsDuringSort = 0;
  const countClaimsRequest = (request: import("@playwright/test").Request) => {
    if (request.url().includes("/api/v1/failure-analysis/claims?")) {
      claimsRequestsDuringSort += 1;
    }
  };
  page.on("request", countClaimsRequest);
  const sortedCandidates = page.waitForResponse((response) =>
    response.url().includes("/api/v1/failure-analysis/candidates?"),
  );
  await page.getByRole("button", { name: "失败堆栈" }).click();
  await sortedCandidates;
  expect(claimsRequestsDuringSort).toBe(0);
  page.off("request", countClaimsRequest);

  const classSortResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/failure-analysis/candidates" &&
      url.searchParams.get("sort") === "class_path" &&
      url.searchParams.get("direction") === "asc"
    );
  });
  await page.getByRole("button", { name: "类路径" }).click();
  expect((await classSortResponse).status()).toBe(200);
  const temporarilyClaimedName = fixture.failedNames[0];
  await page.getByLabel(`认领 ${temporarilyClaimedName}`).check();
  await page.getByRole("button", { name: "认领并进入分析" }).click();
  await expect(page.getByRole("heading", { name: "我的分析队列" })).toBeVisible();

  const rankedCandidateResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/failure-analysis/candidates?"),
  );
  await page.getByRole("button", { name: "返回继续认领" }).click();
  expect((await rankedCandidateResponse).status()).toBe(200);
  const rankedCandidateRows = page.locator(".failure-analysis-table tbody tr");
  await expect(rankedCandidateRows.last()).toContainText(temporarilyClaimedName);
  await expect(rankedCandidateRows.last()).toContainText("已认领");
  await expect(page.getByRole("tab", { name: "我的分析 1" })).toBeVisible();
  await expect(page.getByLabel("任务分析概览")).toContainText("已认领 1");

  await page.reload();
  await expect(page.getByRole("tab", { name: "我的分析 1" })).toBeVisible();
  await expect(page.getByLabel("任务分析概览")).toContainText("已认领 1");

  const myClaimsResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/failure-analysis/claims?"),
  );
  await page.getByRole("tab", { name: /我的分析/u }).click();
  expect((await myClaimsResponse).status()).toBe(200);
  const temporarilyClaimedCard = analysisCard(page, temporarilyClaimedName);
  await temporarilyClaimedCard.getByRole("button", { name: "取消认领" }).click();
  const releaseDialog = page.getByRole("alertdialog", {
    name: `取消认领 ${temporarilyClaimedName}`,
  });
  const releaseAction = releaseDialog.getByRole("button", { name: "确认取消认领" });
  await expect(releaseDialog).toContainText("其他分析人员可以立即认领该用例");
  await expect(releaseAction).toBeDisabled();
  await releaseDialog.getByLabel("取消原因 *").fill("误领，需要由环境负责人分析");
  await expect(releaseAction).toBeEnabled();
  await expectDialogFitsViewport(page, releaseDialog);
  await captureUi(page, "failure-analysis-release-claim-1024", false);
  const releaseResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/failure-analysis/claims/") &&
      response.url().endsWith("/release"),
  );
  await releaseAction.click();
  expect((await releaseResponse).status()).toBe(200);
  await expect(releaseDialog).toBeHidden();
  await expect(temporarilyClaimedCard).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "我的分析 0" })).toBeVisible();
  await expect(page.getByLabel("任务分析概览")).toContainText("已认领 0");

  const releasedCandidateResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/failure-analysis/candidates?"),
  );
  await page.getByRole("button", { name: "返回继续认领" }).click();
  expect((await releasedCandidateResponse).status()).toBe(200);
  const releasedCandidateRow = page
    .locator(".failure-analysis-table tbody tr")
    .filter({ hasText: temporarilyClaimedName });
  await expect(releasedCandidateRow).toContainText("待认领");

  await page.getByLabel("选择本页全部未认领用例").check();
  await expect(page.locator(".failure-analysis-floating-action")).toContainText("已选择 4 个用例");
  let tabServerComponentRequests = 0;
  const countTabServerComponentRequest = (request: import("@playwright/test").Request) => {
    if (
      request.url().includes(`case-analysis/${fixture.batchId}`) &&
      request.url().includes("_rsc=")
    ) {
      tabServerComponentRequests += 1;
    }
  };
  page.on("request", countTabServerComponentRequest);
  await page.getByRole("button", { name: "认领并进入分析" }).click();
  await expect(page.getByRole("heading", { name: "我的分析队列" })).toBeVisible();
  const claimSortResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/failure-analysis/claims" &&
      url.searchParams.get("sort") === "failure_summary" &&
      url.searchParams.get("direction") === "asc"
    );
  });
  await page.getByRole("button", { name: "我的分析排序字段" }).click();
  await page.getByRole("option", { name: "失败堆栈", exact: true }).click();
  expect((await claimSortResponse).status()).toBe(200);
  const descendingClaimsResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/failure-analysis/claims" &&
      url.searchParams.get("sort") === "failure_summary" &&
      url.searchParams.get("direction") === "desc"
    );
  });
  await page.getByRole("button", { name: "当前升序，点击切换为降序" }).click();
  expect((await descendingClaimsResponse).status()).toBe(200);
  await expect(page.locator(".failure-analysis-card h3").first()).toHaveText(
    fixture.failedNames[3],
  );
  expect(
    await page
      .locator(".failure-analysis-card")
      .evaluateAll((cards) =>
        Math.max(...cards.map((card) => card.getBoundingClientRect().height)),
      ),
  ).toBeLessThanOrEqual(92);
  for (const viewport of [
    { width: 1536, height: 960 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `failure-analysis-workspace-${viewport.width}`);
  }
  expect(tabServerComponentRequests).toBe(0);
  page.off("request", countTabServerComponentRequest);

  const firstCard = analysisCard(page, fixture.failedNames[0]);
  const secondCard = analysisCard(page, fixture.failedNames[1]);
  await firstCard.getByRole("checkbox").check();
  await secondCard.getByRole("checkbox").check();
  await page.getByRole("button", { name: "批量分析" }).click();
  const batchDialog = page.getByRole("dialog", { name: "批量分析 2 个用例" });
  await expect(batchDialog.getByText(fixture.failedNames[0], { exact: true })).toBeVisible();
  await expect(batchDialog.getByRole("button", { name: "弹窗日志" })).toHaveCount(2);
  await expectDialogFitsViewport(page, batchDialog);
  await captureUi(page, "failure-analysis-batch-dialog-1024", false);
  const popupPromise = page.waitForEvent("popup");
  await batchDialog.getByRole("button", { name: "公开日志" }).first().click();
  const publicLogPage = await popupPromise;
  await expect(publicLogPage).toHaveURL(/\/share\/attempt-log\//u);
  await publicLogPage.close();
  await batchDialog.getByLabel("用例问题已修改", { exact: false }).check();
  await batchDialog.getByLabel("问题说明 *").fill("测试数据字段已经失效");
  await batchDialog.getByLabel("用例已修改证明 *").fill("commit abc123，已更新断言数据");
  await batchDialog.getByLabel("备注说明 选填").fill("相同根因批量处理");
  await captureUi(page, "failure-analysis-case-fixed-dialog-1024", false);
  await batchDialog.getByRole("button", { name: "提交分析" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认用例问题" });
  await expect(confirmation).toContainText("不要为了让执行结果通过而修改正确的校验逻辑");
  await captureUi(page, "failure-analysis-confirmation-1024", false);
  await confirmation.getByRole("button", { name: "我已核实，确认提交" }).click();
  await expect(batchDialog).toBeHidden();
  await expect(firstCard).toContainText("已完成");
  await expect(secondCard).toContainText("用例问题已修改");

  const codeCard = analysisCard(page, fixture.failedNames[2]);
  await codeCard.getByRole("button", { name: "开始分析" }).click();
  const codeDialog = page.getByRole("dialog", { name: `分析 ${fixture.failedNames[2]}` });
  await expect(codeDialog.getByText("历史分析结论", { exact: true })).toBeVisible();
  await expect(codeDialog).toContainText("BUG-1023");
  await codeDialog.getByRole("button", { name: "继承此代码问题结论" }).click();
  const inheritanceConfirmation = page.getByRole("alertdialog", {
    name: "确认继承未闭环代码问题",
  });
  await expect(inheritanceConfirmation).toContainText("问题单尚未闭环");
  await expect(inheritanceConfirmation).toContainText("当前失败仍由同一代码问题引起");
  await inheritanceConfirmation.getByRole("button", { name: "问题仍存在，继承结论" }).click();
  await expect(codeDialog.getByLabel("代码问题已提单", { exact: false })).toBeChecked();
  await expect(codeDialog.getByLabel("问题说明 *")).toHaveValue("历史状态字段转换错误");
  await expect(codeDialog.getByLabel("问题单链接或问题单号 *")).toHaveValue("BUG-1023");
  await codeDialog.getByLabel("问题说明 *").fill("后端返回的状态字段错误");
  await codeDialog.getByLabel("问题单链接或问题单号 *").fill("BUG-2048");
  await expectDialogFitsViewport(page, codeDialog);
  await captureUi(page, "failure-analysis-code-issue-dialog-1024", false);
  await codeDialog.getByRole("button", { name: "提交分析" }).click();
  await expect(codeDialog).toBeHidden();
  await expect(codeCard).toContainText("代码问题已提单");

  const rerunCard = analysisCard(page, fixture.failedNames[3]);
  await rerunCard.getByRole("button", { name: "开始分析" }).click();
  const rerunDialog = page.getByRole("dialog", { name: `分析 ${fixture.failedNames[3]}` });
  await rerunDialog.getByLabel("重跑通过", { exact: false }).check();
  await rerunDialog.getByRole("button", { name: "提交分析" }).click();
  await expect(rerunDialog).toContainText("请粘贴执行通过截图");
  await expect(rerunDialog).toContainText("直接按 Ctrl + V 粘贴执行通过截图");
  await expect(rerunDialog.locator('input[type="file"]')).toHaveCount(0);
  const pasteZone = rerunDialog.getByRole("group", {
    name: "使用 Ctrl+V 粘贴重跑通过截图",
  });
  await pasteZone.scrollIntoViewIfNeeded();
  await expect(pasteZone).toBeVisible();
  await captureUi(page, "failure-analysis-rerun-paste-1024", false);
  await pastePng(page);
  await expect(rerunDialog).toContainText("通过截图已上传到平台对象存储");
  await expect(rerunDialog.getByAltText("重跑通过截图：rerun-passed.png")).toBeVisible();
  await captureUi(page, "failure-analysis-rerun-evidence-1024", false);
  await rerunDialog.getByRole("button", { name: "提交分析" }).click();
  await expect(rerunDialog).toBeHidden();
  await expect(rerunCard).toContainText("重跑通过");

  await page.reload();
  await expect(page.getByRole("heading", { name: "我的分析队列" })).toBeVisible();
  await expect(analysisCard(page, fixture.failedNames[0])).toContainText("已完成");
  await expect(analysisCard(page, fixture.failedNames[3])).toContainText("重跑通过");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectUiIntegrity(page);
  await captureUi(page, "failure-analysis-completed-1024");
  const completedCard = analysisCard(page, fixture.failedNames[0]);
  await completedCard.getByRole("button", { name: "查看分析详情" }).click();
  const completedDialog = page.getByRole("dialog", { name: `分析 ${fixture.failedNames[0]}` });
  await expect(completedDialog.getByRole("radio")).toHaveCount(0);
  await expect(completedDialog.getByText("分析结论", { exact: true })).toBeVisible();
  await expectDialogFitsViewport(page, completedDialog);
  await captureUi(page, "failure-analysis-read-only-dialog-1024", false);
  await completedDialog.getByRole("button", { name: "关闭" }).last().click();

  const completedRerunCard = analysisCard(page, fixture.failedNames[3]);
  await completedRerunCard.getByRole("button", { name: "查看分析详情" }).click();
  const completedRerunDialog = page.getByRole("dialog", {
    name: `分析 ${fixture.failedNames[3]}`,
  });
  const screenshotThumbnail = completedRerunDialog.getByRole("button", {
    name: "放大查看截图 rerun-passed.png",
  });
  await expect(screenshotThumbnail).toBeVisible();
  await expect
    .poll(() =>
      completedRerunDialog
        .getByAltText("重跑通过截图：rerun-passed.png")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await screenshotThumbnail.click();
  const imagePreview = page.getByRole("dialog", { name: "图片预览 rerun-passed.png" });
  await expect(imagePreview.getByAltText("重跑通过截图大图：rerun-passed.png")).toBeVisible();
  await expect(imagePreview.getByLabel("当前图片缩放比例")).toHaveText("100%");
  await imagePreview.getByRole("button", { name: "放大图片" }).click();
  await expect(imagePreview.getByLabel("当前图片缩放比例")).toHaveText("125%");
  await expectDialogFitsViewport(page, imagePreview);
  await captureUi(page, "failure-analysis-image-preview-125", false);
  await imagePreview.getByRole("button", { name: "关闭图片预览" }).click();
  await completedRerunDialog.getByRole("button", { name: "关闭" }).last().click();

  const exportResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith(`/run-batches/${fixture.batchId}/export`) &&
      url.searchParams.get("template") === "failure-analysis" &&
      url.searchParams.get("scope") === "final"
    );
  });
  const analysisDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出分析结果" }).click();
  expect((await exportResponsePromise).status()).toBe(200);
  const analysisDownload = await analysisDownloadPromise;
  expect(analysisDownload.suggestedFilename()).toContain("failure-analysis-final.xlsx");
  const analysisArchive = unzipSync(
    new Uint8Array(await readFile((await analysisDownload.path())!)),
  );
  const analysisStrings = new TextDecoder("utf-8").decode(analysisArchive["xl/sharedStrings.xml"]);
  for (const persistedValue of [
    "E2E Administrator（e2e-admin）",
    "用例问题已修改",
    "测试数据字段已经失效",
    "commit abc123，已更新断言数据",
    "相同根因批量处理",
    "代码问题已提单",
    "后端返回的状态字段错误",
    "BUG-2048",
    "重跑通过",
    "rerun-passed.png",
  ]) {
    expect(analysisStrings).toContain(persistedValue);
  }
  const relationshipXml = new TextDecoder("utf-8").decode(
    analysisArchive["xl/worksheets/_rels/sheet1.xml.rels"],
  );
  expect(relationshipXml).toContain("/api/v1/failure-analysis/claims/");
  expect(relationshipXml).toContain("/share/attempt-log/");
  const evidenceLink = /Target="([^"]*\/api\/v1\/failure-analysis\/claims\/[^"]*\/evidence[^"]*)"/u
    .exec(relationshipXml)?.[1]
    ?.replaceAll("&amp;", "&");
  expect(evidenceLink).toBeTruthy();
  const evidenceResponse = await page.request.get(evidenceLink!);
  expect(evidenceResponse.status()).toBe(200);
  expect(evidenceResponse.headers()["content-type"]).toBe("image/png");
  expect(evidenceResponse.headers()["content-disposition"]).toContain("inline");

  const emptyVersion = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: `空分析版本 ${suffix}` } },
  );
  expect(emptyVersion.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, emptyVersion.body.id);
  await page.goto("/case-analysis");
  await expect(page.getByText("当前版本没有待分析的终态任务")).toBeVisible();
  for (const viewport of [
    { width: 1536, height: 960 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `failure-analysis-empty-${viewport.width}`);
  }
});

async function captureUi(
  page: import("@playwright/test").Page,
  name: string,
  fullPage = false,
): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDirectory, `${name}.png`), fullPage });
}

async function expectDialogFitsViewport(
  page: import("@playwright/test").Page,
  dialog: import("@playwright/test").Locator,
): Promise<void> {
  const [bounds, viewport] = await Promise.all([
    dialog.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(16);
  expect(bounds!.y).toBeGreaterThanOrEqual(16);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 16);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 16);
}

function analysisCard(page: import("@playwright/test").Page, caseName: string) {
  return page.locator(".failure-analysis-card").filter({ hasText: caseName });
}

async function pastePng(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement)) throw new Error("active paste target not found");
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const file = new File([png], "rerun-passed.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  });
}

function insertFailureAnalysisFixture(
  dataDirectory: string,
  projectVersionId: string,
  suffix: string,
) {
  const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
  const batchId = randomUUID();
  const runnerId = `analysis-runner-${suffix}`;
  const suiteName = `E2E 失败分析任务 ${suffix}`;
  const failedNames: [string, string, string, string] = [
    `失败 Alpha ${suffix}`,
    `失败 Beta ${suffix}`,
    `失败 Gamma ${suffix}`,
    `失败 Zeta ${suffix}`,
  ];
  const passedName = `通过用例 ${suffix}`;
  const recordedAt = new Date().toISOString();
  const historicalRecordedAt = new Date(Date.now() - 86_400_000).toISOString();
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database
      .prepare(
        `INSERT INTO case_suites
      (id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at)
      VALUES (?,?,?,'',1,'active',1,1,'{}',?,?)`,
      )
      .run(`suite-${suffix}`, DEFAULT_PROJECT_ID, suiteName, recordedAt, recordedAt);
    database
      .prepare(
        `INSERT INTO runners
      (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,
       labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
      VALUES (?,?,?,0,0,'linux','amd64','1.0.0',1,'[]','[]',4,0,?,?,?)`,
      )
      .run(runnerId, `hash-${suffix}`, `分析 Runner ${suffix}`, recordedAt, recordedAt, recordedAt);
    database
      .prepare(
        `INSERT INTO run_batches
      (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,
       total_runs,project_id,policy_json,created_at,updated_at)
      VALUES (?,991,?,?,1,'succeeded',0,'[]',5,?,?,?,?)`,
      )
      .run(
        batchId,
        `suite-${suffix}`,
        suiteName,
        DEFAULT_PROJECT_ID,
        JSON.stringify({ projectVersionId }),
        recordedAt,
        recordedAt,
      );
    const historicalBatchId = `history-batch-${suffix}`;
    const historicalRunId = `history-run-${suffix}`;
    const historicalAttemptId = `history-attempt-${suffix}`;
    const historicalCaseDefinitionId = `case-run-failed-2-${suffix}`;
    database
      .prepare(
        `INSERT INTO run_batches
      (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,
       total_runs,project_id,policy_json,created_at,updated_at)
      VALUES (?,990,?,?,1,'failed',0,'[]',1,?,?,?,?)`,
      )
      .run(
        historicalBatchId,
        `suite-${suffix}`,
        `历史代码问题 ${suffix}`,
        DEFAULT_PROJECT_ID,
        JSON.stringify({ projectVersionId }),
        historicalRecordedAt,
        historicalRecordedAt,
      );
    database
      .prepare(
        `INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,
       terminal_outcome,created_at,updated_at)
      VALUES (?,?,?,1,?,?,'failed',1,'failed',?,?)`,
      )
      .run(
        historicalRunId,
        historicalBatchId,
        historicalCaseDefinitionId,
        failedNames[2],
        "e2e.analysis.Failed2Test",
        historicalRecordedAt,
        historicalRecordedAt,
      );
    database
      .prepare(
        `INSERT INTO run_attempts
      (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_code,
       result_summary,created_at,finished_at)
      VALUES (?,?,?,1,'failed',1,'failed','TEST_ASSERTION_FAILED',?,?,?)`,
      )
      .run(
        historicalAttemptId,
        historicalRunId,
        runnerId,
        "Historical assertion failure",
        historicalRecordedAt,
        historicalRecordedAt,
      );
    database
      .prepare(
        `INSERT INTO failure_analysis_claims
      (id,project_id,batch_id,execution_run_id,case_definition_id,attempt_id,case_name,class_name,
       attempt_number,failure_summary,result_code,status,category,claimant_id,claimant_username,
       claimant_display_name,claimed_at,analysis_started_at,completed_at,issue_description,
       ticket_reference,remark,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,'TEST_ASSERTION_FAILED','completed','code_issue_filed',
              'historical-analyst','c10086','历史分析员',?,?,?,?,?,?,?)`,
      )
      .run(
        `history-analysis-${suffix}`,
        DEFAULT_PROJECT_ID,
        historicalBatchId,
        historicalRunId,
        historicalCaseDefinitionId,
        historicalAttemptId,
        failedNames[2],
        "e2e.analysis.Failed2Test",
        "Historical assertion failure",
        historicalRecordedAt,
        historicalRecordedAt,
        historicalRecordedAt,
        "历史状态字段转换错误",
        "BUG-1023",
        "等待修复",
        historicalRecordedAt,
      );
    const cases = [
      ...failedNames.map(
        (name, index) =>
          [
            `run-failed-${index}-${suffix}`,
            name,
            `e2e.analysis.Failed${index}Test`,
            `Assertion failure ${index}`,
            "failed",
          ] as const,
      ),
      [`run-pass-${suffix}`, passedName, "e2e.analysis.PassedTest", "", "succeeded"] as const,
    ];
    for (const [runId, name, className, summary, outcome] of cases) {
      database
        .prepare(
          `INSERT INTO execution_runs
        (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,
         terminal_outcome,created_at,updated_at) VALUES (?,?,?,1,?,?,?,1,?,?,?)`,
        )
        .run(
          runId,
          batchId,
          `case-${runId}`,
          name,
          className,
          outcome,
          outcome,
          recordedAt,
          recordedAt,
        );
      database
        .prepare(
          `INSERT INTO run_attempts
        (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_code,
         result_summary,created_at,finished_at) VALUES (?,?,?,1,?,1,?,'TESTNG_RESULT',?,?,?)`,
        )
        .run(
          `attempt-${runId}`,
          runId,
          runnerId,
          outcome,
          outcome,
          summary,
          recordedAt,
          recordedAt,
        );
    }
    return { batchId, failedNames, passedName, suiteName };
  } finally {
    database.close();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
