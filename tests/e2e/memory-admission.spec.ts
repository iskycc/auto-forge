import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import {
  memoryAdmissionModeSchema,
  type PlatformConfigurationView,
  type ClaimAssignmentsResponse,
} from "@autoforge/contracts";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { browserJson, ensureAdministrator, selectProjectContext } from "./support/session";
import { configureTaskExecution, createTaskRun } from "./support/task-execution";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { expectUiIntegrity } from "./support/ui-guard";

const modeLabels = {
  reserved: "阈值与预留（默认）",
  threshold: "仅按内存使用率",
  disabled: "不限制内存",
};
const activeMode = memoryAdmissionModeSchema.parse(
  process.env.AUTOFORGE_E2E_MEMORY_ADMISSION_MODE ?? "reserved",
);

test("memory admission settings persist three policies without numeric bypasses", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  await page.goto("/settings/platform?section=configuration");
  const initial = (await (
    await page.request.get("/api/v1/settings/platform")
  ).json()) as PlatformConfigurationView;
  const selector = page.locator('select[name="memoryAdmissionMode"]');
  for (const mode of ["reserved", "threshold", "disabled"] as const) {
    await page.getByRole("combobox", { name: "内存调度策略", exact: true }).click();
    await page.getByRole("option", { name: modeLabels[mode], exact: true }).click();
    await saveSettings(page);
    await expect(selector).toHaveValue(mode);
    if (mode !== "reserved") {
      const theme = mode === "disabled" ? "dark" : "light";
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, domain: "127.0.0.1", path: "/" },
        ]);
      await page.reload();
      await expect(selector).toHaveValue(mode);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await selector
          .locator("xpath=ancestor::label")
          .evaluate((element) => element.scrollIntoView({ block: "center" }));
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`memory-settings-${mode}-${theme}-${width}.png`),
        });
      }
    }
  }
  const saved = (await (
    await page.request.get("/api/v1/settings/platform")
  ).json()) as PlatformConfigurationView;
  const { memoryAdmissionMode: mode, ...legacyScheduler } = saved.scheduler;
  expect(mode).toBe("disabled");
  const legacy = await page.request.patch("/api/v1/settings/platform", {
    headers: { origin: new URL(page.url()).origin },
    data: {
      revision: saved.revision,
      mode: saved.mode,
      web: saved.web,
      limits: saved.limits,
      scheduler: legacyScheduler,
      worker: saved.worker,
    },
  });
  expect(legacy.status()).toBe(200);
  const preserved = (await legacy.json()) as PlatformConfigurationView;
  expect(preserved.scheduler.memoryAdmissionMode).toBe("disabled");
  const invalid = await page.request.patch("/api/v1/settings/platform", {
    headers: { origin: new URL(page.url()).origin },
    data: {
      revision: preserved.revision,
      mode: saved.mode,
      web: saved.web,
      limits: saved.limits,
      scheduler: { ...saved.scheduler, maximumMemoryUtilizationPercent: 200 },
      worker: saved.worker,
    },
  });
  expect(invalid.status()).toBe(400);
  await page.reload();
  await selector.selectOption(initial.scheduler.memoryAdmissionMode ?? "reserved");
  await saveSettings(page);
});

async function saveSettings(page: Page) {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/settings/platform" &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "保存平台配置", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const configuration = (await response.json()) as PlatformConfigurationView;
  // Policy changes use the existing restart-only scheduler lifecycle.
  if (configuration.restartRequired)
    expect(configuration.restartRequiredFields).toContain("调度阈值");
}

test("memory admission dispatches to a Runner without cgroup v2 using the active policy", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await ensureAdministrator(page);
  const suffix = randomUUID();
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: `内存策略 ${suffix}`, slug: `memory-${suffix}` },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions`,
    { method: "POST", body: { name: "兼容节点" } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "内存调度", description: "无 cgroup v2 的协议验证" } },
  );
  expect(stage.status).toBe(201);
  await selectProjectContext(page, project.body.id, version.body.id, stage.body.id);
  const jar = zipSync(
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `example/MemoryPolicy${i}.class`,
        buildClassFile({
          className: `example.MemoryPolicy${i}`,
          methods: [{ name: "test", annotations: [{ type: "Test", values: {} }] }],
        }),
      ]),
    ),
  );
  await page.goto(`/cases/import?projectVersionId=${version.body.id}&testStageId=${stage.body.id}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "memory-policy.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("将创建 8 个用例定义", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status").filter({ hasText: /已导入|已返回现有用例/ })).toBeVisible({
    timeout: 60000,
  });
  await page.goto(`/case-suites?projectId=${project.body.id}`);
  await page.getByRole("button", { name: "创建任务" }).click();
  const dialog = page.getByRole("dialog", { name: "创建用例任务" });
  await dialog.getByLabel("使用 CoTest TestNG Adapter").uncheck();
  const suiteName = `内存兼容任务 ${suffix}`;
  await dialog.getByLabel("任务名称").fill(suiteName);
  await dialog.getByRole("button", { name: "创建任务" }).click();
  await expect(page.getByRole("link", { name: suiteName })).toBeVisible();
  await page.goto(`/cases?projectId=${project.body.id}`);
  await page.getByLabel("页内搜索用例").fill("MemoryPolicy");
  await page.getByLabel("选择当前搜索结果中的全部用例").check();
  await page.locator('select[aria-label="目标用例任务"]').selectOption({ label: suiteName });
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.locator(".toast-card", { hasText: "已将 8 个用例加入任务" })).toBeVisible();
  const suites = await browserJson<{ items: Array<{ id: string; name: string }> }>(
    page,
    `/api/v1/case-suites?projectId=${project.body.id}&limit=200`,
  );
  const suiteId = suites.body.items.find((suite) => suite.name === suiteName)!.id;
  const capabilities = ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"];
  const labels = ["linux", "java", "testng"];
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: `Legacy memory ${suffix}`,
      labels,
      capabilities,
      maxConcurrency: 8,
      os: "linux",
      architecture: "amd64",
      agentVersion: "1.20.0",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const identity = (await registration.json()) as { runnerId: string; credential: string };
  const authorization = { authorization: `Bearer ${identity.credential}` };
  try {
    const heartbeat = await page.request.post(
      `/api/v1/runner-agents/${identity.runnerId}/heartbeat`,
      {
        headers: authorization,
        data: {
          schemaVersion: 1,
          busySlots: 0,
          labels,
          capabilities,
          maxConcurrency: 8,
          agentVersion: "1.20.0",
          terminalEnabled: false,
          resourceSnapshot: {
            cpuUtilizationPercent: 10,
            memoryUtilizationPercent: activeMode === "disabled" ? 100 : 25,
            memoryTotalBytes: 16 * 1024 ** 3,
            memoryAvailableBytes: activeMode === "disabled" ? 0 : 12 * 1024 ** 3,
            loadAverage1m: 0,
            logicalCpuCount: 16,
            observedAt: new Date().toISOString(),
          },
        },
      },
    );
    expect(heartbeat.status()).toBe(200);
    await configureTaskExecution(page, suiteId, identity.runnerId, {
      concurrency: 8,
      retryLimit: 0,
    });
    const batch = await createTaskRun(page, suiteId);
    const assignments: ClaimAssignmentsResponse["assignments"] = [];
    const expected = activeMode === "reserved" ? 4 : 8;
    await expect
      .poll(
        async () => {
          const response = await page.request.post(
            `/api/v1/runner-agents/${identity.runnerId}/claims`,
            {
              headers: authorization,
              data: {
                schemaVersion: 1,
                requestId: randomUUID(),
                availableSlots: 8 - assignments.length,
                labels,
                capabilities,
                waitSeconds: 0,
              },
            },
          );
          expect(response.status()).toBe(200);
          assignments.push(...((await response.json()) as ClaimAssignmentsResponse).assignments);
          return assignments.length;
        },
        { timeout: 15000 },
      )
      .toBe(expected);
    const diagnostic = await page.request.get(
      `/api/v1/run-batches/${batch.id}/concurrency-diagnostics`,
    );
    expect(diagnostic.status()).toBe(200);
    expect(await diagnostic.json()).toMatchObject({
      thresholds: { memoryAdmissionMode: activeMode },
      runningRuns: expected,
    });
    await page.goto(`/run-batches/${batch.id}`);
    await page.getByRole("button", { name: "并发诊断", exact: true }).click();
    const diagnosticDialog = page.getByRole("dialog", { name: "并发诊断", exact: true });
    await expect(
      diagnosticDialog.getByText(`内存调度策略：${modeLabels[activeMode]}。`, { exact: false }),
    ).toBeVisible();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expect(
        diagnosticDialog.getByRole("button", { name: "关闭", exact: true }),
      ).toBeInViewport();
      await diagnosticDialog.screenshot({
        path: testInfo.outputPath(`memory-diagnostics-${activeMode}-${width}.png`),
      });
    }
  } finally {
    const response = await page.request.patch(`/api/v1/runners/${identity.runnerId}`, {
      headers: { origin: new URL(page.url()).origin },
      data: { state: "disabled" },
    });
    expect(response.status()).toBe(200);
  }
});
