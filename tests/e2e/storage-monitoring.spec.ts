import { expect, test } from "@playwright/test";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { browserJson, ensureAdministrator } from "./support/session";
import { expectUiIntegrity, waitForUiTransitions } from "./support/ui-guard";

test("standard exporter monitors primary and log volumes with independent persisted configuration", async ({
  page,
}, testInfo) => {
  const directory =
    process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("E2E directory required");
  test.skip(
    new PlatformConfigurationStore(directory).read().mode !== "full",
    "Remote volume monitoring is Full infrastructure.",
  );
  test.skip(
    !process.env.AUTOFORGE_TEST_NODE_EXPORTER_PORT,
    "Use a real Node Exporter with the PostgreSQL data directory mounted at /pgdata.",
  );
  await ensureAdministrator(page);
  const port = process.env.AUTOFORGE_TEST_NODE_EXPORTER_PORT!;
  const source = { host: "127.0.0.1", port: Number(port), tls: false, mountpoint: "/pgdata" };
  const logs = await browserJson<{ activeDatabaseId: string }>(
    page,
    "/api/v1/settings/log-databases",
  );
  const databaseId = logs.body.activeDatabaseId;
  expect(databaseId).toBeTruthy();
  const originalLogMonitoring = await browserJson<{ source: typeof source | null }>(
    page,
    `/api/v1/settings/storage-monitoring?kind=logs&databaseId=${databaseId}`,
  );
  await page.goto("/system-info");
  await page.getByRole("button", { name: "查看数据库使用详情", exact: true }).click();
  const usage = page.getByRole("dialog", { name: "数据库使用详情", exact: true });
  await usage.getByRole("button", { name: "配置磁盘监控", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "配置磁盘监控", exact: true });
  await editor.getByRole("checkbox", { name: "启用 Node Exporter 磁盘监控" }).check();
  await expect(editor.getByRole("button", { name: "检查连接", exact: true })).toBeEnabled();
  await editor.getByLabel("监控 IP / 主机名", { exact: true }).fill(source.host);
  await editor.getByLabel("监控端口", { exact: true }).fill(port);
  await editor.getByLabel("数据卷挂载点", { exact: true }).fill("/not-the-database");
  await editor.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("无法读取数据卷指标");
  await editor.getByLabel("数据卷挂载点", { exact: true }).fill(source.mountpoint);
  await editor.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("连接成功");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await waitForUiTransitions(page);
    await expectUiIntegrity(page);
    await page.screenshot({
      path: testInfo.outputPath(`monitoring-configuration-${width}.png`),
      animations: "disabled",
    });
  }
  await editor.getByRole("button", { name: "保存监控配置", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(usage).toContainText("当前可用空间");
  const first = await browserJson<{ source: typeof source; revision: number }>(
    page,
    "/api/v1/settings/storage-monitoring?kind=primary",
  );
  expect(first.status).toBe(200);
  expect(first.body.source).toEqual(source);
  expect(
    (
      await browserJson(page, "/api/v1/settings/storage-monitoring", {
        method: "PUT",
        body: { target: { kind: "primary" }, source: null, revision: first.body.revision - 1 },
      })
    ).status,
  ).toBe(409);
  await usage.getByRole("button", { name: "关闭数据库使用详情", exact: true }).click();
  const before = await browserJson<{ source: typeof source | null }>(
    page,
    `/api/v1/settings/storage-monitoring?kind=logs&databaseId=${databaseId}`,
  );
  expect(before.body.source).toEqual(originalLogMonitoring.body.source);
  await page.goto("/logs?section=databases");
  const card = page.locator(".ant-card").filter({ hasText: databaseId });
  await card.getByRole("button", { name: "查看容量", exact: true }).click();
  const capacity = page.getByRole("dialog", { name: "日志库磁盘容量", exact: true });
  await capacity.getByRole("button", { name: "配置磁盘监控", exact: true }).click();
  await editor.getByRole("checkbox", { name: "启用 Node Exporter 磁盘监控" }).check();
  await expect(editor.getByRole("button", { name: "检查连接", exact: true })).toBeEnabled();
  await editor.getByLabel("监控 IP / 主机名", { exact: true }).fill(source.host);
  await editor.getByLabel("监控端口", { exact: true }).fill(port);
  await editor.getByLabel("数据卷挂载点", { exact: true }).fill(source.mountpoint);
  await editor.getByRole("button", { name: "检查连接", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("连接成功");
  await editor.getByRole("button", { name: "保存监控配置", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(capacity).toContainText("当前可用空间");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await waitForUiTransitions(page);
    await expectUiIntegrity(page);
    await page.screenshot({
      path: testInfo.outputPath(`log-volume-monitoring-${width}.png`),
      animations: "disabled",
    });
  }
  await capacity.getByRole("button", { name: "关闭日志库磁盘容量", exact: true }).click();
  await page.reload();
  expect(
    (
      await browserJson<{ source: typeof source }>(
        page,
        `/api/v1/settings/storage-monitoring?kind=logs&databaseId=${databaseId}`,
      )
    ).body.source,
  ).toEqual(source);
  expect(
    (
      await browserJson<{ source: typeof source }>(
        page,
        "/api/v1/settings/storage-monitoring?kind=primary",
      )
    ).body.source,
  ).toEqual(source);
  expect((await page.request.get("/api/v1/health/ready")).status()).toBe(200);
});

test("Lite keeps local disk information without requiring a monitoring component", async ({
  page,
}) => {
  const directory =
    process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("E2E directory required");
  test.skip(
    new PlatformConfigurationStore(directory).read().mode !== "lite",
    "Lite compatibility.",
  );
  await ensureAdministrator(page);
  expect(
    (await page.request.get("/api/v1/settings/storage-monitoring?kind=primary")).status(),
  ).toBe(400);
  await page.goto("/system-info");
  await page.getByRole("button", { name: "查看数据库使用详情", exact: true }).click();
  const usage = page.getByRole("dialog", { name: "数据库使用详情", exact: true });
  await expect(usage).toContainText("SQLite");
  await expect(usage.getByRole("button", { name: "配置磁盘监控", exact: true })).toHaveCount(0);
});
