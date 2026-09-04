import { expect, test, type Locator, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { configureTaskExecution, startTaskFromTopbar } from "./support/task-execution";
import {
  browserJson,
  E2E_ADMIN_USERNAME,
  ensureAdministrator,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

/**
 * 全部轮次虚拟轮次视图的验收：覆盖 Runner 异常同轮重调度、真实失败整轮重跑、
 * Jenkins 轮次恢复与公开日志。验证：
 * - 全部轮次逐条展示并用轮次列标注；通过/失败筛选可用；
 * - Runner 异常不会消耗或虚增用例重跑轮次；
 * - 全部轮次视图导出走 scope=all（逐条记录、Excel 含轮次列）。
 */

async function captureUi(page: Page, name: string): Promise<void> {
  const screenshotDirectory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!screenshotDirectory) return;
  const absoluteDirectory = resolve(screenshotDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  await page.screenshot({ path: resolve(absoluteDirectory, `${name}.png`), fullPage: true });
}

async function expectDialogFitsViewport(page: Page, dialog: Locator): Promise<void> {
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);
}

async function expectIndependentSharedLogScrolling(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1024, height: 560 });
  const caseInformation = page.getByRole("region", { name: "用例信息" });
  const logContent = page.getByRole("region", { name: "日志内容" });
  const caseScrollbar = page.getByRole("scrollbar", { name: "用例信息滚动条" });
  const logScrollbar = page.getByRole("scrollbar", { name: "日志内容滚动条" });
  await expect(caseScrollbar).toBeVisible();
  await expect(logScrollbar).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      })),
    )
    .toEqual({ clientHeight: 560, scrollHeight: 560 });
  await expect(caseInformation).toHaveCSS("scrollbar-width", "none");
  await expect(logContent).toHaveCSS("scrollbar-width", "none");

  await caseInformation.evaluate((element) => {
    element.scrollTop = 0;
  });
  await logContent.evaluate((element) => {
    element.scrollTop = 0;
  });
  await caseInformation.hover();
  await page.mouse.wheel(0, 360);
  await expect
    .poll(() => caseInformation.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await logContent.evaluate((element) => element.scrollTop)).toBe(0);
  const caseScrollTop = await caseInformation.evaluate((element) => element.scrollTop);

  await logContent.hover();
  await page.mouse.wheel(0, 480);
  await expect.poll(() => logContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await caseInformation.evaluate((element) => element.scrollTop)).toBe(caseScrollTop);

  await logScrollbar.focus();
  await logScrollbar.press("End");
  await expect
    .poll(() =>
      logContent.evaluate(
        (element) => element.scrollTop + element.clientHeight - element.scrollHeight,
      ),
    )
    .toBe(0);
}

type RunnerIdentity = { runnerId: string; credential: string };

type ClaimedAssignment = {
  assignment: {
    attemptId: string;
    executionSpec: {
      executionRunId: string;
      inputs: Array<{ inputId: string; kind: string }>;
    };
  };
  lease: { token: string };
};

type FakeJenkins = { baseUrl: string; close: () => Promise<void> };

async function startFakeJenkins(): Promise<FakeJenkins> {
  const sourceBuilds = new Map([
    ["reset-app", 41],
    ["reset-database", 91],
  ]);
  const transientPollFailures = new Set<string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const jobName = url.pathname.match(/^\/job\/([^/]+)\//u)?.[1];
    const sourceBuild = jobName ? sourceBuilds.get(jobName) : undefined;
    if (!jobName || sourceBuild === undefined) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/lastBuild/rebuild/")) {
      response.writeHead(201).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/lastBuild/api/json")) {
      response.end(JSON.stringify({ number: sourceBuild }));
      return;
    }
    if (url.pathname.endsWith("/api/json")) {
      if (jobName === "reset-app" && !transientPollFailures.has(jobName)) {
        transientPollFailures.add(jobName);
        response.writeHead(503).end(JSON.stringify({ message: "temporary Jenkins outage" }));
        return;
      }
      const startedAt = Date.now() - 2_000;
      response.end(
        JSON.stringify({
          builds: [
            {
              number: sourceBuild + 1,
              url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/job/${jobName}/${sourceBuild + 1}/`,
              building: false,
              result: "SUCCESS",
              timestamp: startedAt,
              duration: 1_500,
              actions: [
                {
                  causes: [
                    {
                      _class: "com.sonyericsson.rebuild.RebuildCause",
                      upstreamBuild: sourceBuild,
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
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

async function publishVersionDependency(
  page: Page,
  apiToken: string,
  version: string,
  label: "historical" | "current",
): Promise<string> {
  const response = await page.request.post("/api/v1/jenkins/dependencies", {
    headers: { authorization: `Bearer ${apiToken}` },
    data: {
      projectId: DEFAULT_PROJECT_ID,
      version,
      dependencyArchive: {
        url: `http://127.0.0.1:3100/jenkins-fixtures/dependencies-${label}.zip`,
        fileName: `dependencies-${label}.zip`,
        sha256: (label === "historical" ? "d" : "e").repeat(64),
        sizeBytes: 1024,
        archiveFormat: "zip",
      },
    },
  });
  expect(response.status()).toBe(200);
  const publication = (await response.json()) as { assetId: string };
  expect(publication.assetId).toBeTruthy();
  return publication.assetId;
}

function dependencyInputId(claim: ClaimedAssignment): string | undefined {
  return claim.assignment.executionSpec.inputs.find((input) => input.kind === "jar-bundle")
    ?.inputId;
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
            "adapter:cotest-testng-v1",
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
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
          "adapter:cotest-testng-v1",
        ],
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
    stdoutWatermark?: number;
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
          logWatermarks: { stdout: result.stdoutWatermark ?? 0, stderr: -1, agent: -1 },
          artifacts: [],
        },
      },
    },
  );
  expect(response.status()).toBe(200);
}

async function uploadAttemptLog(
  page: Page,
  identity: RunnerIdentity,
  claim: ClaimedAssignment,
  content: string,
): Promise<void> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(claim.assignment.attemptId)}/logs`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: `e2e-manual-log-${randomUUID()}`,
        leaseToken: claim.lease.token,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content,
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  expect(response.status()).toBe(200);
}

async function uploadCompressibleAttemptLog(
  page: Page,
  identity: RunnerIdentity,
  claim: ClaimedAssignment,
  label: string,
): Promise<number> {
  const marker = `compressed public log ${label}`;
  const chunks = Array.from({ length: 160 }, (_, sequence) => ({
    stream: "stdout" as const,
    sequence,
    content: `${marker} sequence=${sequence}\n${"repeatable diagnostic context ".repeat(120)}\n`,
    recordedAt: new Date().toISOString(),
  }));
  const response = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(claim.assignment.attemptId)}/logs`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: `e2e-compressed-log-${randomUUID()}`,
        leaseToken: claim.lease.token,
        chunks,
      },
    },
  );
  expect(response.status()).toBe(200);
  return chunks.at(-1)!.sequence;
}

test("all-rounds virtual round annotates every record and later rounds hide previously passed cases", async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000);
  const suiteName = "全部轮次验收任务";
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
  await createSuiteDialog.getByLabel("任务名称").fill(suiteName);
  await createSuiteDialog.getByLabel("说明").fill("验证全部轮次虚拟轮次视图");
  await createSuiteDialog.getByRole("button", { name: "创建任务" }).click();
  const suiteLink = page.getByRole("link", { name: new RegExp(suiteName) });
  await expect(suiteLink).toBeVisible();
  const suiteHref = await suiteLink.getAttribute("href");
  const suiteId = new URL(suiteHref!, page.url()).pathname.split("/").at(-1)!;

  for (const caseName of ["AllRoundsStableTest", "AllRoundsFlakyTest"]) {
    await page.goto(`/cases?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
    await page.getByLabel("页内搜索用例").fill(caseName);
    await page.getByLabel(`选择 ${caseName}`).check();
    await page.locator('select[aria-label="目标用例任务"]').selectOption(suiteId);
    await page.getByRole("button", { name: "加入任务" }).click();
    await expect(page.locator(".toast-card", { hasText: "已将 1 个用例加入任务" })).toBeVisible();
  }

  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: "E2E All-Rounds Runner",
      labels: ["linux", "java", "testng"],
      capabilities: [
        "executor:testng-v1",
        "isolation:cgroup-v2",
        "java:21.0.8",
        "testng:7.11.0",
        "adapter:cotest-testng-v1",
      ],
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

  // 第 1 逻辑轮：稳定用例通过，flaky 用例先发生 Runner 异常。
  for (let claimed = 0; claimed < 2; claimed += 1) {
    const claim = await claimAssignment(page, identity);
    const names = await runNames();
    const caseName = names.get(claim.assignment.executionSpec.executionRunId) ?? "";
    const stable = caseName.includes("AllRoundsStableTest");
    if (claimed === 0) {
      await page.goto(`/run-batches/${encodeURIComponent(batch.id)}`);
      await page.getByRole("button", { name: "初始轮次", exact: true }).click();
      const runningCases = page.locator(".round-cases");
      const overviewResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname ===
            `/api/v1/run-batches/${encodeURIComponent(batch.id)}/overview`,
      );
      await overviewResponse;
      await expect(runningCases).toBeVisible();
      await runningCases.locator('select[aria-label="按状态筛选"]').selectOption("running");
      await expect(runningCases.locator("tbody tr")).toHaveCount(1);
      await expect(runningCases.locator("tbody tr").first()).toContainText("运行中");
      await runningCases.locator('select[aria-label="按状态筛选"]').selectOption("all");
    }
    await completeAttempt(page, identity, claim, {
      completionId: `e2e-allround-r1-${claimed}`,
      status: stable ? "succeeded" : "failed",
      resultCode: stable ? "TESTNG_SUCCEEDED" : "PROCESS_START_FAILED",
      summary: stable ? "round 1 passed" : "failed to create the Runner process",
    });
  }

  // 基础设施异常不等待整轮结束，但新的物理 attempt 必须仍属于初始逻辑轮次；
  // 用户重跑额度为 0 时不得凭空出现“重跑第 1 轮”。
  await page.goto(`/run-batches/${encodeURIComponent(batch.id)}`);
  const roundTable = page.locator(".execution-round-table");
  const initialRoundRow = roundTable.getByRole("row", { name: /初始轮次/ });
  const retryRoundRow = roundTable.getByRole("row", { name: /重跑第 1 轮/ });
  await expect(initialRoundRow.locator("td").nth(3)).toHaveText("2");
  await expect(initialRoundRow.locator("td").nth(8)).toHaveText("0");
  await expect(retryRoundRow).toHaveCount(0);

  // 释放 Runner 槽位并领取同一逻辑轮次内自动重调度的第 2 个物理 attempt。
  const idleHeartbeat = await postHeartbeat(page, identity, 0);
  expect(idleHeartbeat.status()).toBe(200);
  const retryClaim = await claimAssignment(page, identity);
  await completeAttempt(page, identity, retryClaim, {
    completionId: "e2e-allround-r2",
    status: "succeeded",
    resultCode: "TESTNG_SUCCEEDED",
    summary: "runner reschedule passed in logical round 1",
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

  const completedDetailsResponse = await page.request.get(
    `/api/v1/run-batches/${encodeURIComponent(batch.id)}`,
    { headers: userHeaders },
  );
  expect(completedDetailsResponse.status()).toBe(200);
  const completedDetails = (await completedDetailsResponse.json()) as {
    currentRound: number;
    runs: Array<{ id: string; displayName: string; executionRound: number }>;
    attempts: Array<{ executionRunId: string; attemptNumber: number; executionRound: number }>;
  };
  expect(completedDetails.currentRound).toBe(1);
  const flakyRunId = completedDetails.runs.find((run) =>
    run.displayName.includes("AllRoundsFlakyTest"),
  )?.id;
  expect(flakyRunId).toBeTruthy();
  expect(
    completedDetails.attempts
      .filter((attempt) => attempt.executionRunId === flakyRunId)
      .map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        executionRound: attempt.executionRound,
      })),
  ).toEqual([
    { attemptNumber: 1, executionRound: 1 },
    { attemptNumber: 2, executionRound: 1 },
  ]);

  // 全部轮次视图按逻辑轮次计数：Runner 异常 attempt 不得重复计入用例总数。
  await page.goto(`/run-batches/${encodeURIComponent(batch.id)}`);
  const completedAllRoundsRow = page
    .locator(".execution-round-table")
    .getByRole("row", { name: /全部轮次/ });
  await expect(completedAllRoundsRow.locator("td").nth(3)).toHaveText("2");
  await expect(completedAllRoundsRow.locator("td").nth(4)).toHaveText("100%");
  await expect(completedAllRoundsRow.locator("td").nth(6)).toHaveText("2");
  await expect(completedAllRoundsRow.locator("td").nth(7)).toHaveText("0");
  await expect(completedAllRoundsRow.locator("td").nth(8)).toHaveText("0");
  await page.getByRole("button", { name: "全部轮次", exact: true }).click();
  await expect(page).toHaveURL(/round=all/);
  const casesRegion = page.locator(".round-cases");
  await expect(casesRegion.getByRole("columnheader", { name: "轮次" })).toBeVisible();
  const stableRows = casesRegion.getByRole("row", { name: /AllRoundsStableTest/ });
  const flakyRows = casesRegion.getByRole("row", { name: /AllRoundsFlakyTest/ });
  await expect(stableRows).toHaveCount(1);
  await expect(flakyRows).toHaveCount(1);
  await expect(stableRows.first()).toContainText("第 1 轮");
  await expect(stableRows.first()).toContainText("通过");
  await expect(flakyRows.first()).toContainText("第 1 轮");
  await expect(flakyRows.first()).toContainText("通过");

  // 通过/失败筛选在全部轮次下可用。
  await page.locator('select[aria-label="按状态筛选"]').selectOption("succeeded");
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(2);
  await page.locator('select[aria-label="按状态筛选"]').selectOption("failed");
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(0);
  await page.locator('select[aria-label="按状态筛选"]').selectOption("all");
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

  // Runner 重调度完成后仍只有初始逻辑轮，且不会出现虚假的“未执行”行。
  await page.getByRole("button", { name: "初始轮次", exact: true }).click();
  await expect(
    page.getByRole("img", { name: /截至本轮总体通过进度：累计通过 2 个用例，共 2 个/ }),
  ).toBeVisible();
  await expect(casesRegion.getByRole("row", { name: /AllRoundsFlakyTest/ })).toHaveCount(1);
  await expect(casesRegion.getByRole("row", { name: /AllRoundsStableTest/ })).toHaveCount(1);
  // 「未执行」同时是筛选下拉的选项文案，断言限定在用例行 tbody 内。
  await expect(casesRegion.locator("tbody").getByText("未执行")).toHaveCount(0);
  await captureUi(page, "round-two-cases");

  // “总结”按初始用例去重：首轮通过 + 重试通过共 2 个，通过率 100%，列表也只有 2 行。
  const summaryRow = roundTable.getByRole("row", { name: /总结/ });
  await expect(summaryRow.locator("td").nth(3)).toHaveText("2");
  await expect(summaryRow.locator("td").nth(4)).toHaveText("100%");
  await expect(summaryRow.locator("td").nth(6)).toHaveText("2");
  await expect(summaryRow.locator("td").nth(7)).toHaveText("0");
  await page.getByRole("button", { name: "总结", exact: true }).click();
  await expect(page).toHaveURL(/round=summary/);
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(2);

  // PROCESS_START_FAILED 属于执行机异常：保留原失败记录、自动重新调度，并在执行机视图聚合展示。
  await page.getByRole("button", { name: "初始轮次", exact: true }).click();
  const retainedCaseSearch = page.getByRole("textbox", { name: "按名称搜索用例" });
  const searchWidthBeforeLongQuery = (await retainedCaseSearch.boundingBox())?.width ?? 0;
  await retainedCaseSearch.fill("AllRoundsFlakyTest".repeat(8));
  await page.waitForTimeout(350);
  const searchWidthAfterLongQuery = (await retainedCaseSearch.boundingBox())?.width ?? 0;
  expect(searchWidthBeforeLongQuery).toBeGreaterThan(0);
  expect(searchWidthAfterLongQuery).toBeGreaterThanOrEqual(searchWidthBeforeLongQuery - 1);
  await retainedCaseSearch.fill("AllRoundsFlakyTest");
  const retainedFlakyRow = casesRegion.getByRole("row", { name: /AllRounds/ });
  await expect(retainedFlakyRow).toHaveCount(1);
  const logicalRoundLogPopupPromise = page.waitForEvent("popup");
  await retainedFlakyRow.getByRole("button", { name: "公开日志" }).click();
  const logicalRoundLogPage = await logicalRoundLogPopupPromise;
  await logicalRoundLogPage.waitForLoadState("domcontentloaded");
  const logicalRoundHistory = logicalRoundLogPage.getByRole("navigation", {
    name: "同一用例的执行历史",
  });
  await expect(logicalRoundHistory.getByText("第 1 轮", { exact: true })).toBeVisible();
  await expect(
    logicalRoundHistory.getByText("第 1 轮 · 第 2 次尝试", { exact: true }),
  ).toBeVisible();
  await expect(logicalRoundHistory.getByText("第 2 轮", { exact: true })).toHaveCount(0);
  await logicalRoundLogPage.close();
  await page.getByRole("button", { name: "执行机", exact: true }).click();
  await page.getByRole("button", { name: /执行机异常 1/ }).click();
  const faultDialog = page.getByRole("dialog", { name: "执行机异常事件" });
  await expect(faultDialog).toContainText("PROCESS_START_FAILED");
  await expect(faultDialog).toContainText("failed to create the Runner process");
  await expect(faultDialog).toContainText("AllRoundsFlakyTest");
  await faultDialog.getByRole("button", { name: "关闭" }).click();

  // 初始轮次仍包含两个用例。
  await page.getByRole("button", { name: "用例", exact: true }).click();
  await expect(retainedCaseSearch).toHaveValue("AllRoundsFlakyTest");
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(1);
  await retainedCaseSearch.fill("");
  await expect(casesRegion.getByRole("row", { name: /AllRounds/ })).toHaveCount(2);

  // 现场问题精确回归：用户额度 10 次 + Runner 独立重调度 2 次会产生 13 个物理
  // attempt，但逻辑上只能是初始轮次 + 10 次重跑，绝不能出现第 12 轮。
  await configureTaskExecution(page, suiteId, identity.runnerId, {
    concurrency: 2,
    retryLimit: 10,
    retryMode: "round",
  });
  const cappedRetryBatch = await startTaskFromTopbar(page, suiteId);
  const cappedRetryDetailsResponse = await page.request.get(
    `/api/v1/run-batches/${encodeURIComponent(cappedRetryBatch.id)}`,
    { headers: userHeaders },
  );
  expect(cappedRetryDetailsResponse.status()).toBe(200);
  const cappedRunNames = new Map(
    (
      (await cappedRetryDetailsResponse.json()) as {
        runs: Array<{ id: string; displayName: string }>;
      }
    ).runs.map((run) => [run.id, run.displayName]),
  );
  let cappedFlakyAttempts = 0;
  let cappedStableCompleted = false;
  while (cappedFlakyAttempts < 13 || !cappedStableCompleted) {
    const claim = await claimAssignment(page, identity);
    const runId = claim.assignment.executionSpec.executionRunId;
    const caseName = cappedRunNames.get(runId) ?? "";
    if (caseName.includes("AllRoundsStableTest")) {
      cappedStableCompleted = true;
      await completeAttempt(page, identity, claim, {
        completionId: `e2e-retry-cap-stable-${claim.assignment.attemptId}`,
        status: "succeeded",
        resultCode: "TESTNG_SUCCEEDED",
        summary: "stable case passed",
      });
    } else {
      expect(caseName).toContain("AllRoundsFlakyTest");
      cappedFlakyAttempts += 1;
      const runnerFailure = cappedFlakyAttempts <= 2;
      await completeAttempt(page, identity, claim, {
        completionId: `e2e-retry-cap-flaky-${cappedFlakyAttempts}`,
        status: "failed",
        resultCode: runnerFailure ? "PROCESS_START_FAILED" : "TESTNG_ASSERTIONS_FAILED",
        summary: runnerFailure
          ? "Runner could not start the process"
          : `ordinary failure ${cappedFlakyAttempts - 2}`,
      });
    }
    expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
  }
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/run-batches/${encodeURIComponent(cappedRetryBatch.id)}`,
        { headers: userHeaders },
      );
      const details = (await response.json()) as { status: string; attempts: unknown[] };
      return `${details.status}:${details.attempts.length}`;
    })
    .toBe("succeeded:14");

  const cappedCompletedResponse = await page.request.get(
    `/api/v1/run-batches/${encodeURIComponent(cappedRetryBatch.id)}`,
    { headers: userHeaders },
  );
  const cappedCompleted = (await cappedCompletedResponse.json()) as {
    currentRound: number;
    runs: Array<{
      id: string;
      displayName: string;
      attemptCount: number;
      executionRound: number;
    }>;
    attempts: Array<{ executionRunId: string; attemptNumber: number; executionRound: number }>;
  };
  const cappedFlakyRun = cappedCompleted.runs.find((run) =>
    run.displayName.includes("AllRoundsFlakyTest"),
  );
  expect(cappedCompleted.currentRound).toBe(11);
  expect(cappedFlakyRun).toMatchObject({ attemptCount: 13, executionRound: 11 });
  const cappedFlakyAttemptRows = cappedCompleted.attempts.filter(
    (attempt) => attempt.executionRunId === cappedFlakyRun?.id,
  );
  expect(cappedFlakyAttemptRows.at(-1)).toMatchObject({
    attemptNumber: 13,
    executionRound: 11,
  });
  expect([...new Set(cappedFlakyAttemptRows.map((attempt) => attempt.executionRound))]).toEqual(
    Array.from({ length: 11 }, (_, index) => index + 1),
  );

  await page.goto(`/run-batches/${encodeURIComponent(cappedRetryBatch.id)}`);
  const cappedRoundTable = page.locator(".execution-round-table");
  await expect(cappedRoundTable.getByRole("row", { name: /重跑第 10 轮/ })).toBeVisible();
  await expect(cappedRoundTable.getByRole("row", { name: /重跑第 11 轮/ })).toHaveCount(0);
  await page.getByRole("button", { name: "重跑第 10 轮", exact: true }).click();
  const cappedFinalCaseRow = page
    .locator(".round-cases")
    .getByRole("row", { name: /AllRoundsFlakyTest/ });
  const cappedPublicLogPopupPromise = page.waitForEvent("popup");
  await cappedFinalCaseRow.getByRole("button", { name: "公开日志" }).click();
  const cappedPublicLogPage = await cappedPublicLogPopupPromise;
  await cappedPublicLogPage.waitForLoadState("domcontentloaded");
  const cappedPublicLogHistory = cappedPublicLogPage.getByRole("navigation", {
    name: "同一用例的执行历史",
  });
  await expect(
    cappedPublicLogHistory.getByText("第 11 轮 · 第 13 次尝试", { exact: true }),
  ).toBeVisible();
  await expect(cappedPublicLogHistory.getByText("第 12 轮", { exact: true })).toHaveCount(0);
  await cappedPublicLogPage.close();

  // 真实编排一轮双 Jenkins 环境恢复：两个 Rebuild 并行触发并共同形成轮次屏障，
  // 其中一个状态查询先返回瞬时 503，验证有界重试不会把批次直接判为失败；页面时间线
  // 展示一个恢复节点，详情按流水线分别展示实际起止时间与结果。
  const fakeJenkins = await startFakeJenkins();
  try {
    await configureTaskExecution(page, suiteId, identity.runnerId, {
      concurrency: 2,
      retryLimit: 1,
      retryMode: "round",
      retryConcurrencyRules: [
        {
          id: "e2e-recovery-round-two-concurrency",
          executionRound: 2,
          concurrency: 1,
        },
      ],
      roundRecoveryRules: [
        {
          id: "e2e-reset-app",
          afterRound: 1,
          jenkinsJobUrl: `${fakeJenkins.baseUrl}/job/reset-app/`,
          waitMinutes: 0,
          apiKey: "e2e-user:e2e-token",
        },
        {
          id: "e2e-reset-database",
          afterRound: 1,
          jenkinsJobUrl: `${fakeJenkins.baseUrl}/job/reset-database/`,
          waitMinutes: 0,
          apiKey: "e2e-user:e2e-token",
        },
      ],
    });
    const recoveryBatch = await startTaskFromTopbar(page, suiteId);
    expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
    for (let claimed = 0; claimed < 2; claimed += 1) {
      const claim = await claimAssignment(page, identity);
      await completeAttempt(page, identity, claim, {
        completionId: `e2e-recovery-round-1-${claimed}`,
        status: claimed === 0 ? "failed" : "succeeded",
        resultCode: claimed === 0 ? "TESTNG_ASSERTIONS_FAILED" : "TESTNG_SUCCEEDED",
        summary: claimed === 0 ? "retry after recovery" : "stable case passed",
      });
      expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
    }
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/v1/run-batches/${encodeURIComponent(recoveryBatch.id)}`,
            { headers: userHeaders },
          );
          const details = (await response.json()) as {
            roundRecoveries: Array<{
              status: string;
              startedAt?: string;
              finishedAt?: string;
              buildResult?: string;
            }>;
          };
          return details.roundRecoveries.map((item) => ({
            status: item.status,
            hasStartedAt: Boolean(item.startedAt),
            hasFinishedAt: Boolean(item.finishedAt),
            result: item.buildResult,
          }));
        },
        { timeout: 30_000 },
      )
      .toEqual([
        { status: "succeeded", hasStartedAt: true, hasFinishedAt: true, result: "SUCCESS" },
        { status: "succeeded", hasStartedAt: true, hasFinishedAt: true, result: "SUCCESS" },
      ]);

    const recoveryRetry = await claimAssignment(page, identity);
    await completeAttempt(page, identity, recoveryRetry, {
      completionId: "e2e-recovery-round-2",
      status: "succeeded",
      resultCode: "TESTNG_SUCCEEDED",
      summary: "recovery retry passed",
    });
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(recoveryBatch.id)}`,
          { headers: userHeaders },
        );
        return ((await response.json()) as { status: string }).status;
      })
      .toBe("succeeded");

    await page.goto(`/run-batches/${encodeURIComponent(recoveryBatch.id)}`);
    const recoveryRoundTable = page.locator(".execution-round-table");
    await expect(
      recoveryRoundTable
        .getByRole("row", { name: /初始轮次/ })
        .locator("td")
        .nth(2),
    ).toHaveText("2");
    const changedConcurrency = recoveryRoundTable
      .getByRole("row", { name: /重跑第 1 轮/ })
      .locator(".round-concurrency");
    await expect(changedConcurrency).toContainText("1");
    await expect(changedConcurrency).toContainText("已变更");
    await page.getByRole("button", { name: "重跑第 1 轮", exact: true }).click();
    await page.getByRole("button", { name: "总体调度日志", exact: true }).click();
    const schedulingLogDialog = page.getByRole("dialog", { name: "总体调度日志" });
    await expect(schedulingLogDialog).toContainText("第 2 轮触发动态并发规则，并发数由 2 调整为 1");
    await schedulingLogDialog.getByRole("button", { name: "关闭日志终端" }).click();
    const recoveryRow = page
      .locator(".execution-round-table")
      .getByRole("row", { name: /环境恢复.*第 1 轮后/u });
    await expect(recoveryRow).toContainText("Jenkins 流水线 2 个 · 完成 2 · 失败 0");
    await expect(recoveryRow).toContainText("恢复完成");
    await recoveryRow.getByRole("button", { name: "环境恢复", exact: true }).click();
    const recoveryPanel = page.getByRole("region", { name: "环境恢复详情：第 1 轮后" });
    await expect(recoveryPanel.locator(".recovery-step-card")).toHaveCount(2);
    await expect(recoveryPanel).toContainText("reset-app");
    await expect(recoveryPanel).toContainText("reset-database");
    await expect(recoveryPanel.getByText("SUCCESS", { exact: true })).toHaveCount(2);
    await expect(recoveryPanel.getByText("—", { exact: true })).toHaveCount(0);
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1536, height: 960 },
    ]) {
      await page.setViewportSize(viewport);
      await expectUiIntegrity(page);
      await captureUi(page, `round-recovery-timeline-${viewport.width}`);
    }
  } finally {
    await fakeJenkins.close();
  }

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
  // 返回免登录进展链接；终态结果链接复用完整执行详情（只移除外壳与鉴权操作）。
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
    resultUrl: string;
    progressApiUrl: string;
    pollIntervalSeconds: number;
    completionTimeoutSeconds: number;
  };
  expect(jenkinsRun.pollIntervalSeconds).toBe(30);
  expect(jenkinsRun.completionTimeoutSeconds).toBe(7 * 24 * 60 * 60);
  expect(jenkinsRun.progressUrl).toContain(`/progress/${jenkinsRun.batchId}`);
  expect(jenkinsRun.resultUrl).toContain("/share/run/");
  const anonymousContext = await browser.newContext();
  const anonymousProgressPage = await anonymousContext.newPage();
  const progressPageResponse = await anonymousProgressPage.goto(jenkinsRun.progressUrl);
  expect(progressPageResponse?.status()).toBe(200);
  expect(new URL(anonymousProgressPage.url()).pathname).not.toBe("/login");
  await expect(
    anonymousProgressPage.getByText("只读执行进展 · 每 30 秒自动刷新", { exact: true }),
  ).toBeVisible();
  await expect(anonymousProgressPage.locator(".app-shell, .app-sidebar, .topbar")).toHaveCount(0);

  expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
  for (let claimed = 0; claimed < 2; claimed += 1) {
    const claim = await claimAssignment(page, identity);
    const stdoutWatermark = await uploadCompressibleAttemptLog(
      page,
      identity,
      claim,
      `jenkins-${claimed}`,
    );
    await completeAttempt(page, identity, claim, {
      completionId: `e2e-jenkins-completion-${claimed}`,
      status: "succeeded",
      resultCode: "TESTNG_SUCCEEDED",
      summary: "Jenkins lifecycle acceptance passed",
      stdoutWatermark,
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
  await anonymousProgressPage.reload();
  await expect(anonymousProgressPage.getByText("执行完成", { exact: true })).toBeVisible();
  const anonymousResultPage = await anonymousContext.newPage();
  const resultPageResponse = await anonymousResultPage.goto(jenkinsRun.resultUrl);
  expect(resultPageResponse?.status()).toBe(200);
  expect(new URL(anonymousResultPage.url()).pathname).not.toBe("/login");
  await expect(anonymousResultPage.getByText("永久匿名只读执行详情")).toBeVisible();
  await expect(anonymousResultPage.getByRole("heading", { name: suiteName })).toBeVisible();
  await expect(anonymousResultPage.getByRole("region", { name: "批次概览" })).toBeVisible();
  await expect(
    anonymousResultPage.getByRole("heading", { name: "轮次", exact: true }),
  ).toBeVisible();
  await expect(anonymousResultPage.locator(".execution-round-table")).toBeVisible();
  await expect(anonymousResultPage.locator(".execution-case-table tbody tr")).toHaveCount(2);
  const sharedLogLinks = anonymousResultPage.getByRole("link", { name: "查看公开日志" });
  await expect(sharedLogLinks).toHaveCount(2);
  const sharedLogHref = await sharedLogLinks.first().getAttribute("href");
  expect(sharedLogHref).toMatch(/^\/share\/run\/[^/]+\/attempt\/[^/]+$/u);
  const anonymousLogPage = await anonymousContext.newPage();
  const anonymousLogNavigation = anonymousLogPage.goto(sharedLogHref!);
  const platformHealthStartedAt = performance.now();
  const platformHealthResponse = await page.request.get("/api/v1/health/live");
  const platformHealthDurationMs = performance.now() - platformHealthStartedAt;
  const anonymousLogResponse = await anonymousLogNavigation;
  expect(platformHealthResponse.status()).toBe(200);
  expect(platformHealthDurationMs).toBeLessThan(5_000);
  expect(anonymousLogResponse?.status()).toBe(200);
  expect(new URL(anonymousLogPage.url()).pathname).not.toBe("/login");
  await expect(anonymousLogPage.locator("pre.execution-log")).toContainText(
    "compressed public log jenkins-",
  );
  await expect(anonymousLogPage.getByRole("status")).toContainText("仅展示前 512 KB 内容");
  await expect(anonymousLogPage.locator(".app-shell, .app-sidebar, .topbar")).toHaveCount(0);
  await expectIndependentSharedLogScrolling(anonymousLogPage);
  await anonymousLogPage.close();
  await expect(anonymousResultPage.locator(".public-progress-card")).toHaveCount(0);
  await expect(
    anonymousResultPage.getByRole("button", {
      name: /终止任务|再次执行|导出结果|查看日志|公开日志|调度日志/,
    }),
  ).toHaveCount(0);
  await expect(anonymousResultPage.locator(".app-shell, .app-sidebar, .topbar")).toHaveCount(0);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await anonymousResultPage.setViewportSize(viewport);
    await expectUiIntegrity(anonymousResultPage);
    const [sharedTableViewport, firstSharedLogLink] = await Promise.all([
      anonymousResultPage.locator(".execution-case-table").locator("xpath=..").boundingBox(),
      sharedLogLinks.first().boundingBox(),
    ]);
    expect(sharedTableViewport).not.toBeNull();
    expect(firstSharedLogLink).not.toBeNull();
    expect(firstSharedLogLink!.x).toBeGreaterThanOrEqual(sharedTableViewport!.x);
    expect(firstSharedLogLink!.x + firstSharedLogLink!.width).toBeLessThanOrEqual(
      sharedTableViewport!.x + sharedTableViewport!.width + 1,
    );
    await captureUi(anonymousResultPage, `shared-run-details-${viewport.width}`);
  }
  await anonymousContext.close();

  // 执行记录真机布局：一个极端长值只能在自身单元格内截断，不能改变列宽或整表宽度。
  await page.goto("/execution-records");
  await page.evaluate(() =>
    window.localStorage.removeItem("autoforge.execution-records.column-widths.v1"),
  );
  await page.reload();
  const executionRecordsTable = page.locator(".execution-records-table");
  await expect(executionRecordsTable).toBeVisible();
  const jenkinsRecord = executionRecordsTable.locator("tbody tr", {
    has: page.locator(`a[href="/run-batches/${jenkinsRun.batchId}"]`),
  });
  expect(
    await jenkinsRecord
      .locator("td")
      .nth(3)
      .evaluate((cell) => cell.scrollWidth <= cell.clientWidth),
    "the complete pass rate should fit its cell",
  ).toBe(true);
  const shareResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/v1/run-batches/${jenkinsRun.batchId}/share`,
  );
  await jenkinsRecord
    .getByRole("button", { name: new RegExp(`生成批次 #\\d+ 永久分享链接`) })
    .click();
  expect((await shareResponse).status()).toBe(200);
  const sharedResultHref = await jenkinsRecord
    .getByRole("link", { name: /打开批次 #\d+ 永久分享链接/ })
    .getAttribute("href");
  expect(sharedResultHref).toContain("/share/run/");
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    window.addEventListener(
      "copy",
      () => {
        const activeElement = document.activeElement;
        Object.assign(window, {
          __autoforgeCopiedText:
            activeElement instanceof HTMLTextAreaElement
              ? activeElement.value.slice(activeElement.selectionStart, activeElement.selectionEnd)
              : (window.getSelection()?.toString() ?? ""),
        });
      },
      { once: true },
    );
  });
  await jenkinsRecord.getByRole("button", { name: /复制批次 #\d+ 永久分享链接/ }).click();
  await expect(jenkinsRecord.getByRole("status")).toHaveText("永久分享链接已复制");
  expect(
    await page.evaluate(() => Reflect.get(window, "__autoforgeCopiedText") as string | undefined),
  ).toBe(sharedResultHref);
  const historyAnonymousContext = await browser.newContext();
  const historyAnonymousPage = await historyAnonymousContext.newPage();
  const historyShareResponse = await historyAnonymousPage.goto(sharedResultHref!);
  expect(historyShareResponse?.status()).toBe(200);
  await expect(historyAnonymousPage.getByText("永久匿名只读执行详情")).toBeVisible();
  await expect(historyAnonymousPage.getByRole("region", { name: "批次概览" })).toBeVisible();
  await expect(historyAnonymousPage.locator(".execution-round-table")).toBeVisible();
  await expect(historyAnonymousPage.locator(".public-progress-card")).toHaveCount(0);
  await expect(historyAnonymousPage.locator(".app-shell, .app-sidebar, .topbar")).toHaveCount(0);
  await historyAnonymousContext.close();
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

  // 终态失败批次提供两条互不污染统计的重跑路径：单用例日志里的诊断重跑隐藏于
  // 常规执行记录，末轮失败集重跑则创建可追踪的新批次，并允许关闭动态并发和环境恢复。
  let failedSourceBatch!: { id: string };
  let failedAttemptId = "";
  const suiteConfiguration = await browserJson<{
    policy: { projectVersionId?: string };
  }>(page, `/api/v1/case-suites/${encodeURIComponent(suiteId)}`);
  expect(suiteConfiguration.status).toBe(200);
  const projectStructure = await browserJson<{
    versions: Array<{ id: string; name: string }>;
  }>(page, `/api/v1/projects/${encodeURIComponent(DEFAULT_PROJECT_ID)}/structure`);
  expect(projectStructure.status).toBe(200);
  const suiteProjectVersion = projectStructure.body.versions.find(
    (version) => version.id === suiteConfiguration.body.policy.projectVersionId,
  );
  if (!suiteProjectVersion) throw new Error("Suite project version is unavailable for rerun E2E.");
  const historicalDependencyId = await publishVersionDependency(
    page,
    jenkinsToken,
    suiteProjectVersion.name,
    "historical",
  );
  const derivedFakeJenkins = await startFakeJenkins();
  try {
    await configureTaskExecution(page, suiteId, identity.runnerId, {
      concurrency: 2,
      retryLimit: 1,
      retryMode: "round",
      retryConcurrencyRules: [
        {
          id: "e2e-final-failure-concurrency",
          executionRound: 2,
          concurrency: 1,
        },
      ],
      roundRecoveryRules: [
        {
          id: "e2e-final-failure-recovery",
          afterRound: 1,
          jenkinsJobUrl: `${derivedFakeJenkins.baseUrl}/job/reset-app/`,
          waitMinutes: 0,
          apiKey: "e2e-user:e2e-token",
        },
      ],
      adapter: {
        enabled: true,
        suiteName: "rerun-dependency-suite",
        testName: "rerun-dependency-test",
        environmentAddresses: ["10.0.0.11", "10.0.0.12"],
      },
    });
    failedSourceBatch = await startTaskFromTopbar(page, suiteId);
    expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
    for (let claimed = 0; claimed < 2; claimed += 1) {
      const claim = await claimAssignment(page, identity);
      expect(dependencyInputId(claim)).toBe(historicalDependencyId);
      const fails = claimed === 0;
      await completeAttempt(page, identity, claim, {
        completionId: `e2e-derived-source-round-one-${claimed}`,
        status: fails ? "failed" : "succeeded",
        resultCode: fails ? "TESTNG_ASSERTIONS_FAILED" : "TESTNG_SUCCEEDED",
        summary: fails ? "retry after environment recovery" : "source stable case passed",
      });
      expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
    }
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/v1/run-batches/${encodeURIComponent(failedSourceBatch.id)}`,
            { headers: userHeaders },
          );
          const details = (await response.json()) as {
            roundRecoveries: Array<{ status: string }>;
          };
          return details.roundRecoveries.map((recovery) => recovery.status);
        },
        { timeout: 30_000 },
      )
      .toEqual(["succeeded"]);
    const finalRoundFailure = await claimAssignment(page, identity);
    expect(dependencyInputId(finalRoundFailure)).toBe(historicalDependencyId);
    failedAttemptId = finalRoundFailure.assignment.attemptId;
    await completeAttempt(page, identity, finalRoundFailure, {
      completionId: "e2e-derived-source-round-two",
      status: "failed",
      resultCode: "TESTNG_ASSERTIONS_FAILED",
      summary: "final failure selected for rerun",
    });
    expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(failedSourceBatch.id)}`,
          { headers: userHeaders },
        );
        const details = (await response.json()) as { status: string; failedRuns: number };
        return `${details.status}:${details.failedRuns}`;
      })
      .toBe("succeeded:1");
  } finally {
    await derivedFakeJenkins.close();
  }
  expect(failedAttemptId).not.toBe("");
  const currentDependencyId = await publishVersionDependency(
    page,
    jenkinsToken,
    suiteProjectVersion.name,
    "current",
  );
  expect(currentDependencyId).not.toBe(historicalDependencyId);

  await page.goto(`/run-batches/${encodeURIComponent(failedSourceBatch.id)}`);
  await page.getByRole("button", { name: "初始轮次", exact: true }).click();
  const failedCaseRow = page.locator(".round-cases tbody tr").filter({ hasText: "失败" });
  await expect(failedCaseRow).toHaveCount(1);
  await failedCaseRow.getByRole("button", { name: "查看日志" }).click();
  const diagnosticResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /^\/api\/v1\/run-attempts\/[^/]+\/rerun$/u.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "执行此用例", exact: true }).click();
  const diagnosticResponse = await diagnosticResponsePromise;
  expect(diagnosticResponse.status()).toBe(201);
  const sharedAttemptId = decodeURIComponent(
    new URL(diagnosticResponse.url()).pathname.split("/").at(-2)!,
  );
  const diagnosticBatchId = ((await diagnosticResponse.json()) as { batchId: string }).batchId;
  await expect(page.getByRole("status")).toContainText(/手动执行|等待调度/);

  const visibleBatchPage = await browserJson<{ items: Array<{ id: string }> }>(
    page,
    "/api/v1/run-batches?limit=200",
  );
  expect(visibleBatchPage.status).toBe(200);
  expect(visibleBatchPage.body.items.map((item) => item.id)).not.toContain(diagnosticBatchId);
  expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
  const diagnosticClaim = await claimAssignment(page, identity);
  expect(diagnosticClaim.assignment.executionSpec.executionRunId).toBeTruthy();
  expect(dependencyInputId(diagnosticClaim)).toBe(currentDependencyId);
  await expect(page.getByRole("button", { name: "查看实时日志", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "查看实时日志", exact: true }).click();
  const liveLogDialog = page.getByRole("dialog", { name: /执行日志/ });
  await expect(liveLogDialog).toContainText("返回原日志");
  const realtimeMarker = "manual diagnostic realtime log\n";
  await uploadAttemptLog(page, identity, diagnosticClaim, realtimeMarker);
  await expect(liveLogDialog.locator("pre.execution-log")).toContainText(realtimeMarker.trim(), {
    timeout: 10_000,
  });
  await expectDialogFitsViewport(page, liveLogDialog);
  await captureUi(page, "manual-rerun-live-log");
  await page.getByRole("button", { name: "关闭日志终端" }).click();

  // 手动执行尚未结束时，永久日志详情的执行历史也必须立即出现“执行中”记录，
  // 登录用户可在当前页面打开实时日志，而不是等到完成后才看到它。
  await page.goto(`/run-batches/${encodeURIComponent(failedSourceBatch.id)}`);
  await page.getByRole("button", { name: "初始轮次", exact: true }).click();
  const runningSourceRow = page.locator(".round-cases tbody tr").filter({ hasText: "失败" });
  const runningPublicLogPopupPromise = page.waitForEvent("popup");
  await runningSourceRow.getByRole("button", { name: "公开日志" }).click();
  const runningPublicLogPage = await runningPublicLogPopupPromise;
  await runningPublicLogPage.waitForLoadState("domcontentloaded");
  const runningHistory = runningPublicLogPage.getByRole("navigation", {
    name: "同一用例的执行历史",
  });
  const runningManualLink = runningHistory.getByRole("link", {
    name: /手动重跑.*执行中/u,
  });
  await expect(runningManualLink).toBeVisible();
  await runningManualLink.click();
  const sharedRealtimeButton = runningPublicLogPage.getByRole("button", {
    name: "查看实时日志",
    exact: true,
  });
  await expect(sharedRealtimeButton).toHaveCSS("color", "rgb(255, 255, 255)");
  await sharedRealtimeButton.click();
  const sharedLiveLogDialog = runningPublicLogPage.getByRole("dialog", { name: /执行日志/ });
  await expect(sharedLiveLogDialog.locator("pre.execution-log")).toContainText(
    realtimeMarker.trim(),
  );
  await expectDialogFitsViewport(runningPublicLogPage, sharedLiveLogDialog);
  await runningPublicLogPage.getByRole("button", { name: "关闭日志终端" }).click();
  await runningPublicLogPage.close();

  await completeAttempt(page, identity, diagnosticClaim, {
    completionId: "e2e-diagnostic-rerun",
    status: "succeeded",
    resultCode: "TESTNG_SUCCEEDED",
    summary: "manual diagnostic rerun passed",
  });
  expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);

  await page.goto(`/run-batches/${encodeURIComponent(failedSourceBatch.id)}`);
  await page.getByRole("button", { name: "初始轮次", exact: true }).click();
  const refreshedFailedCaseRow = page.locator(".round-cases tbody tr").filter({ hasText: "失败" });
  const publicLogPopupPromise = page.waitForEvent("popup");
  const publicLogResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v1/run-attempts/${encodeURIComponent(sharedAttemptId)}/log-share`,
  );
  await refreshedFailedCaseRow.getByRole("button", { name: "公开日志" }).click();
  expect((await publicLogResponsePromise).status()).toBe(200);
  const publicLogPage = await publicLogPopupPromise;
  await publicLogPage.waitForLoadState("domcontentloaded");
  const executionHistory = publicLogPage.getByRole("navigation", {
    name: "同一用例的执行历史",
  });
  await expect(executionHistory).toBeVisible();
  await expect(
    publicLogPage.getByRole("button", { name: "执行此用例", exact: true }),
  ).toBeVisible();
  await expect(executionHistory.getByText(`by ${E2E_ADMIN_USERNAME}（本地）`)).toBeVisible();
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await publicLogPage.setViewportSize(viewport);
    await expectUiIntegrity(publicLogPage);
    await captureUi(publicLogPage, `shared-diagnostic-history-${viewport.width}`);
  }
  const openPageCount = publicLogPage.context().pages().length;
  const manualRerunLink = executionHistory.getByRole("link", { name: /手动重跑.*通过/u });
  await manualRerunLink.click();
  await expect(manualRerunLink).toHaveAttribute("aria-current", "page");
  expect(publicLogPage.context().pages()).toHaveLength(openPageCount);
  expect(publicLogPage.url()).toContain(
    `attempt=${encodeURIComponent(diagnosticClaim.assignment.attemptId)}`,
  );

  // 从公开日志页再次执行后，新记录必须在同一页面自动进入执行历史，不能依赖手动刷新。
  const publicPageRerunResponsePromise = publicLogPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /^\/api\/v1\/run-attempts\/[^/]+\/rerun$/u.test(new URL(response.url()).pathname),
  );
  await publicLogPage.getByRole("button", { name: "执行此用例", exact: true }).click();
  const publicPageRerunResponse = await publicPageRerunResponsePromise;
  expect(publicPageRerunResponse.status()).toBe(201);
  expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
  const publicPageRerunClaim = await claimAssignment(page, identity);
  const latestManualRerunLink = executionHistory.getByRole("link", {
    name: /手动重跑.*等待执行/u,
  });
  await expect(latestManualRerunLink).toBeVisible({ timeout: 10_000 });
  await expect(latestManualRerunLink).toContainText(`by ${E2E_ADMIN_USERNAME}（本地）`);
  await expectUiIntegrity(publicLogPage);
  await captureUi(publicLogPage, "shared-diagnostic-history-live-update");
  expect(publicLogPage.context().pages()).toHaveLength(openPageCount);
  await completeAttempt(page, identity, publicPageRerunClaim, {
    completionId: "e2e-public-page-diagnostic-rerun",
    status: "succeeded",
    resultCode: "TESTNG_SUCCEEDED",
    summary: "public page diagnostic rerun passed",
  });
  expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
  await publicLogPage.close();

  await page.goto(`/run-batches/${encodeURIComponent(failedSourceBatch.id)}`);
  await page.getByRole("button", { name: "重新执行最后一轮", exact: true }).click();
  const finalFailureDialog = page.getByRole("dialog", { name: "重新执行最后一轮" });
  await expect(finalFailureDialog).toContainText("仅使用当前批次最后仍失败或超时的 1 个用例");
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expectUiIntegrity(page);
    await captureUi(page, `rerun-final-failures-dialog-${viewport.width}`);
  }
  await finalFailureDialog.getByLabel("本次并发数").fill("1");
  await finalFailureDialog.getByLabel("启用动态并发规则").uncheck();
  await finalFailureDialog.getByLabel("启用 Jenkins 环境恢复").uncheck();
  const finalFailureResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v1/run-batches/${encodeURIComponent(failedSourceBatch.id)}/rerun-final-failures`,
  );
  await finalFailureDialog.getByRole("button", { name: "执行 1 个用例" }).click();
  const finalFailureResponse = await finalFailureResponsePromise;
  expect(finalFailureResponse.status()).toBe(201);
  const finalFailureBatchId = ((await finalFailureResponse.json()) as { id: string }).id;
  await expect(page).toHaveURL(
    new RegExp(`/run-batches/${finalFailureBatchId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`),
  );
  const finalFailureDetails = await browserJson<{
    kind: string;
    parentBatchId: string;
    totalRuns: number;
    policy: { concurrency: number; retryConcurrencyRules: unknown[] };
    roundRecoveries: unknown[];
  }>(page, `/api/v1/run-batches/${encodeURIComponent(finalFailureBatchId)}`);
  expect(finalFailureDetails.status).toBe(200);
  expect(finalFailureDetails.body).toMatchObject({
    kind: "final_failure_rerun",
    parentBatchId: failedSourceBatch.id,
    totalRuns: 1,
    policy: { concurrency: 1, retryConcurrencyRules: [] },
    roundRecoveries: [],
  });
  const visibleBatchesAfterFinalRerun = await browserJson<{ items: Array<{ id: string }> }>(
    page,
    "/api/v1/run-batches?limit=200",
  );
  expect(visibleBatchesAfterFinalRerun.body.items.map((item) => item.id)).toContain(
    finalFailureBatchId,
  );
  expect((await postHeartbeat(page, identity, 0)).status()).toBe(200);
  const finalFailureClaim = await claimAssignment(page, identity);
  expect(dependencyInputId(finalFailureClaim)).toBe(historicalDependencyId);
  await completeAttempt(page, identity, finalFailureClaim, {
    completionId: "e2e-final-failure-rerun",
    status: "succeeded",
    resultCode: "TESTNG_SUCCEEDED",
    summary: "final failure rerun passed",
  });
});
