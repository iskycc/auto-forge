import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { randomUUID } from "node:crypto";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { configureTaskExecution, createTaskRun } from "./support/task-execution";
import { acceptSystemDialog, browserJson, ensureAdministrator } from "./support/session";

/**
 * 即时补槽调度验收：一个批次 5 个用例、执行机并发 2。验证：
 * - 初始领取占满 2 个并发槽后，没有空闲槽时领不到新任务；
 * - 任意一个 attempt 完成上报被接受后，无需等待同批其他用例完成、
 *   也无需等待心跳，立即可以领取下一个用例（保持并发槽满载）；
 * - 首轮仍有用例运行时，失败用例可立即进入第二次 attempt 并占用刚释放的槽位；
 * - 完成响应携带 batchId，且仅最后一个用例完成时 batchClosed 为 true；
 * - 批次终态后不再派发新任务。
 * 初始领取后仅发送一次“已满载”心跳，此后不再心跳；补槽必须由实时 claim
 * 容量纠正旧心跳，而不能等待下一轮心跳调度。
 */

const caseNames = ["RefillCaseA", "RefillCaseB", "RefillCaseC", "RefillCaseD", "RefillCaseE"];

type RunnerIdentity = { runnerId: string; credential: string };

type ClaimedAssignment = {
  assignment: {
    attemptId: string;
    executionSpec: { executionRunId: string };
  };
  lease: { token: string };
};

type CompletionResponse = {
  disposition: "accepted" | "duplicate" | "late";
  retryScheduled: boolean;
  batchId?: string;
  batchClosed?: boolean;
};

function runnerHeaders(identity: RunnerIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${identity.credential}`,
    "x-autoforge-runner-id": identity.runnerId,
  };
}

async function browserSessionHeaders(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  return { cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; ") };
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

async function claimOnce(
  page: Page,
  identity: RunnerIdentity,
  availableSlots: number,
): Promise<ClaimedAssignment[]> {
  const response = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/claims`,
    {
      headers: { authorization: `Bearer ${identity.credential}` },
      data: {
        schemaVersion: 1,
        requestId: `e2e-refill-claim-${randomUUID()}`,
        availableSlots,
        labels: ["linux", "java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        waitSeconds: 0,
      },
    },
  );
  expect(response.status()).toBe(200);
  return ((await response.json()) as { assignments: ClaimedAssignment[] }).assignments;
}

async function expectNoAssignment(page: Page, identity: RunnerIdentity): Promise<void> {
  //  absence 断言给调度链路留三个短窗口，避免与进行中的写路径竞态。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const assignments = await claimOnce(page, identity, 1);
    expect(assignments).toEqual([]);
    if (attempt < 2) await page.waitForTimeout(250);
  }
}

async function completeAttempt(
  page: Page,
  identity: RunnerIdentity,
  claim: ClaimedAssignment,
  completionId: string,
  outcome: "succeeded" | "failed" = "succeeded",
): Promise<CompletionResponse> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(claim.assignment.attemptId)}/complete`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        completionId,
        leaseToken: claim.lease.token,
        result: {
          status: outcome,
          resultCode: outcome === "succeeded" ? "TESTNG_SUCCEEDED" : "TEST_ASSERTION_FAILED",
          summary: outcome === "succeeded" ? "refill probe passed" : "refill retry probe failed",
          durationMs: 100,
          logWatermarks: { stdout: 0, stderr: -1, agent: -1 },
          artifacts: [],
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as CompletionResponse;
}

async function uploadAttemptLog(
  page: Page,
  identity: RunnerIdentity,
  claim: ClaimedAssignment,
): Promise<void> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(claim.assignment.attemptId)}/logs`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        requestId: `e2e-refill-log-${randomUUID()}`,
        leaseToken: claim.lease.token,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "worker-backed log upload\n",
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ acknowledgedSequence: { stdout: 0 } });
}

test("completion immediately refills free runner slots without waiting for the whole wave", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  await ensureProjectHierarchy(page);

  // 5 个合成 TestNG 类，一次导入。
  const jar = zipSync(
    Object.fromEntries(
      caseNames.map((name) => [
        `com/example/${name}.class`,
        buildClassFile({
          className: `com.example.${name}`,
          methods: [{ name: "passes", annotations: [{ type: "Test", values: {} }] }],
        }),
      ]),
    ),
  );
  await page.goto(`/cases/import?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "refill-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.RefillCaseA")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });

  await page.goto(`/case-suites?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.getByRole("button", { name: "创建任务" }).click();
  const createSuiteDialog = page.getByRole("dialog", { name: "创建用例任务" });
  await createSuiteDialog.getByLabel("任务名称").fill("即时补槽验收任务");
  await createSuiteDialog.getByLabel("说明").fill("验证完成一个用例后立即补派下一个");
  await createSuiteDialog.getByRole("button", { name: "创建任务" }).click();
  const suiteLink = page.getByRole("link", { name: /即时补槽验收任务/ });
  await expect(suiteLink).toBeVisible();

  // 搜索公共前缀，全选 5 个用例一次性加入任务。
  await page.goto(`/cases?projectId=${encodeURIComponent(DEFAULT_PROJECT_ID)}`);
  await page.getByLabel("页内搜索用例").fill("RefillCase");
  await page.getByLabel("选择当前搜索结果中的全部用例").check();
  await page
    .locator('select[aria-label="目标用例任务"]')
    .selectOption({ label: "即时补槽验收任务" });
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.locator(".toast-card", { hasText: "已将 5 个用例加入任务" })).toBeVisible();

  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: "E2E Refill Runner",
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

  // 首次心跳让执行机上线可选；领取后会再写一次满载心跳来复现旧容量窗口。
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/heartbeat`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        busySlots: 0,
        labels: ["linux", "java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 10,
          memoryUtilizationPercent: 20,
          loadAverage1m: 0.1,
          logicalCpuCount: 4,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(heartbeat.status()).toBe(200);

  const suites = await browserJson<{ items: Array<{ id: string; name: string }> }>(
    page,
    "/api/v1/case-suites?limit=200",
  );
  const suiteId = suites.body.items.find((suite) => suite.name === "即时补槽验收任务")?.id;
  expect(suiteId).toBeTruthy();
  await configureTaskExecution(page, suiteId!, identity.runnerId, {
    retryLimit: 1,
    retryMode: "immediate",
  });
  const batch = await createTaskRun(page, suiteId!);

  // 初始领取占满 2 个并发槽。
  const initial = await claimOnce(page, identity, 2);
  expect(initial).toHaveLength(2);
  await uploadAttemptLog(page, identity, initial[0]!);
  // 复现真实高并发窗口：执行机占满后心跳将 busySlots=2 写入控制面；随后一个
  // attempt 完成时，这个心跳值仍然是旧的，补槽必须使用下一次 claim 的实时
  // availableSlots，而不能等待下一轮心跳覆盖。
  const saturatedHeartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/heartbeat`,
    {
      headers: runnerHeaders(identity),
      data: {
        schemaVersion: 1,
        busySlots: 2,
        labels: ["linux", "java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 10,
          memoryUtilizationPercent: 20,
          loadAverage1m: 0.1,
          logicalCpuCount: 4,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(saturatedHeartbeat.status()).toBe(200);
  // 没有空闲槽时领不到新任务。
  await expectNoAssignment(page, identity);

  // 第一个用例失败：其第二次 attempt 立即占用释放的槽位；此时首轮另一个
  // attempt 仍在运行，证明立即重试不等待整轮结束，也不等待心跳。
  const first = await completeAttempt(page, identity, initial[0]!, "e2e-refill-r1", "failed");
  expect(first.disposition).toBe("accepted");
  expect(first.retryScheduled).toBe(true);
  expect(first.batchId).toBe(batch.id);
  expect(first.batchClosed).toBe(false);
  // 模拟完成响应丢失后的相同上报重放。duplicate 也应安全地补做幂等调度，
  // 不能额外创建 attempt，也不能让已释放的槽位空转。
  const duplicate = await completeAttempt(page, identity, initial[0]!, "e2e-refill-r1", "failed");
  expect(duplicate.disposition).toBe("duplicate");
  expect(duplicate.retryScheduled).toBe(true);
  expect(duplicate.batchId).toBe(batch.id);
  const retry = await claimOnce(page, identity, 1);
  expect(retry).toHaveLength(1);
  expect(retry[0]!.assignment.executionSpec.executionRunId).toBe(
    initial[0]!.assignment.executionSpec.executionRunId,
  );

  const second = await completeAttempt(page, identity, initial[1]!, "e2e-refill-r2");
  expect(second.batchClosed).toBe(false);
  const refill1 = await claimOnce(page, identity, 1);
  expect(refill1).toHaveLength(1);

  const retried = await completeAttempt(page, identity, retry[0]!, "e2e-refill-retry");
  expect(retried.retryScheduled).toBe(false);
  expect(retried.batchClosed).toBe(false);
  const refill2 = await claimOnce(page, identity, 1);
  expect(refill2).toHaveLength(1);

  const third = await completeAttempt(page, identity, refill1[0]!, "e2e-refill-r3");
  expect(third.batchClosed).toBe(false);
  const refill3 = await claimOnce(page, identity, 1);
  expect(refill3).toHaveLength(1);

  // 倒数第二个完成时仍有一个在途，且已经没有待补位用例；批次未关闭。
  const fourth = await completeAttempt(page, identity, refill2[0]!, "e2e-refill-r4");
  expect(fourth.batchId).toBe(batch.id);
  expect(fourth.batchClosed).toBe(false);
  await expectNoAssignment(page, identity);
  // 最后一个完成后 batchClosed=true。
  const last = await completeAttempt(page, identity, refill3[0]!, "e2e-refill-r5");
  expect(last.batchId).toBe(batch.id);
  expect(last.batchClosed).toBe(true);

  const userHeaders = await browserSessionHeaders(page);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/run-batches/${encodeURIComponent(batch.id)}`,
        { headers: userHeaders },
      );
      return ((await response.json()) as { status: string }).status;
    })
    .toBe("succeeded");
  // 批次终态后不再派发新任务。
  await expectNoAssignment(page, identity);

  // 同一套 5 个用例再次执行：领取 2 个后从执行记录列表终止。未领取的 3 个必须
  // 立即停止调度，2 个在途 attempt 保持 continue 并自然完成，最后展示“已终止”。
  const terminatingBatch = await createTaskRun(page, suiteId!);
  const inFlight = await claimOnce(page, identity, 2);
  expect(inFlight).toHaveLength(2);
  await page.goto("/execution-records");
  const terminatingRow = page.locator("tbody tr", {
    has: page.locator(`a[href="/run-batches/${terminatingBatch.id}"]`),
  });
  await expect(terminatingRow).toBeVisible();
  await terminatingRow.getByRole("button", { name: "终止任务" }).click();
  await acceptSystemDialog(page, /终止批次/, "确认终止");
  await expect(terminatingRow).toContainText("终止中");
  await expectNoAssignment(page, identity);

  expect(
    (await completeAttempt(page, identity, inFlight[0]!, "e2e-termination-active-1")).batchClosed,
  ).toBe(false);
  expect(
    (await completeAttempt(page, identity, inFlight[1]!, "e2e-termination-active-2")).batchClosed,
  ).toBe(true);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/run-batches/${encodeURIComponent(terminatingBatch.id)}`,
        { headers: userHeaders },
      );
      return (await response.json()) as {
        status: string;
        succeededRuns: number;
        cancelledRuns: number;
        terminationRequestedAt?: string;
      };
    })
    .toMatchObject({
      status: "cancelled",
      succeededRuns: 2,
      cancelledRuns: 3,
      terminationRequestedAt: expect.any(String),
    });
  await page.reload();
  await expect(terminatingRow).toContainText("已终止");
  await page.screenshot({
    path: testInfo.outputPath("execution-records-terminated.png"),
    fullPage: true,
  });
});
