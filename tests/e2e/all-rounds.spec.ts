import { expect, test, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { configureTaskExecution, startTaskFromTopbar } from "./support/task-execution";
import { browserJson, ensureAdministrator, uniqueName } from "./support/session";

/**
 * 全部轮次虚拟轮次视图的验收：一个批次两个用例，一个首轮通过、
 * 一个首轮失败第二轮通过。验证：
 * - 全部轮次逐条展示并用轮次列标注；通过/失败筛选可用；
 * - 第 2 轮不再把首轮已通过的用例显示为「未执行」；
 * - 全部轮次视图导出走 scope=all（逐条记录、Excel 含轮次列）。
 */

async function captureUi(page: Page, name: string): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  const absoluteDirectory = resolve(screenshotDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  await page.screenshot({ path: resolve(absoluteDirectory, `${name}.png`), fullPage: true });
}

type RunnerIdentity = { runnerId: string; credential: string };

type ClaimedAssignment = {
  assignment: {
    attemptId: string;
    executionSpec: { executionRunId: string };
  };
  lease: { token: string };
};

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

async function issueJenkinsApiToken(page: Page): Promise<string> {
  const permissions = ["run.create", "run.read", "project.manage"];
  const account = await browserJson<{ id: string }>(page, "/api/v1/service-accounts", {
    method: "POST",
    body: {
      name: uniqueName("jenkins-e2e"),
      description: "Jenkins 插件端到端验收",
      projectPermissions: { [DEFAULT_PROJECT_ID]: permissions },
    },
  });
  expect(account.status).toBe(201);
  const token = await browserJson<{ token: string }>(
    page,
    `/api/v1/service-accounts/${encodeURIComponent(account.body.id)}/tokens`,
    {
      method: "POST",
      body: {
        name: "jenkins-pipeline",
        scopes: permissions,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  );
  expect(token.status).toBe(201);
  expect(token.body.token).toMatch(/^af_api_/);
  return token.body.token;
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
          requestId: `e2e-allround-claim-${requestNumber}-${randomUUID()}`,
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
        terminalEnabled: false,
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

async function completeAttempt(
  page: Page,
  identity: RunnerIdentity,
  claim: ClaimedAssignment,
  result: {
    completionId: string;
    status: "succeeded" | "failed";
    resultCode: string;
    summary: string;
  },
): Promise<void> {
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
          durationMs: 100,
          logWatermarks: { stdout: 0, stderr: -1, agent: -1 },
          artifacts: [],
        },
      },
    },
  );
  expect(response.status()).toBe(200);
}

test("all-rounds virtual round annotates every record and later rounds hide previously passed cases", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  await ensureProjectHierarchy(page);

  // 两个用例：一个稳定通过，一个首轮失败、第二轮通过。
  const jar = zipSync({
    "com/example/AllRoundsStableTest.class": buildClassFile({
      className: "com.example.AllRoundsStableTest",
      methods: [{ name: "passes", annotations: [{ type: "Test", values: {} }] }],
    }),
    "com/example/AllRoundsFlakyTest.class": buildClassFile({
      className: "com.example.AllRoundsFlakyTest",
      methods: [{ name: "flaky", annotations: [{ type: "Test", values: {} }] }],
    }),
  });
  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "all-rounds-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.AllRoundsStableTest")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });

  await page.goto(`/case-suites?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.getByRole("button", { name: "创建任务" }).click();
  const createSuiteDialog = page.getByRole("dialog", { name: "创建用例任务" });
  await createSuiteDialog.getByLabel("任务名称").fill("全部轮次验收任务");
  await createSuiteDialog.getByLabel("说明").fill("验证全部轮次虚拟轮次视图");
  await createSuiteDialog.getByRole("button", { name: "创建任务" }).click();
  const suiteLink = page.getByRole("link", { name: /全部轮次验收任务/ });
  await expect(suiteLink).toBeVisible();
  const suiteHref = await suiteLink.getAttribute("href");
  const suiteId = new URL(suiteHref!, page.url()).pathname.split("/").at(-1)!;

  for (const caseName of ["AllRoundsStableTest", "AllRoundsFlakyTest"]) {
    await page.goto(`/cases?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
    await page.getByLabel("页内搜索用例").fill(caseName);
    await page.getByLabel(`选择 ${caseName}`).check();
    await page.getByLabel("目标用例任务").selectOption(suiteId);
    await page.getByRole("button", { name: "加入任务" }).click();
    await expect(page.locator(".inline-feedback")).toContainText("已将 1 个用例加入任务");
  }

  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: "E2E All-Rounds Runner",
      labels: ["linux", "java", "testng"],
      capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.2.0",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const identity = (await registration.json()) as RunnerIdentity;
  const registrationHeartbeat = await postHeartbeat(page, identity, 1);
  expect(registrationHeartbeat.status()).toBe(200);

  // 用户重跑额度为 0；首轮 PROCESS_START_FAILED 仍必须获得独立的执行机异常重调度。
  await configureTaskExecution(page, suiteId, identity.runnerId, {
    retryLimit: 0,
    retryMode: "round",
  });
  const batch = await startTaskFromTopbar(page, suiteId);

  // 通过批次 API 把 executionRunId 映射到用例名，领取顺序不确定。
  const userHeaders = await browserSessionHeaders(page);
  const runNames = async (): Promise<Map<string, string>> => {
    const response = await page.request.get(`/api/v1/run-batches/${encodeURIComponent(batch.id)}`, {
      headers: userHeaders,
    });
    expect(response.status()).toBe(200);
    const details = (await response.json()) as {
      runs: Array<{ id: string; displayName: string }>;
    };
    return new Map(details.runs.map((run) => [run.id, run.displayName]));
  };

  // 第 1 轮：稳定用例通过，flaky 用例失败。
  for (let claimed = 0; claimed < 2; claimed += 1) {
    const claim = await claimAssignment(page, identity);
    const names = await runNames();
    const caseName = names.get(claim.assignment.executionSpec.executionRunId) ?? "";
    const stable = caseName.includes("AllRoundsStableTest");
    await completeAttempt(page, identity, claim, {
      completionId: `e2e-allround-r1-${claimed}`,
      status: stable ? "succeeded" : "failed",
      resultCode: stable ? "TESTNG_SUCCEEDED" : "PROCESS_START_FAILED",
      summary: stable ? "round 1 passed" : "failed to create the Runner process",
    });
  }

  // 基础设施异常不等待整轮结束：第 2 轮 attempt 已调度、尚未领取，
  // 因此本轮有 1 个用例且未执行数为 0。
  // 首轮失败记录已经终止，即便 execution run 正处于 queued 等待重跑，也不能显示取消按钮。
  await page.goto(`/run-batches/${encodeURIComponent(batch.id)}`);
  const roundTable = page.locator(".execution-round-table");
  const initialRoundRow = roundTable.getByRole("row", { name: /初始轮次/ });
  const retryRoundRow = roundTable.getByRole("row", { name: /重跑第 1 轮/ });
  await expect(initialRoundRow.locator("td").nth(2)).toHaveText("2");
  await expect(initialRoundRow.locator("td").nth(7)).toHaveText("0");
  await expect(retryRoundRow.locator("td").nth(2)).toHaveText("1");
  await expect(retryRoundRow.locator("td").nth(7)).toHaveText("0");
  await page.getByRole("button", { name: "初始轮次", exact: true }).click();
  const failedFirstRoundRow = page.locator(".round-cases tbody tr").filter({ hasText: "失败" });
  await expect(failedFirstRoundRow).toHaveCount(1);
  await expect(failedFirstRoundRow.getByRole("button", { name: "取消该用例" })).toHaveCount(0);

  // 释放 Runner 槽位并领取已自动重调度的第 2 轮。
  const idleHeartbeat = await postHeartbeat(page, identity, 0);
  expect(idleHeartbeat.status()).toBe(200);
  const retryClaim = await claimAssignment(page, identity);
  await completeAttempt(page, identity, retryClaim, {
    completionId: "e2e-allround-r2",
    status: "succeeded",
    resultCode: "TESTNG_SUCCEEDED",
    summary: "round 2 passed",
  });

  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/run-batches/${encodeURIComponent(batch.id)}`,
        { headers: userHeaders },
      );
      return ((await response.json()) as { status: string }).status;
    })
    .toBe("succeeded");

  // 全部轮次视图：flaky 用例两条记录分别标注第 1/2 轮，稳定用例只有一条。
  await page.goto(`/run-batches/${encodeURIComponent(batch.id)}`);
  const completedAllRoundsRow = page
    .locator(".execution-round-table")
    .getByRole("row", { name: /全部轮次/ });
  await expect(completedAllRoundsRow.locator("td").nth(2)).toHaveText("3");
  await expect(completedAllRoundsRow.locator("td").nth(3)).toHaveText("67%");
  await expect(completedAllRoundsRow.locator("td").nth(5)).toHaveText("2");
  await expect(completedAllRoundsRow.locator("td").nth(6)).toHaveText("1");
  await expect(completedAllRoundsRow.locator("td").nth(7)).toHaveText("0");
  await page.getByRole("button", { name: "全部轮次", exact: true }).click();
  await expect(page).toHaveURL(/round=all/);
  const casesRegion = page.locator(".round-cases");
  await expect(casesRegion.getByRole("columnheader", { name: "轮次" })).toBeVisible();
  const stableRows = casesRegion.getByRole("row", { name: /AllRoundsStableTest/ });
  const flakyRows = casesRegion.getByRole("row", { name: /AllRoundsFlakyTest/ });
  await expect(stableRows).toHaveCount(1);
  await expect(flakyRows).toHaveCount(2);
  await expect(stableRows.first()).toContainText("第 1 轮");
  await expect(stableRows.first()).toContainText("通过");
  await expect(flakyRows.filter({ hasText: "第 1 轮" })).toContainText("失败");
  await expect(flakyRows.filter({ hasText: "第 2 轮" })).toContainText("通过");

  // 通过/失败筛选在全部轮次下可用。
  await page.getByLabel("按状态筛选").selectOption("succeeded");
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(2);
  await page.getByLabel("按状态筛选").selectOption("failed");
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(1);
  await page.getByLabel("按状态筛选").selectOption("all");
  // 布局回归：全部轮次没有环形图，用例表格必须占满面板宽度，而不是被挤进图表列。
  const panelBox = await page.locator("section.round-detail-panel").boundingBox();
  const tableBox = await casesRegion.locator("table.data-table").boundingBox();
  expect(panelBox).toBeTruthy();
  expect(tableBox).toBeTruthy();
  expect(tableBox!.width).toBeGreaterThan(panelBox!.width * 0.6);
  await expect(casesRegion.locator("table")).toHaveCSS("table-layout", "fixed");
  const compactCellPadding = await casesRegion
    .locator("tbody td")
    .first()
    .evaluate((cell) => {
      const style = window.getComputedStyle(cell);
      return {
        top: Number.parseFloat(style.paddingTop),
        bottom: Number.parseFloat(style.paddingBottom),
      };
    });
  expect(compactCellPadding.top).toBeLessThanOrEqual(8);
  expect(compactCellPadding.bottom).toBeLessThanOrEqual(8);
  await captureUi(page, "all-rounds-view");

  // 第 2 轮不再把首轮已通过的稳定用例显示为「未执行」。
  await page.getByRole("button", { name: "重跑第 1 轮", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /截至本轮总体通过进度：累计通过 2 个用例，共 2 个/ }),
  ).toBeVisible();
  await expect(casesRegion.getByRole("row", { name: /AllRoundsFlakyTest/ })).toHaveCount(1);
  await expect(casesRegion.getByRole("row", { name: /AllRoundsStableTest/ })).toHaveCount(0);
  // 「未执行」同时是筛选下拉的选项文案，断言限定在用例行 tbody 内。
  await expect(casesRegion.locator("tbody").getByText("未执行")).toHaveCount(0);
  await captureUi(page, "round-two-cases");

  // “总结”按初始用例去重：首轮通过 + 重试通过共 2 个，通过率 100%，列表也只有 2 行。
  const summaryRow = roundTable.getByRole("row", { name: /总结/ });
  await expect(summaryRow.locator("td").nth(2)).toHaveText("2");
  await expect(summaryRow.locator("td").nth(3)).toHaveText("100%");
  await expect(summaryRow.locator("td").nth(5)).toHaveText("2");
  await expect(summaryRow.locator("td").nth(6)).toHaveText("0");
  await page.getByRole("button", { name: "总结", exact: true }).click();
  await expect(page).toHaveURL(/round=summary/);
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(2);

  // PROCESS_START_FAILED 属于执行机异常：保留原失败记录、自动重新调度，并在执行机视图聚合展示。
  await page.getByRole("button", { name: "初始轮次", exact: true }).click();
  await page.getByRole("button", { name: "执行机", exact: true }).click();
  await page.getByRole("button", { name: /执行机异常 1/ }).click();
  const faultDialog = page.getByRole("dialog", { name: "执行机异常事件" });
  await expect(faultDialog).toContainText("PROCESS_START_FAILED");
  await expect(faultDialog).toContainText("failed to create the Runner process");
  await expect(faultDialog).toContainText("AllRoundsFlakyTest");
  await faultDialog.getByRole("button", { name: "关闭" }).click();

  // 初始轮次仍包含两个用例。
  await page.getByRole("button", { name: "用例", exact: true }).click();
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(2);

  // 全部轮次导出：scope=all，Excel 首列为轮次，文件名带 all-rounds。
  await page.getByRole("button", { name: "全部轮次", exact: true }).click();
  // 等面板切换完成再点导出，否则导航重渲染会重置对话框的打开状态（偶发丢失点击）。
  await expect(page).toHaveURL(/round=all/);
  await expect(page.locator(".round-cases")).toBeVisible();
  await page.getByRole("button", { name: "导出结果" }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出执行结果" });
  await expect(exportDialog).toBeVisible();
  await expect(exportDialog.getByRole("radio", { name: /^全部轮次/ })).toBeChecked();
  await expect(exportDialog.getByRole("radio", { name: /当前轮次/ })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  const exportResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/export"),
  );
  await exportDialog.getByRole("button", { name: "导出 Excel" }).click();
  const exportResponse = await exportResponsePromise;
  expect(exportResponse.status()).toBe(200);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("all-rounds");
  const exportBody = new Uint8Array(await readFile(await download.path()));
  expect(Array.from(exportBody.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  const sharedStrings = new TextDecoder("utf-8").decode(
    unzipSync(exportBody)["xl/sharedStrings.xml"],
  );
  expect(sharedStrings).toContain("轮次");

  // Jenkins 的两个 Pipeline 步骤使用同一种 API Key：依赖按项目版本替换，执行接口
  // 返回免登录进展链接；链接页不渲染产品顶栏和侧栏，且生命周期持续到批次终态。
  const jenkinsToken = await issueJenkinsApiToken(page);
  const dependencyPublication = await page.request.post("/api/v1/jenkins/dependencies", {
    headers: { authorization: `Bearer ${jenkinsToken}` },
    data: {
      projectId: DEFAULT_PROJECT_ID,
      version: "jenkins-e2e-1.0.0",
      dependencyArchive: {
        url: "http://127.0.0.1:3100/jenkins-fixtures/dependencies.zip",
        fileName: "dependencies.zip",
        sha256: "a".repeat(64),
        sizeBytes: 1024,
        archiveFormat: "zip",
      },
    },
  });
  expect(dependencyPublication.status()).toBe(200);
  expect(await dependencyPublication.json()).toMatchObject({
    projectId: DEFAULT_PROJECT_ID,
    version: "jenkins-e2e-1.0.0",
    replaced: true,
  });

  const jenkinsRunResponse = await page.request.post("/api/v1/jenkins/runs", {
    headers: { authorization: `Bearer ${jenkinsToken}` },
    data: { suiteId },
  });
  expect(jenkinsRunResponse.status()).toBe(201);
  const jenkinsRun = (await jenkinsRunResponse.json()) as {
    batchId: string;
    progressUrl: string;
    progressApiUrl: string;
    pollIntervalSeconds: number;
  };
  expect(jenkinsRun.pollIntervalSeconds).toBe(30);
  expect(jenkinsRun.progressUrl).toContain(`/progress/${jenkinsRun.batchId}`);
  await page.goto(jenkinsRun.progressUrl);
  await expect(page.getByText("只读执行进展 · 每 30 秒自动刷新", { exact: true })).toBeVisible();
  await expect(page.locator(".app-shell, .app-sidebar, .topbar")).toHaveCount(0);

  expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
  for (let claimed = 0; claimed < 2; claimed += 1) {
    const claim = await claimAssignment(page, identity);
    await completeAttempt(page, identity, claim, {
      completionId: `e2e-jenkins-completion-${claimed}`,
      status: "succeeded",
      resultCode: "TESTNG_SUCCEEDED",
      summary: "Jenkins lifecycle acceptance passed",
    });
    expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
  }
  await expect
    .poll(async () => {
      const progress = await page.request.get(jenkinsRun.progressApiUrl);
      expect(progress.status()).toBe(200);
      const body = (await progress.json()) as {
        active: boolean;
        statusLabel: string;
        totalCases: number;
        totalPassed: number;
      };
      return `${body.active}:${body.statusLabel}:${body.totalPassed}/${body.totalCases}`;
    })
    .toBe("false:执行完成:2/2");
  await page.reload();
  await expect(page.getByText("执行完成", { exact: true })).toBeVisible();

  // 执行记录真机布局：一个极端长值只能在自身单元格内截断，不能改变列宽或整表宽度。
  await page.goto("/execution-records");
  await page.evaluate(() =>
    window.localStorage.removeItem("autoforge.execution-records.column-widths.v1"),
  );
  await page.reload();
  const executionRecordsTable = page.locator(".execution-records-table");
  await expect(executionRecordsTable).toBeVisible();
  const suiteCell = executionRecordsTable.locator("tbody tr").first().locator("td").nth(1);
  const widthBeforeOutlier = await executionRecordsTable.evaluate((table) => ({
    table: table.getBoundingClientRect().width,
    suite: table.querySelectorAll("col")[1]?.getBoundingClientRect().width ?? 0,
  }));
  await suiteCell.locator("strong").evaluate((element) => {
    element.textContent = "单个极端超长任务名称".repeat(200);
  });
  const widthAfterOutlier = await executionRecordsTable.evaluate((table) => ({
    table: table.getBoundingClientRect().width,
    suite: table.querySelectorAll("col")[1]?.getBoundingClientRect().width ?? 0,
  }));
  expect(widthAfterOutlier.table).toBeCloseTo(widthBeforeOutlier.table, 0);
  expect(widthAfterOutlier.suite).toBeCloseTo(widthBeforeOutlier.suite, 0);
  const overflow = await suiteCell.evaluate((cell) => ({
    clientWidth: cell.clientWidth,
    scrollWidth: cell.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
});
