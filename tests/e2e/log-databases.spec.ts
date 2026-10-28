import { expect, test } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { createPostgresDatabase, PostgresLogDatabaseRepository } from "@autoforge/db/postgres";
import { AesGcmSecretCipher } from "../../apps/web/src/lib/secret-cipher-core";
import { ensureAdministrator } from "./support/session";
import { expectPageFitsViewport, waitForUiTransitions } from "./support/ui-guard";

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
  const names = [`logs_e2e_${namespace}_a`, `logs_e2e_${namespace}_b`];
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
    if (!externalLogUrls)
      for (const name of names) await database.pool.query(`CREATE DATABASE "${name}"`);
    for (let index = 0; index < names.length; index++) {
      await page.getByRole("button", { name: /添加日志数据库$/ }).click();
      const dialog = page.getByRole("dialog", { name: "添加日志数据库", exact: true });
      await dialog.getByLabel("日志库名称", { exact: true }).fill(labels[index]!);
      await dialog.getByLabel("PostgreSQL 连接地址", { exact: true }).fill(urls[index]!);
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
        await page.getByRole("button", { name: /添加日志数据库$/ }).click();
        await waitForUiTransitions(page);
        await page.screenshot({
          path: testInfo.outputPath(`log-database-dialog-${theme}-${width}.png`),
          fullPage: true,
        });
        await page
          .getByRole("dialog", { name: "添加日志数据库", exact: true })
          .getByRole("button", { name: "取消", exact: true })
          .click();
      }
    }
  } finally {
    await choose(oldSetting.activeDatabaseId);
    for (const id of ids)
      await registry.withDatabase(id, async (pool) => {
        await pool.query("DELETE FROM log_batches WHERE batch_id=ANY($1::text[])", [batches]);
      });
    await registry.close();
    await database.pool.query("DELETE FROM run_batches WHERE id=ANY($1::text[])", [batches]);
    await database.pool.query(
      "DELETE FROM run_batch_log_storage WHERE database_id=ANY($1::text[])",
      [ids],
    );
    await database.pool.query("DELETE FROM log_databases WHERE id=ANY($1::text[])", [ids]);
    await database.pool.query("DELETE FROM runners WHERE id=$1", [runnerId]);
    if (!externalLogUrls)
      for (const name of names)
        await database.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await database.close();
  }
});
