import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import { browserJson, ensureAdministrator, uniqueName } from "./support/session";

test("case metadata, immutable versions and suite policy survive lifecycle changes", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await ensureAdministrator(page);
  const suffix = uniqueName("lifecycle");
  const project = await createProject(page, suffix);
  const className = `com.example.Lifecycle${Date.now()}Test`;
  const initialSourceName = `${suffix}-v1.jar`;
  const candidateSourceName = `${suffix}-v2.jar`;
  await importJar(page, project, initialSourceName, className, ["createsVersion"]);
  await setAuthoritativeSource(page, project.id, initialSourceName);

  const definitions = await browserJson<{
    items: Array<{ id: string; className: string; revision: number }>;
  }>(
    page,
    `/api/v1/case-definitions?projectId=${encodeURIComponent(project.id)}&query=${encodeURIComponent(className)}`,
  );
  const definition = definitions.body.items.find((item) => item.className === className);
  expect(definition).toBeTruthy();

  const firstUpdate = await browserJson<{ revision: number }>(
    page,
    `/api/v1/case-definitions/${definition!.id}`,
    {
      method: "PATCH",
      body: {
        displayName: `Lifecycle display ${suffix}`,
        description: "first accepted metadata revision",
        tags: ["lifecycle", "accepted"],
        enabled: true,
        archived: false,
        expectedRevision: definition!.revision,
      },
    },
  );
  expect(firstUpdate.status).toBe(200);
  const staleUpdate = await browserJson<{ error?: { code?: string } }>(
    page,
    `/api/v1/case-definitions/${definition!.id}`,
    {
      method: "PATCH",
      body: {
        displayName: `Stale ${suffix}`,
        expectedRevision: definition!.revision,
      },
    },
  );
  expect(staleUpdate.status).toBe(409);
  expect(staleUpdate.body.error?.code).toMatch(/REVISION_CONFLICT/);

  await importJar(page, project, candidateSourceName, className, [
    "createsVersion",
    "browserAdded",
  ]);
  const sources = await browserJson<{
    items: Array<{ id: string; originalFileName: string }>;
  }>(page, `/api/v1/case-sources?projectId=${encodeURIComponent(project.id)}&limit=200`);
  const candidateSource = sources.body.items.find(
    (source) => source.originalFileName === candidateSourceName,
  );
  expect(candidateSource).toBeTruthy();
  await page.goto(`/case-sources/${encodeURIComponent(candidateSource!.id)}`);
  await page.getByRole("button", { name: "对比权威来源" }).click();
  await expect(page.getByText(/对比结果：新增 0、变更 1、消失 0、冲突 0/)).toBeVisible();
  await page.getByRole("button", { name: "确认同步为权威来源" }).click();
  await expect(page.getByText("已切换为权威来源。")).toBeVisible();

  await page.goto(`/cases/${encodeURIComponent(definition!.id)}`);
  await expect(page.getByRole("heading", { name: `Lifecycle display ${suffix}` })).toBeVisible();
  await page.getByLabel("标签（逗号分隔）").fill("lifecycle, browser-update");
  await page.getByLabel(/启用（禁用后/).uncheck();
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例已更新");
  await expect(page.getByText("版本历史（2）")).toBeVisible();
  await expect(
    page.locator(".version-diff-list").getByText(/方法新增：.*browserAdded/),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "从该版本创建" }).last().click();
  await expect(page.getByText("版本历史（3）")).toBeVisible();

  const suiteName = `Lifecycle suite ${suffix}`;
  const suite = await browserJson<{ id: string; revision: number }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId: project.id, name: suiteName, description: "lifecycle E2E suite" },
  });
  expect(suite.status).toBe(201);
  const addCase = await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
    method: "POST",
    body: { caseDefinitionIds: [definition!.id] },
  });
  expect(addCase.status).toBe(200);

  await page.goto(`/case-suites/${encodeURIComponent(suite.body.id)}`);
  await page.getByLabel("任务名称").fill(`${suiteName} updated`);
  await page.getByLabel("优先级（-100 到 100）").fill("42");
  await page.getByLabel("并发度（同时在途执行数）").fill("3");
  await page.getByLabel("重试次数上限").fill("2");
  await page.getByLabel("排队超时（分钟）").fill("7");
  await page.getByLabel("执行超时（分钟）").fill("11");
  await page.getByLabel("Runner 标签（逗号分隔）").fill("linux, lifecycle");
  await page.getByLabel("参数模板（每行一个 KEY=VALUE，用例参数优先）").fill("REGION=cn\nMODE=e2e");
  await page.getByLabel("产物规则（每行一个相对路径 glob）").fill("reports/**/*.xml");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例任务已更新");

  await page.getByLabel("Cron（分 时 日 月 周）").fill("17 8 * * 1-5");
  await page.getByLabel("IANA 时区").fill("Asia/Shanghai");
  await page.getByLabel("错过触发").selectOption("skip");
  await page.getByRole("button", { name: "保存计划" }).click();
  await expect(page.getByRole("status")).toContainText("计划触发已保存");

  const copyName = `${suiteName} copy`;
  await page.getByLabel("复制为新任务").fill(copyName);
  await page.getByRole("button", { name: "复制任务" }).click();
  await expect(page.getByRole("heading", { name: copyName })).toBeVisible();
  await expect(page.getByText("1 个用例")).toBeVisible();

  await page.goto(`/case-suites/${encodeURIComponent(suite.body.id)}`);
  await page.getByLabel(/启用（停用后/).uncheck();
  await page.getByLabel(/归档（保留历史记录/).check();
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toContainText("用例任务已更新");
  const disabledSuite = await browserJson<{
    enabled: boolean;
    status: string;
    policy: { priority: number; concurrency: number; retryLimit: number; parameters: unknown };
  }>(page, `/api/v1/case-suites/${suite.body.id}`);
  expect(disabledSuite.body).toMatchObject({
    enabled: false,
    status: "archived",
    policy: {
      priority: 42,
      concurrency: 3,
      retryLimit: 2,
      parameters: { REGION: "cn", MODE: "e2e" },
    },
  });

  const schedule = await browserJson<{
    items: Array<{ suiteId: string; missedRunPolicy: string }>;
  }>(page, "/api/v1/schedules");
  expect(schedule.body.items).toContainEqual(
    expect.objectContaining({ suiteId: suite.body.id, missedRunPolicy: "skip" }),
  );
});

test("source comparison, promotion, archive recovery and guarded deletion are observable", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureAdministrator(page);
  const suffix = uniqueName("source-lifecycle");
  const project = await createProject(page, suffix);
  const className = `com.example.SourceLifecycle${Date.now()}Test`;
  const originalName = `${suffix}-v1.jar`;
  const candidateName = `${suffix}-v2.jar`;
  await importJar(page, project, originalName, className, ["original"]);
  await setAuthoritativeSource(page, project.id, originalName);
  await importJar(page, project, candidateName, className, ["original", "addedByCandidate"]);

  const sources = await browserJson<{
    items: Array<{
      id: string;
      originalFileName: string;
      authoritative: boolean;
      lifecycleStatus: string;
      revision: number;
    }>;
  }>(page, `/api/v1/case-sources?projectId=${encodeURIComponent(project.id)}&limit=200`);
  const original = sources.body.items.find((source) => source.originalFileName === originalName);
  const candidate = sources.body.items.find((source) => source.originalFileName === candidateName);
  expect(original).toBeTruthy();
  expect(candidate).toBeTruthy();
  expect(original!.authoritative).toBe(true);
  expect(candidate!.authoritative).toBe(false);

  await page.goto(`/case-sources/${encodeURIComponent(candidate!.id)}`);
  await page.getByRole("button", { name: "归档来源" }).click();
  await expect(page.getByText("来源已归档。")).toBeVisible();
  await page.getByRole("button", { name: "恢复为活跃" }).click();
  await expect(page.getByText("来源已恢复为活跃状态。")).toBeVisible();
  await page.getByRole("button", { name: "对比权威来源" }).click();
  await expect(page.getByText(/对比结果：新增 0、变更 1、消失 0、冲突 0/)).toBeVisible();
  await page.getByRole("button", { name: "确认同步为权威来源" }).click();
  await expect(page.getByText("已切换为权威来源。")).toBeVisible();

  const promoted = await browserJson<{ source: { authoritative: boolean } }>(
    page,
    `/api/v1/case-sources/${candidate!.id}`,
  );
  expect(promoted.body.source.authoritative).toBe(true);
  const refreshedOriginal = await browserJson<{ source: { revision: number } }>(
    page,
    `/api/v1/case-sources/${original!.id}`,
  );
  const guardedDelete = await browserJson<{ error?: { code?: string } }>(
    page,
    `/api/v1/case-sources/${original!.id}`,
    { method: "DELETE", body: { expectedRevision: refreshedOriginal.body.source.revision } },
  );
  expect(guardedDelete.status).toBe(409);
  expect(guardedDelete.body.error?.code).toBe("CASE_SOURCE_IN_USE");
});

async function importJar(
  page: Page,
  project: { id: string; name: string },
  fileName: string,
  className: string,
  methodNames: string[],
): Promise<void> {
  const jar = zipSync({
    [`${className.replaceAll(".", "/")}.class`]: buildClassFile({
      className,
      methods: methodNames.map((name) => ({
        name,
        annotations: [{ type: "Test" as const, values: { groups: ["lifecycle"] } }],
      })),
    }),
  });
  await page.goto(`/cases/import?projectId=${encodeURIComponent(project.id)}`);
  await page.getByLabel("导入项目").selectOption({ label: project.name });
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

async function createProject(page: Page, suffix: string): Promise<{ id: string; name: string }> {
  const name = `Lifecycle project ${suffix}`;
  const response = await browserJson<{ id: string; name: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name, slug: `lifecycle-${suffix}` },
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function setAuthoritativeSource(
  page: Page,
  projectId: string,
  originalFileName: string,
): Promise<void> {
  const sources = await browserJson<{
    items: Array<{ id: string; originalFileName: string }>;
  }>(page, `/api/v1/case-sources?projectId=${encodeURIComponent(projectId)}&limit=200`);
  const source = sources.body.items.find(
    (candidate) => candidate.originalFileName === originalFileName,
  );
  expect(source).toBeTruthy();
  const result = await browserJson(page, `/api/v1/case-sources/${source!.id}/authoritative`, {
    method: "PUT",
    body: { authoritative: true },
  });
  expect(result.status).toBe(200);
}
