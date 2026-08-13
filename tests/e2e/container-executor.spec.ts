import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { ensureAdministrator } from "./support/session";

const execFileAsync = promisify(execFile);
const runnerName = "Container Executor Agent";
const suiteName = "容器执行器安全验收";

test("executes and cancels TestNG in a constrained immutable container", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  await ensureAdministrator(page);

  const agent = await startAgent();
  try {
    await waitForOnlineRunner(page, agent);
    await importContainerFixture(page);
    await createContainerSuite(page);

    const successfulBatchId = await scheduleExecution(page, "success");
    const succeeded = await waitForBatch(page, successfulBatchId, agent, "succeeded");
    expect(succeeded.attempts.at(-1)).toMatchObject({
      status: "succeeded",
      resultCode: "TESTNG_SUCCEEDED",
      testNg: { total: 1, passed: 1, failed: 0, skipped: 0 },
    });
    await page.goto(`/run-batches/${encodeURIComponent(successfulBatchId)}`);
    await expect(page.locator(".execution-log")).toContainText("CONTAINER_POLICY_STDOUT_中文_完成");
    await page.getByRole("button", { name: "stderr", exact: true }).click();
    await expect(page.locator(".execution-log")).toContainText("CONTAINER_POLICY_STDERR_CAPTURED");
    await expect(page.getByText(/reports\/testng\/testng-results\.xml/)).toBeVisible();

    const cancellationBatchId = await scheduleExecution(page, "cancel");
    await waitForRunningContainer(agent);
    await page.goto(`/run-batches/${encodeURIComponent(cancellationBatchId)}`);
    page.once("dialog", (dialog) => dialog.accept("Container cleanup acceptance"));
    await page.getByRole("button", { name: "取消该用例" }).click();
    const cancelled = await waitForBatch(page, cancellationBatchId, agent, "cancelled");
    expect(cancelled.attempts.at(-1)).toMatchObject({
      status: "cancelled",
      resultCode: "CANCELLED_BY_CONTROL_PLANE",
    });
    await expect.poll(runningContainerIDs, { timeout: 30_000 }).toEqual([]);
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
    status: string;
    resultCode?: string;
    resultSummary?: string;
    testNg?: {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
    };
  }>;
};

async function startAgent(): Promise<AgentProcess> {
  const bootstrapToken = requiredEnvironment("E2E_RUNNER_BOOTSTRAP_TOKEN");
  const child = spawn(requiredEnvironment("E2E_CONTAINER_AGENT_BINARY"), ["start"], {
    detached: true,
    env: {
      ...process.env,
      AUTOFORGE_SERVER_URL: "http://127.0.0.1:3100",
      AUTOFORGE_AGENT_DATA_DIR: requiredEnvironment("E2E_CONTAINER_AGENT_DATA_DIR"),
      AUTOFORGE_AGENT_NAME: runnerName,
      AUTOFORGE_AGENT_LABELS: "acceptance,container,offline",
      AUTOFORGE_AGENT_MAX_CONCURRENCY: "1",
      AUTOFORGE_AGENT_BOOTSTRAP_TOKEN: bootstrapToken,
      AUTOFORGE_AGENT_JAVA_EXECUTABLE: requiredEnvironment("E2E_HOST_JAVA_EXECUTABLE"),
      AUTOFORGE_AGENT_JAVA_VERSION: requiredEnvironment("E2E_HOST_JAVA_VERSION"),
      AUTOFORGE_AGENT_TESTNG_CLASSPATH: requiredEnvironment("E2E_HOST_TESTNG_CLASSPATH"),
      AUTOFORGE_AGENT_TESTNG_VERSION: "7.11.0",
      AUTOFORGE_AGENT_CONTAINER_RUNTIME: requiredEnvironment("E2E_CONTAINER_RUNTIME"),
      AUTOFORGE_AGENT_CONTAINER_IMAGE: requiredEnvironment("E2E_CONTAINER_IMAGE"),
      AUTOFORGE_AGENT_CONTAINER_SECCOMP: requiredEnvironment("E2E_CONTAINER_SECCOMP"),
      AUTOFORGE_AGENT_CONTAINER_USER: requiredEnvironment("E2E_CONTAINER_USER"),
      AUTOFORGE_AGENT_CONTAINER_JAVA_EXECUTABLE: "/opt/java/openjdk/bin/java",
      AUTOFORGE_AGENT_CONTAINER_TESTNG_CLASSPATH:
        "/opt/autoforge/testng/testng-7.11.0.jar:/opt/autoforge/testng/jcommander-1.83.jar:/opt/autoforge/testng/slf4j-api-2.0.16.jar:/opt/autoforge/testng/jquery-3.7.1.jar",
      AUTOFORGE_AGENT_CGROUP_ROOT: requiredEnvironment("E2E_CONTAINER_CGROUP_ROOT"),
      AUTOFORGE_AGENT_CLAIM_WAIT: "1s",
      AUTOFORGE_AGENT_CLAIM_MAX_BACKOFF: "1s",
      AUTOFORGE_AGENT_SHUTDOWN_GRACE: "10s",
    },
    stdio: "pipe",
  });
  const diagnostics: string[] = [];
  captureBounded(child.stdout, diagnostics, bootstrapToken);
  captureBounded(child.stderr, diagnostics, bootstrapToken);
  await writeFile(requiredEnvironment("E2E_CONTAINER_AGENT_PID_FILE"), `${child.pid ?? ""}\n`, {
    mode: 0o600,
  });
  return { child, diagnostics };
}

function captureBounded(
  stream: NodeJS.ReadableStream,
  diagnostics: string[],
  bootstrapToken: string,
): void {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    diagnostics.push(chunk.replaceAll(bootstrapToken, "[REDACTED]"));
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
        if (!runner.capabilities.includes("executor:testng-container-v1")) {
          return "container-capability-missing";
        }
        return runner.state;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe("online");
}

async function importContainerFixture(page: Page): Promise<void> {
  await page.goto("/cases/import");
  await page
    .locator('input[type="file"]')
    .setInputFiles(requiredEnvironment("E2E_CONTAINER_TEST_JAR"));
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.autoforge.acceptance.ContainerAgentFixture")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".method-row code")).toHaveText("enforcesContainerPolicy");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
}

async function createContainerSuite(page: Page): Promise<void> {
  await page.goto("/case-suites");
  await page.getByLabel("任务名称").fill(suiteName);
  await page.getByLabel("说明").fill("GitHub Actions 真实容器隔离与取消清理验收");
  await page.getByRole("button", { name: "创建任务" }).click();
  const suiteLink = page.getByRole("link", { name: new RegExp(suiteName) });
  await expect(suiteLink).toBeVisible();
  await suiteLink.click();
  await page.getByLabel("执行器").selectOption("testng-container");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例任务已更新");

  await page.goto("/cases");
  await page.getByLabel("选择 ContainerAgentFixture").check();
  await page.getByLabel("目标用例任务").selectOption({ label: suiteName });
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByRole("status")).toContainText("已将 1 个用例加入任务");
}

async function scheduleExecution(page: Page, mode: "success" | "cancel"): Promise<string> {
  await page.goto("/run-batches");
  const runner = page.locator(".runner-choice").filter({ hasText: runnerName });
  await expect(runner).toContainText("兼容");
  await runner.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "添加变量" }).click();
  await page.getByLabel("环境变量名").fill("AUTOFORGE_CONTAINER_MODE");
  await page.getByLabel("环境变量值").fill(mode);
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

async function waitForBatch(
  page: Page,
  batchId: string,
  agent: AgentProcess,
  expectedStatus: "succeeded" | "cancelled",
): Promise<BatchDetails> {
  let latest: BatchDetails | undefined;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assertAgentRunning(agent);
    const response = await page.request.get(`/api/v1/run-batches/${encodeURIComponent(batchId)}`);
    if (!response.ok()) {
      await page.waitForTimeout(500);
      continue;
    }
    latest = (await response.json()) as BatchDetails;
    if (latest.status === expectedStatus) return latest;
    if (["succeeded", "failed", "cancelled"].includes(latest.status)) {
      const attempt = latest.attempts.at(-1);
      const logs = attempt ? await readAttemptLogs(page, attempt.id) : "No attempt was created.";
      throw new Error(
        `Batch ${batchId} reached ${latest.status}, expected ${expectedStatus}. ` +
          `${attempt?.resultCode ?? "NO_RESULT_CODE"}: ${attempt?.resultSummary ?? "No result summary."}\n${logs}`,
      );
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Batch ${batchId} did not reach ${expectedStatus}; last status was ${latest?.status ?? "unknown"}.`,
  );
}

async function readAttemptLogs(page: Page, attemptId: string): Promise<string> {
  const streams = await Promise.all(
    (["agent", "stdout", "stderr"] as const).map(async (stream) => {
      const response = await page.request.get(
        `/api/v1/run-attempts/${encodeURIComponent(attemptId)}/logs?stream=${stream}&limit=500`,
      );
      if (!response.ok()) return `${stream}: HTTP ${response.status()}`;
      const body = (await response.json()) as { items: Array<{ content: string }> };
      return `${stream}:\n${body.items.map((item) => item.content).join("")}`;
    }),
  );
  return streams.join("\n");
}

async function waitForRunningContainer(agent: AgentProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        return runningContainerIDs();
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .not.toEqual([]);
}

async function runningContainerIDs(): Promise<string[]> {
  const { stdout } = await execFileAsync(requiredEnvironment("E2E_CONTAINER_RUNTIME"), [
    "ps",
    "--filter",
    `ancestor=${requiredEnvironment("E2E_CONTAINER_IMAGE")}`,
    "--format",
    "{{.ID}}",
  ]);
  return stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function assertAgentRunning(agent: AgentProcess): void {
  if (agent.child.exitCode !== null) {
    throw new Error(
      `The container Agent exited with code ${agent.child.exitCode}.\n${agent.diagnostics.join("")}`,
    );
  }
}

async function attachAgentDiagnostics(testInfo: TestInfo, agent: AgentProcess): Promise<void> {
  await testInfo.attach("container-agent-diagnostics", {
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for container executor acceptance.`);
  return value;
}
