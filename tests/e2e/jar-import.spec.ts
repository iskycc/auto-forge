import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import WebSocket from "ws";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";

test("imports TestNG methods from a JAR into the case library", async ({ page }) => {
  test.setTimeout(120_000);
  const jar = zipSync({
    "com/example/CheckoutTest.class": buildClassFile({
      className: "com.example.CheckoutTest",
      methods: [
        {
          name: "checkout",
          annotations: [{ type: "Test", values: { groups: ["smoke", "checkout"] } }],
        },
      ],
    }),
    "testng.xml": new TextEncoder().encode('<suite name="AutoForge fixture" />'),
  });

  await page.goto("/cases/import");
  await expect(page.getByRole("heading", { name: "导入 TestNG JAR" })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "checkout-tests.jar",
    mimeType: "application/java-archive",
    buffer: Buffer.from(jar),
  });
  await page.getByRole("button", { name: "扫描测试类" }).click();

  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".method-row code")).toHaveText("checkout");
  await expect(page.getByText("smoke", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText(/已导入|已返回现有用例/);

  await page.getByRole("link", { name: "查看用例库" }).click();
  await expect(page.getByText("com.example.CheckoutTest")).toBeVisible();

  await page.goto("/case-suites");
  await page.getByLabel("任务名称").fill("每日冒烟测试");
  await page.getByLabel("说明").fill("E2E 创建的可复用任务");
  await page.getByRole("button", { name: "创建任务" }).click();
  await expect(page.getByRole("link", { name: /每日冒烟测试/ })).toBeVisible();

  await page.goto("/cases");
  await page.getByLabel("选择 CheckoutTest").check();
  await page.getByRole("button", { name: "加入任务" }).click();
  await expect(page.getByRole("status")).toContainText("已将 1 个用例加入任务");

  await page.goto("/case-suites");
  await page.getByRole("link", { name: /每日冒烟测试/ }).click();
  await page.getByRole("button", { name: "移除" }).click();
  await expect(page.getByText("任务中还没有用例")).toBeVisible({ timeout: 20_000 });

  await page.goto("/objects");
  await expect(page.getByText("checkout-tests.jar")).toBeVisible();
  await page.getByRole("link", { name: "预览" }).first().click();
  await expect(page.getByRole("heading", { name: "测试类与方法" })).toBeVisible();
  await page.getByRole("button", { name: "设为全量来源" }).click();
  await expect(page.getByRole("button", { name: "当前全量来源" })).toBeVisible();

  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: "Bearer e2e-runner-bootstrap-token-000000000000" },
    data: {
      schemaVersion: 1,
      name: "E2E Runner",
      labels: ["linux", "testng"],
      maxConcurrency: 2,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.2.0",
      protocolVersion: 1,
      terminalEnabled: true,
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
        busySlots: 1,
        labels: ["linux", "testng"],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: true,
      },
    },
  );
  expect(heartbeat.status()).toBe(200);
  const heartbeatResult = (await heartbeat.json()) as { terminalConnectionToken: string };
  expect(heartbeatResult.terminalConnectionToken).toBeTruthy();

  const agentSocket = new WebSocket(
    "ws://127.0.0.1:3100/api/v1/terminal-stream",
    "autoforge-runner-terminal-v1",
    { headers: { authorization: `Bearer ${heartbeatResult.terminalConnectionToken}` } },
  );
  await new Promise<void>((resolve, reject) => {
    agentSocket.once("open", resolve);
    agentSocket.once("error", reject);
  });

  await page.goto("/runners");
  await expect(page.getByText("E2E Runner")).toBeVisible();
  await page.getByRole("button", { name: "终端浮窗" }).click();
  await page.getByLabel("终端访问令牌").fill("e2e-terminal-access-token-000000000000");

  const openCommand = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Agent did not receive terminal open command")),
      10_000,
    );
    agentSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "open") {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
  await page.getByRole("button", { name: "连接终端" }).click();
  const command = await openCommand;
  const sessionId = String(command.sessionId);
  agentSocket.send(JSON.stringify({ schemaVersion: 1, type: "ready", sessionId }));
  agentSocket.send(
    JSON.stringify({
      schemaVersion: 1,
      type: "output",
      sessionId,
      data: Buffer.from("direct-terminal-ready\r\n").toString("base64"),
    }),
  );
  await expect(page.locator(".terminal-viewport")).toContainText("direct-terminal-ready");
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭终端" }).click();
  agentSocket.close();
});
