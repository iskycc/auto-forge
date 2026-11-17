import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import type { ClaimAssignmentsResponse } from "@autoforge/contracts";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { openExecutionCaseDetails } from "./support/execution-details";
import { editEnvironmentAddresses } from "./support/environment-addresses";
import { expectUiIntegrity } from "./support/ui-guard";
import { assertExportedWorkbookFeatureOrder } from "./support/export-workbook-structure";

const ExcelJS = createRequire(resolve(import.meta.dirname, "../../apps/web/package.json"))(
  "exceljs",
) as typeof import("exceljs").default;
const capabilities = [
  "executor:testng-v1",
  "java:21.0.8",
  "testng:7.11.0",
  "adapter:cotest-testng-v1",
  "runtime:project-assets-v1",
];

test("task creation, task settings, quick execution and debug have CoTest fields without a switch", async ({
  page,
}, testInfo) => {
  const fixture = await prepareCases(page);
  for (const color of ["light", "dark"] as const) {
    await applyTheme(page, testInfo, color);
    await page.goto("/case-suites");
    await page.getByRole("button", { name: "创建任务", exact: true }).click();
    const creation = page.getByRole("dialog", { name: "创建用例任务", exact: true });
    await expect(creation.getByLabel("使用 CoTest TestNG Adapter")).toHaveCount(0);
    await expect(creation.getByLabel("TestNG Suite Name", { exact: true })).toBeVisible();
    await editEnvironmentAddresses(page, creation, ["10.0.0.21", "10.0.0.22"]);
    await capture(
      page,
      testInfo,
      `task-creation-${color}`,
      creation.getByRole("button", { name: "修改环境 IP", exact: true }),
    );
    await creation.getByRole("button", { name: "取消", exact: true }).click();

    await page.goto(`/case-suites/${fixture.suite.id}`);
    await page.getByRole("link", { name: "任务配置", exact: true }).click();
    await expect(page.locator('[name="adapterEnabled"]')).toHaveCount(0);
    await expect(page.locator('[name="adapterSuiteName"]')).toHaveValue("Export verification");
    await page.locator('[name="adapterSuiteName"]').scrollIntoViewIfNeeded();
    await capture(page, testInfo, `task-configuration-${color}`);

    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    const run = page.getByRole("dialog", { name: "开始执行", exact: true });
    await run.getByRole("radio", { name: "单个用例", exact: true }).locator("..").click();
    await expect(run.getByLabel("使用 CoTest TestNG Adapter")).toHaveCount(0);
    await run.getByLabel("单用例 Adapter Suite Name").scrollIntoViewIfNeeded();
    await capture(
      page,
      testInfo,
      `single-case-configuration-${color}`,
      run.getByLabel("单用例 Adapter Suite Name"),
    );
    await run.getByRole("button", { name: "取消", exact: true }).click();

    await page.goto("/case-debug");
    const debug = page.getByRole("region", { name: "普通用例调试配置", exact: true });
    await expect(debug.getByLabel("调试启用 Adapter")).toHaveCount(0);
    await expect(debug.getByLabel("调试 Suite Name")).toBeVisible();
    await capture(
      page,
      testInfo,
      `debug-configuration-${color}`,
      debug.getByLabel("调试 Test Name"),
    );
  }
});

test("public execution exports the same failure-analysis Excel anonymously and rejects unpublished batches", async ({
  page,
  browser,
}, testInfo) => {
  const fixture = await prepareCases(page);
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: uniqueName("CoTest export runner"),
      os: "linux",
      architecture: "amd64",
      agentVersion: "1.22.20",
      protocolVersion: 1,
      labels: ["java", "testng"],
      capabilities,
      maxConcurrency: 2,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const runner = (await registration.json()) as { runnerId: string; credential: string };
  const heartbeat = await page.request.post(`/api/v1/runner-agents/${runner.runnerId}/heartbeat`, {
    headers: {
      authorization: `Bearer ${runner.credential}`,
      "x-autoforge-runner-id": runner.runnerId,
    },
    data: {
      schemaVersion: 1,
      busySlots: 0,
      labels: ["java", "testng"],
      capabilities,
      maxConcurrency: 2,
      agentVersion: "1.22.20",
      terminalEnabled: false,
      resourceSnapshot: {
        cpuUtilizationPercent: 1,
        memoryUtilizationPercent: 1,
        loadAverage1m: 0.1,
        logicalCpuCount: 4,
        observedAt: new Date().toISOString(),
      },
    },
  });
  expect(heartbeat.status()).toBe(200);
  const configured = await browserJson(page, `/api/v1/case-suites/${fixture.suite.id}`, {
    method: "PATCH",
    body: {
      expectedRevision: fixture.suite.revision,
      policy: {
        concurrency: 2,
        runnerIds: [runner.runnerId],
        adapter: {
          enabled: false,
          suiteName: "Export verification",
          testName: "Regression",
          environmentAddresses: ["10.0.0.21"],
        },
      },
    },
  });
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  const created = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
    method: "POST",
    body: { suiteId: fixture.suite.id },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const batchId = created.body.id;
  const claims = await claimCases(page, runner);
  expect(claims).toHaveLength(2);
  for (const [index, claim] of claims.entries()) {
    expect(claim.assignment.executionSpec.adapter?.environmentAddress).toBe("10.0.0.21");
    expect(claim.assignment.executionSpec.inputs.some((input) => input.kind === "jar-bundle")).toBe(
      true,
    );
    const response = await page.request.post(
      `/api/v1/run-attempts/${claim.assignment.attemptId}/complete`,
      {
        headers: {
          authorization: `Bearer ${runner.credential}`,
          "x-autoforge-runner-id": runner.runnerId,
        },
        data: {
          schemaVersion: 1,
          completionId: randomUUID(),
          leaseToken: claim.lease.token,
          result: {
            status: index === 0 ? "failed" : "succeeded",
            resultCode: index === 0 ? "TESTNG_ASSERTIONS_FAILED" : "TESTNG_SUCCEEDED",
            summary:
              index === 0
                ? "业务断言失败：预期 1，实际 0\nat example.Checkout.verify(Checkout.java:21)"
                : "passed",
            durationMs: 100,
          },
        },
      },
    );
    expect(response.status(), await response.text()).toBe(200);
  }
  const publication = await browserJson<{ shareUrl: string }>(
    page,
    `/api/v1/run-batches/${batchId}/share`,
    { method: "POST" },
  );
  expect(publication.status).toBe(200);
  const visitorContext = await browser.newContext();
  try {
    const visitor = await visitorContext.newPage();
    for (const scope of ["round", "all", "final"]) {
      const query = `scope=${scope}${scope === "round" ? "&round=1" : ""}&template=failure-analysis`;
      const authenticated = await page.request.get(
        `/api/v1/run-batches/${batchId}/export?${query}`,
      );
      const anonymous = await visitor.request.get(
        `${testInfo.project.use.baseURL}/api/v1/run-batches/${batchId}/export?${query}&public=1`,
      );
      expect(authenticated.status()).toBe(200);
      expect(anonymous.status()).toBe(200);
      const consoleRows = await workbookRows(await authenticated.body());
      const publicRows = await workbookRows(await anonymous.body());
      expect(publicRows).toEqual(consoleRows);
      expect(publicRows).toHaveLength(2);
      expect(publicRows[1]!.join(" ")).toContain("业务断言失败");
    }
    const blocked = await visitor.request.get(
      `${testInfo.project.use.baseURL}/api/v1/run-batches/${randomUUID()}/export?public=1&scope=final&template=failure-analysis`,
    );
    expect(blocked.status()).toBe(400);
    for (const color of ["light", "dark"] as const) {
      await applyTheme(visitor, testInfo, color);
      await visitor.goto(publication.body.shareUrl);
      await openExecutionCaseDetails(visitor);
      await visitor.getByRole("button", { name: "导出结果", exact: true }).click();
      const dialog = visitor.getByRole("dialog", { name: "导出执行结果", exact: true });
      await dialog.getByText("失败用例分析清单", { exact: true }).click();
      await expect(dialog.getByRole("radio", { name: /失败用例分析清单/ })).toBeChecked();
      await dialog.getByText("最终结果", { exact: true }).click();
      await expect(dialog.getByRole("radio", { name: /最终结果/ })).toBeChecked();
      await capture(visitor, testInfo, `anonymous-analysis-export-${color}`);
      const downloadEvent = visitor.waitForEvent("download");
      await dialog.getByRole("button", { name: "导出分析清单", exact: true }).click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toContain("失败用例分析清单");
      const file = await download.path();
      expect(file).not.toBeNull();
      expect(await workbookRows(await readFile(file!))).toHaveLength(2);
    }
  } finally {
    await visitorContext.close();
  }
});

async function prepareCases(page: Page) {
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("CoTest defaults") } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "Regression" } },
  );
  expect(stage.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id, stage.body.id);
  const query = new URLSearchParams({
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: version.body.id,
    testStageId: stage.body.id,
  });
  const classes = ["example.ExportFailedTest", "example.ExportPassedTest"];
  const jar = zipSync(
    Object.fromEntries(
      classes.map((className) => [
        `${className.replaceAll(".", "/")}.class`,
        buildClassFile({
          className,
          methods: [{ name: "verify", annotations: [{ type: "Test", values: {} }] }],
        }),
      ]),
    ),
  );
  const imported = await page.request.post(`/api/v1/case-sources/jar/import?${query}`, {
    headers: { origin: new URL(page.url()).origin, "Idempotency-Key": randomUUID() },
    multipart: {
      file: {
        name: "cotest-export.jar",
        mimeType: "application/java-archive",
        buffer: Buffer.from(jar),
      },
    },
  });
  expect([200, 202]).toContain(imported.status());
  let caseIds: string[] = [];
  await expect
    .poll(
      async () => {
        const response = await browserJson<{ items: Array<{ id: string }> }>(
          page,
          `/api/v1/case-definitions?${query}&limit=100`,
        );
        caseIds = response.body.items.map((item) => item.id);
        return caseIds.length;
      },
      { timeout: 30_000 },
    )
    .toBe(2);
  const uploaded = await page.request.post(
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/runtime-assets/upload?kind=jar-bundle&archiveFormat=zip`,
    {
      headers: {
        origin: new URL(page.url()).origin,
        "content-type": "application/octet-stream",
        "x-autoforge-file-name": "cotest-dependencies.zip",
      },
      data: Buffer.from(zipSync({ "tests.jar": jar })),
    },
  );
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const asset = (await uploaded.json()) as { id: string };
  expect(
    (
      await browserJson(
        page,
        `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions/${version.body.id}/adapter-configuration`,
        { method: "PUT", body: { jarBundleAssetId: asset.id, expectedRevision: 0 } },
      )
    ).status,
  ).toBe(200);
  const created = await browserJson<{
    id: string;
    revision: number;
    policy: { adapter: { enabled: boolean } };
  }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: version.body.id,
      name: uniqueName("CoTest defaults"),
      adapter: {
        enabled: false,
        suiteName: "Export verification",
        testName: "Regression",
        environmentAddresses: ["10.0.0.21"],
      },
    },
  });
  expect(created.status).toBe(201);
  expect(created.body.policy.adapter.enabled).toBe(true);
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${created.body.id}/cases`, {
        method: "POST",
        body: { caseDefinitionIds: caseIds },
      })
    ).status,
  ).toBe(200);
  const suite = await browserJson<typeof created.body>(
    page,
    `/api/v1/case-suites/${created.body.id}?view=summary`,
  );
  return { suite: suite.body, versionId: version.body.id, stageId: stage.body.id };
}

async function claimCases(page: Page, runner: { runnerId: string; credential: string }) {
  const claims: ClaimAssignmentsResponse["assignments"] = [];
  await expect
    .poll(
      async () => {
        const response = await page.request.post(
          `/api/v1/runner-agents/${runner.runnerId}/claims`,
          {
            headers: { authorization: `Bearer ${runner.credential}` },
            data: {
              schemaVersion: 1,
              requestId: randomUUID(),
              availableSlots: 2 - claims.length,
              labels: ["java", "testng"],
              capabilities,
              waitSeconds: 0,
            },
          },
        );
        expect(response.status(), await response.text()).toBe(200);
        claims.push(...((await response.json()) as ClaimAssignmentsResponse).assignments);
        return claims.length;
      },
      { timeout: 30_000 },
    )
    .toBe(2);
  return claims;
}

async function workbookRows(buffer: Buffer) {
  assertExportedWorkbookFeatureOrder(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const rows: string[][] = [];
  workbook.worksheets[0]!.eachRow((row) =>
    rows.push(
      (row.values as unknown[])
        .slice(1)
        .map((value) =>
          typeof value === "object" && value && "text" in value
            ? String(value.text)
            : String(value ?? ""),
        ),
    ),
  );
  return rows;
}

async function applyTheme(page: Page, testInfo: TestInfo, color: "light" | "dark") {
  await page.context().addCookies([
    {
      name: "autoforge-color-mode",
      value: color,
      url: new URL("/", testInfo.project.use.baseURL!).href,
    },
  ]);
}

async function capture(page: Page, testInfo: TestInfo, name: string, focus?: Locator) {
  const folder = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(folder, { recursive: true });
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await focus?.scrollIntoViewIfNeeded();
    await expectUiIntegrity(page);
    const orphanedPunctuation = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const punctuation: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest("script,style,noscript")) continue;
        const text = node.textContent?.trim();
        if (text === "(" || text === ")") punctuation.push(text);
      }
      return punctuation;
    });
    expect(orphanedPunctuation, "removing optional fields must not render JSX delimiters").toEqual(
      [],
    );
    await page.screenshot({
      path: resolve(folder, `${name}-${width}.png`),
      animations: "disabled",
    });
  }
}
