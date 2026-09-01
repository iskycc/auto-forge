import { expect, type Page } from "@playwright/test";

import { browserJson } from "./session";

type SuitePolicyOverrides = {
  concurrency?: number;
  retryLimit?: number;
  retryMode?: "immediate" | "round";
  queueTimeoutMs?: number;
  claimTimeoutMs?: number;
  uploadTimeoutMs?: number;
  runnerLabels?: string[];
  artifactPatterns?: string[];
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
  const suite = await browserJson<{ revision: number; policy: Record<string, unknown> }>(
    page,
    `/api/v1/case-suites/${encodeURIComponent(suiteId)}`,
  );
  expect(suite.status).toBe(200);
  const updated = await browserJson(page, `/api/v1/case-suites/${encodeURIComponent(suiteId)}`, {
    method: "PATCH",
    body: {
      policy: {
        ...suite.body.policy,
        runnerIds: [runnerId],
        runnerGroupId: "",
        ...overrides,
      },
      expectedRevision: suite.body.revision,
    },
  });
  expect(updated.status).toBe(200);
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
