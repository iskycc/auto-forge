import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { ensureAdministrator, uniqueName } from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("Runner terminal sends function keys once and cancels browser actions only inside xterm", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const name = uniqueName("终端功能键节点");
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name,
      labels: [],
      capabilities: ["executor:process"],
      maxConcurrency: 1,
      os: "linux",
      architecture: "amd64",
      agentVersion: "1.19.5",
      protocolVersion: 1,
      terminalEnabled: true,
    },
  });
  expect(registration.status()).toBe(201);
  const receivedInput: string[] = [];
  await page.routeWebSocket("**/api/v1/terminal-stream", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; data?: string };
      if (message.type === "input" && message.data)
        receivedInput.push(Buffer.from(message.data, "base64").toString());
    });
    socket.send(JSON.stringify({ schemaVersion: 1, type: "ready" }));
  });
  await page.goto(`/runners?query=${encodeURIComponent(name)}`);
  const entry = page.getByRole("button", { name: "终端浮窗", exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: `${name} 直连终端` });
  await dialog.getByRole("button", { name: "连接终端", exact: true }).click();
  await expect(dialog.getByText("已连接", { exact: true })).toBeVisible();
  const input = dialog.locator(".xterm-helper-textarea");
  await expect(input).toBeFocused();
  const probe = await page.evaluateHandle(() => {
    const captured = {
      events: [] as KeyboardEvent[],
      bubbled: [] as string[],
    };
    const observe = (event: KeyboardEvent) => {
      if (!/^F(?:[1-9]|1[0-2])$/u.test(event.key)) return;
      captured.events.push(event);
    };
    for (const type of ["keydown", "keyup"] as const) {
      document.addEventListener(type, observe, true);
      document.addEventListener(type, (event) => {
        if (/^F(?:[1-9]|1[0-2])$/u.test(event.key)) captured.bubbled.push(event.key);
      });
    }
    return captured;
  });
  const keys = [
    ["F1", "\u001bOP"],
    ["F2", "\u001bOQ"],
    ["F3", "\u001bOR"],
    ["F4", "\u001bOS"],
    ["F5", "\u001b[15~"],
    ["F6", "\u001b[17~"],
    ["F7", "\u001b[18~"],
    ["F8", "\u001b[19~"],
    ["F9", "\u001b[20~"],
    ["F10", "\u001b[21~"],
    ["F11", "\u001b[23~"],
    ["F12", "\u001b[24~"],
    ["Shift+F5", "\u001b[15;2~"],
    ["Control+F5", "\u001b[15;5~"],
    ["Alt+F1", "\u001b[1;3P"],
    ["Control+Shift+F12", "\u001b[24;6~"],
  ] as const;
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") {
      await dialog.getByRole("button", { name: "关闭终端", exact: true }).click();
      await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
      await entry.click();
      await dialog.getByRole("button", { name: "连接终端", exact: true }).click();
      await expect(dialog.getByText("已连接", { exact: true })).toBeVisible();
      await expect(input).toBeFocused();
    }
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      for (const expanded of [false, true]) {
        if (expanded) {
          await dialog.getByRole("button", { name: "放大终端窗口", exact: true }).click();
          await input.focus();
        }
        for (const [key, sequence] of keys) {
          const previousInputCount = receivedInput.length;
          const previousEventCount = await probe.evaluate((captured) => captured.events.length);
          await page.keyboard.press(key);
          await expect.poll(() => receivedInput.slice(previousInputCount)).toEqual([sequence]);
          const functionKey = key.split("+").at(-1)!;
          expect(
            await probe.evaluate(
              (captured, count) =>
                captured.events.slice(count).map((event) => ({
                  key: event.key,
                  type: event.type,
                  prevented: event.defaultPrevented,
                })),
              previousEventCount,
            ),
          ).toEqual([
            { key: functionKey, type: "keydown", prevented: true },
            { key: functionKey, type: "keyup", prevented: true },
          ]);
          expect(await probe.evaluate((captured) => captured.bubbled)).toEqual([]);
          await expect(input).toBeFocused();
        }
        const previousInputCount = receivedInput.length;
        await page.keyboard.type("echo function-ready");
        await page.keyboard.press("Enter");
        await expect
          .poll(() => receivedInput.slice(previousInputCount).join(""))
          .toBe("echo function-ready\r");
        await expectUiIntegrity(page);
        await page.screenshot({
          path: test
            .info()
            .outputPath(
              `terminal-function-${theme}-${width}-${expanded ? "expanded" : "window"}.png`,
            ),
        });
        if (expanded) {
          await dialog.getByRole("button", { name: "还原终端窗口", exact: true }).click();
          await input.focus();
        }
      }
    }
  }
  expect(navigations).toBe(0);
  const previousInputCount = receivedInput.length;
  const close = dialog.getByRole("button", { name: "关闭终端", exact: true });
  await close.focus();
  const cancelledOnToolbar = await close.evaluate((button) => {
    const event = new KeyboardEvent("keydown", {
      key: "F3",
      code: "F3",
      keyCode: 114,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(cancelledOnToolbar).toBe(false);
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(entry).toBeFocused();
  expect(
    await entry.evaluate((button) => {
      const event = new KeyboardEvent("keydown", {
        key: "F5",
        code: "F5",
        keyCode: 116,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  expect(receivedInput).toHaveLength(previousInputCount);
  expect(await probe.evaluate((captured) => captured.bubbled)).toEqual(["F3", "F5"]);
  await probe.dispose();
});

test("Runner terminal keeps Tab input inside xterm while toolbar focus remains accessible", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const name = uniqueName("终端按键节点");
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name,
      labels: [],
      capabilities: ["executor:process"],
      maxConcurrency: 1,
      os: "linux",
      architecture: "amd64",
      agentVersion: "1.18.13",
      protocolVersion: 1,
      terminalEnabled: true,
    },
  });
  expect(registration.status()).toBe(201);
  const receivedInput: string[] = [];
  await page.routeWebSocket("**/api/v1/terminal-stream", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; data?: string };
      if (message.type === "input" && message.data)
        receivedInput.push(Buffer.from(message.data, "base64").toString());
    });
    socket.send(JSON.stringify({ schemaVersion: 1, type: "ready" }));
  });
  await page.goto(`/runners?query=${encodeURIComponent(name)}`);
  const entry = page.getByRole("button", { name: "终端浮窗", exact: true });
  const dialog = page.getByRole("dialog", { name: `${name} 直连终端` });
  const input = dialog.locator(".xterm-helper-textarea");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await entry.click();
    const connect = dialog.getByRole("button", { name: "连接终端", exact: true });
    const expand = dialog.getByRole("button", { name: "放大终端窗口", exact: true });
    // Keyboard events do not wait for Ant's opening motion and focus setup like clicks do.
    await expect(dialog).not.toHaveClass(/\bant-zoom-(?:appear|enter)\b/);
    await connect.focus();
    await expect(connect).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(expand).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(connect).toBeFocused();
    await connect.click();
    await expect(dialog.getByText("已连接", { exact: true })).toBeVisible();
    await expect(input).toBeFocused();
    for (const expanded of [false, true]) {
      if (expanded) {
        await expand.click();
        await input.focus();
      }
      for (let press = 0; press < 2; press += 1) {
        const previousCount = receivedInput.length;
        await page.keyboard.press("Tab");
        await expect.poll(() => receivedInput.slice(previousCount)).toEqual(["\t"]);
        await expect(input).toBeFocused();
      }
      await page.keyboard.type("echo tab-ready");
      await page.keyboard.press("Enter");
      await expect.poll(() => receivedInput.join("")).toContain("\t\techo tab-ready\r");
      const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await page.screenshot({
          path: resolve(directory, `terminal-tab-${width}-${expanded ? "expanded" : "window"}.png`),
        });
      }
    }
    await page.keyboard.press("Escape");
    await expect(expand).toBeVisible();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(entry).toBeFocused();
  }
});

test("Runner terminal initializes after the modal mounts and can reopen", async ({ page }) => {
  await ensureAdministrator(page);
  const name = uniqueName("终端初始化节点");
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name,
      labels: [],
      capabilities: ["executor:process"],
      maxConcurrency: 1,
      os: "linux",
      architecture: "amd64",
      agentVersion: "1.18.2",
      protocolVersion: 1,
      terminalEnabled: true,
    },
  });
  expect(registration.status()).toBe(201);
  await page.route("**/api/v1/terminal-sessions", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "RUNNER_OFFLINE",
          message: "测试终端网关暂时不可用，请重试。",
          requestId: "terminal-mount-e2e",
        },
      },
    }),
  );
  await page.goto(`/runners?query=${encodeURIComponent(name)}`);
  const entry = page.getByRole("button", { name: "终端浮窗", exact: true });
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await entry.click();
    const dialog = page.getByRole("dialog", { name: `${name} 直连终端` });
    await expect(dialog.locator(".xterm-screen")).toBeVisible();
    await dialog.getByRole("button", { name: "连接终端", exact: true }).click();
    await expect(dialog).toContainText("测试终端网关暂时不可用，请重试。");
    await expectUiIntegrity(page);
    const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: resolve(directory, `runner-terminal-${width}.png`) });
    }
    await dialog.getByRole("button", { name: "关闭终端", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});

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
