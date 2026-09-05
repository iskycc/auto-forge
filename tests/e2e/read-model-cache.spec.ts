import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import {
  browserJson,
  ensureAdministrator,
  login,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("large pages reuse browser and database snapshots and refresh after imports", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const name = uniqueName("snapshot");
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name, slug: name },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions`,
    { method: "POST", body: { name: "快照验收版本" } },
  );
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "回归测试" } },
  );
  const scope = {
    projectId: project.body.id,
    projectVersionId: version.body.id,
    testStageId: stage.body.id,
  };
  await selectProjectContext(page, scope.projectId, scope.projectVersionId, scope.testStageId);
  await importCases(page, scope, 0, 501);
  let chunkReads = 0;
  let casePageReads = 0;
  let snapshotId = "";
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/read-models/") && url.pathname.endsWith("/parts")) {
      chunkReads += 1;
      snapshotId = url.pathname.split("/")[4]!;
    }
    if (url.pathname === "/cases" && request.headers().rsc === "1") casePageReads += 1;
  });
  await page.goto("/cases");
  await expect(page.locator(".case-directory-tree")).toContainText("501 个用例", {
    timeout: 30_000,
  });
  await expect(page.getByText(/正在载入用例目录/)).toHaveCount(0);
  expect(chunkReads).toBe(3);
  await page.locator(".case-directory-tree").getByText("cache", { exact: true }).click();
  await page.locator(".case-directory-tree").getByText("fixture", { exact: true }).click();
  await expect(page.locator(".case-directory-tree")).toContainText("Snapshot0000Test");
  const status = await browserJson<{ items: Array<{ generation: string; state: string }> }>(
    page,
    `/api/v1/read-models/status?ids=${snapshotId}`,
  );
  expect(status.body.items[0]?.state).toBe("ready");
  await page.screenshot({ path: testInfo.outputPath("cases-1536.png"), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectUiIntegrity(page);
  await page.screenshot({ path: testInfo.outputPath("cases-1024.png"), fullPage: true });
  await page.setViewportSize({ width: 1536, height: 1024 });

  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("link", { name: "工作概览", exact: true }).click();
  await expect(page.getByRole("region", { name: "工作台概览" })).toBeVisible();
  await expect(page.locator(".read-model-status")).toContainText("数据更新于", { timeout: 30_000 });
  await expect(page.locator(".dashboard-library-overview > span > strong")).toHaveText("501");
  await page.screenshot({ path: testInfo.outputPath("overview-1536.png"), fullPage: true });
  await nav.getByRole("link", { name: "质量洞察", exact: true }).click();
  await expect(page.getByRole("heading", { name: "批次对比", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expectUiIntegrity(page);
  await page.screenshot({ path: testInfo.outputPath("insights-1536.png"), fullPage: true });
  const previousChunkReads = chunkReads;
  await nav.getByRole("link", { name: "用例管理", exact: true }).click();
  await expect(page.locator(".case-directory-tree")).toContainText("501 个用例");
  expect(chunkReads).toBe(previousChunkReads);
  // The first publication of a cold projection refreshes the current RSC route.
  // Once both routes are warm, normal navigation must not request either page again.
  await nav.getByRole("link", { name: "质量洞察", exact: true }).click();
  await expect(page.getByRole("heading", { name: "批次对比", exact: true })).toBeVisible();
  const previousPageReads = casePageReads;
  await nav.getByRole("link", { name: "用例管理", exact: true }).click();
  await expect(page.locator(".case-directory-tree")).toContainText("501 个用例");
  expect(casePageReads).toBe(previousPageReads);
  expect(chunkReads).toBe(previousChunkReads);
  await page.reload();
  await expect(page.locator(".case-directory-tree")).toContainText("501 个用例");
  const afterReload = await browserJson<{ items: Array<{ generation: string }> }>(
    page,
    `/api/v1/read-models/status?ids=${snapshotId}`,
  );
  expect(afterReload.body.items[0]?.generation).toBe(status.body.items[0]?.generation);

  await importCases(page, scope, 501, 1);
  await expect
    .poll(
      async () => {
        const current = await browserJson<{ items: Array<{ generation: string; state: string }> }>(
          page,
          `/api/v1/read-models/status?ids=${snapshotId}`,
        );
        return (
          current.body.items[0]?.state === "ready" &&
          current.body.items[0]?.generation !== status.body.items[0]?.generation
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.locator(".toast-viewport")).toContainText("已请求后台更新");
  await expect(page.getByText(/后台更新暂未完成/)).toHaveCount(0);
  await expect(page.locator(".case-directory-tree")).toContainText("502 个用例", {
    timeout: 30_000,
  });

  // A slow first dashboard snapshot must leave DDT list controls usable.
  let releaseDashboard: () => void = () => undefined;
  const dashboardGate = new Promise<void>((resolve) => {
    releaseDashboard = resolve;
  });
  await page.route("**/api/v1/ddt/dashboard?**", async (route) => {
    await dashboardGate;
    await route.continue();
  });
  try {
    await page.getByRole("link", { name: "DDT 管理", exact: true }).click();
    await page.getByRole("tab", { name: "用例", exact: true }).click();
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(page.getByText("正在加载 DDT 工作台", { exact: true })).toHaveCount(0);
  } finally {
    releaseDashboard();
    await page.unrouteAll({ behavior: "wait" });
  }

  const otherProject = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: `${name}-other`, slug: `${name}-other` },
  });
  const username = uniqueName("snapshot-viewer");
  const password = "SnapshotViewer!12345";
  const user = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: username, password, forcePasswordChange: false },
  });
  expect(user.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/users/${user.body.id}/project-roles`, {
        method: "POST",
        body: { projectId: otherProject.body.id, roleId: "00000000-0000-7000-8100-000000000005" },
      })
    ).status,
  ).toBe(204);
  const restricted = await page
    .context()
    .browser()!
    .newContext({ baseURL: new URL(page.url()).origin });
  try {
    const restrictedPage = await restricted.newPage();
    await login(restrictedPage, username, password);
    const deniedStatus = await restricted.request.get(
      `/api/v1/read-models/status?ids=${snapshotId}`,
    );
    expect(deniedStatus.status()).toBe(403);
    const deniedPart = await restricted.request.get(
      `/api/v1/read-models/${snapshotId}/parts?generation=${status.body.items[0]!.generation}&ordinal=0`,
    );
    expect(deniedPart.status()).toBe(403);
  } finally {
    await restricted.close();
  }

  const anonymous = await page.context().browser()!.newContext();
  try {
    const response = await anonymous.request.get(
      new URL(`/api/v1/read-models/status?ids=${snapshotId}`, page.url()).toString(),
    );
    expect(response.status()).toBe(401);
  } finally {
    await anonymous.close();
  }
  // Task configuration is usable before its separately cached member directory arrives.
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: {
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      name: "缓存验收任务",
    },
  });
  expect(suite.status).toBe(201);
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ ...scope, limit: "100", ...(cursor ? { cursor } : {}) });
    const result = await browserJson<{ items: Array<{ id: string }>; nextCursor?: string }>(
      page,
      `/api/v1/case-definitions?${query}`,
    );
    expect(result.status).toBe(200);
    ids.push(...result.body.items.map((item) => item.id));
    cursor = result.body.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(502);
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
        method: "POST",
        body: { caseDefinitionIds: ids },
      })
    ).status,
  ).toBe(200);
  const suiteParts: Array<Promise<number>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/parts"))
      suiteParts.push(
        response
          .json()
          .then((payload) => (Array.isArray(payload.ddtItems) ? payload.items.length : 0)),
      );
  });
  const document = await page.goto(`/case-suites/${suite.body.id}`);
  const initialHtml = await document!.text();
  expect(initialHtml).not.toContain('"className":"cache.fixture.Snapshot0000Test"');
  await expect(page.getByLabel("任务名称")).toHaveValue("缓存验收任务");
  await expect(page.locator(".suite-ordinary-tree-section")).toContainText("502", {
    timeout: 30_000,
  });
  expect((await Promise.all(suiteParts)).filter(Boolean).sort((a, b) => a - b)).toEqual([
    2, 250, 250,
  ]);
  await expectUiIntegrity(page);
  await page.screenshot({ path: testInfo.outputPath("suite-1536.png"), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectUiIntegrity(page);
  await page.screenshot({ path: testInfo.outputPath("suite-1024.png"), fullPage: true });
});

async function importCases(
  page: Page,
  scope: { projectId: string; projectVersionId: string; testStageId: string },
  start: number,
  count: number,
) {
  const entries = Object.fromEntries(
    Array.from({ length: count }, (_, offset) => {
      const className = `cache.fixture.Snapshot${String(start + offset).padStart(4, "0")}Test`;
      return [
        `${className.replaceAll(".", "/")}.class`,
        buildClassFile({
          className,
          methods: [{ name: "verify", annotations: [{ type: "Test", values: {} }] }],
        }),
      ];
    }),
  );
  const response = await page.request.post(
    `/api/v1/case-sources/jar/import?${new URLSearchParams(scope)}`,
    {
      headers: { origin: new URL(page.url()).origin },
      multipart: {
        file: {
          name: `snapshot-${start}.jar`,
          mimeType: "application/java-archive",
          buffer: Buffer.from(zipSync(entries)),
        },
      },
    },
  );
  expect(response.status()).toBe(202);
  const job = (await response.json()) as { id: string };
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`/api/v1/case-sources/jar/imports/${job.id}`)).json()) as {
            status: string;
          }
        ).status,
      { timeout: 60_000 },
    )
    .toBe("succeeded");
}
