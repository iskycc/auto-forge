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
  test.setTimeout(600_000);
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
  const runnerId = await waitForRegisteredRunner(page, "SSH Installed Runner");
  await exerciseOfflineUpgradeAndRollback(page);
  await verifyStoredProfileAndBatchUpdate(page, runnerId);
  await exerciseRunnerLifecycle(page, "SSH Installed Runner");
  await exerciseDeregisteredReinstall(page);
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
  const adapter = await execFileAsync("docker", [
    "exec",
    container,
    "test",
    "-s",
    "/opt/autoforge/lib/cotest-testng-adapter.jar",
  ]);
  expect(adapter.stderr).toBe("");
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
  await page.goto("/runners");
  const savedConnections = page.getByLabel("已保存连接");
  await expect(savedConnections).toBeVisible();
  const savedOption = savedConnections
    .locator("option")
    .filter({ hasText: "SSH Installed Runner" })
    .last();
  const profileId = await savedOption.getAttribute("value");
  expect(profileId).toBeTruthy();
  await savedConnections.selectOption(profileId!);
  await expect(page.getByLabel("SSH / sudo 密码")).toHaveValue("");
  await page.getByRole("button", { name: "使用已保存连接安装" }).click();
  await expect(page.getByRole("status").filter({ hasText: "服务已启动" })).toContainText("Agent", {
    timeout: 120_000,
  });
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

async function waitForRegisteredRunner(page: Page, name: string): Promise<string> {
  let runnerId = "";
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/v1/runners?limit=100");
        const body = (await response.json()) as {
          items: Array<{ id: string; name: string; state: string }>;
        };
        const runner = body.items.find((candidate) => candidate.name === name);
        runnerId = runner?.id ?? "";
        return runner?.state ?? "missing";
      },
      { timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe("online");
  return runnerId;
}

async function verifyStoredProfileAndBatchUpdate(page: Page, runnerId: string): Promise<void> {
  const profiles = await page.request.get("/api/v1/runners/installations/profiles");
  expect(profiles.status()).toBe(200);
  const rawProfiles = await profiles.text();
  expect(rawProfiles).not.toContain(passwordConnection.password);
  const profileBody = JSON.parse(rawProfiles) as {
    items: Array<{
      runnerId?: string;
      host: string;
      username: string;
      hasStoredPassword: boolean;
    }>;
  };
  expect(profileBody.items).toContainEqual(
    expect.objectContaining({
      runnerId,
      host: passwordConnection.host,
      username: passwordConnection.username,
      hasStoredPassword: true,
    }),
  );

  const batchUpdate = await browserJson<{
    items: Array<{ runnerId: string; status: string }>;
  }>(page, "/api/v1/runners/updates", {
    method: "POST",
    body: { runnerIds: [runnerId] },
  });
  expect(batchUpdate.status).toBe(200);
  expect(batchUpdate.body.items).toContainEqual(
    expect.objectContaining({ runnerId, status: "updated" }),
  );
  await verifyInstalledSystemdService();
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

async function exerciseDeregisteredReinstall(page: Page): Promise<void> {
  // 注销后旧身份文件残留在数据目录，重装时必须能自动重新注册而不是报
  // "control plane rejected request (RUNNER_AUTH_REJECTED)"。
  const staleIdentityBefore = await installedConfigurationDigest(
    "/var/lib/autoforge-agent/identity/credentials.json",
  );
  expect(staleIdentityBefore).not.toBe("");

  await probeThroughUi(page);
  await installThroughUi(page);
  await verifyInstalledSystemdService();

  // Agent 启动后发现旧凭据已被控制面拒绝，应删除本地身份并用新 bootstrap
  // token 重新注册。等待同名新 runner 上线（旧注销记录仍会保留在列表中，
  // 因此不能用 find 取第一条，必须显式匹配 online 状态）。
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/v1/runners?limit=100");
        const body = (await response.json()) as {
          items: Array<{ name: string; state: string }>;
        };
        return body.items.some(
          (runner) => runner.name === "SSH Installed Runner" && runner.state === "online",
        );
      },
      { timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe(true);

  // 身份文件必须已被替换为新注册的身份。
  await expect
    .poll(
      () => installedConfigurationDigest("/var/lib/autoforge-agent/identity/credentials.json"),
      {
        timeout: 30_000,
      },
    )
    .not.toBe(staleIdentityBefore);

  // 注销的旧 runner 仍保留在列表中（state=disabled），新注册产生同名的新
  // runner。关键断言是存在一条 online 状态的同名 runner。
  const runners = await page.request.get("/api/v1/runners?limit=100");
  expect(runners.status()).toBe(200);
  const body = (await runners.json()) as {
    items: Array<{ name: string; state: string }>;
  };
  const onlineMatching = body.items.filter(
    (runner) => runner.name === "SSH Installed Runner" && runner.state === "online",
  );
  expect(onlineMatching.length).toBe(1);
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
