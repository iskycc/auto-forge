import { expect, test, type Locator, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { randomUUID } from "node:crypto";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { browserJson, ensureAdministrator, uniqueName } from "./support/session";

const runnerCapabilities = [
  "executor:testng-v1",
  "isolation:cgroup-v2",
  "java:21.0.8",
  "testng:7.11.0",
  "adapter:cotest-testng-v1",
];

test("global execution dialog schedules one case through a runner group with Adapter IP", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const project = await createProject(page);
  await uploadAdapterDependencies(page, project.id);
  await importSingleCase(page, project);

  const runner = await registerRunner(page);
  const groupName = `单用例执行池-${randomUUID().slice(0, 8)}`;
  await page.goto("/runners?section=groups");
  const createGroup = page.locator("form", {
    has: page.getByRole("button", { name: "创建执行机组" }),
  });
  await createGroup.getByLabel("组名称").fill(groupName);
  await createGroup
    .locator(".runner-member-picker label", { hasText: "E2E Single Case Runner" })
    .getByRole("checkbox")
    .check();
  await createGroup.getByRole("button", { name: "创建执行机组" }).click();
  await expect(page.locator(".runner-group-card", { hasText: groupName })).toBeVisible();

  // 全局入口必须在任意业务页可见，且旧的侧栏“用例批跑”入口不再存在。
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "本周质量" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByText("用例批跑")).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "开始执行" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "单个用例" }).click();
  await selectOptionContaining(dialog.getByLabel("待执行单个用例"), "SingleCaseFixture");
  await dialog.getByRole("button", { name: "使用执行机组" }).click();
  await selectOptionContaining(dialog.getByLabel("执行机组"), groupName);
  await dialog.getByLabel("单用例参数覆盖").fill("target=single-case-e2e");
  await dialog.getByLabel("使用 CoTest TestNG Adapter").check();
  await dialog.getByLabel("单用例 Adapter Suite Name").fill("Single Case Suite");
  await dialog.getByLabel("单用例 Adapter Test Name").fill("Single Case Test");
  await dialog.getByLabel("单用例执行环境 IP 地址").fill("10.0.0.21");

  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/v1\/case-definitions\/[^/]+\/execute$/u.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole("button", { name: "确认并开始执行" }).click();
  const response = await createResponse;
  expect(response.status()).toBe(201);
  const batch = (await response.json()) as {
    id: string;
    projectId: string;
    selectedRunnerIds: string[];
  };
  expect(batch.projectId).toBe(project.id);
  expect(batch.selectedRunnerIds).toEqual([runner.runnerId]);
  await expect(page).toHaveURL(new RegExp(`/run-batches/${batch.id}$`));

  const claim = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/claims`,
    {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        requestId: `single-case-claim-${randomUUID()}`,
        availableSlots: 1,
        labels: ["linux", "java", "testng"],
        capabilities: runnerCapabilities,
        waitSeconds: 0,
      },
    },
  );
  expect(claim.status()).toBe(200);
  const body = (await claim.json()) as {
    assignments: Array<{
      assignment: {
        executionSpec: {
          className: string;
          parameters: Record<string, string>;
          adapter?: { suiteName: string; testName: string; environmentAddress: string };
        };
      };
    }>;
  };
  expect(body.assignments).toHaveLength(1);
  expect(body.assignments[0]!.assignment.executionSpec).toMatchObject({
    className: "com.example.SingleCaseFixture",
    parameters: { target: "single-case-e2e" },
    adapter: {
      suiteName: "Single Case Suite",
      testName: "Single Case Test",
      environmentAddress: "10.0.0.21",
    },
  });
});

async function selectOptionContaining(select: Locator, text: string): Promise<void> {
  const option = select.locator("option").filter({ hasText: text });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  if (!value) throw new Error(`Option containing ${text} has no selectable value.`);
  await select.selectOption(value);
}

async function createProject(page: Page) {
  const suffix = uniqueName("single-case");
  const project = await browserJson<{ id: string; name: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: `单用例项目 ${suffix}`, slug: suffix },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(project.body.id)}/versions`,
    { method: "POST", body: { name: "单用例 E2E 版本" } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${encodeURIComponent(project.body.id)}/versions/${encodeURIComponent(version.body.id)}/stages`,
    { method: "POST", body: { name: "单用例 E2E 阶段", description: "全局单用例调度验收" } },
  );
  expect(stage.status).toBe(201);
  return { ...project.body, versionId: version.body.id, stageId: stage.body.id };
}

async function uploadAdapterDependencies(page: Page, projectId: string): Promise<void> {
  const dependencyJar = zipSync({
    "META-INF/MANIFEST.MF": new TextEncoder().encode("Manifest-Version: 1.0\n"),
  });
  const dependencyArchive = zipSync({ "lib/e2e-placeholder.jar": dependencyJar });
  await page.goto(
    `/settings/projects?${new URLSearchParams({
      projectId,
      section: "execution",
    }).toString()}`,
  );
  const uploadForm = page.locator("form", {
    has: page.getByRole("button", { name: "上传并启用" }),
  });
  await uploadForm.getByLabel("资源类型").selectOption("jar-bundle");
  await uploadForm.getByLabel("压缩格式").selectOption("zip");
  await uploadForm.getByLabel("本地文件").setInputFiles({
    name: "single-case-dependencies.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(dependencyArchive),
  });
  await uploadForm.getByRole("button", { name: "上传并启用" }).click();
  await expect(page.getByText("运行时资源已上传并设为当前配置。")).toBeVisible({
    timeout: 60_000,
  });
}

async function importSingleCase(
  page: Page,
  project: { id: string; name: string; versionId: string; stageId: string },
): Promise<void> {
  const jar = zipSync({
    "com/example/SingleCaseFixture.class": buildClassFile({
      className: "com.example.SingleCaseFixture",
      methods: [{ name: "runsOnce", annotations: [{ type: "Test", values: {} }] }],
    }),
  });
  await page.goto(
    `/cases/import?${new URLSearchParams({
      projectId: project.id,
      projectVersionId: project.versionId,
      testStageId: project.stageId,
    }).toString()}`,
  );
  await page.getByLabel("导入项目").selectOption({ label: project.name });
  await page.locator('input[type="file"]').setInputFiles({
    name: "single-case-fixture.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText("com.example.SingleCaseFixture")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/u, {
    timeout: 60_000,
  });
}

async function registerRunner(page: Page): Promise<{ runnerId: string; credential: string }> {
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: "E2E Single Case Runner",
      labels: ["linux", "java", "testng"],
      capabilities: runnerCapabilities,
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.7.2",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const runner = (await registration.json()) as { runnerId: string; credential: string };
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(runner.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${runner.credential}` },
      data: {
        schemaVersion: 1,
        busySlots: 0,
        labels: ["linux", "java", "testng"],
        capabilities: runnerCapabilities,
        maxConcurrency: 2,
        agentVersion: "0.7.2",
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
  return runner;
}
