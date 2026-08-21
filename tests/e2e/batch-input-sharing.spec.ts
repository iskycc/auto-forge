import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, lstat, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { ensureAdministrator } from "./support/session";
import {
  configureTaskExecution,
  createTaskRun,
  findRunnerId,
  findSuiteId,
} from "./support/task-execution";

// 批次级输入共享端到端验收：同一 batchId 的 test-jar / jar-bundle 输入在
// <Agent数据目录>/work/batches/<batchId>/ 只下载一次，依赖压缩包也只解压一次；
// 同批次并发 attempt 通过文件级硬链接与 JDK 目录链接共享（inode 相同证明没有重复物化）；
// 首轮并发结束后启动的后续 attempt 仍复用同一份文件；批次终态后共享目录被回收；
// Agent 异常中断重启后保留仍未结束批次的运行时，reconcile 后继续复用。
// 本规格不设置 AUTOFORGE_AGENT_CGROUP_ROOT：无 cgroup 环境走 rlimit 回退，
// 控制面也会过滤掉 isolation:cgroup-v2 的匹配要求。

const runnerName = "Batch Share Agent";
const suiteName = "batch-share 输入共享验收";
const environmentAddress = "10.20.30.40";

// 注册令牌是一次性的：两个 test 复用同一个数据目录与 runner 身份，
// 第二个 test 的 Agent 直接沿用第一个 test 注册后持久化的凭据，不再消耗令牌。
const agentDataDirectory = join(requiredEnvironment("E2E_BATCH_SHARE_AGENT_DATA_DIR"), "agent");

test("同批次并发 attempt 共享输入目录，批次终态后回收", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  await ensureAdministrator(page);

  const agent = await startAgent();
  try {
    await waitForOnlineRunner(page, agent);
    await importJavaCasesJar(page);
    await createSharedSuite(page);

    // 单个批次包含 Alpha/Beta/Gamma 三个用例，由并发度为 2 的 Agent 执行：
    // Alpha/Beta 构成首轮并发，Gamma 必须在其中一个完成后由空闲槽补派。
    const batchId = await scheduleExecution(page);
    // 先等 attempt 记录出现再直接轮询文件系统：服务端 running 状态上报有数秒延迟，
    // 若等 running 再看工作区，6 秒的执行窗口可能不足以完成两次采样。
    const attemptIds = await waitForBatchAttemptIds(page, batchId, agent, 2);
    const batchDir = batchWorkspaceDirectory(batchId);

    // 等待批次共享目录与两个 attempt 工作目录都挂载了共享输入。
    await waitForSharedWorkspace(batchId, attemptIds);

    // Adapter 的依赖压缩包必须在批次目录中只解压一次；每个 attempt 的
    // test-jars 必须是真实目录，内部 JAR 通过硬链接复用；Java 的目录遍历默认
    // 不跟随符号链接根目录，因此不能把整个 test-jars 做成目录链接。
    const sharedDependency = join(
      batchDir,
      "runtime",
      "cotest",
      "test-jars",
      "level-1",
      "level-2",
      "level-3",
      "project-fixture.jar",
    );
    const sharedDependencyStat = await stat(sharedDependency);
    const sharedJavaStat = await stat(join(batchDir, "runtime", "cotest", "jdk", "bin", "java"));
    for (const attemptId of attemptIds) {
      const workspace = await findAttemptWorkspace(attemptId);
      expect(workspace, `attempt ${attemptId} 的工作目录应仍存在`).toBeTruthy();
      const testJarsDirectory = await lstat(join(workspace!, "test-jars"));
      expect(testJarsDirectory.isDirectory()).toBe(true);
      expect(testJarsDirectory.isSymbolicLink()).toBe(false);
      const attemptDependencyStat = await stat(
        join(workspace!, "test-jars", "level-1", "level-2", "level-3", "project-fixture.jar"),
      );
      expect(attemptDependencyStat.ino).toBe(sharedDependencyStat.ino);
      const jdkLink = await lstat(join(workspace!, "runtime", "jdk"));
      expect(jdkLink.isSymbolicLink()).toBe(true);
      const attemptJavaStat = await stat(join(workspace!, "runtime", "jdk", "bin", "java"));
      expect(attemptJavaStat.ino).toBe(sharedJavaStat.ino);
    }

    // 第一次采样：批次目录中的每个输入文件与任一 attempt 工作目录下
    // 相同相对路径的文件 inode 必须一致（硬链接共享，只下载一次）。
    const first = await snapshotSharedInputs(batchId, attemptIds);
    expect(first.shared.size).toBeGreaterThanOrEqual(2);
    expect(first.shared.has("inputs/tests.jar")).toBe(true);
    for (const [attemptId, linked] of first.attempts) {
      for (const [relativePath, sharedStat] of first.shared) {
        expect(
          linked.get(relativePath),
          `attempt ${attemptId} 的 ${relativePath} 应与批次目录共享 inode`,
        ).toBe(sharedStat.inode);
      }
    }

    // 确认两个 attempt 确实并发进入 running，再隔约 2 秒第二次采样：
    // mtime 不变证明没有重复下载覆盖共享文件。此处只读取批次目录；首轮
    // attempt 可能已经结束并清理各自工作目录，而批次级运行时仍需供 Gamma 复用。
    await waitForRunningAttempts(page, batchId, agent, 2);
    await delay(2_000);
    const second = await collectSharedInputFiles(batchDir);
    for (const [relativePath, sharedStat] of first.shared) {
      expect(
        second.get(relativePath)?.mtimeMs,
        `批次目录的 ${relativePath} 在执行期间不应被重新下载`,
      ).toBe(sharedStat.mtimeMs);
    }

    // Gamma 是首轮两个 attempt 之后才创建的后续 attempt。它仍必须引用首轮
    // 已物化的原始输入和解压依赖，证明共享范围覆盖整个批次而非单次并发波次。
    const laterAttemptId = await waitForLaterRunningAttempt(page, batchId, agent, attemptIds);
    await waitForSharedWorkspace(batchId, [laterAttemptId]);
    const later = await snapshotSharedInputs(batchId, [laterAttemptId]);
    for (const [relativePath, sharedStat] of first.shared) {
      expect(later.shared.get(relativePath)?.inode).toBe(sharedStat.inode);
      expect(later.shared.get(relativePath)?.mtimeMs).toBe(sharedStat.mtimeMs);
      expect(later.attempts.get(laterAttemptId)?.get(relativePath)).toBe(sharedStat.inode);
    }
    await expectAttemptUsesSharedRuntime(laterAttemptId, sharedDependencyStat, sharedJavaStat);

    // 把共享采样观测值归档到测试报告，便于人工核对 inode/mtime。
    await testInfo.attach("batch-shared-inputs-snapshot", {
      body: Buffer.from(formatSharedSnapshot(batchId, first, second), "utf8"),
      contentType: "text/plain",
    });

    const details = await waitForTerminalBatch(
      page,
      batchId,
      agent,
      "succeeded",
      "TESTNG_SUCCEEDED",
      3,
    );
    expect(details.attempts).toHaveLength(3);

    // 批次终态且本机无在途 attempt 后，Agent 应回收批次共享目录。
    await expect
      .poll(async () => pathExists(batchDir), { timeout: 30_000, intervals: [250, 500, 1_000] })
      .toBe(false);

    // 日志隔离标记仍在：三个 attempt 的 ALPHA/BETA/GAMMA 标记互不窜入。
    const logs = await Promise.all(
      [...attemptIds, laterAttemptId].map(async (attemptId) => {
        const stdout = await readAttemptLogs(page, attemptId, "stdout");
        const stderr = await readAttemptLogs(page, attemptId, "stderr");
        return stdout + stderr;
      }),
    );
    const alphaLog = logs.find((content) => content.includes("JAVA_CASES_CONCURRENT_ALPHA_START"));
    const betaLog = logs.find((content) => content.includes("JAVA_CASES_CONCURRENT_BETA_START"));
    const gammaLog = logs.find((content) => content.includes("JAVA_CASES_CONCURRENT_GAMMA_START"));
    expect(alphaLog, "应有一个 attempt 输出 ALPHA 标记").toBeTruthy();
    expect(betaLog, "应有一个 attempt 输出 BETA 标记").toBeTruthy();
    expect(gammaLog, "应有一个后续 attempt 输出 GAMMA 标记").toBeTruthy();
    expect(alphaLog).not.toBe(betaLog);
    expect(alphaLog).toContain("JAVA_CASES_CONCURRENT_ALPHA_DONE");
    expect(alphaLog).not.toContain("JAVA_CASES_CONCURRENT_BETA");
    expect(betaLog).toContain("JAVA_CASES_CONCURRENT_BETA_DONE");
    expect(betaLog).not.toContain("JAVA_CASES_CONCURRENT_ALPHA");
    expect(gammaLog).toContain("JAVA_CASES_CONCURRENT_GAMMA_DONE");
    expect(gammaLog).not.toContain("JAVA_CASES_CONCURRENT_ALPHA");
    expect(gammaLog).not.toContain("JAVA_CASES_CONCURRENT_BETA");
  } finally {
    await attachAgentDiagnostics(testInfo, agent, 0);
    await stopAgent(agent);
  }
});

test("Agent 异常中断后，重启继续复用未完成批次的共享目录", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  await ensureAdministrator(page);

  let agent = await startAgent();
  const agents = [agent];
  try {
    await waitForOnlineRunner(page, agent);

    // 复用 test 1 创建的任务再调度一个批次。
    const batchId = await scheduleExecution(page);
    const attemptIds = await waitForRunningAttempts(page, batchId, agent, 2);
    const batchDir = batchWorkspaceDirectory(batchId);
    await waitForSharedWorkspace(batchId, attemptIds);
    const beforeRestart = await snapshotSharedInputs(batchId, attemptIds);
    const sharedDependency = join(
      batchDir,
      "runtime",
      "cotest",
      "test-jars",
      "level-1",
      "level-2",
      "level-3",
      "project-fixture.jar",
    );
    const sharedDependencyStat = await stat(sharedDependency);
    const sharedJavaStat = await stat(join(batchDir, "runtime", "cotest", "jdk", "bin", "java"));
    const heartbeatBeforeRestart = await runnerLastSeenAt(page);

    // SIGKILL 模拟 Agent 崩溃：批次共享目录与 attempt 工作目录都来不及清理。
    await killAgentAbruptly(agent);
    agent = await startAgent();
    agents.push(agent);
    await waitForOnlineRunner(page, agent, heartbeatBeforeRestart);

    // 重启不得删除仍有排队用例的批次目录；原始文件 inode/mtime 与解压依赖
    // 均保持不变，reconcile 后补派的 Gamma 继续使用这一份运行时。
    const afterRestart = await snapshotSharedInputs(batchId, []);
    for (const [relativePath, sharedStat] of beforeRestart.shared) {
      expect(afterRestart.shared.get(relativePath)?.inode).toBe(sharedStat.inode);
      expect(afterRestart.shared.get(relativePath)?.mtimeMs).toBe(sharedStat.mtimeMs);
    }
    expect((await stat(join(batchDir, "runtime", "cotest", "jdk", "bin", "java"))).ino).toBe(
      sharedJavaStat.ino,
    );
    const laterAttemptId = await waitForLaterRunningAttempt(page, batchId, agent, attemptIds);
    await waitForSharedWorkspace(batchId, [laterAttemptId]);
    const later = await snapshotSharedInputs(batchId, [laterAttemptId]);
    for (const [relativePath, sharedStat] of beforeRestart.shared) {
      expect(later.attempts.get(laterAttemptId)?.get(relativePath)).toBe(sharedStat.inode);
    }
    await expectAttemptUsesSharedRuntime(laterAttemptId, sharedDependencyStat, sharedJavaStat);

    // 崩溃时的两个在途 attempt 经 reconcile 后保留重启故障记录；控制面随后
    // 自动重调度这两个用例，连同尚未执行的 Gamma 一起成功完成批次。
    const recovered = await waitForTerminalBatch(
      page,
      batchId,
      agent,
      "succeeded",
      "TESTNG_SUCCEEDED",
      5,
    );
    expect(
      recovered.attempts.filter(
        (attempt) => attempt.resultCode === "AGENT_RESTARTED_DURING_EXECUTION",
      ),
    ).toHaveLength(2);
    expect(
      recovered.attempts.filter((attempt) => attempt.resultCode === "TESTNG_SUCCEEDED"),
    ).toHaveLength(3);
    await expect
      .poll(async () => pathExists(batchDir), { timeout: 30_000, intervals: [250, 500, 1_000] })
      .toBe(false);
    for (const crashedAttemptId of attemptIds) {
      await expect
        .poll(() => findAttemptWorkspace(crashedAttemptId), {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toBeUndefined();
    }
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
  }>;
};

type SharedFileStat = {
  inode: number;
  mtimeMs: number;
};

type SharedSnapshot = {
  /** 批次共享目录中的输入文件（相对路径 -> inode/mtime），不含 runtime/ JDK 解压产物。 */
  shared: Map<string, SharedFileStat>;
  /** 每个在途 attempt 工作目录中同名文件的 inode。 */
  attempts: Map<string, Map<string, number>>;
};

function startAgent(): Promise<AgentProcess> {
  const binary = requiredEnvironment("E2E_BATCH_SHARE_AGENT_BINARY");
  const bootstrapToken = requiredEnvironment("E2E_RUNNER_BOOTSTRAP_TOKEN");
  const child = spawn(binary, ["start"], {
    detached: true,
    env: {
      ...process.env,
      AUTOFORGE_SERVER_URL: "http://127.0.0.1:3100",
      AUTOFORGE_AGENT_DATA_DIR: agentDataDirectory,
      AUTOFORGE_AGENT_NAME: runnerName,
      AUTOFORGE_AGENT_LABELS: "batch-share,acceptance",
      AUTOFORGE_AGENT_MAX_CONCURRENCY: "2",
      AUTOFORGE_AGENT_BOOTSTRAP_TOKEN: bootstrapToken,
      AUTOFORGE_AGENT_JAVA_EXECUTABLE: requiredEnvironment("E2E_BATCH_SHARE_JAVA_EXECUTABLE"),
      AUTOFORGE_AGENT_JAVA_VERSION: requiredEnvironment("E2E_BATCH_SHARE_JAVA_VERSION"),
      AUTOFORGE_AGENT_TESTNG_CLASSPATH: requiredEnvironment("E2E_BATCH_SHARE_TESTNG_CLASSPATH"),
      AUTOFORGE_AGENT_TESTNG_VERSION: "7.11.0",
      AUTOFORGE_AGENT_ADAPTER_JAR: requiredEnvironment("E2E_BATCH_SHARE_ADAPTER_JAR"),
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

async function importJavaCasesJar(page: Page): Promise<void> {
  await ensureProjectHierarchy(page);
  await uploadAdapterDependencies(page);
  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page
    .locator('input[type="file"]')
    .setInputFiles(requiredEnvironment("E2E_BATCH_SHARE_TEST_JAR"));
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.autoforge.javacases.JavaCasesFixture")).toBeVisible({
    timeout: 20_000,
  });
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
      data: { name: "batch-share 版本" },
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
      data: { name: "batch-share 阶段", description: "批次级输入共享端到端验收" },
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
    .setInputFiles(requiredEnvironment("E2E_BATCH_SHARE_DEPENDENCY_ARCHIVE"));
  await uploadForm.getByRole("button", { name: "上传并启用" }).click();
  await expect(page.getByText("运行时资源已上传并设为当前配置。")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/java-cases-dependencies\.zip/).first()).toBeVisible();

  await uploadForm.getByLabel("资源类型").selectOption("jdk");
  await uploadForm.getByLabel("压缩格式").selectOption("tar.gz");
  const jdkArchive = requiredEnvironment("E2E_BATCH_SHARE_JDK_ARCHIVE");
  await uploadForm.getByLabel("本地文件").setInputFiles(jdkArchive);
  await uploadForm.getByRole("button", { name: "上传并启用" }).click();
  await expect(page.getByText("运行时资源已上传并设为当前配置。")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(basename(jdkArchive), { exact: false }).first()).toBeVisible({
    timeout: 120_000,
  });
}

async function createSharedSuite(page: Page): Promise<void> {
  await page.goto(`/case-suites?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.getByRole("button", { name: "创建任务" }).click();
  const createSuiteDialog = page.getByRole("dialog", { name: "创建用例任务" });
  await createSuiteDialog.getByLabel("任务名称").fill(suiteName);
  await createSuiteDialog.getByLabel("说明").fill("批次级输入共享端到端验收任务");
  await createSuiteDialog.getByLabel("使用 CoTest TestNG Adapter").check();
  await createSuiteDialog.getByLabel("TestNG Suite Name").fill(`Adapter · ${suiteName}`);
  await createSuiteDialog.getByLabel("TestNG Test Name").fill("JavaCasesConcurrent");
  // 三个 fixture 都断言注入地址为 environmentAddress，只填一个地址保证
  // 轮询分配对三个 run 都落在同一 mock 值上。
  await createSuiteDialog.getByLabel("环境 IP / 地址（每行一个）").fill(environmentAddress);
  await createSuiteDialog.getByRole("button", { name: "创建任务" }).click();
  const suiteLink = page.getByRole("link", { name: suiteName });
  await expect(suiteLink).toBeVisible();
  const [suiteId, runnerId] = await Promise.all([
    findSuiteId(page, suiteName),
    findRunnerId(page, runnerName),
  ]);
  await configureTaskExecution(page, suiteId, runnerId);
  await suiteLink.click();
  await page.getByLabel("重试次数上限").fill("0");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例任务已更新");

  // 搜索 "Concurrent" 同时命中 Alpha/Beta/Gamma，全选加入同一任务；Runner
  // 并发度为 2，因此 Gamma 会成为首轮完成后才补派的后续 attempt。
  await page.goto(`/cases?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.getByLabel("页内搜索用例").fill("Concurrent");
  await page.getByLabel("选择当前搜索结果中的全部用例").check();
  await page.locator('select[aria-label="目标用例任务"]').selectOption({ label: suiteName });
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByRole("status")).toContainText("已将 3 个用例加入任务");
}

async function scheduleExecution(page: Page): Promise<string> {
  const [suiteId, runnerId] = await Promise.all([
    findSuiteId(page, suiteName),
    findRunnerId(page, runnerName),
  ]);
  await configureTaskExecution(page, suiteId, runnerId);
  return (await createTaskRun(page, suiteId)).id;
}

async function waitForOnlineRunner(
  page: Page,
  agent: AgentProcess,
  heartbeatAfter?: string,
): Promise<void> {
  // 本机无可用 cgroup 挂载点，不断言 isolation:cgroup-v2 能力。
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        const response = await page.request.get("/api/v1/runners?limit=100");
        if (!response.ok()) return `HTTP ${response.status()}`;
        const body = (await response.json()) as {
          items: Array<{
            name: string;
            state: string;
            capabilities: string[];
            lastSeenAt: string;
          }>;
        };
        const runner = body.items.find((candidate) => candidate.name === runnerName);
        if (!runner) return "not-registered";
        if (!runner.capabilities.includes("adapter:cotest-testng-v1")) return "adapter-missing";
        if (!runner.capabilities.includes("runtime:project-assets-v1")) {
          return "runtime-assets-missing";
        }
        if (heartbeatAfter && runner.lastSeenAt <= heartbeatAfter) return "stale-heartbeat";
        return runner.state;
      },
      { timeout: 180_000, intervals: [250, 500, 1_000, 2_000] },
    )
    .toBe("online");
}

async function runnerLastSeenAt(page: Page): Promise<string> {
  const response = await page.request.get("/api/v1/runners?limit=100");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    items: Array<{ name: string; lastSeenAt: string }>;
  };
  const runner = body.items.find((candidate) => candidate.name === runnerName);
  expect(runner).toBeTruthy();
  return runner!.lastSeenAt;
}

// 等待批次下出现预期数量的 attempt 记录（不限状态），返回 attempt ID 列表。
// 相比等待 running 状态，该观察点更早，给文件系统采样留出充足执行窗口。
async function waitForBatchAttemptIds(
  page: Page,
  batchId: string,
  agent: AgentProcess,
  expectedCount: number,
): Promise<string[]> {
  let attemptIds: string[] = [];
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
        );
        if (!response.ok()) return -1;
        const details = (await response.json()) as BatchDetails;
        attemptIds = details.attempts.map((attempt) => attempt.id);
        return attemptIds.length;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(expectedCount);
  return attemptIds;
}

async function waitForRunningAttempts(
  page: Page,
  batchId: string,
  agent: AgentProcess,
  expectedCount: number,
): Promise<string[]> {
  let attemptIds: string[] = [];
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
        );
        if (!response.ok()) return `HTTP ${response.status()}`;
        const details = (await response.json()) as BatchDetails;
        attemptIds = details.attempts.map((attempt) => attempt.id);
        return details.attempts.filter((attempt) => attempt.status === "running").length;
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toBe(expectedCount);
  if (attemptIds.length !== expectedCount) {
    throw new Error(
      `批次 ${batchId} 的 attempt 数量 ${attemptIds.length} 与预期 ${expectedCount} 不符。`,
    );
  }
  return attemptIds;
}

async function waitForLaterRunningAttempt(
  page: Page,
  batchId: string,
  agent: AgentProcess,
  earlierAttemptIds: string[],
): Promise<string> {
  const earlier = new Set(earlierAttemptIds);
  let laterAttemptId: string | undefined;
  await expect
    .poll(
      async () => {
        assertAgentRunning(agent);
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
        );
        if (!response.ok()) return `HTTP ${response.status()}`;
        const details = (await response.json()) as BatchDetails;
        const later = details.attempts.find(
          (attempt) => !earlier.has(attempt.id) && attempt.status === "running",
        );
        laterAttemptId = later?.id;
        return later ? "running" : "pending";
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe("running");
  return laterAttemptId!;
}

async function expectAttemptUsesSharedRuntime(
  attemptId: string,
  sharedDependencyStat: { ino: number },
  sharedJavaStat: { ino: number },
): Promise<void> {
  const workspace = await findAttemptWorkspace(attemptId);
  expect(workspace, `attempt ${attemptId} 的工作目录应仍存在`).toBeTruthy();
  const testJarsDirectory = await lstat(join(workspace!, "test-jars"));
  expect(testJarsDirectory.isDirectory()).toBe(true);
  expect(testJarsDirectory.isSymbolicLink()).toBe(false);
  const dependency = await stat(
    join(workspace!, "test-jars", "level-1", "level-2", "level-3", "project-fixture.jar"),
  );
  expect(dependency.ino).toBe(sharedDependencyStat.ino);
  const jdkLink = await lstat(join(workspace!, "runtime", "jdk"));
  expect(jdkLink.isSymbolicLink()).toBe(true);
  const java = await stat(join(workspace!, "runtime", "jdk", "bin", "java"));
  expect(java.ino).toBe(sharedJavaStat.ino);
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
        const hasExpectedResult = latest.attempts.some(
          (attempt) => attempt.resultCode === expectedResultCode,
        );
        return `${latest.status}:${hasExpectedResult}:${latest.attempts.length}`;
      },
      { timeout: 180_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(`${expectedStatus}:true:${expectedAttempts}`);
  return latest!;
}

function workRootDirectory(): string {
  return join(agentDataDirectory, "work");
}

function batchWorkspaceDirectory(batchId: string): string {
  return join(workRootDirectory(), "batches", batchId);
}

// 工作目录由 os.MkdirTemp(workRoot, attemptID+"-") 创建，目录名为 <attemptId>-<随机后缀>。
async function findAttemptWorkspace(attemptId: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(attemptId)) {
    throw new Error(`拒绝检查非法的本地 attempt 标识：${attemptId}`);
  }
  let entries;
  try {
    entries = await readdir(workRootDirectory(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const entry = entries.find(
    (candidate) => candidate.isDirectory() && candidate.name.startsWith(`${attemptId}-`),
  );
  return entry ? join(workRootDirectory(), entry.name) : undefined;
}

// 收集批次共享目录中的输入文件（跳过 runtime/ 下的 JDK 解压产物，它们不参与
// 硬链接共享），返回相对路径到 inode/mtime 的映射。
async function collectSharedInputFiles(batchDir: string): Promise<Map<string, SharedFileStat>> {
  const files = new Map<string, SharedFileStat>();
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (relativePath === "runtime") continue;
        await walk(join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        const stats = await stat(join(directory, entry.name));
        files.set(relativePath, { inode: stats.ino, mtimeMs: stats.mtimeMs });
      }
    }
  }
  await walk(batchDir, "");
  return files;
}

// 轮询直到批次共享目录存在、包含输入文件，且每个在途 attempt 的工作目录
// 都已挂载全部共享输入。
async function waitForSharedWorkspace(batchId: string, attemptIds: string[]): Promise<void> {
  const batchDir = batchWorkspaceDirectory(batchId);
  await expect
    .poll(
      async () => {
        try {
          const shared = await collectSharedInputFiles(batchDir);
          if (shared.size === 0) return "no-shared-inputs";
          await stat(
            join(
              batchDir,
              "runtime",
              "cotest",
              "test-jars",
              "level-1",
              "level-2",
              "level-3",
              "project-fixture.jar",
            ),
          );
          for (const attemptId of attemptIds) {
            const workspace = await findAttemptWorkspace(attemptId);
            if (!workspace) return `attempt-workspace-missing:${attemptId}`;
            for (const relativePath of shared.keys()) {
              await stat(join(workspace, relativePath));
            }
          }
          return "ready";
        } catch {
          return "not-ready";
        }
      },
      { timeout: 180_000, intervals: [250, 500, 1_000, 2_000] },
    )
    .toBe("ready");
}

// 采样批次目录与所有 attempt 工作目录中共享输入的 inode/mtime。
async function snapshotSharedInputs(
  batchId: string,
  attemptIds: string[],
): Promise<SharedSnapshot> {
  let shared: Map<string, SharedFileStat>;
  try {
    shared = await collectSharedInputFiles(batchWorkspaceDirectory(batchId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`批次 ${batchId} 的共享目录在采样时已消失：批次可能已提前终态并被回收。`);
    }
    throw error;
  }
  const attempts = new Map<string, Map<string, number>>();
  for (const attemptId of attemptIds) {
    const workspace = await findAttemptWorkspace(attemptId);
    if (!workspace) throw new Error(`attempt ${attemptId} 的工作目录在采样时消失。`);
    const linked = new Map<string, number>();
    for (const relativePath of shared.keys()) {
      linked.set(relativePath, (await stat(join(workspace, relativePath))).ino);
    }
    attempts.set(attemptId, linked);
  }
  return { shared, attempts };
}

// 把共享输入采样格式化为可读文本，归档到测试报告。
function formatSharedSnapshot(
  batchId: string,
  first: SharedSnapshot,
  second: ReadonlyMap<string, SharedFileStat>,
): string {
  const lines = [`batchId: ${batchId}`, "共享输入（批次目录）:"];
  for (const [relativePath, stats] of first.shared) {
    const secondStats = second.get(relativePath);
    lines.push(
      `  ${relativePath} inode=${stats.inode} mtime=${stats.mtimeMs} -> ${secondStats?.mtimeMs}`,
    );
  }
  for (const [attemptId, linked] of first.attempts) {
    lines.push(`attempt ${attemptId}:`);
    for (const [relativePath, inode] of linked) {
      lines.push(`  ${relativePath} inode=${inode}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
      `The batch-share Agent exited with code ${agent.child.exitCode}.\n${agent.diagnostics.join("")}`,
    );
  }
}

async function attachAgentDiagnostics(
  testInfo: TestInfo,
  agent: AgentProcess,
  index: number,
): Promise<void> {
  await testInfo.attach(`batch-share-agent-diagnostics-${index + 1}`, {
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the batch-share acceptance test.`);
  return value;
}
