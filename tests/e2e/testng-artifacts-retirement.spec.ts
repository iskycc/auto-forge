import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { openHistoryFixtureConnection } from "./support/history-fixture-connection";
import { openExecutionCaseDetails } from "./support/execution-details";
import { expectUiIntegrity } from "./support/ui-guard";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";

test("platform configuration no longer offers execution artifact collection", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const configuration = await browserJson<{ limits: Record<string, unknown> }>(
    page,
    "/api/v1/settings/platform",
  );
  expect(configuration.status).toBe(200);
  expect(configuration.body.limits).not.toHaveProperty("artifactCollectionEnabled");
  await page.goto("/settings/platform?section=configuration");
  await expect(page.getByLabel(/启用产物收集/)).toHaveCount(0);
  await page.locator('input[name="caseExecutionTimeoutSeconds"]').scrollIntoViewIfNeeded();
  await capture(page, testInfo, "settings-without-artifacts");
  await page.goto("/settings/access?section=roles");
  await expect(page.getByText("查看执行产物", { exact: true })).toHaveCount(0);
  await capture(page, testInfo, "roles-without-artifact-permission");
});

test("saved task rules cannot enable artifact collection and task configuration stays tidy", async ({
  page,
}, testInfo) => {
  const suite = await createSuite(page);
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: uniqueName("退役规则验证节点"),
      labels: [],
      capabilities: ["executor:testng-v1"],
      maxConcurrency: 1,
      os: "linux",
      architecture: "amd64",
      agentVersion: "1.22.20",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const runner = (await registration.json()) as { runnerId: string };
  const patched = await browserJson<{ policy: { artifactPatterns: string[] } }>(
    page,
    `/api/v1/case-suites/${suite.id}`,
    {
      method: "PATCH",
      body: {
        expectedRevision: suite.revision,
        policy: { runnerIds: [runner.runnerId], artifactPatterns: ["reports/testng/**"] },
      },
    },
  );
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  expect(patched.body.policy.artifactPatterns).toEqual([]);
  await page.goto(`/case-suites/${suite.id}`);
  await expect(page.getByLabel("产物规则（每行一个相对路径 glob）")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "立即执行", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "任务配置", exact: true }).click();
  await capture(page, testInfo, "task-without-artifact-rules");
  await page.goto("/execution-records?view=api");
  await expect(page.getByRole("heading", { name: "单用例执行 API", exact: true })).toBeVisible();
  await expect(page.getByText(/artifactPatterns/)).toHaveCount(0);
  await page.getByText("其他策略", { exact: true }).scrollIntoViewIfNeeded();
  await capture(page, testInfo, "execution-api-without-artifact-options");
});

test("authenticated and public execution details preserve TestNG results without reading historical artifacts", async ({
  page,
  browser,
}, testInfo) => {
  const suite = await createSuite(page);
  const batchId = await insertCompletedExecution(suite);
  const publication = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-batches/${batchId}/share`,
    { method: "POST" },
  );
  expect(publication.status).toBe(200);
  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    for (const [target, path, audience] of [
      [page, `/run-batches/${batchId}`, "console"],
      [visitor, publication.body.shareUrl, "public"],
    ] as const) {
      const artifactRequests: string[] = [];
      target.on("request", (request) => {
        if (new URL(request.url()).pathname.includes("/artifacts"))
          artifactRequests.push(request.url());
      });
      for (const color of ["light", "dark"] as const) {
        await target.context().addCookies([
          {
            name: "autoforge-color-mode",
            value: color,
            url: new URL("/", testInfo.project.use.baseURL!).href,
          },
        ]);
        await target.goto(path);
        await openExecutionCaseDetails(target);
        await target
          .getByRole("row", { name: /RetirementCaseTest/ })
          .getByRole("button", { name: "详情", exact: true })
          .click();
        const detail = target.getByRole("dialog", { name: "结构化执行详情", exact: true });
        await expect(
          detail.getByRole("heading", { name: "结构化测试结果", exact: true }),
        ).toBeVisible();
        await expect(detail.getByLabel("TestNG 结果汇总")).toContainText("失败1");
        await expect(detail.getByRole("heading", { name: "产物", exact: true })).toHaveCount(0);
        await capture(target, testInfo, `${audience}-result-without-artifacts`, [color]);
        expect(artifactRequests).toEqual([]);
        await detail.press("Escape");
      }
    }
  } finally {
    await context.close();
  }
});

async function createSuite(page: Page) {
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("产物退役验证") } },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const suite = await browserJson<{ id: string; revision: number }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      name: uniqueName("结果与日志保留验证"),
    },
  });
  expect(suite.status).toBe(201);
  return { ...suite.body, versionId: version.body.id };
}

async function insertCompletedExecution(suite: { id: string; versionId: string }) {
  const database = await openHistoryFixtureConnection({
    directory: process.env.AUTOFORGE_E2E_DATA_DIR,
    postgresUrl: process.env.AUTOFORGE_E2E_POSTGRES_URL,
  });
  const batchId = randomUUID(),
    runId = randomUUID(),
    attemptId = randomUUID(),
    runnerId = randomUUID();
  const now = new Date().toISOString();
  const counts = { total: 1, passed: 0, failed: 1, skipped: 0, configurationFailures: 0 };
  const result = {
    ...counts,
    detailsTruncated: false,
    suites: [
      {
        ...counts,
        name: "Retirement Suite",
        durationMs: 100,
        tests: [
          {
            ...counts,
            name: "Retirement Test",
            durationMs: 100,
            classes: [
              {
                ...counts,
                name: "example.RetirementCaseTest",
                durationMs: 100,
                methods: [
                  {
                    name: "verifyBusinessResult",
                    status: "failed",
                    configuration: false,
                    durationMs: 100,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  try {
    await database.execute(
      `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES (?,?,?,FALSE,FALSE,'linux','amd64','1.22.20',1,'[]','[]',1,0,?,?,?)`,
      [
        runnerId,
        createHash("sha256").update(runnerId).digest("hex"),
        "退役回归执行节点",
        now,
        now,
        now,
      ],
    );
    await database.execute(
      `INSERT INTO run_batches(id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,policy_json,scheduled_for,created_at,updated_at) VALUES (?,${database.nextBatchSequence},?,'结构化结果保留验证',1,'failed',0,'[]',1,?,?,?,?,?)`,
      [
        batchId,
        suite.id,
        DEFAULT_PROJECT_ID,
        JSON.stringify({ projectVersionId: suite.versionId }),
        now,
        now,
        now,
      ],
    );
    await database.execute(
      `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,terminal_outcome,created_at,updated_at) VALUES (?,?,?,1,'RetirementCaseTest','example.RetirementCaseTest','failed',1,'failed',?,?)`,
      [runId, batchId, randomUUID(), now, now],
    );
    await database.execute(
      `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_code,result_summary,duration_ms,testng_result_json,started_at,finished_at,created_at) VALUES (?,?,?,1,'failed',1,'failed','TESTNG_FAILED','Assertion failed',100,?,?,?,?)`,
      [attemptId, runId, runnerId, JSON.stringify(result), now, now, now],
    );
    await database.execute(
      `INSERT INTO attempt_artifacts(id,attempt_id,relative_path,media_type,size_bytes,sha256,required,status,created_at,updated_at) VALUES (?,?,'reports/testng/old.xml','application/xml',10,?,FALSE,'declared',?,?)`,
      [randomUUID(), attemptId, "a".repeat(64), now, now],
    );
    return batchId;
  } finally {
    await database.close();
  }
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  colors: readonly ("light" | "dark")[] = ["light", "dark"],
) {
  const folder = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(folder, { recursive: true });
  for (const color of colors) {
    // A full-screen result hides the page-level toggle, so apply the existing theme cookie on reload only outside dialogs.
    const toggle = page.getByRole("button", {
      name: color === "dark" ? "切换到深色模式" : "切换到浅色模式",
      exact: true,
    });
    if (await toggle.isVisible()) await toggle.click();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(folder, `${name}-${color}-${width}.png`),
        animations: "disabled",
      });
    }
  }
}
