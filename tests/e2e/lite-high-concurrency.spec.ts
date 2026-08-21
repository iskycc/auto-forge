import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { browserJson, ensureAdministrator } from "./support/session";

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
  lease: { token: string };
};

test("Lite control plane completes 500 concurrent protocol slots without blocking reads", async ({
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
      name: `Lite 500 并发协议验收 ${randomUUID()}`,
      description: "GitHub Actions 托管机上的 500 槽位控制面回归",
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

  const readLatenciesMs: number[] = [];
  let keepProbing = true;
  const probe = probeExecutionRecords(page, readLatenciesMs, () => keepProbing);
  const executionStartedAt = performance.now();
  try {
    await mapWithConcurrency(claimed, CLIENT_REQUEST_CONCURRENCY, async (claim, index) => {
      await uploadLog(page, claim, index);
      await completeAttempt(page, claim, index);
    });
  } finally {
    keepProbing = false;
    await probe;
  }
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
  expect(readLatenciesMs.length).toBeGreaterThan(0);
  const p95ReadLatencyMs = percentile(readLatenciesMs, 0.95);
  const maximumReadLatencyMs = Math.max(...readLatenciesMs);
  expect(p95ReadLatencyMs).toBeLessThan(1_500);
  expect(maximumReadLatencyMs).toBeLessThan(5_000);
  expect(executionDurationMs).toBeLessThan(90_000);

  await writePerformanceReport({
    schemaVersion: 1,
    caseCount: CASE_COUNT,
    runnerCount: RUNNER_COUNT,
    runnerCapacity: RUNNER_CAPACITY,
    clientRequestConcurrency: CLIENT_REQUEST_CONCURRENCY,
    importDurationMs: rounded(importDurationMs),
    batchCreationDurationMs: rounded(batchCreationDurationMs),
    claimDurationMs: rounded(claimDurationMs),
    executionDurationMs: rounded(executionDurationMs),
    readProbeCount: readLatenciesMs.length,
    p95ReadLatencyMs: rounded(p95ReadLatencyMs),
    maximumReadLatencyMs: rounded(maximumReadLatencyMs),
  });
});

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
