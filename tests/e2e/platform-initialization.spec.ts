import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { PostgresDatabaseHandle } from "@autoforge/db/postgres";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { expectUiIntegrity } from "./support/ui-guard";

test("initialization guides Full connections, isolates logs and rejects oversized paste", async ({
  browser,
}, testInfo) => {
  const directory = testInfo.outputPath("platform");
  await mkdir(directory, { recursive: true });
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port allocated");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const fullDatabase = await createInitializationDatabase();
  const store = new PlatformConfigurationStore(directory);
  const initial = store.initialize();
  const configuration = store.replace(
    { ...initial, web: { ...initial.web, hostname: "127.0.0.1", port, publicBaseUrl: origin } },
    initial.revision,
  );
  // This fixture must never inherit a Full deployment's external services or data paths.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AUTOFORGE_")),
  );
  const log = await open(testInfo.outputPath("platform.log"), "w");
  let server = spawn(
    process.execPath,
    [resolve("apps/web/dist-server/server/index.js"), `--data-dir=${directory}`],
    {
      cwd: resolve("."),
      env: { ...environment, NODE_ENV: "production" },
      shell: false,
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  let startError = "";
  server.on("error", (error) => {
    startError = error.message;
  });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  try {
    await expect
      .poll(
        async () => {
          if (startError) throw new Error(startError);
          try {
            return (
              await context.request.get(`${origin}/api/v1/auth/setup-status`, { timeout: 2000 })
            ).status();
          } catch {
            return 0;
          }
        },
        { timeout: 30000 },
      )
      .toBe(200);
    const page = await context.newPage();
    const errors: string[] = [];
    const submissions: string[] = [];
    const pasteTimings: { mode: string; width: number; characters: number; durationMs: number }[] =
      [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("setup-platform"))
        submissions.push(request.url());
    });
    await page.goto(`${origin}/setup`);
    await page.getByRole("button", { name: /Full/ }).click();
    const savedAddress = "http://10.20.0.11:3000";
    const targets = [
      "publicBaseUrl",
      "runnerBaseUrl",
      "postgres.host",
      "logs.host",
      "redis.host",
      "nats.host",
      "minio.host",
    ];
    for (const name of targets) {
      const control = page.locator(`input[name="${name}"]`);
      await control.fill(savedAddress);
      // Keep the initial regression small; an independent reproduction measured
      // one million Chinese characters taking 25 seconds before this guard existed.
      const pasted = "http://example.com/" + "地址/".repeat(22000);
      await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
      await control.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Control+V");
      await expect(control).toHaveValue(savedAddress);
      await expect(control).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByRole("alert").filter({ hasText: "本次粘贴未写入" })).toBeVisible();
      const replacement = name.endsWith(".host") ? "10.20.0.12" : savedAddress;
      await page.evaluate((text) => navigator.clipboard.writeText(text), replacement);
      await page.keyboard.press("Control+V");
      await expect(control).toHaveValue(replacement);
      await expect(control).not.toHaveAttribute("aria-invalid", "true");
    }
    const publicAddress = page.locator('input[name="publicBaseUrl"]');
    const maximumAddress = "http://example.com/" + "a".repeat(2048 - "http://example.com/".length);
    await page.evaluate((text) => navigator.clipboard.writeText(text), maximumAddress);
    await publicAddress.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+V");
    await expect(publicAddress).toHaveValue(maximumAddress);
    // Exercise the alternate native paste shortcut with the actual clipboard.
    await page.evaluate((text) => navigator.clipboard.writeText(text), savedAddress);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Shift+Insert");
    await expect(publicAddress).toHaveValue(savedAddress);
    expect(submissions).toEqual([]);
    const fields = setupFields(configuration.secrets.adminBootstrapToken, fullDatabase?.url);
    // A real closed port verifies error feedback without any dependency on Full services.
    for (const [name, value] of Object.entries(fields))
      await page.locator(`.setup-runtime-card input[name="${name}"]`).fill(value);
    await page.locator('input[name="postgres.port"]').fill("1");
    let releaseCheck!: () => void;
    const heldCheck = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    await page.route("**/api/v1/auth/setup-platform/check", async (route) => {
      await heldCheck;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: "检查PostgreSQL 主库连接", exact: true }).click();
      await expect(page.getByRole("button", { name: "保存平台配置", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: /Lite/ })).toBeDisabled();
    } finally {
      releaseCheck();
    }
    await expect(page.locator('[data-component="postgres"]').getByRole("alert")).toContainText(
      "连接被拒绝",
    );
    await page.unroute("**/api/v1/auth/setup-platform/check");
    await page.locator('input[name="postgres.port"]').fill(fields["postgres.port"]!);
    await expect(page.locator('[data-component="postgres"]').getByRole("alert")).toHaveCount(0);
    const live = Boolean(fullDatabase);
    if (live) {
      for (const component of ["postgres", "logs", "redis", "nats", "minio"]) {
        const card = page.locator(`[data-component="${component}"]`);
        await card.getByRole("button", { name: /^检查/ }).click();
        await expect(card.getByRole("alert")).toContainText("连接成功");
      }
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath("setup-checked-light-1536.png"),
        fullPage: true,
        animations: "disabled",
      });
    }
    await expect(page.locator('select[name="logs.enabled"]')).toHaveCount(0);
    await expect(page.getByText("本地日志存储", { exact: true })).toHaveCount(0);
    for (const mode of ["light", "dark"]) {
      await context.addCookies([{ name: "autoforge-color-mode", value: mode, url: origin }]);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await page.reload();
        await page.getByRole("button", { name: /Full/ }).click();
        for (const [name, value] of Object.entries(fields))
          await page.locator(`.setup-runtime-card input[name="${name}"]`).fill(value);
        const control = page.locator('input[name="publicBaseUrl"]');
        await control.fill(savedAddress);
        await page.evaluate(() => navigator.clipboard.writeText("地址/".repeat(350000)));
        await control.click();
        await page.keyboard.press("Control+A");
        const started = Date.now();
        await page.keyboard.press("Control+V");
        await expect(control).toHaveValue(savedAddress);
        pasteTimings.push({ mode, width, characters: 1050000, durationMs: Date.now() - started });
        expect(pasteTimings.at(-1)!.durationMs).toBeLessThan(2000);
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`setup-paste-${mode}-${width}.png`),
          animations: "disabled",
          fullPage: true,
        });
        for (const component of ["postgres", "logs", "minio"]) {
          await page.locator(`[data-component="${component}"]`).screenshot({
            path: testInfo.outputPath(`setup-${component}-${mode}-${width}.png`),
            animations: "disabled",
          });
        }
      }
    }
    for (const [name, value] of Object.entries(fields))
      await page.locator(`.setup-runtime-card input[name="${name}"]`).fill(value);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/auth/setup-platform") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "保存平台配置", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: "配置已安全写入" })).toBeVisible();
    const persisted = store.read();
    expect(persisted.web.publicBaseUrl).toBe(savedAddress);
    const databaseUrl = new URL(persisted.full!.databaseUrl);
    expect(databaseUrl.hostname).toBe(fields["postgres.host"]);
    expect(decodeURIComponent(databaseUrl.password)).toBe(fields["postgres.password"]);
    expect(persisted.full?.logServer).toMatchObject({
      host: fields["logs.host"],
      password: fields["logs.password"],
      databasePrefix: fields["logs.databasePrefix"],
    });
    if (live) {
      await stopServer(server);
      server = spawn(
        process.execPath,
        [resolve("apps/web/dist-server/server/index.js"), `--data-dir=${directory}`],
        {
          cwd: resolve("."),
          env: { ...environment, NODE_ENV: "production" },
          shell: false,
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      await expect
        .poll(
          async () => {
            try {
              return (
                await context.request.get(`${origin}/api/v1/auth/setup-status`, { timeout: 2000 })
              ).status();
            } catch {
              return 0;
            }
          },
          { timeout: 30000 },
        )
        .toBe(200);
      await page.goto(`${origin}/setup`);
      const admin = page.locator(".setup-admin-card");
      await admin
        .locator('input[name="bootstrapToken"]')
        .fill(configuration.secrets.adminBootstrapToken);
      await admin.locator('input[name="username"]').fill("setup-admin");
      await admin.locator('input[name="displayName"]').fill("初始化验证管理员");
      await admin.locator('input[name="password"]').fill("Fixture-password-20261030!");
      await admin.getByRole("button", { name: "创建系统管理员", exact: true }).click();
      await expect(page).toHaveURL(`${origin}/`);
      const logSettings = await context.request.get(`${origin}/api/v1/settings/log-databases`);
      expect(logSettings.status()).toBe(200);
      const registry = (await logSettings.json()) as {
        activeDatabaseId: string | null;
        items: { id: string; storageMode: string }[];
      };
      expect(registry.activeDatabaseId).toBeTruthy();
      expect(
        registry.items.find((item) => item.id === registry.activeDatabaseId)?.storageMode,
      ).toBe("daily");
      const originalFull = store.read().full!;
      await page.goto(`${origin}/settings/platform?section=configuration`);
      await expect(
        page.locator(
          'textarea[name="natsServers"], input[name="databaseUrl"], input[name="redisUrl"]',
        ),
      ).toHaveCount(0);
      for (const component of ["postgres", "redis", "nats", "minio"]) {
        const card = page.locator(`[data-component="${component}"]`);
        for (const [name, value] of Object.entries(fields).filter(([name]) =>
          name.startsWith(component + "."),
        ))
          await card.locator(`input[name="${name}"]`).fill(value);
        await card.getByRole("button", { name: /^检查/ }).click();
        await expect(card.getByRole("alert")).toContainText("连接成功");
      }
      for (const mode of ["light", "dark"]) {
        await context.addCookies([{ name: "autoforge-color-mode", value: mode, url: origin }]);
        for (const width of [1024, 1536]) {
          await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
          await page.reload();
          await expectUiIntegrity(page);
          await page.locator("#platform-infrastructure").screenshot({
            path: testInfo.outputPath(`full-settings-${mode}-${width}.png`),
            animations: "disabled",
          });
          await page.locator('[data-component="postgres"]').screenshot({
            path: testInfo.outputPath(`full-settings-postgres-${mode}-${width}.png`),
            animations: "disabled",
          });
          await expect(page.locator('input[name="redis.password"]')).toHaveValue("");
        }
      }
      const redis = page.locator('[data-component="redis"]');
      for (const [name, value] of Object.entries(fields).filter(([name]) =>
        name.startsWith("redis."),
      ))
        await redis.locator(`input[name="${name}"]`).fill(name === "redis.database" ? "1" : value);
      const savedSettings = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/settings/platform") &&
          response.request().method() === "PATCH",
      );
      await page.getByRole("button", { name: /保存平台配置/ }).click();
      const settingsResponse = await savedSettings;
      expect(settingsResponse.status()).toBe(200);
      expect(JSON.stringify(await settingsResponse.json())).not.toContain(fields["redis.password"]);
      expect(store.read().full?.databaseUrl).toBe(originalFull.databaseUrl);
      expect(store.read().full?.minio).toEqual(originalFull.minio);
      expect(store.read().full?.logServer).toEqual(originalFull.logServer);
      expect(new URL(store.read().full!.redisUrl).pathname).toBe("/1");
      await page.goto(`${origin}/settings/platform?section=logs`);
      await expect(page.getByRole("button", { name: "切换为本地写入" })).toHaveCount(0);
      const forbiddenLocal = await context.request.put(
        `${origin}/api/v1/settings/log-databases/active`,
        { headers: { origin }, data: { databaseId: null, revision: 1 } },
      );
      expect(forbiddenLocal.status()).toBe(409);
      expect((await forbiddenLocal.json()).error.code).toBe("FULL_LOCAL_LOG_WRITE_DISABLED");
      for (const mode of ["light", "dark"]) {
        await context.addCookies([{ name: "autoforge-color-mode", value: mode, url: origin }]);
        for (const width of [1024, 1536]) {
          await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
          await page.reload();
          await expectUiIntegrity(page);
          await page.screenshot({
            path: testInfo.outputPath(`full-log-policy-${mode}-${width}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
      }
      // A consumed bootstrap token must never remain a general-purpose connection probe.
      const rejected = await context.request.post(`${origin}/api/v1/auth/setup-platform/check`, {
        headers: { origin },
        data: {
          bootstrapToken: configuration.secrets.adminBootstrapToken,
          target: { component: "redis", connection: { host: "127.0.0.1" } },
        },
      });
      expect(rejected.status()).toBe(403);
      // Simulate an older Full installation that has not selected a PostgreSQL log target.
      await fullDatabase!.setLogWriteTarget(null);
      try {
        await context.addCookies([{ name: "autoforge-color-mode", value: "light", url: origin }]);
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto(`${origin}/settings/platform?section=logs`);
        await expect(
          page.getByRole("alert").filter({ hasText: "请添加并设定 PostgreSQL 日志服务器" }),
        ).toBeVisible();
        await expect(page.getByText("未配置 PostgreSQL 写入库", { exact: false })).toBeVisible();
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath("full-log-unconfigured-1024.png"),
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await fullDatabase!.setLogWriteTarget(registry.activeDatabaseId);
      }
    }
    expect(errors).toEqual([]);
    await testInfo.attach("paste-timings", {
      body: JSON.stringify(pasteTimings, null, 2),
      contentType: "application/json",
    });
  } finally {
    await context.close();
    await stopServer(server);
    await log.close();
    await fullDatabase?.remove();
  }
});

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    server.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

function setupFields(bootstrapToken: string, databaseUrl?: string): Record<string, string> {
  const fields: Record<string, string> = {
    bootstrapToken,
    publicBaseUrl: "http://10.20.0.11:3000",
    runnerBaseUrl: "http://10.20.0.11:3001",
    "postgres.host": "127.0.0.1",
    "postgres.port": "5432",
    "postgres.database": "autoforge",
    "postgres.username": "autoforge",
    "postgres.password": " password@:/?#%+ ",
    "logs.host": "127.0.0.1",
    "logs.port": "5433",
    "logs.maintenanceDatabase": "postgres",
    "logs.databasePrefix": "autoforge_logs",
    "logs.username": "postgres",
    "logs.password": "fixture-logs-password",
    "redis.host": "127.0.0.1",
    "redis.port": "6379",
    "redis.username": "",
    "redis.password": "fixture-redis-password",
    "redis.database": "0",
    "nats.host": "127.0.0.1",
    "nats.port": "4222",
    "nats.token": "fixture-nats-token-20261030",
    "minio.host": "127.0.0.1",
    "minio.port": "9000",
    "minio.accessKey": "fixture-access",
    "minio.secretKey": "fixture-secret",
    "minio.bucket": "autoforge-objects",
    "minio.region": "us-east-1",
  };
  if (!databaseUrl) return fields;
  for (const [component, variable, defaultPort] of [
    ["postgres", databaseUrl, 5432],
    ["logs", process.env.AUTOFORGE_TEST_POSTGRES_URL, 5432],
    ["redis", process.env.AUTOFORGE_TEST_REDIS_URL, 6379],
    ["nats", process.env.AUTOFORGE_TEST_NATS_URL, 4222],
    ["minio", process.env.AUTOFORGE_TEST_MINIO_ENDPOINT, 9000],
  ] as const) {
    if (!variable) throw new Error(`Missing ${component} test connection`);
    const url = new URL(variable);
    fields[`${component}.host`] = url.hostname;
    fields[`${component}.port`] = url.port || String(defaultPort);
    if (["postgres", "logs", "redis"].includes(component)) {
      fields[`${component}.username`] = decodeURIComponent(url.username);
      fields[`${component}.password`] = decodeURIComponent(url.password);
      fields[`${component}.${component === "logs" ? "maintenanceDatabase" : "database"}`] =
        url.pathname.slice(1) || (component === "redis" ? "0" : "postgres");
    }
  }
  fields["nats.token"] = process.env.AUTOFORGE_TEST_NATS_TOKEN ?? "";
  fields["minio.accessKey"] = process.env.AUTOFORGE_TEST_MINIO_ACCESS_KEY ?? "";
  fields["minio.secretKey"] = process.env.AUTOFORGE_TEST_MINIO_SECRET_KEY ?? "";
  fields["minio.bucket"] = process.env.AUTOFORGE_E2E_SETUP_MINIO_BUCKET ?? "autoforge-objects";
  return fields;
}

async function createInitializationDatabase() {
  const source = process.env.AUTOFORGE_E2E_SETUP_DATABASE_URL;
  if (!source) return undefined;
  const { Pool } = createRequire(resolve("packages/db/package.json"))("pg") as {
    Pool: new (configuration: {
      connectionString: string;
      max: number;
      connectionTimeoutMillis: number;
    }) => Pick<PostgresDatabaseHandle["pool"], "query" | "end">;
  };
  const admin = new Pool({ connectionString: source, max: 1, connectionTimeoutMillis: 3000 });
  const name = `af_setup_${randomUUID().replaceAll("-", "")}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (cause) {
    await admin.end();
    throw cause;
  }
  const url = new URL(source);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    setLogWriteTarget: async (databaseId: string | null) => {
      const business = new Pool({
        connectionString: url.toString(),
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      try {
        await business.query("UPDATE log_database_settings SET active_database_id=$1 WHERE id=1", [
          databaseId,
        ]);
      } finally {
        await business.end();
      }
    },
    remove: async () => {
      try {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
