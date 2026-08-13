import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { randomUUID } from "node:crypto";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { browserJson, ensureAdministrator, uniqueName } from "./support/session";

const runnerCapabilities = [
  "executor:testng-v1",
  "isolation:cgroup-v2",
  "java:21.0.8",
  "testng:7.11.0",
];

test("authoritative execution recovery handles every timeout and idempotent race", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureAdministrator(page);
  const suiteId = await createExecutableFixture(page);
  const runner = await registerRunner(page, "Execution Recovery Runner", runnerCapabilities);
  const incompatible = await registerRunner(page, "Incompatible Recovery Runner", [
    "isolation:cgroup-v2",
  ]);

  const preflight = await browserJson<{
    ready: boolean;
    blockers: Array<{ category: string; runnerId?: string }>;
  }>(page, "/api/v1/run-batches/preflight", {
    method: "POST",
    body: {
      suiteId,
      runnerIds: [incompatible.runnerId],
      environmentVariables: [],
    },
  });
  expect(preflight.status).toBe(200);
  expect(preflight.body.ready).toBe(false);
  expect(preflight.body.blockers).toContainEqual(
    expect.objectContaining({ category: "runner", runnerId: incompatible.runnerId }),
  );

  const claimTimeoutBatch = await createBatch(page, suiteId, runner.runnerId, {
    claimTimeoutMs: 1_000,
  });
  await page.waitForTimeout(1_300);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, claimTimeoutBatch, "ASSIGNMENT_CLAIM_TIMEOUT");

  const executionTimeoutBatch = await createBatch(page, suiteId, runner.runnerId, {
    executionTimeoutMs: 1_000,
  });
  const executionTimeoutClaim = await claimAssignment(page, runner);
  await page.waitForTimeout(1_300);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, executionTimeoutBatch, "EXECUTION_TIMEOUT");
  expect(
    (await complete(page, runner, executionTimeoutClaim, "late-after-timeout")).disposition,
  ).toBe("late");

  const uploadTimeoutBatch = await createBatch(page, suiteId, runner.runnerId, {
    executionTimeoutMs: 60_000,
    uploadTimeoutMs: 1_000,
  });
  const uploadTimeoutClaim = await claimAssignment(page, runner);
  const declaration = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(uploadTimeoutClaim.assignment.attemptId)}/artifacts`,
    {
      headers: runnerHeaders(runner),
      data: {
        schemaVersion: 1,
        requestId: randomUUID(),
        leaseToken: uploadTimeoutClaim.lease.token,
        artifacts: [],
      },
    },
  );
  expect(declaration.status()).toBe(200);
  await page.waitForTimeout(1_300);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, uploadTimeoutBatch, "UPLOAD_TIMEOUT");

  const capacityBatch = await createBatch(page, suiteId, runner.runnerId, {
    executionTimeoutMs: 120_000,
  });
  const capacityClaim = await claimAssignment(page, runner);
  const queueTimeoutBatch = await createBatch(page, suiteId, runner.runnerId, {
    queueTimeoutMs: 1_000,
  });
  await page.waitForTimeout(1_300);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, queueTimeoutBatch, "QUEUE_TIMEOUT");
  expect(
    (await complete(page, runner, capacityClaim, "release-project-capacity")).disposition,
  ).toBe("accepted");
  await expectBatchReason(page, capacityBatch, "TESTNG_SUCCEEDED");

  const idempotentBatch = await createBatch(page, suiteId, runner.runnerId, {});
  await waitForAttemptStatus(page, idempotentBatch, "assigned");
  const claimRequestId = randomUUID();
  const firstClaimResponse = await claimOnce(page, runner, claimRequestId);
  const duplicateClaimResponse = await claimOnce(page, runner, claimRequestId);
  const firstClaim = firstClaimResponse.assignments[0]!;
  expect(duplicateClaimResponse.assignments[0]?.assignment.attemptId).toBe(
    firstClaim.assignment.attemptId,
  );
  const completionId = randomUUID();
  expect((await complete(page, runner, firstClaim, completionId)).disposition).toBe("accepted");
  expect((await complete(page, runner, firstClaim, completionId)).disposition).toBe("duplicate");
  await expectBatchReason(page, idempotentBatch, "TESTNG_SUCCEEDED");

  const cancellationBatch = await createBatch(page, suiteId, runner.runnerId, {});
  const cancellationClaim = await claimAssignment(page, runner);
  const cancellation = await browserJson(
    page,
    `/api/v1/execution-runs/${encodeURIComponent(cancellationClaim.assignment.executionSpec.executionRunId)}/cancel`,
    { method: "POST", body: { reason: "E2E completion/cancel race" } },
  );
  expect(cancellation.status).toBe(200);
  expect((await complete(page, runner, cancellationClaim, randomUUID())).disposition).toBe("late");
  await expectBatchReason(page, cancellationBatch, "CANCELLED_BY_USER");

  const leaseExpiryBatch = await createBatch(page, suiteId, runner.runnerId, {
    executionTimeoutMs: 120_000,
  });
  await claimAssignment(page, runner);
  await page.waitForTimeout(46_000);
  await triggerRecovery(page, runner);
  await expectBatchReason(page, leaseExpiryBatch, "LEASE_EXPIRED");
});

type RunnerIdentity = { runnerId: string; credential: string };
type Claim = {
  assignment: {
    attemptId: string;
    executionSpec: { executionRunId: string };
  };
  lease: { token: string };
};

async function createExecutableFixture(page: Page): Promise<string> {
  const className = `com.example.ExecutionRecovery${Date.now()}Test`;
  const jar = zipSync({
    [`${className.replaceAll(".", "/")}.class`]: buildClassFile({
      className,
      methods: [{ name: "recovers", annotations: [{ type: "Test", values: {} }] }],
    }),
  });
  await page.goto("/cases/import");
  await page.locator('input[type="file"]').setInputFiles({
    name: "execution-recovery.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText(className)).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText("已导入", { timeout: 60_000 });
  const cases = await browserJson<{ items: Array<{ id: string; className: string }> }>(
    page,
    "/api/v1/case-definitions?limit=200",
  );
  const caseDefinition = cases.body.items.find((item) => item.className === className);
  expect(caseDefinition).toBeTruthy();
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { name: uniqueName("execution-recovery") },
  });
  expect(suite.status).toBe(201);
  const addition = await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
    method: "POST",
    body: { caseDefinitionIds: [caseDefinition!.id] },
  });
  expect(addition.status).toBe(200);
  return suite.body.id;
}

async function registerRunner(
  page: Page,
  name: string,
  capabilities: string[],
): Promise<RunnerIdentity> {
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${requiredEnvironment("E2E_RUNNER_BOOTSTRAP_TOKEN")}` },
    data: {
      schemaVersion: 1,
      name,
      labels: ["linux", "java", "testng"],
      capabilities,
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.3.4-e2e",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const runner = (await registration.json()) as RunnerIdentity;
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        busySlots: 0,
        labels: ["linux", "java", "testng"],
        capabilities,
        maxConcurrency: 2,
        agentVersion: "0.3.4-e2e",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 1,
          memoryUtilizationPercent: 1,
          loadAverage1m: 0,
          logicalCpuCount: 2,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(heartbeat.status()).toBe(200);
  return runner;
}

async function createBatch(
  page: Page,
  suiteId: string,
  runnerId: string,
  timeouts: Record<string, number>,
): Promise<string> {
  const response = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
    method: "POST",
    body: {
      suiteId,
      runnerIds: [runnerId],
      retryLimit: 0,
      environmentVariables: [],
      ...timeouts,
    },
  });
  expect(response.status).toBe(201);
  return response.body.id;
}

async function claimAssignment(page: Page, runner: RunnerIdentity): Promise<Claim> {
  let observed: Claim | undefined;
  await expect
    .poll(
      async () => {
        const response = await claimOnce(page, runner, randomUUID());
        observed = response.assignments[0];
        return Boolean(observed);
      },
      { timeout: 20_000, intervals: [100, 250, 500] },
    )
    .toBe(true);
  return observed!;
}

async function triggerRecovery(page: Page, runner: RunnerIdentity): Promise<void> {
  const response = await claimOnce(page, runner, randomUUID());
  expect(response.assignments).toHaveLength(0);
}

async function claimOnce(page: Page, runner: RunnerIdentity, requestId: string) {
  const response = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/claims`,
    {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        requestId,
        availableSlots: 1,
        labels: ["linux", "java", "testng"],
        capabilities: runnerCapabilities,
        waitSeconds: 0,
      },
    },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as { assignments: Claim[] };
}

async function complete(
  page: Page,
  runner: RunnerIdentity,
  claim: Claim,
  completionId: string,
): Promise<{ disposition: string }> {
  const response = await page.request.post(
    `/api/v1/run-attempts/${encodeURIComponent(claim.assignment.attemptId)}/complete`,
    {
      headers: runnerHeaders(runner),
      data: {
        schemaVersion: 1,
        completionId,
        leaseToken: claim.lease.token,
        result: {
          status: "succeeded",
          resultCode: "TESTNG_SUCCEEDED",
          summary: "Execution recovery E2E completion",
          durationMs: 10,
          artifacts: [],
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as { disposition: string };
}

async function expectBatchReason(page: Page, batchId: string, reason: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}`,
        );
        if (!response.ok()) return `HTTP ${response.status()}`;
        const body = (await response.json()) as {
          attempts: Array<{ resultCode?: string }>;
          runs: Array<{ terminalReasonCode?: string }>;
        };
        return (
          body.attempts.find((attempt) => attempt.resultCode)?.resultCode ??
          body.runs.find((run) => run.terminalReasonCode)?.terminalReasonCode ??
          "pending"
        );
      },
      { timeout: 20_000, intervals: [100, 250, 500] },
    )
    .toBe(reason);
}

async function waitForAttemptStatus(page: Page, batchId: string, status: string): Promise<void> {
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/run-batches/${encodeURIComponent(batchId)}`);
      return ((await response.json()) as { attempts: Array<{ status: string }> }).attempts[0]
        ?.status;
    })
    .toBe(status);
}

function runnerHeaders(runner: RunnerIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${runner.credential}`,
    "x-autoforge-runner-id": runner.runnerId,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for execution recovery acceptance.`);
  return value;
}
