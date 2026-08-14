import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { browserJson, ensureAdministrator } from "./support/session";

const execFileAsync = promisify(execFile);
const passwordConnection = {
  host: "127.0.0.1",
  port: 22,
  username: "passwordrunner",
  password: "Password!Runner123",
};

test("probes and installs the embedded Agent through real SSH and systemd", async ({ page }) => {
  test.setTimeout(300_000);
  await ensureAdministrator(page);

  const rejected = await browserJson<{ error?: { code?: string } }>(
    page,
    "/api/v1/runners/installations/probe",
    {
      method: "POST",
      body: { connection: { ...passwordConnection, password: "Wrong!Password123" } },
    },
  );
  expect(rejected.status).toBe(502);
  expect(rejected.body.error?.code).toBe("RUNNER_HOST_AUTHENTICATION_FAILED");

  const refused = await browserJson<{ error?: { code?: string } }>(
    page,
    "/api/v1/runners/installations/probe",
    {
      method: "POST",
      body: { connection: { ...passwordConnection, port: 1 } },
    },
  );
  expect(refused.status).toBe(502);
  expect(refused.body.error?.code).toBe("RUNNER_HOST_CONNECTION_REFUSED");

  const keyboardInteractive = await browserJson<{
    hostKeySha256: string;
    privilegeMode: string;
  }>(page, "/api/v1/runners/installations/probe", {
    method: "POST",
    body: {
      connection: {
        host: "127.0.0.1",
        port: 22,
        username: "pamrunner",
        password: "Keyboard!Runner123",
      },
    },
  });
  expect(keyboardInteractive.status).toBe(200);
  expect(keyboardInteractive.body).toMatchObject({ privilegeMode: "sudo" });
  expect(keyboardInteractive.body.hostKeySha256).toMatch(/^SHA256:/);

  const probe = await probeThroughUi(page);
  const mismatch = await browserJson<{ error?: { code?: string } }>(
    page,
    "/api/v1/runners/installations",
    {
      method: "POST",
      body: {
        connection: passwordConnection,
        expectedHostKeySha256: `SHA256:${"A".repeat(43)}`,
        name: "mismatch-must-not-install",
        labels: ["linux"],
        maxConcurrency: 1,
        terminalEnabled: false,
      },
    },
  );
  expect(mismatch.status).toBe(409);
  expect(mismatch.body.error?.code).toBe("RUNNER_HOST_KEY_MISMATCH");
  expect(probe).toMatch(/^SHA256:/);

  await installThroughUi(page);
  await verifyInstalledSystemdService();
  await waitForRegisteredRunner(page, "SSH Installed Runner");
  await exerciseOfflineUpgradeAndRollback(page);
  await exerciseRunnerLifecycle(page, "SSH Installed Runner");
});

async function probeThroughUi(page: Page): Promise<string> {
  await page.goto("/runners");
  await page.getByLabel("执行机 IP / 主机名").fill(passwordConnection.host);
  await page.getByLabel("SSH 端口").fill(String(passwordConnection.port));
  await page.getByLabel("用户名").fill(passwordConnection.username);
  await page.getByLabel("SSH / sudo 密码").fill(passwordConnection.password);
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/runners/installations/probe"),
  );
  await page.getByRole("button", { name: "探测并核验主机" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { hostKeySha256: string };
  await expect(page.getByText(/Ubuntu 24\.04/)).toBeVisible();
  await expect(page.getByText(/amd64 · systemd · sudo/)).toBeVisible();
  await expect(page.getByText(body.hostKeySha256, { exact: true })).toBeVisible();
  return body.hostKeySha256;
}

async function installThroughUi(page: Page): Promise<void> {
  await page.getByLabel("我已通过可信渠道核对并确认上述 SSH 主机指纹").check();
  await page.getByLabel("执行机名称").fill("SSH Installed Runner");
  await page.getByLabel("标签（逗号分隔）").fill("linux,ssh-e2e");
  await page.getByLabel("最大并发").fill("1");
  await page.getByLabel("允许管理员直连终端").check();
  await page
    .getByLabel("私有 CA 证书（可选，PEM）")
    .fill(await readFile(requiredEnvironment("E2E_SSH_CA_FILE"), "utf8"));
  await page.getByRole("button", { name: "安装内置 Agent" }).click();
  const installationSuccess = page.getByRole("status").filter({ hasText: "服务已启动" });
  await expect(installationSuccess).toContainText("Agent", { timeout: 120_000 });
  await expect(installationSuccess).toContainText("服务已启动");
}

async function verifyInstalledSystemdService(): Promise<void> {
  const container = requiredEnvironment("E2E_SSH_CONTAINER");
  const active = await execFileAsync("docker", [
    "exec",
    container,
    "systemctl",
    "is-active",
    "autoforge-agent.service",
  ]);
  expect(active.stdout.trim()).toBe("active");
  const metadata = await execFileAsync("docker", [
    "exec",
    container,
    "stat",
    "-c",
    "%a:%U:%G",
    "/etc/autoforge-agent/config.json",
  ]);
  expect(metadata.stdout.trim()).toBe("600:autoforge-agent:autoforge-agent");
  const caMetadata = await execFileAsync("docker", [
    "exec",
    container,
    "stat",
    "-c",
    "%a:%U:%G",
    "/etc/autoforge-agent/control-plane-ca.pem",
  ]);
  expect(caMetadata.stdout.trim()).toBe("600:autoforge-agent:autoforge-agent");
  const version = await execFileAsync("docker", [
    "exec",
    container,
    "/opt/autoforge/bin/autoforge-agent",
    "version",
  ]);
  expect(JSON.parse(version.stdout)).toMatchObject({ version: expect.stringMatching(/^\d+\./) });
}

async function exerciseOfflineUpgradeAndRollback(page: Page): Promise<void> {
  const before = await installedConfigurationDigest("/etc/autoforge-agent/config.json");
  await probeThroughUi(page);
  await installThroughUi(page);
  await verifyInstalledSystemdService();
  const container = requiredEnvironment("E2E_SSH_CONTAINER");
  for (const previousFile of [
    "/opt/autoforge/bin/autoforge-agent.autoforge-previous",
    "/etc/autoforge-agent/config.json.autoforge-previous",
    "/etc/systemd/system/autoforge-agent.service.autoforge-previous",
  ]) {
    const previous = await execFileAsync("docker", ["exec", container, "test", "-f", previousFile]);
    expect(previous.stderr).toBe("");
  }
  // Agent 启动消费一次性 bootstrapToken 后会重写 config.json，重装后配置收敛为相同字节，
  // 因此升级前后 config.json 摘要可能相等；离线回滚的关键属性是备份字节与升级前一致。
  expect(
    await installedConfigurationDigest("/etc/autoforge-agent/config.json.autoforge-previous"),
  ).toBe(before);

  await probeThroughUi(page);
  await page.getByLabel("我已通过可信渠道核对并确认上述 SSH 主机指纹").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "回滚上次安装" }).click();
  await expect(page.getByRole("status").filter({ hasText: "systemd 健康检查通过" })).toContainText(
    /Agent 已回滚到 .*systemd 健康检查通过/,
    { timeout: 120_000 },
  );
  expect(await installedConfigurationDigest("/etc/autoforge-agent/config.json")).toBe(before);
  await verifyInstalledSystemdService();
  const audit = await page.request.get(
    "/api/v1/audit-events?action=runner.install.rollback&limit=10",
  );
  expect(audit.status()).toBe(200);
  expect(await audit.json()).toMatchObject({
    items: [expect.objectContaining({ action: "runner.install.rollback" })],
  });
}

async function waitForRegisteredRunner(page: Page, name: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/v1/runners?limit=100");
        const body = (await response.json()) as {
          items: Array<{ name: string; state: string }>;
        };
        return body.items.find((runner) => runner.name === name)?.state ?? "missing";
      },
      { timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe("online");
}

async function exerciseRunnerLifecycle(page: Page, name: string): Promise<void> {
  const credentialFileBefore = await installedConfigurationDigest(
    "/var/lib/autoforge-agent/identity/credentials.json",
  );
  await page.goto("/runners");
  let row = page.getByRole("row", { name: new RegExp(name) });
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "排空" }).click();
  await expect(row).toContainText("排空中");

  row = page.getByRole("row", { name: new RegExp(name) });
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "恢复接单" }).click();
  await expect(row).toContainText("在线");

  row = page.getByRole("row", { name: new RegExp(name) });
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "轮换凭据" }).click();
  await expect
    .poll(
      () => installedConfigurationDigest("/var/lib/autoforge-agent/identity/credentials.json"),
      {
        timeout: 30_000,
      },
    )
    .not.toBe(credentialFileBefore);
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/v1/runners?limit=100");
      const body = (await response.json()) as {
        items: Array<{ name: string; credentialRotationRequestedAt?: string }>;
      };
      return body.items.find((runner) => runner.name === name)?.credentialRotationRequestedAt;
    })
    .toBeUndefined();

  await page.reload();
  row = page.getByRole("row", { name: new RegExp(name) });
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "撤销凭据" }).click();
  await expect(row).toContainText("凭据已撤销");

  row = page.getByRole("row", { name: new RegExp(name) });
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "注销" }).click();
  await expect(row).toContainText("已注销");
}

async function installedConfigurationDigest(path: string): Promise<string> {
  const digest = await execFileAsync("docker", [
    "exec",
    requiredEnvironment("E2E_SSH_CONTAINER"),
    "sha256sum",
    path,
  ]);
  return digest.stdout.split(/\s+/)[0] ?? "";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for SSH installation acceptance.`);
  return value;
}
