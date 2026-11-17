import { expect, type Page } from "@playwright/test";
import { zipSync } from "fflate";

import { closeExecutionCaseDetails } from "./execution-details";
import { browserJson } from "./session";

type SuitePolicyOverrides = {
  aiAnalysisAfterCompletion?: boolean;
  concurrency?: number;
  retryLimit?: number;
  retryMode?: "immediate" | "round";
  queueTimeoutMs?: number;
  claimTimeoutMs?: number;
  uploadTimeoutMs?: number;
  runnerLabels?: string[];
  adapter?: {
    enabled: boolean;
    suiteName: string;
    testName: string;
    environmentAddresses: string[];
  };
  retryConcurrencyRules?: Array<{
    id: string;
    executionRound: number;
    previousRoundPassRateMinimum?: number;
    previousRoundPassRateMaximum?: number;
    remainingRunsMinimum?: number;
    remainingRunsMaximum?: number;
    concurrency: number;
  }>;
  roundRecoveryRules?: Array<{
    id: string;
    afterRound: number;
    jenkinsJobUrl: string;
    waitMinutes: number;
    apiKey: string;
  }>;
};

type NamedResource = { id: string; name: string };

export async function findRunnerId(page: Page, runnerName: string): Promise<string> {
  const response = await browserJson<{ items: NamedResource[] }>(page, "/api/v1/runners?limit=100");
  expect(response.status).toBe(200);
  const runner = response.body.items.find((item) => item.name === runnerName);
  expect(runner, `执行机 ${runnerName} 应已注册`).toBeDefined();
  return runner!.id;
}

export async function findSuiteId(page: Page, suiteName: string): Promise<string> {
  const response = await browserJson<{ items: NamedResource[] }>(
    page,
    "/api/v1/case-suites?limit=200",
  );
  expect(response.status).toBe(200);
  const suite = response.body.items.find((item) => item.name === suiteName);
  expect(suite, `用例任务 ${suiteName} 应已创建`).toBeDefined();
  return suite!.id;
}

/** Saves the execution source of truth on the task before any shortcut/API run. */
export async function configureTaskExecution(
  page: Page,
  suiteId: string,
  runnerId: string,
  overrides: SuitePolicyOverrides = {},
): Promise<void> {
  const suite = await browserJson<{
    projectId: string;
    revision: number;
    policy: Record<string, unknown>;
  }>(page, `/api/v1/case-suites/${encodeURIComponent(suiteId)}`);
  expect(suite.status).toBe(200);
  await ensureTaskDependencyFixture(
    page,
    suite.body.projectId,
    String(suite.body.policy.projectVersionId),
  );
  const adapter = suite.body.policy.adapter as SuitePolicyOverrides["adapter"];
  const updated = await browserJson(page, `/api/v1/case-suites/${encodeURIComponent(suiteId)}`, {
    method: "PATCH",
    body: {
      policy: {
        ...suite.body.policy,
        runnerIds: [runnerId],
        runnerGroupId: "",
        ...overrides,
        adapter: {
          enabled: true,
          suiteName: adapter?.suiteName || "E2E Suite",
          testName: adapter?.testName || "E2E Test",
          environmentAddresses: adapter?.environmentAddresses.length
            ? adapter.environmentAddresses
            : ["10.0.0.21"],
          ...overrides.adapter,
        },
      },
      expectedRevision: suite.body.revision,
    },
  });
  expect(updated.status).toBe(200);
}

async function ensureTaskDependencyFixture(page: Page, projectId: string, versionId: string) {
  const endpoint = `/api/v1/projects/${projectId}/versions/${versionId}/adapter-configuration`;
  const configuration = await browserJson<{ revision: number; jarBundleAsset?: { id: string } }>(
    page,
    endpoint,
  );
  expect(configuration.status).toBe(200);
  if (configuration.body.jarBundleAsset) return;
  // Fake-Runner scenarios still need a valid runtime snapshot. Real-Agent tests supply
  // their executable archive before configuring the task and keep that archive intact.
  const archive = zipSync({
    "fixture.jar": zipSync({
      "META-INF/MANIFEST.MF": new TextEncoder().encode("Manifest-Version: 1.0\n"),
    }),
  });
  const uploaded = await page.request.post(
    `/api/v1/projects/${projectId}/runtime-assets/upload?kind=jar-bundle&archiveFormat=zip`,
    {
      headers: {
        origin: new URL(page.url()).origin,
        "content-type": "application/octet-stream",
        "x-autoforge-file-name": "protocol-fixture.zip",
      },
      data: Buffer.from(archive),
    },
  );
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const asset = (await uploaded.json()) as { id: string };
  expect(
    (
      await browserJson(page, endpoint, {
        method: "PUT",
        body: { jarBundleAssetId: asset.id, expectedRevision: configuration.body.revision },
      })
    ).status,
  ).toBe(200);
}

export async function createTaskRun(page: Page, suiteId: string): Promise<{ id: string }> {
  const response = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
    method: "POST",
    body: { suiteId },
  });
  expect(response.status).toBe(201);
  return response.body;
}

/** Exercises the globally visible top-bar shortcut and its task-only payload. */
export async function startTaskFromTopbar(page: Page, suiteId: string): Promise<{ id: string }> {
  await closeExecutionCaseDetails(page);
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "开始执行" });
  await expect(dialog).toBeVisible();
  await dialog.locator('select[aria-label="执行用例任务"]').selectOption(suiteId);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/v1/run-batches",
  );
  await dialog.getByRole("button", { name: "确认并开始执行" }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  return (await created.json()) as { id: string };
}
