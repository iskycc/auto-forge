import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { ensureAdministrator } from "./support/session";

// When AUTOFORGE_LOG_SCREENSHOT_DIR is set, capture the execution log panel
// (real Agent/Adapter output) for visual review of log level highlighting.
async function captureExecutionLog(page: Page, name: string): Promise<void> {
  const directory = process.env.AUTOFORGE_LOG_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.locator(".execution-log").screenshot({ path: resolve(directory, `${name}.png`) });
}

async function captureDetailsPage(page: Page, name: string): Promise<void> {
  const directory = process.env.AUTOFORGE_LOG_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
}

// Covers the full java-cases acceptance chain through the UI:
// JAR import -> suite creation -> case selection -> runner addition ->
// execution -> detail page with logs, structured results and artifacts.
// The suite environment addresses are mock values: the Adapter only injects
// them into ProjectFileUtil and never opens a network connection to them.

const runnerName = "Java Cases Agent";
const managedEnvironmentName = "java-cases 受管环境";
const managedSecretName = "java-cases 执行密文";
const successSuiteName = "java-cases 成功链路验收";
const failureSuiteName = "java-cases 失败重试验收";
const secretValue = "java-cases-secret-v1-9d2f";
const environmentAddress = "10.20.30.40";
const backupEnvironmentAddress = "10.20.30.41";

test("runs the java-cases module through the adapter E2E chain", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  await ensureAdministrator(page);

  const agent = await startAgent();
  try {
    // 执行机添加：Agent 注册后出现在 /runners 并具备 Adapter 能力。
    await waitForOnlineRunner(page, agent);
    await createManagedExecutionEnvironment(page);

    // JAR 导入：上传 java-cases-tests.jar，扫描测试类并确认导入。
    await importJavaCasesJar(page);

    // 任务创建 + 用例勾选：创建 Adapter 任务并把用例加入任务。
    await createExecutableSuite(page, successSuiteName, "JavaCasesFixture", 0, ["artifacts/*.txt"]);

    // 任务执行：选择任务与执行机后开始调度。
    const batchId = await scheduleExecution(page, successSuiteName);

    // 实时 stdout 捕获验证：attempt 运行期间日志即出现在详情页。
    await waitForAttemptState(page, batchId, agent, "running");
    await page.goto(`/run-batches/${encodeURIComponent(batchId)}`);
    await expect(page.getByText("实时更新", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "查看日志" }).click();
    const executionLog = page.locator(".execution-log");
    await expect
      .poll(async () => executionLog.textContent(), { timeout: 30_000 })
      .toContain(`JAVA_CASES_STDOUT_完成:java-cases-env-v2:${environmentAddress}`);

    // 查看执行详情及日志：等待成功后校验结构化结果、日志与产物。
    const details = await waitForTerminalBatch(
      page,
      batchId,
      agent,
      "succeeded",
      "TESTNG_SUCCEEDED",
      1,
    );
    expect(details.attempts[0]?.testNg).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      configurationFailures: 0,
    });

    await page.goto(`/run-batches/${encodeURIComponent(batchId)}`);
    // 需求5后单用例不再自动展开，需先点详情才能看到结构化结果与产物。
    await page
      .getByRole("row", { name: "JavaCasesFixture" })
      .getByRole("button", { name: "详情" })
      .click();
    await expect(page.getByRole("heading", { name: "结构化测试结果" })).toBeVisible();
    await expect(page.getByLabel("TestNG 结果汇总")).toContainText("通过1");
    await expect(page.getByText("executesThroughJavaCasesModule", { exact: true })).toBeVisible();
    await captureDetailsPage(page, "real-details-success-dark");

    await page.getByRole("button", { name: "查看日志" }).click();
    await expect(executionLog).toContainText("[REDACTED]");
    await expect(executionLog).not.toContainText(secretValue);
    expect(agent.diagnostics.join("")).not.toContain(secretValue);
    await captureDetailsPage(page, "real-logviewer-open-dark");
    await captureExecutionLog(page, "real-stdout-dark");
    await page.getByRole("button", { name: "浅色日志" }).click();
    await captureExecutionLog(page, "real-stdout-light");
    await page.getByRole("button", { name: "深色日志" }).click();

    await page.getByRole("button", { name: "stderr", exact: true }).click();
    await expect(executionLog).toContainText("JAVA_CASES_STDERR_CAPTURED");
    await captureExecutionLog(page, "real-stderr-dark");
    await page.getByRole("button", { name: "agent", exact: true }).click();
    await expect(executionLog).toContainText("AutoForge Runner Agent started the attempt.");
    await captureExecutionLog(page, "real-agent-dark");

    const customArtifact = page.getByLabel("下载 artifacts/java-cases.txt");
    await expect(customArtifact).toBeVisible();
    const artifactHref = await customArtifact.getAttribute("href");
    expect(artifactHref).toBeTruthy();
    const artifactDownload = await page.request.get(artifactHref!);
    expect(artifactDownload.status()).toBe(200);
    expect(await artifactDownload.text()).toBe("JAVA_CASES_ARTIFACT_SAFE\n");

    // 失败链路：真实失败输出 + 重试一次后进入失败终态。
    await createExecutableSuite(page, failureSuiteName, "JavaCasesFailureFixture", 1);
    const failureBatchId = await scheduleExecution(page, failureSuiteName);
    const failed = await waitForTerminalBatch(
      page,
      failureBatchId,
      agent,
      "failed",
      "TESTNG_ASSERTIONS_FAILED",
      2,
    );
    for (const attempt of failed.attempts) {
      expect(attempt.testNg).toMatchObject({ total: 1, passed: 0, failed: 1 });
    }
    await page.goto(`/run-batches/${encodeURIComponent(failureBatchId)}`);
    // 需求5后单用例不再自动展开，需先点详情才能看到方法级失败结果。
    await page
      .getByRole("row", { name: "JavaCasesFailureFixture" })
      .getByRole("button", { name: "详情" })
      .click();
    await expect(
      page.getByText("failsAfterRealProcessOutput", { exact: true }).last(),
    ).toBeVisible();
    await captureDetailsPage(page, "real-details-failure-dark");
    await page.getByRole("button", { name: "查看日志" }).click();
    await expect(page.locator(".execution-log")).toContainText(
      "JAVA_CASES_FAILURE_OUTPUT_BEFORE_ASSERTION",
    );
    await expect(page.locator(".execution-log")).toContainText(
      "ERROR deliberate assertion failure to exercise the retry chain",
    );
    await captureExecutionLog(page, "real-failure-stdout-dark");
  } finally {
    await attachAgentDiagnostics(testInfo, agent);
    await stopAgent(agent);
  }
});

const concurrentAlphaSuiteName = "java-cases 并发 Alpha 验收";
const concurrentBetaSuiteName = "java-cases 并发 Beta 验收";
const concurrentEnvironmentName = "java-cases 并发受管环境";

test("runs multiple java-cases attempts concurrently without log cross-contamination", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  await ensureAdministrator(page);

  const agent = await startAgent(2);
  try {
    await waitForOnlineRunner(page, agent);
    await createConcurrentExecutionEnvironment(page);
    await importJavaCasesJar(page);

    await createExecutableSuite(
      page,
      concurrentAlphaSuiteName,
      "JavaCasesConcurrentAlphaFixture",
      0,
    );
    await createExecutableSuite(page, concurrentBetaSuiteName, "JavaCasesConcurrentBetaFixture", 0);

    // 快速连续调度两个 batch，使 Agent 有机会同时 claim 两个 assignment。
    // Playwright 的 page 不能并发导航，所以这里串行调用但要尽量快。
    const alphaBatchId = await scheduleExecution(
      page,
      concurrentAlphaSuiteName,
      concurrentEnvironmentName,
    );
    const betaBatchId = await scheduleExecution(
      page,
      concurrentBetaSuiteName,
      concurrentEnvironmentName,
    );

    // 等待两个 batch 都产生 running 的 attempt，确认 Agent 真的在并发执行。
    const [alphaAttemptId, betaAttemptId] = await Promise.all([
      waitForAttemptState(page, alphaBatchId, agent, "running"),
      waitForAttemptState(page, betaBatchId, agent, "running"),
    ]);

    // 实时日志捕获验证：running 期间即可看到自己 attempt 的 stdout 标记。
    await expect
      .poll(
        async () =>
          (await readAttemptLogs(page, alphaAttemptId, "stdout")).includes(
            "JAVA_CASES_CONCURRENT_ALPHA_START",
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await readAttemptLogs(page, betaAttemptId, "stdout")).includes(
            "JAVA_CASES_CONCURRENT_BETA_START",
          ),
        { timeout: 60_000 },
      )
      .toBe(true);

    // 等待两个 batch 都成功结束。
    const [alphaDetails, betaDetails] = await Promise.all([
      waitForTerminalBatch(page, alphaBatchId, agent, "succeeded", "TESTNG_SUCCEEDED", 1),
      waitForTerminalBatch(page, betaBatchId, agent, "succeeded", "TESTNG_SUCCEEDED", 1),
    ]);

    expect(alphaDetails.attempts[0]?.testNg).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      configurationFailures: 0,
    });
    expect(betaDetails.attempts[0]?.testNg).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      configurationFailures: 0,
    });

    // 最终日志隔离校验：每个 attempt 的日志只包含自己的标记，不含对方标记。
    const alphaStdout = await readAttemptLogs(page, alphaAttemptId, "stdout");
    const alphaStderr = await readAttemptLogs(page, alphaAttemptId, "stderr");
    const betaStdout = await readAttemptLogs(page, betaAttemptId, "stdout");
    const betaStderr = await readAttemptLogs(page, betaAttemptId, "stderr");

    expect(alphaStdout).toContain("JAVA_CASES_CONCURRENT_ALPHA_START");
    expect(alphaStdout).toContain("JAVA_CASES_CONCURRENT_ALPHA_DONE");
    expect(alphaStderr).toContain("JAVA_CASES_CONCURRENT_ALPHA_STDERR");
    expect(alphaStdout + alphaStderr).not.toContain("JAVA_CASES_CONCURRENT_BETA");

    expect(betaStdout).toContain("JAVA_CASES_CONCURRENT_BETA_START");
    expect(betaStdout).toContain("JAVA_CASES_CONCURRENT_BETA_DONE");
    expect(betaStderr).toContain("JAVA_CASES_CONCURRENT_BETA_STDERR");
    expect(betaStdout + betaStderr).not.toContain("JAVA_CASES_CONCURRENT_ALPHA");
  } finally {
    await attachAgentDiagnostics(testInfo, agent);
    await stopAgent(agent);
  }
});

type AgentProcess = {
  child: ChildProcessWithoutNullStreams;
  diagnostics: string[];
};

type BatchDetails = {
  status: string;
  attempts: Array<{
    id: string;
    status?: string;
    resultCode?: string;
    testNg?: {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      configurationFailures: number;
    };
  }>;
};

function startAgent(maxConcurrency = 1): Promise<AgentProcess> {
  const binary = requiredEnvironment("E2E_JAVA_CASES_AGENT_BINARY");
  const bootstrapToken = requiredEnvironment("E2E_RUNNER_BOOTSTRAP_TOKEN");
  const child = spawn(binary, ["start"], {
    detached: true,
    env: {
      ...process.env,
      AUTOFORGE_SERVER_URL: "http://127.0.0.1:3100",
      AUTOFORGE_AGENT_DATA_DIR: requiredEnvironment("E2E_JAVA_CASES_AGENT_DATA_DIR"),
      AUTOFORGE_AGENT_NAME: runnerName,
      AUTOFORGE_AGENT_LABELS: "java-cases,acceptance",
      AUTOFORGE_AGENT_MAX_CONCURRENCY: String(maxConcurrency),
      AUTOFORGE_AGENT_BOOTSTRAP_TOKEN: bootstrapToken,
      AUTOFORGE_AGENT_JAVA_EXECUTABLE: requiredEnvironment("E2E_JAVA_CASES_JAVA_EXECUTABLE"),
      AUTOFORGE_AGENT_JAVA_VERSION: requiredEnvironment("E2E_JAVA_CASES_JAVA_VERSION"),
      AUTOFORGE_AGENT_TESTNG_CLASSPATH: requiredEnvironment("E2E_JAVA_CASES_TESTNG_CLASSPATH"),
      AUTOFORGE_AGENT_TESTNG_VERSION: "7.11.0",
      AUTOFORGE_AGENT_ADAPTER_JAR: requiredEnvironment("E2E_JAVA_CASES_ADAPTER_JAR"),
      AUTOFORGE_AGENT_CGROUP_ROOT: requiredEnvironment("E2E_JAVA_CASES_CGROUP_ROOT"),
      AUTOFORGE_AGENT_CLAIM_WAIT: "1s",
      AUTOFORGE_AGENT_CLAIM_MAX_BACKOFF: "1s",
      AUTOFORGE_AGENT_SHUTDOWN_GRACE: "10s",
    },
    stdio: "pipe",
  });
  const diagnostics: string[] = [];
  captureBounded(child.stdout, diagnostics, bootstrapToken);
  captureBounded(child.stderr, diagnostics, bootstrapToken);
  return Promise.resolve({ child, diagnostics });
}

async function createManagedExecutionEnvironment(page: Page): Promise<void> {
  await page.goto("/settings/environments?section=secrets");
  const secretPanel = page.locator(".secret-create-panel");
  await secretPanel.getByLabel("项目").selectOption(DEFAULT_PROJECT_ID);
  await secretPanel.getByLabel("名称").fill(managedSecretName);
  await secretPanel.getByLabel("说明").fill("java-cases 链路验收密文");
  await secretPanel.getByLabel("密文值").fill(secretValue);
  await secretPanel.getByRole("button", { name: "创建密文" }).click();
  await expect(page.getByText("执行密文已创建。")).toBeVisible();

  await page.goto("/settings/environments?section=environments");
  await page.getByRole("button", { name: "创建执行环境" }).click();
  const createForm = page.locator(".compact-create-form");
  await createForm.getByLabel("项目").selectOption(DEFAULT_PROJECT_ID);
  await createForm.getByLabel("名称").fill(managedEnvironmentName);
  await createForm.getByLabel("说明").fill("java-cases 普通变量与密文版本");
  await createForm.getByLabel("普通变量").fill("AUTOFORGE_JAVA_CASES_ENV=java-cases-env-v1");
  await createForm.getByRole("button", { name: "添加密文绑定" }).click();
  await createForm.getByLabel("注入变量名").fill("AUTOFORGE_JAVA_CASES_SECRET");
  await createForm.getByLabel("执行密文").selectOption({ label: managedSecretName });
  await createForm.getByRole("button", { name: "创建环境" }).click();
  await expect(page.getByRole("heading", { name: managedEnvironmentName })).toBeVisible();

  const variableVersionForm = page.locator("form", {
    has: page.getByRole("button", { name: "创建变量版本" }),
  });
  await variableVersionForm.getByLabel("变量").fill("AUTOFORGE_JAVA_CASES_ENV=java-cases-env-v2");
  await variableVersionForm.getByRole("button", { name: "创建变量版本" }).click();
  await expect(page.getByText("已创建新的普通变量版本。")).toBeVisible();
  await expect(page.locator(".environment-version-list")).toContainText("v2");
}

async function createConcurrentExecutionEnvironment(page: Page): Promise<void> {
  await page.goto("/settings/environments?section=environments");
  await page.getByRole("button", { name: "创建执行环境" }).click();
  const createForm = page.locator(".compact-create-form");
  await createForm.getByLabel("项目").selectOption(DEFAULT_PROJECT_ID);
  await createForm.getByLabel("名称").fill(concurrentEnvironmentName);
  await createForm.getByLabel("说明").fill("java-cases 并发验收普通变量版本");
  await createForm.getByLabel("普通变量").fill("AUTOFORGE_JAVA_CASES_ENV=java-cases-env-v1");
  await createForm.getByRole("button", { name: "创建环境" }).click();
  await expect(page.getByRole("heading", { name: concurrentEnvironmentName })).toBeVisible();

  const variableVersionForm = page.locator("form", {
    has: page.getByRole("button", { name: "创建变量版本" }),
  });
  await variableVersionForm.getByLabel("变量").fill("AUTOFORGE_JAVA_CASES_ENV=java-cases-env-v2");
  await variableVersionForm.getByRole("button", { name: "创建变量版本" }).click();
  await expect(page.getByText("已创建新的普通变量版本。")).toBeVisible();
  await expect(page.locator(".environment-version-list")).toContainText("v2");
}

async function importJavaCasesJar(page: Page): Promise<void> {
  await ensureProjectHierarchy(page);
  await uploadAdapterDependencies(page);
  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page
    .locator('input[type="file"]')
    .setInputFiles(requiredEnvironment("E2E_JAVA_CASES_TEST_JAR"));
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.autoforge.javacases.JavaCasesFixture")).toBeVisible({
    timeout: 20_000,
  });
  const fixtureClass = page.locator("details.class-preview", {
    hasText: "com.autoforge.javacases.JavaCasesFixture",
  });
  if ((await fixtureClass.getAttribute("open")) === null) {
    await fixtureClass.locator("summary").click();
  }
  await expect(
    fixtureClass.getByText("executesThroughJavaCasesModule", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
}

async function ensureProjectHierarchy(page: Page): Promise<void> {
  const projectPath = `/api/v1/projects/${encodeURIComponent(DEFAULT_PROJECT_ID)}`;
  const structureResponse = await page.request.get(`${projectPath}/structure`);
  expect(structureResponse.status()).toBe(200);
  const structure = (await structureResponse.json()) as {
    versions: Array<{ id: string; stages: Array<{ id: string }> }>;
  };
  let version = structure.versions[0];
  const headers = { origin: new URL(page.url()).origin };
  if (!version) {
    const versionResponse = await page.request.post(`${projectPath}/versions`, {
      data: { name: "java-cases 版本" },
      headers,
    });
    expect(versionResponse.status()).toBe(201);
    version = { ...(await versionResponse.json()), stages: [] } as {
      id: string;
      stages: Array<{ id: string }>;
    };
  }
  if (version.stages.length > 0) return;
  const stageResponse = await page.request.post(
    `${projectPath}/versions/${encodeURIComponent(version.id)}/stages`,
    {
      data: { name: "java-cases 阶段", description: "java-cases 全链路验收" },
      headers,
    },
  );
  expect(stageResponse.status()).toBe(201);
}

async function uploadAdapterDependencies(page: Page): Promise<void> {
  await page.goto(
    `/settings/projects?${new URLSearchParams({
      projectId: DEFAULT_PROJECT_ID,
      section: "execution",
    }).toString()}`,
  );
  const uploadForm = page.locator("form", {
    has: page.getByRole("button", { name: "上传并启用" }),
  });
  await uploadForm.getByLabel("资源类型").selectOption("jar-bundle");
  await uploadForm.getByLabel("压缩格式").selectOption("zip");
  await uploadForm
    .getByLabel("本地文件")
    .setInputFiles(requiredEnvironment("E2E_JAVA_CASES_DEPENDENCY_ARCHIVE"));
  await uploadForm.getByRole("button", { name: "上传并启用" }).click();
  await expect(page.getByText("运行时资源已上传并设为当前配置。")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/java-cases-dependencies\.zip/).first()).toBeVisible();
}

async function createExecutableSuite(
  page: Page,
  suiteName: string,
  caseDisplayName: string,
  retryLimit: number,
  artifactPatterns: string[] = [],
): Promise<void> {
  await page.goto(`/case-suites?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.getByLabel("任务名称").fill(suiteName);
  await page.getByLabel("说明").fill("java-cases 模块全链路验收任务");
  await page.getByLabel("使用 CoTest TestNG Adapter").check();
  await page.getByLabel("TestNG Suite Name").fill(`Adapter · ${suiteName}`);
  await page.getByLabel("TestNG Test Name").fill(caseDisplayName);
  if (
    caseDisplayName === "JavaCasesFixture" ||
    caseDisplayName === "JavaCasesConcurrentAlphaFixture" ||
    caseDisplayName === "JavaCasesConcurrentBetaFixture"
  ) {
    await page
      .getByLabel("环境 IP / 地址（每行一个）")
      .fill(`${environmentAddress}\n${backupEnvironmentAddress}`);
  }
  await page.getByRole("button", { name: "创建任务" }).click();
  const suiteLink = page.getByRole("link", { name: suiteName });
  await expect(suiteLink).toBeVisible();
  await suiteLink.click();
  await page.getByLabel("重试次数上限").fill(String(retryLimit));
  await page.getByLabel("产物规则（每行一个相对路径 glob）").fill(artifactPatterns.join("\n"));
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例任务已更新");

  await page.goto(`/cases?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.getByLabel("页内搜索用例").fill(caseDisplayName);
  await page.getByLabel(`选择 ${caseDisplayName}`).first().check();
  await page.getByLabel("目标用例任务").selectOption({ label: suiteName });
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByRole("status")).toContainText("已将 1 个用例加入任务");
}

async function scheduleExecution(
  page: Page,
  suiteName: string,
  environmentName: string = managedEnvironmentName,
): Promise<string> {
  await page.goto(`/run-batches?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  const suiteSelect = page.getByLabel("执行用例任务");
  const suiteOption = suiteSelect.locator("option").filter({ hasText: suiteName });
  const suiteId = await suiteOption.getAttribute("value");
  expect(suiteId).toBeTruthy();
  await suiteSelect.selectOption(suiteId!);

  const runner = page.locator(".runner-choice").filter({ hasText: runnerName });
  await expect(runner).toContainText("兼容");
  await runner.locator('input[type="checkbox"]').check();

  const environmentSelect = page.getByLabel("受管环境版本");
  const environmentOption = environmentSelect
    .locator("option")
    .filter({ hasText: environmentName });
  const versionId = await environmentOption.getAttribute("value");
  expect(versionId).toBeTruthy();
  await environmentSelect.selectOption(versionId!);

  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/run-batches",
  );
  await page.getByRole("button", { name: "开始调度" }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { id?: string };
  expect(body.id).toBeTruthy();
  return body.id!;
}

async function waitForOnlineRunner(page: Page, agent: AgentProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        const response = await page.request.get("/api/v1/runners?limit=100");
        if (!response.ok()) return `HTTP ${response.status()}`;
        const body = (await response.json()) as {
          items: Array<{ name: string; state: string; capabilities: string[] }>;
        };
        const runner = body.items.find((candidate) => candidate.name === runnerName);
        if (!runner) return "not-registered";
        if (!runner.capabilities.includes("isolation:cgroup-v2")) return "cgroup-missing";
        if (!runner.capabilities.includes("adapter:cotest-testng-v1")) return "adapter-missing";
        if (!runner.capabilities.includes("runtime:project-assets-v1")) {
          return "runtime-assets-missing";
        }
        return runner.state;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe("online");

  // 执行机添加的 UI 证据：/runners 页面能看到新注册的执行机。
  await page.goto("/runners");
  await expect(page.getByRole("row", { name: new RegExp(runnerName) })).toBeVisible({
    timeout: 20_000,
  });
}

async function waitForTerminalBatch(
  page: Page,
  batchId: string,
  agent: AgentProcess,
  expectedStatus: string,
  expectedResultCode: string,
  expectedAttempts: number,
): Promise<BatchDetails> {
  let latest: BatchDetails | undefined;
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
        );
        if (!response.ok()) return `HTTP ${response.status()}`;
        latest = (await response.json()) as BatchDetails;
        return `${latest.status}:${latest.attempts.at(-1)?.resultCode ?? "pending"}:${latest.attempts.length}`;
      },
      { timeout: 180_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(`${expectedStatus}:${expectedResultCode}:${expectedAttempts}`);
  return latest!;
}

async function waitForAttemptState(
  page: Page,
  batchId: string,
  agent: AgentProcess,
  expectedState: string,
): Promise<string> {
  let attemptId: string | undefined;
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
        );
        if (!response.ok()) return `HTTP ${response.status()}`;
        const details = (await response.json()) as BatchDetails;
        const attempt = details.attempts.at(-1);
        attemptId = attempt?.id;
        return attempt?.status ?? details.status;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(expectedState);
  if (!attemptId) throw new Error(`Batch ${batchId} reached ${expectedState} without an attempt.`);
  return attemptId;
}

function captureBounded(
  stream: NodeJS.ReadableStream,
  diagnostics: string[],
  bootstrapToken: string,
): void {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const redacted = chunk.replaceAll(bootstrapToken, "[REDACTED]");
    diagnostics.push(redacted);
    while (diagnostics.join("").length > 256_000 && diagnostics.length > 1) diagnostics.shift();
  });
}

function assertAgentRunning(agent: AgentProcess): void {
  if (agent.child.exitCode !== null) {
    throw new Error(
      `The java-cases Agent exited with code ${agent.child.exitCode}.\n${agent.diagnostics.join("")}`,
    );
  }
}

async function attachAgentDiagnostics(testInfo: TestInfo, agent: AgentProcess): Promise<void> {
  await testInfo.attach("java-cases-agent-diagnostics", {
    body: Buffer.from(agent.diagnostics.join(""), "utf8"),
    contentType: "text/plain",
  });
}

async function stopAgent(agent: AgentProcess): Promise<void> {
  if (agent.child.exitCode !== null || agent.child.pid === undefined) return;
  try {
    process.kill(-agent.child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (agent.child.exitCode !== null) return;
  const exited = once(agent.child, "exit").then(() => true);
  const timedOut = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), 10_000).unref();
  });
  if (!(await Promise.race([exited, timedOut]))) {
    if (agent.child.exitCode !== null) return;
    process.kill(-agent.child.pid, "SIGKILL");
    if (agent.child.exitCode === null) await once(agent.child, "exit");
  }
}

async function readAttemptLogs(
  page: Page,
  attemptId: string,
  stream: "stdout" | "stderr" | "agent",
): Promise<string> {
  const response = await page.request.get(
    `/api/v1/run-attempts/${encodeURIComponent(attemptId)}/logs?stream=${stream}&limit=500`,
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<{ content: string }> };
  return body.items.map((item) => item.content).join("");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the java-cases acceptance test.`);
  return value;
}
