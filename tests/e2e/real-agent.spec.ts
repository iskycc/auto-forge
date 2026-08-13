import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";

import { ensureAdministrator } from "./support/session";

const runnerName = "Offline Real Agent";
const managedEnvironmentName = "真实 Agent 受管环境";
const managedSecretName = "真实 Agent 执行密文";
const successSuiteName = "真实 Agent 离线验收";
const failureSuiteName = "真实 Agent 失败重试验收";
const restartSuiteName = "真实 Agent 重启协调验收";
const secretValueV1 = "real-agent-secret-v1-do-not-leak-8f31";
const secretValueV2 = "real-agent-secret-v2-rotated-71ce";

test("executes a TestNG JAR through the real Go Agent", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  await ensureAdministrator(page);

  let agent = await startAgent();
  const agents = [agent];
  try {
    await waitForOnlineRunner(page, agent);
    await createManagedExecutionEnvironment(page);
    await importTestJar(page);
    await createExecutableSuite(page, successSuiteName, "RealAgentFixture", 0, [
      "reports/testng/**",
      "artifacts/*.txt",
    ]);
    const batchId = await scheduleExecution(page, successSuiteName);
    const details = await waitForSucceededBatch(page, batchId, agent);

    expect(details.attempts[0]?.testNg).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      configurationFailures: 0,
    });

    await page.goto(`/run-batches/${encodeURIComponent(batchId)}`);
    await expect(page.getByRole("heading", { name: "结构化测试结果" })).toBeVisible();
    await expect(page.getByLabel("TestNG 结果汇总")).toContainText("通过1");
    await expect(page.getByText("executesThroughRealAgent", { exact: true })).toBeVisible();

    await expect(page.locator(".execution-log")).toContainText(
      "REAL_AGENT_STDOUT_中文_完成:workflow-v2",
    );
    await expect(page.locator(".execution-log")).toContainText("[REDACTED]");
    await expect(page.locator(".execution-log")).not.toContainText(secretValueV1);
    expect(agent.diagnostics.join("")).not.toContain(secretValueV1);
    expect(agent.diagnostics.join("")).not.toContain(secretValueV2);
    await page.getByRole("button", { name: "stderr", exact: true }).click();
    await expect(page.locator(".execution-log")).toContainText("REAL_AGENT_STDERR_CAPTURED");
    await page.getByRole("button", { name: "agent", exact: true }).click();
    await expect(page.locator(".execution-log")).toContainText(
      "AutoForge Runner Agent started the attempt.",
    );
    await expect(page.getByText(/reports\/testng\/testng-results\.xml/)).toBeVisible();
    await expect(page.getByLabel(/下载 reports\/testng\/testng-results\.xml/)).toBeVisible();
    const customArtifact = page.getByLabel("下载 artifacts/real-agent.txt");
    await expect(customArtifact).toBeVisible();
    const artifactHref = await customArtifact.getAttribute("href");
    expect(artifactHref).toBeTruthy();
    const artifactDownload = await page.request.get(artifactHref!);
    expect(artifactDownload.status()).toBe(200);
    expect(await artifactDownload.text()).toBe("REAL_AGENT_ARTIFACT_SAFE\n");

    await expectEnvironmentReference(page, batchId);
    await expectDisabledSecretBlocksNewBatch(page);

    await createExecutableSuite(page, failureSuiteName, "RealAgentFailureFixture", 1);
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
      const logs = await readAttemptLogs(page, attempt.id, "stdout");
      expect(logs).toContain("[REDACTED]");
      expect(logs).not.toContain(secretValueV1);
    }
    await page.goto(`/run-batches/${encodeURIComponent(failureBatchId)}`);
    await expect(
      page.getByText("failsAfterRealProcessOutput", { exact: true }).last(),
    ).toBeVisible();
    await expect(page.locator(".execution-log")).not.toContainText(secretValueV1);

    await createExecutableSuite(page, restartSuiteName, "RealAgentRestartFixture", 0);
    const restartBatchId = await scheduleExecution(page, restartSuiteName);
    await waitForAttemptState(page, restartBatchId, agent, "running");
    await killAgentAbruptly(agent);
    agent = await startAgent();
    agents.push(agent);
    await waitForOnlineRunner(page, agent);
    await waitForTerminalBatch(
      page,
      restartBatchId,
      agent,
      "failed",
      "AGENT_RESTARTED_DURING_EXECUTION",
      1,
    );
    await page.goto(`/run-batches/${encodeURIComponent(restartBatchId)}`);
    await expect(page.getByText("AGENT_RESTARTED_DURING_EXECUTION", { exact: true })).toBeVisible();

    const fullFaultControlDirectory = process.env.E2E_FULL_FAULT_CONTROL_DIR?.trim();
    if (fullFaultControlDirectory) {
      await exerciseFullDependencyRecovery(page, agent, fullFaultControlDirectory);
    }

    await exerciseRealTerminal(page, agent);
  } finally {
    for (const [index, observedAgent] of agents.entries()) {
      await attachAgentDiagnostics(testInfo, observedAgent, index);
    }
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

async function startAgent(): Promise<AgentProcess> {
  const binary = requiredEnvironment("E2E_REAL_AGENT_BINARY");
  const bootstrapToken = requiredEnvironment("E2E_RUNNER_BOOTSTRAP_TOKEN");
  const pidFile = requiredEnvironment("E2E_REAL_AGENT_PID_FILE");
  const child = spawn(binary, ["start"], {
    detached: true,
    env: {
      ...process.env,
      AUTOFORGE_SERVER_URL: process.env.E2E_REAL_AGENT_SERVER_URL ?? "http://127.0.0.1:3100",
      AUTOFORGE_AGENT_DATA_DIR: requiredEnvironment("E2E_REAL_AGENT_DATA_DIR"),
      AUTOFORGE_AGENT_NAME: runnerName,
      AUTOFORGE_AGENT_LABELS: "acceptance,offline",
      AUTOFORGE_AGENT_MAX_CONCURRENCY: "1",
      AUTOFORGE_AGENT_BOOTSTRAP_TOKEN: bootstrapToken,
      AUTOFORGE_AGENT_JAVA_EXECUTABLE: requiredEnvironment("E2E_REAL_JAVA_EXECUTABLE"),
      AUTOFORGE_AGENT_JAVA_VERSION: requiredEnvironment("E2E_REAL_JAVA_VERSION"),
      AUTOFORGE_AGENT_TESTNG_CLASSPATH: requiredEnvironment("E2E_REAL_TESTNG_CLASSPATH"),
      AUTOFORGE_AGENT_TESTNG_VERSION: "7.11.0",
      AUTOFORGE_AGENT_CGROUP_ROOT: requiredEnvironment("E2E_REAL_CGROUP_ROOT"),
      AUTOFORGE_AGENT_CLAIM_WAIT: "1s",
      AUTOFORGE_AGENT_CLAIM_MAX_BACKOFF: "1s",
      AUTOFORGE_AGENT_SHUTDOWN_GRACE: "10s",
      AUTOFORGE_AGENT_TERMINAL_ENABLED: "true",
      AUTOFORGE_AGENT_TERMINAL_SHELL: "/bin/sh",
      AUTOFORGE_AGENT_TERMINAL_MAX_SESSIONS: "1",
      AUTOFORGE_AGENT_TERMINAL_MAX_DURATION: "2m",
    },
    stdio: "pipe",
  });
  const diagnostics: string[] = [];
  captureBounded(child.stdout, diagnostics, bootstrapToken);
  captureBounded(child.stderr, diagnostics, bootstrapToken);
  await writeFile(pidFile, `${child.pid ?? ""}\n`, { mode: 0o600 });
  return { child, diagnostics };
}

async function createManagedExecutionEnvironment(page: Page): Promise<void> {
  await page.goto("/settings/environments");
  await page.getByRole("button", { name: "密文", exact: true }).click();
  const secretPanel = page.locator(".secret-create-panel");
  await secretPanel.getByLabel("名称").fill(managedSecretName);
  await secretPanel.getByLabel("说明").fill("真实 Agent lease 与脱敏验收");
  await secretPanel.getByLabel("密文值").fill(secretValueV1);
  await secretPanel.getByRole("button", { name: "创建密文" }).click();
  await expect(page.getByText("执行密文已创建。")).toBeVisible();

  await page.getByRole("button", { name: "环境", exact: true }).click();
  await page.getByRole("button", { name: "创建执行环境" }).click();
  const createForm = page.locator(".compact-create-form");
  await createForm.getByLabel("名称").fill(managedEnvironmentName);
  await createForm.getByLabel("说明").fill("固定普通变量与密文版本");
  await createForm.getByLabel("普通变量").fill("AUTOFORGE_REAL_AGENT_ENV=workflow-v1");
  await createForm.getByRole("button", { name: "添加密文绑定" }).click();
  await createForm.getByLabel("注入变量名").fill("AUTOFORGE_REAL_AGENT_SECRET");
  await createForm.getByLabel("执行密文").selectOption({ label: managedSecretName });
  await createForm.getByRole("button", { name: "创建环境" }).click();
  await expect(page.getByRole("heading", { name: managedEnvironmentName })).toBeVisible();

  const variableVersionForm = page.locator("form", {
    has: page.getByRole("button", { name: "创建变量版本" }),
  });
  await variableVersionForm.getByLabel("变量").fill("AUTOFORGE_REAL_AGENT_ENV=workflow-v2");
  await variableVersionForm.getByRole("button", { name: "创建变量版本" }).click();
  await expect(page.getByText("已创建新的普通变量版本。")).toBeVisible();
  await expect(page.locator(".environment-version-list")).toContainText("v2");

  await page.getByRole("button", { name: "密文", exact: true }).click();
  await page
    .locator(".secret-record-list")
    .getByRole("button", { name: /真实 Agent 执行密文/ })
    .click();
  const rotationForm = page.locator(".secret-rotation-form");
  await rotationForm.getByLabel("新密文值").fill(secretValueV2);
  await rotationForm.getByRole("button", { name: "轮换" }).click();
  await expect(page.getByText("执行密文已轮换。")).toBeVisible();
}

async function exerciseRealTerminal(page: Page, agent: AgentProcess): Promise<void> {
  await page.goto("/runners");
  const runnerRow = page.getByRole("row", { name: new RegExp(runnerName) });
  const terminalButton = runnerRow.getByRole("button", { name: "终端浮窗" });
  await expect(terminalButton).toBeEnabled();
  await terminalButton.click();
  await page.getByRole("button", { name: "连接终端" }).click();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 20_000 });

  await sendTerminalInput(page, "printf 'REAL_PTY_INPUT=中文\\n'");
  await expect(page.locator(".terminal-viewport")).toContainText("REAL_PTY_INPUT=中文");
  await sendTerminalInput(page, "sleep 120 & printf 'REAL_PTY_CHILD=%s\\n' \"$!\"");
  let terminalText = "";
  await expect
    .poll(
      async () => {
        terminalText = (await page.locator(".terminal-viewport").textContent()) ?? "";
        return terminalText;
      },
      { timeout: 10_000 },
    )
    .toMatch(/REAL_PTY_CHILD=[1-9][0-9]*/);
  const childPID = Number(/REAL_PTY_CHILD=([1-9][0-9]*)/.exec(terminalText)?.[1]);
  expect(Number.isSafeInteger(childPID)).toBe(true);
  expect(isProcessAlive(childPID)).toBe(true);

  await page.reload();
  await expect.poll(() => isProcessAlive(childPID), { timeout: 10_000 }).toBe(false);
  assertAgentRunning(agent);

  const refreshedRow = page.getByRole("row", { name: new RegExp(runnerName) });
  await refreshedRow.getByRole("button", { name: "终端浮窗" }).click();
  await page.getByRole("button", { name: "连接终端" }).click();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible({ timeout: 20_000 });
  await sendTerminalInput(page, "printf 'REAL_PTY_RECONNECTED\\n'");
  await expect(page.locator(".terminal-viewport")).toContainText("REAL_PTY_RECONNECTED");
  await page.getByRole("button", { name: "关闭终端" }).click();

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          "/api/v1/audit-events?action=terminal.session_finished&limit=20",
        );
        if (!response.ok()) return 0;
        const body = (await response.json()) as { items: Array<{ action: string }> };
        return body.items.filter((event) => event.action === "terminal.session_finished").length;
      },
      { timeout: 20_000, intervals: [500, 1_000] },
    )
    .toBeGreaterThanOrEqual(2);
}

async function sendTerminalInput(page: Page, command: string): Promise<void> {
  const input = page.locator(".terminal-window .xterm-helper-textarea");
  await expect(input).toBeFocused();
  await input.pressSequentially(command);
  await input.press("Enter");
}

function isProcessAlive(processID: number): boolean {
  try {
    process.kill(processID, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
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
        return runner.state;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe("online");
}

async function importTestJar(page: Page): Promise<void> {
  await page.goto("/cases/import");
  await page.locator('input[type="file"]').setInputFiles(requiredEnvironment("E2E_REAL_TEST_JAR"));
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.autoforge.acceptance.RealAgentFixture")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".method-row code")).toHaveText("executesThroughRealAgent");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
}

async function createExecutableSuite(
  page: Page,
  suiteName: string,
  caseDisplayName: string,
  retryLimit: number,
  artifactPatterns: string[] = ["reports/testng/**"],
): Promise<void> {
  await page.goto("/case-suites");
  await page.getByLabel("任务名称").fill(suiteName);
  await page.getByLabel("说明").fill("由真实 Go Agent 与离线 TestNG 工具链执行");
  await page.getByRole("button", { name: "创建任务" }).click();
  const suiteLink = page.getByRole("link", { name: suiteName });
  await expect(suiteLink).toBeVisible();
  await suiteLink.click();
  await page.getByLabel("重试次数上限").fill(String(retryLimit));
  await page.getByLabel("产物规则（每行一个相对路径 glob）").fill(artifactPatterns.join("\n"));
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例任务已更新");

  await page.goto("/cases");
  await page.getByLabel(`选择 ${caseDisplayName}`).check();
  await page.getByLabel("目标用例任务").selectOption({ label: suiteName });
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByRole("status")).toContainText("已将 1 个用例加入任务");
}

async function scheduleExecution(page: Page, suiteName: string): Promise<string> {
  await page.goto("/run-batches");
  const suiteSelect = page.getByLabel("用例任务").last();
  const suiteOption = suiteSelect.locator("option").filter({ hasText: suiteName });
  const suiteId = await suiteOption.getAttribute("value");
  expect(suiteId).toBeTruthy();
  await suiteSelect.selectOption(suiteId!);
  const runner = page.locator(".runner-choice").filter({ hasText: runnerName });
  await expect(runner).toContainText("兼容");
  await runner.locator('input[type="checkbox"]').check();
  await selectManagedEnvironment(page);
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

async function selectManagedEnvironment(page: Page): Promise<void> {
  const environmentSelect = page.getByLabel("受管环境版本");
  const option = environmentSelect.locator("option").filter({ hasText: managedEnvironmentName });
  const versionId = await option.getAttribute("value");
  expect(versionId).toBeTruthy();
  await environmentSelect.selectOption(versionId!);
}

async function expectEnvironmentReference(page: Page, batchId: string): Promise<void> {
  await page.goto("/settings/environments");
  await page
    .locator(".environment-record-list")
    .getByRole("button", { name: new RegExp(managedEnvironmentName) })
    .click();
  const reference = page.locator(".environment-reference-list").getByRole("link");
  await expect(reference).toHaveAttribute("href", `/run-batches/${batchId}`);
}

async function expectDisabledSecretBlocksNewBatch(page: Page): Promise<void> {
  await page.goto("/settings/environments");
  await page.getByRole("button", { name: "密文", exact: true }).click();
  await page
    .locator(".secret-record-list")
    .getByRole("button", { name: new RegExp(managedSecretName) })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "停用", exact: true }).click();
  await expect(page.getByText("执行密文已停用。")).toBeVisible();

  await page.goto("/run-batches");
  const runner = page.locator(".runner-choice").filter({ hasText: runnerName });
  await runner.locator('input[type="checkbox"]').check();
  await selectManagedEnvironment(page);
  await page.getByRole("button", { name: "开始调度" }).click();
  await expect(page.getByText("执行配置仍有阻塞项，请逐项处理后重试。")).toBeVisible();
  await expect(page.getByLabel("执行配置阻塞项")).toContainText("密文");

  await page.goto("/settings/environments");
  await page.getByRole("button", { name: "密文", exact: true }).click();
  await page
    .locator(".secret-record-list")
    .getByRole("button", { name: new RegExp(managedSecretName) })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "启用", exact: true }).click();
  await expect(page.getByText("执行密文已启用。")).toBeVisible();
}

async function waitForSucceededBatch(
  page: Page,
  batchId: string,
  agent: AgentProcess,
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
        const resultCode = latest.attempts.at(-1)?.resultCode;
        return resultCode ? `${latest.status}:${resultCode}` : latest.status;
      },
      { timeout: 120_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe("succeeded:TESTNG_SUCCEEDED");
  return latest!;
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
): Promise<void> {
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
        );
        if (!response.ok()) return `HTTP ${response.status()}`;
        const details = (await response.json()) as BatchDetails;
        return details.attempts.at(-1)?.status ?? details.status;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(expectedState);
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

async function exerciseFullDependencyRecovery(
  page: Page,
  agent: AgentProcess,
  controlDirectory: string,
): Promise<void> {
  await exerciseFailedJarImportRetry(page, controlDirectory);
  await exerciseAnalyticsExportCancellation(page, controlDirectory);
  const suiteName = "真实 Agent Full 依赖恢复验收";
  await createExecutableSuite(page, suiteName, "RealAgentRecoveryFixture", 0, [
    "reports/testng/**",
    "artifacts/*.txt",
  ]);

  const natsBatchId = await duringPausedDependency(controlDirectory, "nats", () =>
    scheduleExecution(page, suiteName),
  );
  const natsResult = await waitForSucceededBatch(page, natsBatchId, agent);
  expect(natsResult.attempts).toHaveLength(1);

  const postgresBatchId = await scheduleExecution(page, suiteName);
  await waitForAttemptState(page, postgresBatchId, agent, "running");
  await duringPausedDependency(controlDirectory, "postgres", async () => {
    await delay(2_000);
  });
  await waitForSucceededBatch(page, postgresBatchId, agent);

  const redisSearch = await duringPausedDependency(controlDirectory, "redis", () =>
    page.request.get("/api/v1/search?query=RealAgentRecoveryFixture"),
  );
  expect(redisSearch.status()).toBe(200);
  expect((await redisSearch.json()) as { items: unknown[] }).toMatchObject({
    items: expect.any(Array),
  });

  const minioMarker = join(controlDirectory, "minio.fail-next-put");
  const minioAcknowledgement = join(controlDirectory, "minio.fail-next-put.ack");
  await rm(minioAcknowledgement, { force: true });
  await writeFile(minioMarker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  const minioBatchId = await scheduleExecution(page, suiteName);
  await waitForSucceededBatch(page, minioBatchId, agent);
  await waitForFile(minioAcknowledgement, 60_000);
  await page.goto(`/run-batches/${encodeURIComponent(minioBatchId)}`);
  const artifact = page.getByLabel("下载 artifacts/full-recovery.txt");
  await expect(artifact).toBeVisible();
  const href = await artifact.getAttribute("href");
  expect(href).toBeTruthy();
  const download = await page.request.get(href!);
  expect(await download.text()).toBe("FULL_RECOVERY_ARTIFACT\n");
}

async function exerciseAnalyticsExportCancellation(
  page: Page,
  controlDirectory: string,
): Promise<void> {
  const result = await duringPausedDependency(controlDirectory, "nats", () =>
    page.evaluate(async () => {
      const create = await fetch("/api/v1/analytics/exports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ filter: {}, format: "csv" }),
      });
      const job = (await create.json()) as { id: string };
      const cancellation = await fetch(
        `/api/v1/analytics/exports/${encodeURIComponent(job.id)}/cancel`,
        { method: "POST" },
      );
      return {
        createStatus: create.status,
        cancelStatus: cancellation.status,
        job: (await cancellation.json()) as { status: string },
      };
    }),
  );
  expect(result).toMatchObject({
    createStatus: 202,
    cancelStatus: 200,
    job: { status: "cancelled" },
  });
}

async function exerciseFailedJarImportRetry(page: Page, controlDirectory: string): Promise<void> {
  const entries = unzipSync(await readFile(requiredEnvironment("E2E_REAL_TEST_JAR")));
  entries[`full-failure-${Date.now()}.txt`] = new TextEncoder().encode("failure retry fixture");
  const jar = zipSync(entries);
  await page.goto("/cases/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "real-agent-full-retry.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.autoforge.acceptance.RealAgentFixture")).toBeVisible();

  const failureMarker = join(controlDirectory, "minio.fail-get");
  const failureAcknowledgement = join(controlDirectory, "minio.fail-get.ack");
  await rm(failureAcknowledgement, { force: true });
  await writeFile(failureMarker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await waitForFile(failureAcknowledgement, 30_000);
  await expect(page.getByRole("button", { name: "幂等重试" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("alert")).toContainText(/MinIO|503|对象|S3/);

  await rm(failureMarker, { force: true });
  await page.getByRole("button", { name: "幂等重试" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
}

async function duringPausedDependency<T>(
  controlDirectory: string,
  dependency: "nats" | "postgres" | "redis",
  operation: () => Promise<T>,
): Promise<T> {
  const pauseMarker = join(controlDirectory, `${dependency}.pause`);
  const pausedAcknowledgement = join(controlDirectory, `${dependency}.paused`);
  const resumeMarker = join(controlDirectory, `${dependency}.resume`);
  const resumedAcknowledgement = join(controlDirectory, `${dependency}.resumed`);
  await Promise.all([
    rm(pausedAcknowledgement, { force: true }),
    rm(resumedAcknowledgement, { force: true }),
  ]);
  await writeFile(pauseMarker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  await waitForFile(pausedAcknowledgement, 30_000);
  const operationPromise = operation();
  void operationPromise.catch(() => undefined);
  await delay(2_000);
  await writeFile(resumeMarker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  await waitForFile(resumedAcknowledgement, 30_000);
  return operationPromise;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: timeoutMs, intervals: [100, 250, 500] },
    )
    .toBe(true);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertAgentRunning(agent: AgentProcess): void {
  if (agent.child.exitCode !== null) {
    throw new Error(
      `The real Agent exited with code ${agent.child.exitCode}.\n${agent.diagnostics.join("")}`,
    );
  }
}

async function attachAgentDiagnostics(
  testInfo: TestInfo,
  agent: AgentProcess,
  index: number,
): Promise<void> {
  await testInfo.attach(`real-agent-diagnostics-${index + 1}`, {
    body: Buffer.from(agent.diagnostics.join(""), "utf8"),
    contentType: "text/plain",
  });
}

async function killAgentAbruptly(agent: AgentProcess): Promise<void> {
  if (agent.child.exitCode !== null || agent.child.pid === undefined) return;
  process.kill(-agent.child.pid, "SIGKILL");
  if (agent.child.exitCode === null) await once(agent.child, "exit");
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real Agent acceptance test.`);
  return value;
}
