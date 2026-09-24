import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { ensureAdministrator, uniqueName } from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

// Exercise real heartbeat storage and the read-only dialog, including recovery.
test("Runner telemetry shows resource samples, handles empty history and retries read errors", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  const name = uniqueName("资源监控节点");
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name,
      labels: ["机房 A", "TestNG"],
      capabilities: ["executor:process"],
      maxConcurrency: 8,
      os: "linux",
      architecture: "amd64",
      agentVersion: "1.18.1",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const { runnerId, credential } = (await registration.json()) as {
    runnerId: string;
    credential: string;
  };
  const endpoint = `/api/v1/runners/${runnerId}/telemetry`;
  const anonymous = await browser.newContext({ baseURL: "http://127.0.0.1:3100" });
  try {
    expect((await anonymous.request.get(endpoint)).status()).toBe(401);
  } finally {
    await anonymous.close();
  }
  await page.goto(`/runners?query=${encodeURIComponent(name)}`);
  const entry = page.getByRole("button", { name: `查看 ${name} 的资源监控`, exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: `${name} · 资源监控`, exact: true });
  await expect(dialog).toContainText("暂无资源历史");
  const heartbeat = await page.request.post(`/api/v1/runner-agents/${runnerId}/heartbeat`, {
    headers: { authorization: `Bearer ${credential}` },
    data: {
      schemaVersion: 1,
      busySlots: 3,
      labels: ["机房 A", "TestNG"],
      capabilities: ["executor:process"],
      maxConcurrency: 8,
      agentVersion: "1.18.1",
      terminalEnabled: false,
      resourceSnapshot: {
        cpuUtilizationPercent: 37.5,
        memoryUtilizationPercent: 62.5,
        loadAverage1m: 2.4,
        logicalCpuCount: 8,
        observedAt: "2000-01-01T00:00:00.000Z",
      },
    },
  });
  expect(heartbeat.status()).toBe(200);
  const stored = await (await page.request.get(endpoint)).json();
  expect(stored.samples).toHaveLength(1);
  expect(stored.samples[0]).toMatchObject({
    cpuUtilizationPercent: 37.5,
    busySlots: 3,
    logicalCpuCount: 8,
  });
  expect(stored.samples[0].observedAt).not.toBe("2000-01-01T00:00:00.000Z");
  await dialog.getByRole("button", { name: "刷新监控" }).click();
  await expect(dialog.getByRole("img", { name: /CPU \/ 内存使用率/ })).toBeVisible();
  await expect(dialog).toContainText("37.5");
  const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (directory) await mkdir(directory, { recursive: true });
  for (const colorMode of ["light", "dark"]) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: colorMode, url: "http://127.0.0.1:3100" },
      ]);
    await page.reload();
    await entry.click();
    await expect(dialog.getByRole("img", { name: /执行槽位/ })).toBeVisible();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      if (directory)
        await page.screenshot({
          path: resolve(directory, `runner-telemetry-${colorMode}-${width}.png`),
        });
    }
  }
  await page.route(`**${endpoint}`, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "PLATFORM_BUSY",
          message: "资源监控暂时不可用，请重试。",
          requestId: "telemetry-e2e",
        },
      },
    }),
  );
  await dialog.getByRole("button", { name: "刷新监控" }).click();
  await expect(dialog.getByRole("alert")).toContainText("资源监控暂时不可用");
  await expect(dialog.getByRole("img", { name: /执行槽位/ })).toBeVisible();
  await page.unroute(`**${endpoint}`);
  await dialog.getByRole("button", { name: "刷新监控" }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: /^关闭/ }).click();
  await expect(dialog).toHaveCount(0);
});
