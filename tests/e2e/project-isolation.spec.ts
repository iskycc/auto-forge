import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { browserJson, ensureAdministrator, login, logout, uniqueName } from "./support/session";

const VIEWER_ROLE_ID = "00000000-0000-7000-8100-000000000005";

test("project member cannot observe another project's assets through pages or direct IDs", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await ensureAdministrator(page);
  const suffix = uniqueName("isolation");
  const projectA = await createProject(page, `Project A ${suffix}`, `project-a-${suffix}`);
  const projectB = await createProject(page, `Project B ${suffix}`, `project-b-${suffix}`);
  const username = uniqueName("project-a-viewer");
  const password = "ProjectViewer!Password123";
  const user = await createUser(page, username, password);
  expect(
    (
      await browserJson(page, `/api/v1/users/${user.id}/project-roles`, {
        method: "POST",
        body: { projectId: projectA.id, roleId: VIEWER_ROLE_ID },
      })
    ).status,
  ).toBe(204);

  const classA = `com.example.ProjectA${Date.now()}Test`;
  const classB = `com.example.ProjectB${Date.now()}Test`;
  await importJar(page, projectA.id, projectA.name, classA, `project-a-${suffix}.jar`);
  await importJar(page, projectB.id, projectB.name, classB, `project-b-${suffix}.jar`);

  const casesA = await browserJson<{ items: Array<{ id: string; sourceId: string }> }>(
    page,
    `/api/v1/case-definitions?projectId=${projectA.id}`,
  );
  const casesB = await browserJson<{ items: Array<{ id: string; sourceId: string }> }>(
    page,
    `/api/v1/case-definitions?projectId=${projectB.id}`,
  );
  const caseA = casesA.body.items.at(-1)!;
  const caseB = casesB.body.items.at(-1)!;
  const sourceA = (
    await browserJson<{ items: Array<{ id: string; objectKey: string }> }>(
      page,
      `/api/v1/case-sources?projectId=${projectA.id}`,
    )
  ).body.items.at(-1)!;
  const sourceB = (
    await browserJson<{ items: Array<{ id: string; objectKey: string }> }>(
      page,
      `/api/v1/case-sources?projectId=${projectB.id}`,
    )
  ).body.items.at(-1)!;
  const suiteA = await createSuite(page, projectA.id, `Suite A ${suffix}`);
  const suiteB = await createSuite(page, projectB.id, `Suite B ${suffix}`);
  await addCaseToSuite(page, suiteA.id, caseA.id);
  await addCaseToSuite(page, suiteB.id, caseB.id);
  const environmentA = await createEnvironment(page, projectA.id, `Environment A ${suffix}`);
  const environmentB = await createEnvironment(page, projectB.id, `Environment B ${suffix}`);
  const secretA = await createSecret(page, projectA.id, `Secret A ${suffix}`);
  const secretB = await createSecret(page, projectB.id, `Secret B ${suffix}`);
  const runnerId = await registerRunner(page, suffix);
  const batchA = await createBatch(page, projectA.id, suiteA.id, runnerId);
  const batchB = await createBatch(page, projectB.id, suiteB.id, runnerId);

  await logout(page);
  await login(page, username, password);

  await page.goto("/cases");
  await expect(page.getByText(classA)).toBeVisible();
  await expect(page.getByText(classB)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "导入 JAR" })).toHaveCount(0);
  await expect(page.getByLabel("选择本页全部用例")).toHaveCount(0);
  await page.goto("/objects");
  await expect(page.getByRole("link", { name: sourceA.objectKey, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: sourceB.objectKey, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "导入 JAR" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "设为全量来源" })).toHaveCount(0);
  await page.goto(`/case-sources/${sourceA.id}`);
  await expect(page.getByRole("button", { name: "归档来源" })).toHaveCount(0);
  await page.goto("/case-suites");
  await expect(page.getByRole("link", { name: suiteA.name })).toBeVisible();
  await expect(page.getByRole("link", { name: suiteB.name })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建任务" })).toHaveCount(0);
  await page.getByRole("link", { name: suiteA.name }).click();
  await expect(page.getByRole("link", { name: "添加用例" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "移除" })).toHaveCount(0);
  await page.goto("/settings/environments");
  await expect(page.getByRole("heading", { name: environmentA.name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: environmentB.name, exact: true })).toHaveCount(0);
  await page.goto("/run-batches");
  const suiteOptions = await page.getByLabel("用例任务").last().locator("option").allTextContents();
  expect(suiteOptions.some((option) => option.includes(suiteA.name))).toBe(true);
  expect(suiteOptions.some((option) => option.includes(suiteB.name))).toBe(false);
  await expect(page.getByRole("button", { name: "开始调度" })).toHaveCount(0);

  await expectForbidden(page, `/api/v1/case-definitions?projectId=${projectB.id}`);
  await expectNotFoundOrForbidden(page, `/api/v1/case-definitions/${caseB.id}`);
  await expectNotFoundOrForbidden(page, `/api/v1/case-sources/${sourceB.id}`);
  await expectForbidden(page, `/api/v1/case-suites?projectId=${projectB.id}`);
  await expectNotFoundOrForbidden(page, `/api/v1/case-suites/${suiteB.id}`);
  await expectNotFoundOrForbidden(page, `/api/v1/execution-environments/${environmentB.id}`);
  await expectNotFoundOrForbidden(page, `/api/v1/execution-secrets/${secretB.id}`);
  await expectNotFoundOrForbidden(page, `/api/v1/run-batches/${batchB.id}`);
  const forbiddenAnalytics = await browserJson<{ error?: { code?: string } }>(
    page,
    `/api/v1/analytics?projectId=${projectB.id}`,
  );
  expect(forbiddenAnalytics.status).toBe(403);
  expect(forbiddenAnalytics.body.error?.code).toBe("AUTH_FORBIDDEN");

  const hiddenSearch = await browserJson<{ items: Array<{ projectId?: string; title: string }> }>(
    page,
    `/api/v1/search?query=${encodeURIComponent(classB)}`,
  );
  expect(hiddenSearch.status).toBe(200);
  expect(hiddenSearch.body.items).toHaveLength(0);
  const visibleSearch = await browserJson<{
    items: Array<{ projectId?: string; title: string }>;
  }>(page, `/api/v1/search?query=${encodeURIComponent(classA)}`);
  expect(visibleSearch.body.items).toContainEqual(
    expect.objectContaining({ projectId: projectA.id }),
  );

  const visibleObjects = await browserJson<{
    items: Array<{ objectKey: string }>;
  }>(page, "/api/v1/objects?limit=200");
  expect(visibleObjects.status).toBe(200);
  expect(visibleObjects.body.items.map((item) => item.objectKey)).toContain(sourceA.objectKey);
  expect(visibleObjects.body.items.map((item) => item.objectKey)).not.toContain(sourceB.objectKey);
  const visibleEnvironments = await browserJson<{
    items: Array<{ id: string }>;
  }>(page, "/api/v1/execution-environments");
  expect(visibleEnvironments.body.items.map((item) => item.id)).toContain(environmentA.id);
  expect(visibleEnvironments.body.items.map((item) => item.id)).not.toContain(environmentB.id);
  const visibleBatches = await browserJson<{ items: Array<{ id: string; projectId: string }> }>(
    page,
    "/api/v1/run-batches?limit=200",
  );
  expect(visibleBatches.body.items.map((item) => item.id)).toContain(batchA.id);
  expect(visibleBatches.body.items.map((item) => item.id)).not.toContain(batchB.id);
  expect(caseA.sourceId).toBe(sourceA.id);

  await logout(page);
  await login(page, "e2e-admin", "E2e!Administrator123");
  const owner = await createUser(page, uniqueName("transferred-owner"), "Owner!Password12345");
  const transfer = await browserJson(page, `/api/v1/projects/${projectA.id}/owner`, {
    method: "POST",
    body: { ownerUserId: owner.id },
  });
  expect(transfer.status).toBe(200);
  const removalStatus = await page.evaluate(
    async (path) =>
      (
        await fetch(path, {
          method: "DELETE",
        })
      ).status,
    `/api/v1/users/${user.id}/project-roles/${projectA.id}/${VIEWER_ROLE_ID}`,
  );
  expect(removalStatus).toBe(204);
  const archive = await browserJson(page, `/api/v1/projects/${projectA.id}`, {
    method: "DELETE",
  });
  expect(archive.status).toBe(200);

  await logout(page);
  await login(page, username, password);
  await expectNotFoundOrForbidden(page, `/api/v1/case-definitions/${caseA.id}`);
  await expectNotFoundOrForbidden(page, `/api/v1/run-batches/${batchA.id}`);

  await logout(page);
  await login(page, "e2e-admin", "E2e!Administrator123");
  const historicalCase = await browserJson<{ projectId: string }>(
    page,
    `/api/v1/case-definitions/${caseA.id}`,
  );
  expect(historicalCase.body.projectId).toBe(projectA.id);
  const transferAudit = await browserJson<{
    items: Array<{ action: string; resourceId?: string; projectId?: string }>;
  }>(page, `/api/v1/audit-events?action=project.transfer_owner&limit=20`);
  expect(transferAudit.body.items).toContainEqual(
    expect.objectContaining({ resourceId: projectA.id, projectId: projectA.id }),
  );
  const archiveAudit = await browserJson<{
    items: Array<{ action: string; resourceId?: string; projectId?: string }>;
  }>(page, `/api/v1/audit-events?action=project.archive&limit=20`);
  expect(archiveAudit.body.items).toContainEqual(
    expect.objectContaining({ resourceId: projectA.id, projectId: projectA.id }),
  );
  expect(secretA.id).toBeTruthy();
});

async function createProject(page: Page, name: string, slug: string) {
  const response = await browserJson<{ id: string; name: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name, slug },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function createUser(page: Page, username: string, password: string) {
  const response = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: {
      username,
      displayName: username,
      password,
      forcePasswordChange: false,
    },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function createSuite(page: Page, projectId: string, name: string) {
  const response = await browserJson<{ id: string; name: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId, name },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function createEnvironment(page: Page, projectId: string, name: string) {
  const response = await browserJson<{ id: string; name: string }>(
    page,
    "/api/v1/execution-environments",
    {
      method: "POST",
      body: {
        projectId,
        name,
        description: "Project isolation fixture",
        variables: [{ name: "PROJECT_MARKER", value: projectId }],
        secretBindings: [],
      },
    },
  );
  expect(response.status).toBe(201);
  return response.body;
}

async function createSecret(page: Page, projectId: string, name: string) {
  const response = await browserJson<{ id: string }>(page, "/api/v1/execution-secrets", {
    method: "POST",
    body: {
      projectId,
      name,
      description: "Project isolation secret fixture",
      value: `isolated-${projectId}`,
    },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function addCaseToSuite(
  page: Page,
  suiteId: string,
  caseDefinitionId: string,
): Promise<void> {
  const response = await browserJson(page, `/api/v1/case-suites/${suiteId}/cases`, {
    method: "POST",
    body: { caseDefinitionIds: [caseDefinitionId] },
  });
  expect(response.status).toBe(200);
}

async function registerRunner(page: Page, suffix: string): Promise<string> {
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: `Isolation Runner ${suffix}`,
      labels: ["linux", "java", "testng", "isolation"],
      capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
      maxConcurrency: 4,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.3.3-e2e",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const identity = (await registration.json()) as { runnerId: string; credential: string };
  const heartbeat = await page.request.post(
    `/api/v1/runner-agents/${encodeURIComponent(identity.runnerId)}/heartbeat`,
    {
      headers: { authorization: `Bearer ${identity.credential}` },
      data: {
        schemaVersion: 1,
        busySlots: 0,
        labels: ["linux", "java", "testng", "isolation"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 4,
        agentVersion: "0.3.3-e2e",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 5,
          memoryUtilizationPercent: 10,
          loadAverage1m: 0.1,
          logicalCpuCount: 4,
          observedAt: new Date().toISOString(),
        },
      },
    },
  );
  expect(heartbeat.status()).toBe(200);
  return identity.runnerId;
}

async function createBatch(page: Page, projectId: string, suiteId: string, runnerId: string) {
  const response = await browserJson<{ id: string }>(page, "/api/v1/run-batches", {
    method: "POST",
    body: {
      projectId,
      suiteId,
      runnerIds: [runnerId],
      retryLimit: 0,
      environmentVariables: [],
    },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function importJar(
  page: Page,
  projectId: string,
  projectName: string,
  className: string,
  fileName: string,
): Promise<void> {
  const jar = zipSync({
    [`${className.replaceAll(".", "/")}.class`]: buildClassFile({
      className,
      methods: [{ name: "isolated", annotations: [{ type: "Test", values: {} }] }],
    }),
  });
  await page.goto(`/cases/import?projectId=${projectId}`);
  await page.getByLabel("导入项目").selectOption({ label: projectName });
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();
  await expect(page.getByText(className)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/, {
    timeout: 60_000,
  });
}

async function expectForbidden(page: Page, path: string): Promise<void> {
  const response = await browserJson<{ error?: { code?: string } }>(page, path);
  expect(response.status).toBe(403);
  expect(response.body.error?.code).toBe("AUTH_FORBIDDEN");
}

async function expectNotFoundOrForbidden(page: Page, path: string): Promise<void> {
  const response = await browserJson<{ error?: { code?: string } }>(page, path);
  expect([403, 404]).toContain(response.status);
}
