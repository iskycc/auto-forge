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
  const hydrationErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (/hydration|Minified React error/i.test(error.message)) hydrationErrors.push(error.message);
  });
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
  const branchBodies: Array<
    Promise<{ items: Array<{ methodCount?: number; methods?: unknown }> }>
  > = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/branches") && response.ok())
      branchBodies.push(response.json());
  });
  let chunkReads = 0;
  let casePageReads = 0;
  let snapshotId = "";
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/read-models/") && url.pathname.endsWith("/branches")) {
      chunkReads += 1;
      snapshotId = url.pathname.split("/")[4]!;
    }
    if (url.pathname === "/cases" && request.headers().rsc === "1") casePageReads += 1;
  });
  await page.goto("/cases");
  await expect(page.locator(".case-browser-summary")).toContainText("501 个用例", {
    timeout: 30_000,
  });
  await expect(page.locator(".case-directory-tree > .case-tree-children > details")).toHaveCount(1);
  await expect(page.locator(".case-tree-case")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "目录分页" })).toHaveCount(0);
  expect(chunkReads).toBe(1);
  const parent = page.locator(".case-directory-tree > .case-tree-children > details");
  await parent.locator(":scope > summary").click();
  await expect(parent.locator(":scope > .case-tree-children > details")).toHaveCount(1);
  await expect(page.locator(".case-tree-case")).toHaveCount(0);
  expect(chunkReads).toBe(2);
  const leaf = parent.locator(":scope > .case-tree-children > details");
  await leaf.locator(":scope > summary").click();
  await expect(page.locator(".case-tree-case")).toHaveCount(100);
  expect(chunkReads).toBe(3);
  const initialFiles = (await Promise.all(branchBodies)).flatMap((branch) => branch.items);
  expect(initialFiles).toHaveLength(100);
  expect(initialFiles.every((item) => item.methodCount === 1 && item.methods === undefined)).toBe(
    true,
  );
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

  const firstCheckbox = page.getByLabel("选择 Snapshot0000Test", { exact: true });
  await firstCheckbox.check();
  await leaf.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator(".case-tree-case")).toHaveCount(200);
  await page.getByLabel("选择 Snapshot0100Test", { exact: true }).check();
  await expect(page.getByLabel("已勾选用例的执行统计")).toContainText("已勾选 2 个用例");
  const afterExpansion = chunkReads;
  await leaf.locator(":scope > summary").click();
  await expect(page.locator(".case-tree-case")).toHaveCount(0);
  await leaf.locator(":scope > summary").click();
  await expect(page.locator(".case-tree-case")).toHaveCount(200);
  await expect(firstCheckbox).toBeChecked();
  expect(chunkReads).toBe(afterExpansion);
  await parent.locator(":scope > summary").click();
  await expect(page.locator(".case-tree-case")).toHaveCount(0);
  await parent.locator(":scope > summary").click();
  await expect(page.locator(".case-tree-case")).toHaveCount(100);
  await leaf.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator(".case-tree-case")).toHaveCount(200);
  expect(chunkReads).toBe(afterExpansion);
  await firstCheckbox.uncheck();
  await page.getByLabel("选择 Snapshot0100Test", { exact: true }).uncheck();
  await page.getByLabel("页内搜索用例", { exact: true }).fill("Snapshot0000Test");
  await expect(page.locator(".case-browser-summary")).toContainText("匹配 1 个", {
    timeout: 30_000,
  });
  await expect(page.locator(".case-tree-case")).toHaveCount(1);
  await page.getByRole("button", { name: "导入用例", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "导入用例", exact: true });
  await importDialog.getByLabel("粘贴用例路径").fill("cache.fixture.Snapshot0400Test");
  await importDialog.getByRole("button", { name: "解析并预览" }).click();
  await expect(importDialog.getByRole("status")).toContainText("匹配 1 个 · 未匹配 0 个");
  await importDialog.getByRole("button", { name: "勾选匹配用例" }).click();
  await expect(page.getByLabel("已勾选用例的执行统计")).toContainText("已勾选 1 个用例");
  await page.getByLabel("页内搜索用例", { exact: true }).fill("");
  await expect(page.locator(".case-browser-summary")).toContainText("501 个用例", {
    timeout: 30_000,
  });
  const selectAll = page.getByRole("checkbox", {
    name: "选择当前搜索结果中的全部用例",
    exact: true,
  });
  await selectAll.check();
  await expect(page.getByLabel("已勾选用例的执行统计")).toContainText("已勾选 501 个用例");
  await expect(selectAll).toBeChecked();
  await selectAll.uncheck();
  await expect(page.getByLabel("已勾选用例的执行统计")).toHaveCount(0);
  // Returning from a search preserves the directory expansion; explicitly close it for subtree selection.
  await expect(parent).toHaveAttribute("open", "");
  await parent.locator(":scope > summary").click();
  await expect(page.locator(".case-tree-case")).toHaveCount(0);
  // A closed folder still selects its complete subtree, without expanding it.
  const folderCheckbox = page.getByRole("checkbox", {
    name: "选择文件夹 cache（501 个用例）",
    exact: true,
  });
  await folderCheckbox.check();
  await expect(page.getByLabel("已勾选用例的执行统计")).toContainText("已勾选 501 个用例");
  await expect(page.locator(".case-tree-case")).toHaveCount(0);
  await folderCheckbox.uncheck();
  await expect(page.getByLabel("已勾选用例的执行统计")).toHaveCount(0);

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
  await nav.getByRole("link", { name: "执行节点", exact: true }).click();
  await expectUiIntegrity(page);
  const previousChunkReads = chunkReads;
  await nav.getByRole("link", { name: "用例管理", exact: true }).click();
  await expect(page.locator(".case-browser-summary")).toContainText("501 个用例");
  expect(chunkReads).toBe(previousChunkReads);
  // The first publication of a cold projection refreshes the current RSC route.
  // Once both routes are warm, normal navigation must not request either page again.
  await nav.getByRole("link", { name: "质量洞察", exact: true }).click();
  await expect(page.getByRole("heading", { name: "批次对比", exact: true })).toBeVisible();
  const previousPageReads = casePageReads;
  await nav.getByRole("link", { name: "用例管理", exact: true }).click();
  await expect(page.locator(".case-browser-summary")).toContainText("501 个用例");
  expect(casePageReads).toBe(previousPageReads);
  expect(chunkReads).toBe(previousChunkReads);
  await page.reload();
  await expect(page.locator(".case-browser-summary")).toContainText("501 个用例");
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
  await expect(page.locator(".case-browser-summary")).toContainText("502 个用例", {
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
    expect(
      (
        await restricted.request.get(
          `/api/v1/read-models/${snapshotId}/branches?generation=${status.body.items[0]!.generation}&ordinal=0`,
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await restricted.request.get(`/api/v1/read-models/${snapshotId}/directory?query=Snapshot`)
      ).status(),
    ).toBe(403);
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
  const oversized = await browserJson<{ error: { code: string } }>(
    page,
    `/api/v1/case-suites/${suite.body.id}`,
  );
  expect(oversized.status).toBe(413);
  expect(oversized.body.error.code).toBe("DETAIL_RESPONSE_TOO_LARGE");
  expect(
    (
      await browserJson<{ caseCount: number }>(
        page,
        `/api/v1/case-suites/${suite.body.id}?view=summary`,
      )
    ).body.caseCount,
  ).toBe(502);
  const membersPage = await browserJson<{
    items: Array<{ id: string }>;
    total: number;
    nextCursor: string;
  }>(page, `/api/v1/case-suites/${suite.body.id}/members`);
  expect(membersPage.status).toBe(200);
  expect(membersPage.body.items).toHaveLength(100);
  expect(membersPage.body.total).toBe(502);
  const nextMembers = await browserJson<{ items: Array<{ id: string }> }>(
    page,
    `/api/v1/case-suites/${suite.body.id}/members?cursor=${membersPage.body.nextCursor}`,
  );
  expect(nextMembers.body.items).toHaveLength(100);
  expect(
    new Set([...membersPage.body.items, ...nextMembers.body.items].map((item) => item.id)).size,
  ).toBe(200);
  const firstCase = await browserJson<{ items: Array<{ sourceId: string }> }>(
    page,
    `/api/v1/case-definitions?${new URLSearchParams({ ...scope, limit: "1", query: "Snapshot0000Test" })}`,
  );
  const sourceId = firstCase.body.items[0]!.sourceId;
  expect((await browserJson(page, `/api/v1/case-sources/${sourceId}`)).status).toBe(413);
  const sourcePage = await browserJson<{ items: unknown[]; total: number }>(
    page,
    `/api/v1/case-sources/${sourceId}/classes`,
  );
  expect(sourcePage.status).toBe(200);
  expect(sourcePage.body.items).toHaveLength(100);
  expect(sourcePage.body.total).toBe(501);
  const suiteParts: Array<Promise<number>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/branches"))
      suiteParts.push(
        response
          .json()
          .then((payload) =>
            payload.members ? payload.members.items.length + payload.members.ddtItems.length : 0,
          ),
      );
  });
  const document = await page.goto(`/case-suites/${suite.body.id}`);
  const initialHtml = await document!.text();
  expect(initialHtml).not.toContain('"className":"cache.fixture.Snapshot0000Test"');
  await expect(page.getByLabel("任务名称")).toHaveValue("缓存验收任务");
  await expect(page.getByRole("heading", { name: "502 个用例", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("checkbox", { name: "选择包 cache.fixture", exact: true }),
  ).toBeVisible();
  expect(await Promise.all(suiteParts)).toEqual([0]);
  await expect(page.locator(".suite-tree-case")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "选择包 cache.fixture", exact: true }).check();
  await expect(page.getByRole("button", { name: "批量移除（502）", exact: true })).toBeEnabled();
  await page.getByRole("checkbox", { name: "选择包 cache.fixture", exact: true }).uncheck();
  const packageSummary = page.locator(".suite-case-tree details > summary");
  await packageSummary.click();
  await expect(page.locator(".suite-tree-case")).toHaveCount(100);
  await packageSummary.click();
  await expect(page.locator(".suite-tree-case")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expectUiIntegrity(page);
  await page.screenshot({ path: testInfo.outputPath("suite-1536.png"), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectUiIntegrity(page);
  await page.screenshot({ path: testInfo.outputPath("suite-1024.png"), fullPage: true });
  expect(hydrationErrors).toEqual([]);

  await page.goto("/cases?query=Snapshot0000Test");
  const detailLink = page.getByRole("link", { name: "查看 Snapshot0000Test 详情", exact: true });
  await expect(detailLink).toBeVisible({ timeout: 30_000 });
  const detailPath = await detailLink.getAttribute("href");
  expect(detailPath).toBeTruthy();
  const clockStart = new Date();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  await page.getByLabel("页内搜索用例", { exact: true }).fill("Snapshot");
  // URL updates must finish in the input event, before a subsequent link can start navigation.
  expect(new URL(page.url()).searchParams.get("query")).toBe("Snapshot");
  await page.clock.resume();
  await detailLink.click();
  await expect(page).toHaveURL(detailPath!);
  await expect(page.getByRole("heading", { name: "全部执行历史", exact: true })).toBeVisible();
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
