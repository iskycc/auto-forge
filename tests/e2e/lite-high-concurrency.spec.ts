import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { browserJson, ensureAdministrator } from "./support/session";
import { startBackgroundLoad } from "./support/background-load";
import { expectUiIntegrity } from "./support/ui-guard";
import { readExportedWorkbookText } from "./support/export-workbook";

const CASE_COUNT = 500;
const RUNNER_COUNT = 8;
const RUNNER_CAPACITY = 64;
const CLIENT_REQUEST_CONCURRENCY = 40;
const CLASS_PREFIX = "ConcurrencyProbe";
const CAPABILITIES = ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"];
const LABELS = ["linux", "java", "testng"];

type RunnerIdentity = { runnerId: string; credential: string };
type ClaimedAssignment = {
  identity: RunnerIdentity;
  assignment: { attemptId: string };
  lease: { token: string; leaseId: string; version: number };
};

test("control plane completes 500 concurrent protocol slots without blocking reads", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await ensureAdministrator(page);
  const hierarchy = await ensureProjectHierarchy(page);

  const importStartedAt = performance.now();
  await importSyntheticCases(page, hierarchy.versionId, hierarchy.stageId);
  const importDurationMs = performance.now() - importStartedAt;
  const caseDefinitionIds = await listSyntheticCaseIds(page, hierarchy.versionId);
  expect(caseDefinitionIds).toHaveLength(CASE_COUNT);

  const identities = await Promise.all(
    Array.from({ length: RUNNER_COUNT }, (_, index) => registerRunner(page, index + 1)),
  );
  await Promise.all(identities.map((identity) => heartbeatRunner(page, identity)));

  const suite = await browserJson<{
    id: string;
    revision: number;
    policy: Record<string, unknown>;
  }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: hierarchy.versionId,
      name: `500 并发协议验收 ${randomUUID()}`,
      description: "500 槽位 HTTP 控制面回归",
    },
  });
  expect(suite.status).toBe(201);
  const added = await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
    method: "POST",
    body: { caseDefinitionIds },
  });
  expect(added.status).toBe(200);

  const suiteDetails = await browserJson<{
    revision: number;
    policy: Record<string, unknown>;
  }>(page, `/api/v1/case-suites/${suite.body.id}`);
  const configured = await browserJson(page, `/api/v1/case-suites/${suite.body.id}`, {
    method: "PATCH",
    body: {
      policy: {
        ...suiteDetails.body.policy,
        concurrency: CASE_COUNT,
        retryLimit: 0,
        projectVersionId: hierarchy.versionId,
        runnerIds: identities.map((identity) => identity.runnerId),
        runnerGroupId: "",
      },
      expectedRevision: suiteDetails.body.revision,
    },
  });
  expect(configured.status).toBe(200);

  const { durations, readLatenciesMs } = await observeExecutionRecordReads(page, async () => {
    const finishBackground =
      process.env.E2E_BACKGROUND_LOAD === "1"
        ? await startBackgroundLoad(page, hierarchy)
        : undefined;

    const batchStartedAt = performance.now();
    const created = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
      method: "POST",
      body: { suiteId: suite.body.id },
    });
    expect(created.status).toBe(201);
    const batchCreationDurationMs = performance.now() - batchStartedAt;

    const claimStartedAt = performance.now();
    const claimed = (
      await Promise.all(identities.map((identity) => claimAssignments(page, identity)))
    ).flat();
    const claimDurationMs = performance.now() - claimStartedAt;
    expect(claimed).toHaveLength(CASE_COUNT);

    const firstCompleted = claimed[0]!;
    await uploadLog(page, firstCompleted, 0);
    await completeAttempt(page, firstCompleted, 0);
    const remaining = claimed.slice(1);
    await inspectRunnerDiagnosticsDuringExecution(
      page,
      created.body.id,
      remaining,
      firstCompleted.assignment.attemptId,
    );

    const executionStartedAt = performance.now();
    await mapWithConcurrency(remaining, CLIENT_REQUEST_CONCURRENCY, async (claim, index) => {
      await uploadLog(page, claim, index + 1);
      await completeAttempt(page, claim, index + 1);
    });
    const executionDurationMs = performance.now() - executionStartedAt;

    const completed = await browserJson<{
      status: string;
      succeededRuns: number;
      failedRuns: number;
    }>(page, `/api/v1/run-batches/${created.body.id}`);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      status: "succeeded",
      succeededRuns: CASE_COUNT,
      failedRuns: 0,
    });
    expect(executionDurationMs).toBeLessThan(90_000);
    await finishBackground?.();
    return { batchCreationDurationMs, claimDurationMs, executionDurationMs };
  });

  expect(readLatenciesMs.length).toBeGreaterThan(0);
  const p95ReadLatencyMs = percentile(readLatenciesMs, 0.95);
  const maximumReadLatencyMs = Math.max(...readLatenciesMs);
  expect(p95ReadLatencyMs).toBeLessThan(1_500);
  expect(maximumReadLatencyMs).toBeLessThan(5_000);

  await writePerformanceReport({
    schemaVersion: 1,
    caseCount: CASE_COUNT,
    runnerCount: RUNNER_COUNT,
    runnerCapacity: RUNNER_CAPACITY,
    clientRequestConcurrency: CLIENT_REQUEST_CONCURRENCY,
    importDurationMs: rounded(importDurationMs),
    batchCreationDurationMs: rounded(durations.batchCreationDurationMs),
    claimDurationMs: rounded(durations.claimDurationMs),
    executionDurationMs: rounded(durations.executionDurationMs),
    readProbeCount: readLatenciesMs.length,
    p95ReadLatencyMs: rounded(p95ReadLatencyMs),
    maximumReadLatencyMs: rounded(maximumReadLatencyMs),
  });
});

/** Keep all 500 real protocol leases alive while a user opens cold diagnostic routes. */
async function inspectRunnerDiagnosticsDuringExecution(
  page: Page,
  batchId: string,
  claimed: ClaimedAssignment[],
  completedAttemptId: string,
) {
  const stop = new AbortController();
  const renewals: number[] = [];
  let renewalFailure: unknown;
  const renew = async () => {
    await mapWithConcurrency(claimed, CLIENT_REQUEST_CONCURRENCY, async (claim) => {
      const started = performance.now();
      const response = await page.request.post(
        `/api/v1/runner-agents/${claim.identity.runnerId}/leases/${claim.lease.leaseId}/renew`,
        {
          headers: { authorization: `Bearer ${claim.identity.credential}` },
          data: {
            schemaVersion: 1,
            requestId: randomUUID(),
            leaseToken: claim.lease.token,
            leaseVersion: claim.lease.version,
          },
        },
      );
      expect(response.status()).toBe(200);
      const result = (await response.json()) as { leaseVersion: number; instruction: string };
      expect(result.instruction).toBe("continue");
      claim.lease.version = result.leaseVersion;
      renewals.push(performance.now() - started);
    });
  };
  const initial = renew();
  const keepAlive = (async () => {
    await initial;
    while (!stop.signal.aborted) {
      await delay(12_000, undefined, { signal: stop.signal }).catch((error: unknown) => {
        if (!stop.signal.aborted) throw error;
      });
      if (!stop.signal.aborted) await renew();
    }
  })().catch((error: unknown) => {
    renewalFailure = error;
  });
  const openedAt = performance.now();
  try {
    await page.goto(`/run-batches/${batchId}`);
    await page.locator(".round-tab-toolbar").getByText("执行机", { exact: true }).click();
    const node = page
      .getByRole("region", { name: "本轮执行机状态" })
      .locator(".runner-card")
      .first();
    const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    for (const appearance of ["light", "dark"] as const) {
      if (appearance === "dark")
        await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await node.getByRole("button", { name: "调度日志", exact: true }).click();
        const logs = page.getByRole("dialog", { name: /调度日志/ });
        await expect(logs).toContainText("最新日志");
        await expect(logs.getByRole("log")).not.toHaveAttribute("aria-busy", "true");
        await expectUiIntegrity(page);
        if (screenshots)
          await page.screenshot({
            path: `${screenshots}/active-scheduling-${appearance}-${width}.png`,
          });
        await logs.getByRole("button", { name: "关闭日志终端" }).click();
        await node.getByRole("button", { name: /的资源监控/ }).click();
        const telemetry = page.getByRole("dialog", { name: /资源监控/ });
        await expect(telemetry.getByRole("img", { name: /CPU \/ 内存使用率/ })).toBeVisible();
        const refreshed = page.waitForResponse((response) => response.url().includes("/telemetry"));
        await telemetry.getByRole("button", { name: "刷新监控" }).click();
        expect((await refreshed).status()).toBe(200);
        await expect(telemetry.getByRole("button", { name: "刷新监控" })).toBeEnabled();
        await expectUiIntegrity(page);
        if (screenshots)
          await page.screenshot({
            path: `${screenshots}/active-telemetry-${appearance}-${width}.png`,
          });
        await telemetry.getByRole("button", { name: /^关闭/ }).click();
      }
    }
    await inspectCommonExecutionReads(page, batchId, completedAttemptId);
    // Cross the original 45-second lease deadline, instead of only testing quick completions.
    await delay(Math.max(0, 50_000 - (performance.now() - openedAt)));
  } finally {
    stop.abort();
    await keepAlive;
  }
  if (renewalFailure) throw renewalFailure;
  expect(renewals.length).toBeGreaterThanOrEqual(claimed.length * 3);
  expect(percentile(renewals, 0.95)).toBeLessThan(1_500);
  expect(Math.max(...renewals)).toBeLessThan(5_000);
}

async function inspectCommonExecutionReads(
  page: Page,
  batchId: string,
  completedAttemptId: string,
): Promise<void> {
  const paths = [
    "/api/v1/run-batches?limit=20",
    `/api/v1/run-batches/${batchId}?view=summary`,
    `/api/v1/run-batches/${batchId}/overview`,
    `/api/v1/run-batches/${batchId}/cases?scope=1&sort=status&direction=asc&pageSize=50&query=ConcurrencyProbe`,
    `/api/v1/run-batches/${batchId}/cases?scope=summary&sort=duration&direction=desc&pageSize=50`,
    `/api/v1/run-batches/${batchId}/cases?scope=all&sort=name&direction=asc&pageSize=50&cached=1`,
    `/api/v1/run-batches/${batchId}/exceptions?scope=all&limit=50`,
  ];
  for (const path of paths) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    await response.body();
  }
  for (const template of ["results", "failure-analysis"]) {
    const response = await page.request.get(
      `/api/v1/run-batches/${batchId}/export?scope=final&outcomes=succeeded,failed,blocked&template=${template}`,
    );
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("spreadsheetml");
    const workbook = await response.body();
    expect(workbook.subarray(0, 2).toString()).toBe("PK");
    expect(workbook.length).toBeGreaterThan(1_000);
    const exported = await readExportedWorkbookText(workbook);
    if (template === "results") expect(exported).toContain(CLASS_PREFIX);
    else expect(exported).not.toContain(CLASS_PREFIX);
  }
  const shared = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-attempts/${completedAttemptId}/log-share`,
    { method: "POST" },
  );
  expect(shared.status).toBe(200);
  const logPage = await page.context().newPage();
  try {
    await logPage.goto(shared.body.shareUrl);
    await expect(logPage.locator(".execution-log")).toContainText("concurrency probe 0 passed");
    for (const width of [1024, 1536]) {
      await logPage.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(logPage);
      if (process.env.AUTOFORGE_UI_SCREENSHOT_DIR)
        await logPage.screenshot({
          path: `${process.env.AUTOFORGE_UI_SCREENSHOT_DIR}/active-completed-log-${width}.png`,
        });
    }
  } finally {
    await logPage.close();
  }
}

async function ensureProjectHierarchy(page: Page): Promise<{ versionId: string; stageId: string }> {
  const structure = await browserJson<{
    versions: Array<{ id: string; stages: Array<{ id: string }> }>;
  }>(page, `/api/v1/projects/${DEFAULT_PROJECT_ID}/structure`);
  expect(structure.status).toBe(200);
  let version = structure.body.versions[0];
  if (!version) {
    const created = await browserJson<{ id: string }>(
      page,
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
      { method: "POST", body: { name: "并发验收版本" } },
    );
    expect(created.status).toBe(201);
    version = { id: created.body.id, stages: [] };
  }
  let stage = version.stages[0];
  if (!stage) {
    const created = await browserJson<{ id: string }>(
      page,
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions/${version.id}/stages`,
      { method: "POST", body: { name: "并发验收阶段", description: "500 槽位压力回归" } },
    );
    expect(created.status).toBe(201);
    stage = { id: created.body.id };
  }
  return { versionId: version.id, stageId: stage.id };
}

async function importSyntheticCases(
  page: Page,
  projectVersionId: string,
  testStageId: string,
): Promise<void> {
  const jar = zipSync(
    Object.fromEntries(
      Array.from({ length: CASE_COUNT }, (_, index) => {
        const className = `com.autoforge.performance.${CLASS_PREFIX}${String(index).padStart(4, "0")}`;
        return [
          `${className.replaceAll(".", "/")}.class`,
          buildClassFile({
            className,
            methods: [{ name: "passes", annotations: [{ type: "Test", values: {} }] }],
          }),
        ];
      }),
    ),
  );
  const response = await page.request.post(
    `/api/v1/case-sources/jar/import?projectId=${DEFAULT_PROJECT_ID}&projectVersionId=${projectVersionId}&testStageId=${testStageId}`,
    {
      headers: {
        origin: new URL(page.url()).origin,
        "idempotency-key": `lite-concurrency-${randomUUID()}`,
      },
      multipart: {
        file: {
          name: "lite-concurrency-probes.jar",
          mimeType: "application/java-archive",
          buffer: Buffer.from(jar),
        },
      },
    },
  );
  expect(response.status()).toBe(202);
  const job = (await response.json()) as { id: string };
  await expect
    .poll(
      async () => {
        const current = await page.request.get(`/api/v1/case-sources/jar/imports/${job.id}`);
        expect(current.status()).toBe(200);
        const body = (await current.json()) as { status: string; errorSummary?: string };
        if (body.status === "failed") throw new Error(body.errorSummary ?? "JAR import failed");
        return body.status;
      },
      { timeout: 60_000, intervals: [100, 250, 500, 1_000] },
    )
    .toBe("succeeded");
}

async function listSyntheticCaseIds(page: Page, projectVersionId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const parameters = new URLSearchParams({
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId,
      query: CLASS_PREFIX,
      limit: "100",
    });
    if (cursor) parameters.set("cursor", cursor);
    const response = await browserJson<{
      items: Array<{ id: string }>;
      nextCursor?: string;
    }>(page, `/api/v1/case-definitions?${parameters}`);
    expect(response.status).toBe(200);
    ids.push(...response.body.items.map((item) => item.id));
    cursor = response.body.nextCursor;
  } while (cursor);
  return ids;
}

async function registerRunner(page: Page, ordinal: number): Promise<RunnerIdentity> {
  const response = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: `Concurrency Runner ${ordinal}`,
      labels: LABELS,
      capabilities: CAPABILITIES,
      maxConcurrency: RUNNER_CAPACITY,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.2.0",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as RunnerIdentity;
}

async function heartbeatRunner(page: Page, identity: RunnerIdentity): Promise<void> {
  const response = await page.request.post(`/api/v1/runner-agents/${identity.runnerId}/heartbeat`, {
    headers: runnerHeaders(identity),
    data: {
      schemaVersion: 1,
      busySlots: 0,
      labels: LABELS,
      capabilities: CAPABILITIES,
      maxConcurrency: RUNNER_CAPACITY,
      agentVersion: "0.2.0",
      terminalEnabled: false,
      resourceSnapshot: {
        cpuUtilizationPercent: 10,
        memoryUtilizationPercent: 20,
        loadAverage1m: 0.1,
        logicalCpuCount: 16,
        observedAt: new Date().toISOString(),
      },
    },
  });
  expect(response.status()).toBe(200);
}

async function claimAssignments(
  page: Page,
  identity: RunnerIdentity,
): Promise<ClaimedAssignment[]> {
  const response = await page.request.post(`/api/v1/runner-agents/${identity.runnerId}/claims`, {
    headers: { authorization: `Bearer ${identity.credential}` },
    data: {
      schemaVersion: 1,
      requestId: randomUUID(),
      availableSlots: RUNNER_CAPACITY,
      labels: LABELS,
      capabilities: CAPABILITIES,
      waitSeconds: 0,
    },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    assignments: Array<Omit<ClaimedAssignment, "identity">>;
  };
  return body.assignments.map((assignment) => ({ ...assignment, identity }));
}

async function uploadLog(page: Page, claim: ClaimedAssignment, index: number): Promise<void> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${claim.assignment.attemptId}/logs`,
    {
      headers: runnerHeaders(claim.identity),
      data: {
        schemaVersion: 1,
        requestId: randomUUID(),
        leaseToken: claim.lease.token,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: `concurrency probe ${index} passed\n`,
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  expect(response.status()).toBe(200);
}

async function completeAttempt(page: Page, claim: ClaimedAssignment, index: number): Promise<void> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${claim.assignment.attemptId}/complete`,
    {
      headers: runnerHeaders(claim.identity),
      data: {
        schemaVersion: 1,
        completionId: randomUUID(),
        leaseToken: claim.lease.token,
        result: {
          status: "succeeded",
          resultCode: "TESTNG_SUCCEEDED",
          summary: `concurrency probe ${index} passed`,
          durationMs: 100,
          logWatermarks: { stdout: 0, stderr: -1, agent: -1 },
          artifacts: [],
        },
      },
    },
  );
  expect(response.status()).toBe(200);
}

async function observeExecutionRecordReads<Durations>(
  page: Page,
  operation: () => Promise<Durations>,
): Promise<{ durations: Durations; readLatenciesMs: number[] }> {
  const readLatenciesMs: number[] = [];
  let keepProbing = true;
  let probeFailure: unknown;
  const probe = probeExecutionRecords(page, readLatenciesMs, () => keepProbing).catch((error) => {
    probeFailure = error;
  });
  let durations: Durations;
  try {
    durations = await operation();
  } finally {
    keepProbing = false;
    await probe;
  }
  if (probeFailure) throw probeFailure;
  return { durations, readLatenciesMs };
}

async function probeExecutionRecords(
  page: Page,
  latenciesMs: number[],
  keepProbing: () => boolean,
): Promise<void> {
  while (keepProbing()) {
    const startedAt = performance.now();
    const response = await page.request.get("/api/v1/run-batches?limit=20");
    latenciesMs.push(performance.now() - startedAt);
    expect(response.status()).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function mapWithConcurrency<Item>(
  items: readonly Item[],
  concurrency: number,
  operation: (item: Item, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await operation(items[index]!, index);
      }
    }),
  );
}

function runnerHeaders(identity: RunnerIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${identity.credential}`,
    "x-autoforge-runner-id": identity.runnerId,
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

async function writePerformanceReport(report: Record<string, number>): Promise<void> {
  const target = process.env.AUTOFORGE_CONCURRENCY_REPORT;
  if (!target) return;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
