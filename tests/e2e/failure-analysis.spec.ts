import { expect, test } from "@playwright/test";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

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
  expect(hiddenClaimsRequests).toBe(0);
  expect(duplicateInitialCandidateRequests).toBe(0);
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
  const popupPromise = page.waitForEvent("popup");
  await batchDialog.getByRole("button", { name: "公开日志" }).first().click();
  const publicLogPage = await popupPromise;
  await expect(publicLogPage).toHaveURL(/\/share\/attempt-log\//u);
  await publicLogPage.close();
  await batchDialog.getByLabel("用例问题已修改", { exact: false }).check();
  await batchDialog.getByLabel("问题说明 *").fill("测试数据字段已经失效");
  await batchDialog.getByLabel("用例已修改证明 *").fill("commit abc123，已更新断言数据");
  await batchDialog.getByLabel("备注说明 选填").fill("相同根因批量处理");
  await batchDialog.getByRole("button", { name: "提交分析" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认用例问题" });
  await expect(confirmation).toContainText("不要为了让执行结果通过而修改正确的校验逻辑");
  await confirmation.getByRole("button", { name: "我已核实，确认提交" }).click();
  await expect(batchDialog).toBeHidden();
  await expect(firstCard).toContainText("已完成");
  await expect(secondCard).toContainText("用例问题已修改");

  const codeCard = analysisCard(page, fixture.failedNames[2]);
  await codeCard.getByRole("button", { name: "开始分析" }).click();
  const codeDialog = page.getByRole("dialog", { name: `分析 ${fixture.failedNames[2]}` });
  await codeDialog.getByLabel("代码问题已提单", { exact: false }).check();
  await codeDialog.getByLabel("问题说明 *").fill("后端返回的状态字段错误");
  await codeDialog.getByLabel("问题单链接或问题单号 *").fill("BUG-2048");
  await codeDialog.getByRole("button", { name: "提交分析" }).click();
  await expect(codeDialog).toBeHidden();
  await expect(codeCard).toContainText("代码问题已提单");

  const rerunCard = analysisCard(page, fixture.failedNames[3]);
  await rerunCard.getByRole("button", { name: "开始分析" }).click();
  const rerunDialog = page.getByRole("dialog", { name: `分析 ${fixture.failedNames[3]}` });
  await rerunDialog.getByLabel("重跑通过", { exact: false }).check();
  await rerunDialog.getByRole("button", { name: "提交分析" }).click();
  await expect(rerunDialog).toContainText("请粘贴执行通过截图");
  await pastePng(page, ".failure-analysis-paste-zone");
  await expect(rerunDialog).toContainText("通过截图已上传到平台对象存储");
  await rerunDialog.getByRole("button", { name: "提交分析" }).click();
  await expect(rerunDialog).toBeHidden();
  await expect(rerunCard).toContainText("重跑通过");

  await page.reload();
  await expect(page.getByRole("heading", { name: "我的分析队列" })).toBeVisible();
  await expect(analysisCard(page, fixture.failedNames[0])).toContainText("已完成");
  await expect(analysisCard(page, fixture.failedNames[3])).toContainText("重跑通过");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectUiIntegrity(page);
});

function analysisCard(page: import("@playwright/test").Page, caseName: string) {
  return page.locator(".failure-analysis-card").filter({ hasText: caseName });
}

async function pastePng(page: import("@playwright/test").Page, selector: string): Promise<void> {
  await page.locator(selector).focus();
  await page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!target) throw new Error("paste target not found");
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const file = new File([png], "rerun-passed.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  }, selector);
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
