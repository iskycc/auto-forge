import { expect, test } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { createPostgresDatabase, PostgresLogDatabaseRepository } from "@autoforge/db/postgres";
import { AesGcmSecretCipher } from "../../apps/web/src/lib/secret-cipher-core";
import { browserJson, ensureAdministrator } from "./support/session";
import {
  expectPageFitsViewport,
  expectUiIntegrity,
  waitForUiTransitions,
} from "./support/ui-guard";
import type {
  LogDatabaseStatus,
  RegisterDailyLogServerInput,
  NodeExporterSource,
} from "@autoforge/contracts";

test("log database settings isolate Full payloads, switch live and preserve historical public logs", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const dataDirectory =
    process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!dataDirectory) throw new Error("E2E platform directory is required.");
  const configuration = new PlatformConfigurationStore(dataDirectory).read();
  await page.goto("/settings/platform?section=logs");
  if (configuration.mode === "lite") {
    await expect(page.getByRole("link", { name: "日志数据库", exact: true })).toHaveCount(0);
    expect((await page.request.get("/api/v1/settings/log-databases")).status()).toBe(400);
    return;
  }
  if (!configuration.full) throw new Error("Full connection configuration is missing.");
  const database = createPostgresDatabase({
    connectionString: configuration.full.databaseUrl,
    migrationsFolder: resolve("packages/db/drizzle/postgresql"),
    poolMax: 1,
  });
  await database.ready;
  const namespace = randomUUID().replaceAll("-", "");
  const names = [`logs_e2e_${namespace.slice(0, 12)}_a`, `logs_e2e_${namespace.slice(0, 12)}_b`];
  const ids: string[] = [];
  const batches: string[] = [];
  const runnerId = randomUUID();
  const runnerCredential = randomBytes(32).toString("hex");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const registry = new PostgresLogDatabaseRepository(
    database,
    new AesGcmSecretCipher(configuration.secrets.masterKey),
    createHash("sha256").update(configuration.secrets.masterKey).digest("hex"),
    resolve("packages/db/drizzle/log-postgresql"),
  );
  const externalLogUrls = process.env.AUTOFORGE_E2E_LOG_DATABASE_URLS;
  const urls: string[] = externalLogUrls
    ? (JSON.parse(externalLogUrls) as string[])
    : names.map((name) => {
        const url = new URL(configuration.full!.databaseUrl);
        url.pathname = `/${name}`;
        return url.toString();
      });
  const labels = ["日志库一 · 原始执行与中文日志", "日志库二 · 新批次写入"];
  const oldSetting = (await (await page.request.get("/api/v1/settings/log-databases")).json()) as {
    activeDatabaseId: string | null;
  };
  if (!oldSetting.activeDatabaseId)
    throw new Error(
      "Full acceptance requires an active PostgreSQL log server before execution scenarios.",
    );
  async function choose(id: string | null) {
    const settings = (await (await page.request.get("/api/v1/settings/log-databases")).json()) as {
      revision: number;
    };
    const response = await page.request.put("/api/v1/settings/log-databases/active", {
      headers: { origin: new URL(page.url()).origin },
      data: { databaseId: id, revision: settings.revision },
    });
    expect(response.status()).toBe(200);
  }
  async function seedBatch(message: string) {
    const batchId = randomUUID();
    const attemptId = randomUUID();
    const now = new Date().toISOString();
    batches.push(batchId);
    await database.pool.query(
      `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES($1,'log-e2e','数据库日志验收',1,'running',0,1,'[]',$2,$2)`,
      [batchId, now],
    );
    await database.pool.query(
      `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES($1,$2,$1,1,'中文日志用例','example.LogDatabaseCase','running',1,$3,$3)`,
      [attemptId, batchId, now],
    );
    await database.pool.query(
      `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES($1,$1,$2,1,'running',1,$3)`,
      [attemptId, runnerId, now],
    );
    const assignmentId = randomUUID();
    const leaseToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await database.pool.query(
      "INSERT INTO assignments(id,attempt_id,execution_run_id,batch_id,runner_id,status,execution_spec_json,available_at,claim_deadline_at,created_at,updated_at) VALUES($1,$2,$2,$3,$4,'running','{}',$5,$6,$5,$5)",
      [assignmentId, attemptId, batchId, runnerId, now, expiresAt],
    );
    await database.pool.query(
      "INSERT INTO assignment_leases(id,assignment_id,runner_id,token_hash,token_encrypted,status,expires_at,renewed_at,created_at) VALUES($1,$2,$3,$4,'fixture','active',$5,$6,$6)",
      [randomUUID(), assignmentId, runnerId, digest(leaseToken), expiresAt, now],
    );
    await upload({ attemptId, leaseToken }, 0, message);
    await database.pool.query(
      "INSERT INTO public_attempt_access(attempt_id,created_by,created_at) VALUES($1,'log-e2e',$2)",
      [attemptId, now],
    );
    return { batchId, attemptId, leaseToken };
  }
  async function upload(
    target: { attemptId: string; leaseToken: string },
    sequence: number,
    content: string,
  ) {
    const response = await page.request.post(`/api/v1/run-attempts/${target.attemptId}/logs`, {
      headers: { authorization: `Bearer ${runnerCredential}`, "x-autoforge-runner-id": runnerId },
      data: {
        schemaVersion: 1,
        requestId: randomUUID(),
        leaseToken: target.leaseToken,
        chunks: [{ stream: "stdout", sequence, content, recordedAt: new Date().toISOString() }],
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(
      ((await response.json()) as { acknowledgedSequence: { stdout: number } }).acknowledgedSequence
        .stdout,
    ).toBe(sequence);
  }
  try {
    if (urls.length !== 2) throw new Error("E2E requires two isolated log database URLs.");

    if (!externalLogUrls) {
      for (const name of names) await database.pool.query(`CREATE DATABASE "${name}"`);
    }
    for (let index = 0; index < names.length; index++) {
      await page.getByRole("button", { name: /添加日志服务器$/ }).click();
      const dialog = page.getByRole("dialog", { name: "添加日志服务器", exact: true });
      await dialog.getByLabel("日志库名称", { exact: true }).fill(labels[index]!);
      const connection = new URL(urls[index]!);
      await dialog.getByLabel("PostgreSQL 主机 / IP", { exact: true }).fill(connection.hostname);
      await dialog.getByLabel("端口", { exact: true }).fill(String(connection.port || 5432));
      await dialog
        .getByLabel("维护数据库", { exact: true })
        .fill(decodeURIComponent(connection.pathname.slice(1)));
      await dialog
        .getByLabel("管理员用户名", { exact: true })
        .fill(decodeURIComponent(connection.username));
      await dialog
        .getByLabel("管理员密码", { exact: true })
        .fill(decodeURIComponent(connection.password));
      await dialog.getByLabel("每日库名前缀", { exact: true }).fill(names[index]!);

      const saved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v1/settings/log-databases" &&
          response.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "登记数据库", exact: true }).click();
      const response = await saved;
      expect(response.status(), await response.text()).toBe(201);
      ids.push(((await response.json()) as { id: string }).id);
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("main")).toContainText(labels[index]!);
    }
    const firstCard = page.getByRole("main").locator(".ant-card").filter({ hasText: labels[0]! });
    const selected = page.waitForResponse(
      (response) =>
        response.url().endsWith("/settings/log-databases/active") &&
        response.request().method() === "PUT",
    );
    await firstCard.getByRole("button", { name: "设为写入库", exact: true }).click();
    expect((await selected).status()).toBe(200);
    await expect(firstCard).toContainText("当前写入");
    await database.pool.query(
      `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES($1,$2,'日志验收节点',FALSE,FALSE,'linux','amd64','1.20.22',1,'{}','[]',1,0,$3,$3,$3)`,
      [runnerId, digest(runnerCredential), new Date().toISOString()],
    );
    const first = await seedBatch("原始日志库：中文 CaseId 正常，切换后仍可读取。");
    await choose(ids[1]!);
    const second = await seedBatch("新的日志库：新批次写入成功。");
    await upload(first, 1, "切换后持续写入原日志库。");
    const routes = await database.pool.query(
      "SELECT batch_id,database_id FROM run_batch_log_storage WHERE batch_id=ANY($1::text[])",
      [batches],
    );
    expect(new Map(routes.rows.map((row) => [row.batch_id, row.database_id]))).toEqual(
      new Map([
        [first.batchId, ids[0]],
        [second.batchId, ids[1]],
      ]),
    );
    for (const { attemptId } of [first, second]) {
      await page.goto(`/CaseLog?ExecutionId=${attemptId}`);
      await expect(page.getByRole("main")).toContainText(
        attemptId === first.attemptId ? "切换后仍可读取" : "新批次写入成功",
        { timeout: 30000 },
      );
    }
    for (const theme of ["light", "dark"] as const) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
        ]);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await page.goto("/settings/platform?section=logs");
        await expect(page.getByRole("main")).toContainText(labels[1]!);
        await waitForUiTransitions(page);
        await expectPageFitsViewport(page);
        await page.screenshot({
          path: testInfo.outputPath(`log-databases-${theme}-${width}.png`),
          fullPage: true,
        });
        await page.getByRole("button", { name: /添加日志服务器$/ }).click();
        await waitForUiTransitions(page);
        await page.screenshot({
          path: testInfo.outputPath(`log-database-dialog-${theme}-${width}.png`),
          fullPage: true,
        });
        await page
          .getByRole("dialog", { name: "添加日志服务器", exact: true })
          .getByRole("button", { name: "取消", exact: true })
          .click();
      }
    }
  } finally {
    await registry.select(oldSetting.activeDatabaseId, (await registry.settings()).revision);
    const children = await database.pool.query<{
      id: string;
      physical_name: string;
      parent_database_id: string;
    }>(
      "SELECT id,physical_name,parent_database_id FROM log_databases WHERE parent_database_id=ANY($1::text[])",
      [ids],
    );
    for (const child of children.rows)
      await registry.withDatabase(child.id, async (pool) => {
        await pool.query("DELETE FROM log_batches WHERE batch_id=ANY($1::text[])", [batches]);
      });
    await registry.close();
    await database.pool.query("DELETE FROM run_batches WHERE id=ANY($1::text[])", [batches]);
    for (const table of [
      "attempt_log_database_locations",
      "attempt_log_database_routes",
      "run_batch_log_database_sizes",
      "run_batch_log_storage",
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE batch_id=ANY($1::text[])`, [batches]);
    }
    await database.pool.query(
      "DELETE FROM log_databases WHERE parent_database_id=ANY($1::text[])",
      [ids],
    );
    await database.pool.query("DELETE FROM log_databases WHERE id=ANY($1::text[])", [ids]);
    await database.pool.query("DELETE FROM runners WHERE id=$1", [runnerId]);
    for (const child of children.rows) {
      const source = new URL(urls[ids.indexOf(child.parent_database_id)]!);
      source.pathname = "/postgres";
      const { Pool } = createRequire(resolve("packages/db/package.json"))("pg") as {
        Pool: new (configuration: {
          connectionString: string;
          max: number;
        }) => Pick<typeof database.pool, "query" | "end">;
      };
      const admin = new Pool({ connectionString: source.toString(), max: 1 });
      try {
        if (!/^[a-z][a-z0-9_]+$/.test(child.physical_name))
          throw new Error("Invalid fixture database name");
        await admin.query(`DROP DATABASE IF EXISTS "${child.physical_name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
    if (!externalLogUrls) {
      // These random fixture databases can still have idle connections in the live Web pool.
      for (const name of names)
        await database.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await database.close();
  }
});

test("log server capacity reports its own data volume with explicit sampling state and desktop layouts", async ({
  page,
}) => {
  await ensureAdministrator(page);
  const directory =
    process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("E2E platform directory is required.");
  test.skip(
    new PlatformConfigurationStore(directory).read().mode === "lite",
    "PostgreSQL capacity is a Full log-server feature.",
  );
  const settings = (await (await page.request.get("/api/v1/settings/log-databases")).json()) as {
    activeDatabaseId: string;
    items: Array<{ id: string; active: boolean }>;
  };
  expect(settings.activeDatabaseId).toBeTruthy();
  const response = await page.request.get(
    `/api/v1/settings/log-databases/${settings.activeDatabaseId}/capacity?refresh=1`,
  );
  expect(response.status()).toBe(200);
  const capacity = (await response.json()) as {
    status: string;
    capacityBytes?: number;
    availableBytes?: number;
  };
  if (process.env.AUTOFORGE_TEST_POSTGRES_CAPACITY === "1") {
    expect(capacity.status).toBe("available");
    expect(capacity.capacityBytes).toBeGreaterThan(capacity.availableBytes!);
  }
  await page.goto("/settings/platform?section=logs");
  await page.getByRole("button", { name: "查看容量", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "日志库磁盘容量", exact: true });
  if (capacity.status === "available") await expect(dialog).toContainText("当前可用空间");
  else await expect(dialog).toContainText(/磁盘余量暂不可用|磁盘采样已过期/);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
    await expectPageFitsViewport(page);
    await page.screenshot({
      path: test.info().outputPath(`log-database-capacity-${width}.png`),
      fullPage: false,
    });
  }
  await dialog.getByRole("button", { name: "关闭日志库磁盘容量", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("all log servers automatically show heartbeat and capacity, isolate offline history and refresh after recovery", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const directory =
    process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("E2E platform directory is required.");
  const configuration = new PlatformConfigurationStore(directory).read();
  if (configuration.mode === "lite") {
    const unavailable = await page.request.get(
      `/api/v1/settings/log-databases/${randomUUID()}/status`,
    );
    expect(unavailable.status()).toBe(400);
    return;
  }
  if (!configuration.full) throw new Error("Full connection configuration is missing.");
  const database = createPostgresDatabase({
    connectionString: configuration.full.databaseUrl,
    migrationsFolder: resolve("packages/db/drizzle/postgresql"),
    poolMax: 1,
  });
  await database.ready;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const maintenance = `af_heartbeat_${suffix}`;
  const registered: Array<{ id: string; name: string; input: RegisterDailyLogServerInput }> = [];
  const settings = await browserJson<{
    activeDatabaseId: string;
    items: Array<{ id: string; name: string }>;
  }>(page, "/api/v1/settings/log-databases");
  const active = settings.body.items.find(({ id }) => id === settings.body.activeDatabaseId)!;
  expect(active).toBeTruthy();
  const targetUrl = `/api/v1/settings/storage-monitoring?kind=logs&databaseId=${active.id}`;
  const original = await browserJson<{ source: NodeExporterSource | null }>(page, targetUrl);
  let exporterUnavailable = false;
  let exporterRequests = 0;
  const capacities = [61, 48, 35, 22];
  const metrics = capacities
    .map((available, index) => {
      const labels = `device="/dev/logs${index}",fstype="xfs",mountpoint="/logs-${index}"`;
      return [
        `node_filesystem_size_bytes{${labels}} ${100 * 1024 ** 3}`,
        `node_filesystem_avail_bytes{${labels}} ${available * 1024 ** 3}`,
        `node_filesystem_device_error{${labels}} 0`,
      ].join("\n");
    })
    .join("\n");
  const exporter = createServer((_request, response) => {
    exporterRequests++;
    response.writeHead(exporterUnavailable ? 503 : 200, { "content-type": "text/plain" });
    response.end(`node_scrape_collector_success{collector="filesystem"} 1\n${metrics}\n`);
  });
  await new Promise<void>((resolve) => exporter.listen(0, "127.0.0.1", resolve));
  const address = exporter.address();
  if (!address || typeof address === "string") throw new Error("Fixture exporter has no port.");
  try {
    await database.pool.query(`CREATE DATABASE "${maintenance}"`);
    const connection = new URL(configuration.full.databaseUrl);
    for (let index = 0; index < 3; index++) {
      const input: RegisterDailyLogServerInput = {
        name: `${index === 2 ? "连接异常后恢复" : "保留历史读取"} · ${"日志服务器长名称检查".repeat(3)} ${suffix}-${index}`,
        host: connection.hostname.replace(/^\[|\]$/g, ""),
        port: Number(connection.port || 5432),
        username: decodeURIComponent(connection.username),
        password: decodeURIComponent(connection.password),
        maintenanceDatabase: maintenance,
        databasePrefix: `afh_${suffix}_${index}`,
        sslMode: "disable",
      };
      const created = await browserJson<{ id: string; name: string }>(
        page,
        "/api/v1/settings/log-databases",
        { method: "POST", body: input },
      );
      expect(created.status).toBe(201);
      registered.push({ ...created.body, input });
    }
    const targets = [active, ...registered];
    for (const [index, target] of targets.entries()) {
      const existing = await browserJson<{ revision: number }>(
        page,
        `/api/v1/settings/storage-monitoring?kind=logs&databaseId=${target.id}`,
      );
      const saved = await browserJson(page, "/api/v1/settings/storage-monitoring", {
        method: "PUT",
        body: {
          target: { kind: "logs", databaseId: target.id },
          source: {
            host: "127.0.0.1",
            port: address.port,
            tls: false,
            mountpoint: `/logs-${index}`,
          },
          revision: existing.body.revision,
        },
      });
      expect(saved.status).toBe(200);
    }
    // No log settings page is open: only the background heartbeat can reach this exporter.
    await expect
      .poll(() => exporterRequests, { timeout: 75_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThanOrEqual(targets.length);
    const offline = registered[2]!;
    const unreachable = new URL(connection);
    unreachable.port = "1";
    unreachable.pathname = `/${maintenance}`;
    const cipher = new AesGcmSecretCipher(configuration.secrets.masterKey);
    await database.pool.query("UPDATE log_databases SET connection_encrypted=$2 WHERE id=$1", [
      offline.id,
      cipher.encrypt(unreachable.toString(), `log-database:${offline.id}`),
    ]);
    const failed = await browserJson<LogDatabaseStatus>(
      page,
      `/api/v1/settings/log-databases/${offline.id}/status?refresh=1`,
    );
    expect(failed.status).toBe(200);
    expect(failed.body.heartbeat.status).toBe("unavailable");
    expect(failed.body.capacity.status).toBe("available");

    const seen = new Set<string>();
    const inFlight = new Set<string>();
    let maximum = 0;
    page.on("request", (request) => {
      const match = /\/api\/v1\/settings\/log-databases\/([^/]+)\/status$/.exec(
        new URL(request.url()).pathname,
      );
      if (!match) return;
      seen.add(match[1]!);
      inFlight.add(request.url());
      maximum = Math.max(maximum, inFlight.size);
    });
    page.on("requestfinished", (request) => inFlight.delete(request.url()));
    page.on("requestfailed", (request) => inFlight.delete(request.url()));
    await page.goto("/logs?section=databases");
    for (const [index, target] of targets.entries()) {
      const card = page.getByRole("region", { name: `日志服务器 ${target.name}`, exact: true });
      await expect(card).toContainText(index === 3 ? "连接异常" : "连接正常", { timeout: 15_000 });
      await expect(card).toContainText(`${capacities[index]} GiB`);
      await expect(card).toContainText("最近心跳");
    }
    expect(targets.every(({ id }) => seen.has(id))).toBe(true);
    expect(maximum).toBeLessThanOrEqual(2);
    for (const theme of ["light", "dark"]) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
        ]);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-color-mode", theme);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`log-database-heartbeats-${theme}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    const recovered = await browserJson(page, `/api/v1/settings/log-databases/${offline.id}`, {
      method: "PATCH",
      body: offline.input,
    });
    expect(recovered.status).toBe(200);
    const recoveredCard = page.getByRole("region", {
      name: `日志服务器 ${offline.name}`,
      exact: true,
    });
    await expect(recoveredCard).toContainText("连接正常", { timeout: 45_000 });
    await recoveredCard.getByRole("button", { name: "查看容量", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "日志库磁盘容量", exact: true });
    await expect(dialog).toContainText("当前可用空间");
    exporterUnavailable = true;
    await dialog.getByRole("button", { name: "刷新容量", exact: true }).click();
    await expect(dialog).toContainText("上次采样可用空间");
    await expect(recoveredCard).toContainText("连接正常");
    expect(
      (await browserJson<{ activeDatabaseId: string }>(page, "/api/v1/settings/log-databases")).body
        .activeDatabaseId,
    ).toBe(active.id);
    const children = await database.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM log_databases WHERE parent_database_id=ANY($1::text[])",
      [registered.map(({ id }) => id)],
    );
    expect(children.rows[0]!.count).toBe(0);
  } finally {
    try {
      await page.goto("/docs");
      const current = await browserJson<{ revision: number }>(page, targetUrl);
      await browserJson(page, "/api/v1/settings/storage-monitoring", {
        method: "PUT",
        body: {
          target: { kind: "logs", databaseId: active.id },
          source: original.body.source,
          revision: current.body.revision,
        },
      });
      for (const { id } of registered) {
        await database.pool.query("DELETE FROM storage_monitoring_settings WHERE target_id=$1", [
          `logs:${id}`,
        ]);
        await database.pool.query("DELETE FROM log_databases WHERE id=$1", [id]);
      }
      await database.pool.query(`DROP DATABASE IF EXISTS "${maintenance}" WITH (FORCE)`);
    } finally {
      const cleanup = await Promise.allSettled([
        database.close(),
        new Promise<void>((resolve, reject) =>
          exporter.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
      const failures = cleanup.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Log database monitoring fixture cleanup failed.",
        );
    }
  }
});
