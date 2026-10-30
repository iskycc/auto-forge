import { expect, test } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import type { LogArchiveJob } from "@autoforge/contracts";
import { LocalObjectStore } from "../../packages/object-store/src/local-object-store";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { createAttemptLogStore } from "@autoforge/db/sqlite";
import { ensureAdministrator, browserJson } from "./support/session";
import { openHistoryFixtureConnection } from "./support/history-fixture-connection";
import { expectUiIntegrity, waitForUiTransitions } from "./support/ui-guard";

test("monthly log archive downloads an offline viewer and keeps public logs after verified cleanup", async ({
  page,
  browser,
}, testInfo) => {
  await ensureAdministrator(page);
  const directory =
    process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("E2E platform directory is required.");
  const configuration = new PlatformConfigurationStore(directory).read();
  const database = await openHistoryFixtureConnection(
    configuration.mode === "lite"
      ? { directory }
      : { postgresUrl: configuration.full!.databaseUrl },
  );
  const now = new Date().toISOString(),
    batchId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`,
    extraBatchId = `ffffffff-ffff-4fff-afff-${randomUUID().slice(-12)}`,
    projectId = randomUUID(),
    versionId = randomUUID(),
    stageId = randomUUID(),
    runnerId = randomUUID();
  const projectName = `Wallet 归档验收项目 ${projectId.slice(-4)}`;
  const attempts: string[] = [];
  const logs = createAttemptLogStore(join(directory, "attempt-logs"));
  try {
    const booleanFalse = configuration.mode === "lite" ? "0" : "FALSE";
    await database.execute(
      `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES(?,?,?,${booleanFalse},${booleanFalse},'linux','amd64','e2e',1,'{}','[]',1,0,?,?,?)`,
      [runnerId, runnerId, "归档验收执行节点", now, now, now],
    );
    await database.execute(
      "INSERT INTO projects(id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?)",
      [projectId, projectName, `archive-${projectId}`, now, now],
    );
    await database.execute(
      "INSERT INTO project_versions(id,project_id,name,normalized_name,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      [versionId, projectId, "1.0 归档验收", "1.0 归档验收", now, now],
    );
    await database.execute(
      "INSERT INTO test_stages(id,project_id,project_version_id,name,normalized_name,position,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)",
      [stageId, projectId, versionId, "回归阶段", "回归阶段", now, now],
    );
    await database.execute(
      `INSERT INTO run_batches(id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at,attempt_logs_path) VALUES(?,${database.nextBatchSequence},'archive-e2e','Wallet · 中文 DDT 月度归档验收任务',1,'failed',0,24,'[]',?,?,?)`,
      [batchId, now, now, logs.relativeStorePath(batchId)],
    );
    for (let index = 0; index < 24; index++) {
      const runId = randomUUID();
      await database.execute(
        "INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,case_type,status,attempt_count,created_at,updated_at) VALUES(?,?,?,1,?,?,'ddt','failed',2,?,?)",
        [
          runId,
          batchId,
          runId,
          `Wallet_中文用例_${index + 1}`,
          `com.example.wallet.ArchiveCase${index + 1}`,
          now,
          now,
        ],
      );
      for (let round = 1; round <= 2; round++) {
        const attemptId = randomUUID();
        attempts.push(attemptId);
        await database.execute(
          "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,scheduling_score,created_at,started_at,finished_at) VALUES(?,?,?,?,?,'failed',1,?,?,?)",
          [attemptId, runId, runnerId, round, round, now, now, now],
        );
        await logs.appendChunks({
          batchId,
          attemptId,
          receivedAt: now,
          chunks: Array.from({ length: 120 }, (_, sequence) => ({
            stream: "stdout",
            sequence,
            content: `Wallet 离线归档：第 ${round} 轮，第 ${sequence + 1} 条；中文 CaseId 正常。\n`,
            recordedAt: now,
          })),
        });
      }
    }
    await database.execute("UPDATE run_batches SET project_id=?,policy_json=? WHERE id=?", [
      projectId,
      JSON.stringify({ projectVersionId: versionId, testStageId: stageId }),
      batchId,
    ]);
    await database.execute(
      `INSERT INTO run_batches(id,sequence_number,project_id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at,attempt_logs_path) VALUES(?,${database.nextBatchSequence},?,'archive-e2e-extra','分卷边界普通用例任务',1,'succeeded',0,1,'[]',?,?,?)`,
      [extraBatchId, projectId, now, now, logs.relativeStorePath(extraBatchId)],
    );
    const extraAttempt = randomUUID();
    await database.execute(
      "INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES(?,?,?,1,'普通分卷用例','example.VolumeCase','succeeded',1,?,?)",
      [extraAttempt, extraBatchId, extraAttempt, now, now],
    );
    await database.execute(
      "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at,started_at,finished_at) VALUES(?,?,?,1,'succeeded',1,?,?,?)",
      [extraAttempt, extraAttempt, runnerId, now, now, now],
    );
    await logs.appendChunks({
      batchId: extraBatchId,
      attemptId: extraAttempt,
      receivedAt: now,
      chunks: [
        { stream: "stdout", sequence: 0, content: "第二卷普通用例日志完整。", recordedAt: now },
      ],
    });
    await database.execute(
      "INSERT INTO public_attempt_access(attempt_id,created_by,created_at) VALUES(?,'archive-e2e',?)",
      [attempts[0]!, now],
    );
    if (configuration.mode === "full") {
      await database.execute(
        "INSERT INTO run_batch_log_storage(batch_id,database_id) VALUES(?,NULL)",
        [batchId],
      );
      await database.execute(
        "INSERT INTO run_batch_log_storage(batch_id,database_id) VALUES(?,NULL)",
        [extraBatchId],
      );
      if (configuration.deployment === "distributed")
        await database.execute(
          "INSERT INTO run_batch_log_locations(batch_id,node_id,stored_bytes) VALUES(?,?,?)",
          [batchId, configuration.nodeId!, logs.batchStoreStats([batchId]).get(batchId) ?? 0],
        );
      if (configuration.deployment === "distributed")
        await database.execute(
          "INSERT INTO run_batch_log_locations(batch_id,node_id,stored_bytes) VALUES(?,?,?)",
          [
            extraBatchId,
            configuration.nodeId!,
            logs.batchStoreStats([extraBatchId]).get(extraBatchId) ?? 0,
          ],
        );
    }
  } finally {
    logs.close();
    await database.close();
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const month = `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
  await page.goto("/settings/platform?section=archives");
  await page.getByRole("button", { name: /归档选项$/ }).click();
  const optionsDialog = page.getByRole("dialog", { name: "归档选项", exact: true });
  await optionsDialog.getByLabel("项目范围", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option-content")
    .filter({ hasText: projectName })
    .click();
  await optionsDialog.getByRole("spinbutton", { name: /分卷目标（MiB）$/ }).fill("1");
  await optionsDialog.getByRole("spinbutton", { name: /最小磁盘安全余量（MiB）$/ }).fill("256");
  await optionsDialog.getByRole("spinbutton", { name: /磁盘安全余量比例（%）$/ }).fill("1");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await waitForUiTransitions(page);
    await expectUiIntegrity(page);
    await page.screenshot({
      path: testInfo.outputPath(`archive-options-${width}.png`),
      fullPage: false,
    });
  }
  await optionsDialog.getByRole("button", { name: "保存选项", exact: true }).click();
  await page.getByRole("textbox", { name: "执行结束月份", exact: true }).fill(month);
  await page.getByRole("textbox", { name: "执行结束月份", exact: true }).press("Tab");
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/settings/log-archives" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "生成并校验归档包", exact: true }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(202);
  const job = (await response.json()) as LogArchiveJob;
  expect(job.projectId).toBe(projectId);
  const archiveRow = page.locator(`tr[data-row-key="${job.id}"]`);
  await expect
    .poll(
      async () => {
        const jobs = await browserJson<{
          items: Array<{ id: string; status: string; errorMessage?: string }>;
        }>(page, "/api/v1/settings/log-archives");
        const item = jobs.body.items.find((item) => item.id === job.id);
        if (item?.status === "failed") throw new Error(item.errorMessage);
        return item?.status;
      },
      { timeout: 120000 },
    )
    .toBe("ready");
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(archiveRow.getByText("已校验，待清理", { exact: true })).toBeVisible();
  await expect(archiveRow.getByRole("button", { name: "删除平台副本", exact: true })).toBeVisible();
  await expect(
    archiveRow.getByRole("button", { name: "删除平台副本", exact: true }),
  ).toBeDisabled();
  await expect(archiveRow).toContainText("请先完成“清理原日志”");
  await expect
    .poll(
      async () => {
        const result = await browserJson<{ items: LogArchiveJob[] }>(
          page,
          "/api/v1/settings/log-archives",
        );
        return result.body.items.filter(
          (item) => item.groupId === job.groupId && item.status === "ready",
        ).length;
      },
      { timeout: 120000 },
    )
    .toBe(2);
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  const groupJobs = (
    await browserJson<{ items: LogArchiveJob[] }>(page, "/api/v1/settings/log-archives")
  ).body.items.filter((item) => item.groupId === job.groupId);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const item of groupJobs)
    await page.locator(`tr[data-row-key="${item.id}"]`).getByRole("checkbox").check();
  const copied = new Map<string, string>();
  for (const label of ["复制 wget 命令", "复制 curl 命令", "复制下载直链"]) {
    await page.getByRole("button", { name: "复制下载方式", exact: true }).hover();
    const generated = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/v1/settings/log-archives/download-links" &&
        candidate.request().method() === "POST",
    );
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    expect((await generated).status()).toBe(200);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(
        label.includes("wget")
          ? "wget --tries"
          : label.includes("curl")
            ? "curl --fail"
            : "?ticket=",
      );
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split("\n")).toHaveLength(2);
    copied.set(label, text);
  }
  const beforeDownloads = (
    await browserJson<{ items: LogArchiveJob[] }>(page, "/api/v1/settings/log-archives")
  ).body.items.filter((item) => item.groupId === job.groupId);
  expect(beforeDownloads.every((item) => !item.downloadedAt)).toBe(true);
  for (const label of ["复制 wget 命令", "复制 curl 命令"]) {
    const downloadDirectory = testInfo.outputPath(
      label.includes("wget") ? "wget-downloads" : "curl-downloads",
    );
    await mkdir(downloadDirectory, { recursive: true });
    await promisify(execFile)("sh", ["-eu", "-c", copied.get(label)!], {
      cwd: downloadDirectory,
      timeout: 60000,
      maxBuffer: 65536,
    });
    for (const item of groupJobs) {
      const content = await readFile(join(downloadDirectory, item.filename!));
      expect(content.byteLength).toBe(item.archiveBytes);
      expect(createHash("sha256").update(content).digest("hex")).toBe(item.sha256);
    }
  }
  const unauthenticated = await browser.newContext();
  try {
    for (const url of copied.get("复制下载直链")!.split("\n")) {
      const response = await unauthenticated.request.get(url);
      expect(response.status()).toBe(200);
      const body = await response.body();
      expect(createHash("sha256").update(body).digest("hex")).toBe(
        response.headers()["x-content-sha256"],
      );
      await response.dispose();
    }
  } finally {
    await unauthenticated.close();
  }
  const afterDownloads = (
    await browserJson<{ items: LogArchiveJob[] }>(page, "/api/v1/settings/log-archives")
  ).body.items.filter((item) => item.groupId === job.groupId);
  expect(afterDownloads.every((item) => item.downloadedAt)).toBe(true);
  // Captures below include the selected rows and batch-copy toolbar.
  // Downloading has not yet enabled deletion: the source cleanup gate is separate.
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(
    archiveRow.getByRole("button", { name: "删除平台副本", exact: true }),
  ).toBeDisabled();
  for (const mode of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: mode, url: new URL(page.url()).origin }]);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.reload();
      for (const item of groupJobs)
        await page.locator(`tr[data-row-key="${item.id}"]`).getByRole("checkbox").check();
      await waitForUiTransitions(page);
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`monthly-archive-${mode}-${width}.png`),
        fullPage: false,
      });
    }
  }

  const downloadEvent = page.waitForEvent("download");
  await archiveRow.getByRole("link", { name: "下载归档", exact: true }).click();
  const download = await downloadEvent;
  const archivePath = testInfo.outputPath("monthly-archive.zip");
  await download.saveAs(archivePath);
  await archiveRow.getByRole("button", { name: "清理原日志", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认清理已归档的原日志", exact: true });
  await expect(confirmation).toContainText("清理原日志不能撤销");
  await confirmation.getByRole("button", { name: "确认清理原日志", exact: true }).click();
  await expect
    .poll(
      async () => {
        const jobs = await browserJson<{
          items: Array<{ id: string; status: string; errorMessage?: string }>;
        }>(page, "/api/v1/settings/log-archives");
        return jobs.body.items.find((item) => item.id === job.id)?.status;
      },
      { timeout: 120000 },
    )
    .toBe("completed");
  await page.goto(`/CaseLog?ExecutionId=${attempts[0]}`);
  await expect(page.getByRole("main")).toContainText("Wallet 离线归档", { timeout: 30000 });
  const extracted = testInfo.outputPath("offline-archive");
  await mkdir(extracted, { recursive: true });
  for (const [name, content] of Object.entries(unzipSync(await readFile(archivePath)))) {
    const path = resolve(extracted, name);
    if (!path.startsWith(extracted + sep)) throw new Error("Unsafe archive entry");
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  const executable = join(
    extracted,
    `viewer-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`,
  );
  await chmod(executable, 0o700);
  let viewer: ChildProcess | undefined;
  const offline = await browser.newContext();
  let outbound = 0;
  try {
    let viewerUrl = "",
      failure = "";
    viewer = spawn(executable, ["--directory", extracted, "--no-browser"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    viewer.stdout!.on("data", (chunk: Buffer) => {
      viewerUrl = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? viewerUrl;
    });
    viewer.stderr!.on("data", (chunk: Buffer) => {
      failure += chunk.toString();
    });
    viewer.once("error", (cause) => {
      failure = cause.message;
    });
    await expect
      .poll(
        () => {
          if (failure) throw new Error(failure);
          return viewerUrl;
        },
        { timeout: 15000 },
      )
      .not.toBe("");
    await offline.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === new URL(viewerUrl).origin)
        return route.continue();
      outbound++;
      return route.abort();
    });
    const viewerPage = await offline.newPage();
    await viewerPage.goto(viewerUrl);
    await viewerPage.getByRole("button", { name: /Wallet · 中文 DDT 月度归档验收任务/ }).click();
    await viewerPage.getByRole("button", { name: "查看日志", exact: true }).first().click();
    await expect(viewerPage.getByRole("dialog")).toContainText("Wallet 离线归档");
    await viewerPage
      .getByRole("dialog")
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await expect(viewerPage.getByRole("dialog")).toContainText("第 101 条");
    await viewerPage.getByRole("button", { name: "关闭", exact: true }).click();
    for (const mode of ["light", "dark"]) {
      await viewerPage.evaluate(
        (value) => localStorage.setItem("autoforge-archive-theme", value),
        mode,
      );
      for (const width of [1024, 1536]) {
        await viewerPage.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await viewerPage.goto(viewerUrl);
        await expect(
          viewerPage.getByRole("button", { name: /Wallet · 中文 DDT 月度归档验收任务/ }),
        ).toBeVisible();
        await expectUiIntegrity(viewerPage);
        await viewerPage.screenshot({
          path: testInfo.outputPath(`offline-viewer-${mode}-${width}.png`),
          fullPage: true,
        });
        await viewerPage
          .getByRole("button", { name: /Wallet · 中文 DDT 月度归档验收任务/ })
          .click();
        await expectUiIntegrity(viewerPage);
        await viewerPage.screenshot({
          path: testInfo.outputPath(`offline-cases-${mode}-${width}.png`),
          fullPage: true,
        });
        await viewerPage.getByRole("button", { name: "查看日志", exact: true }).first().click();
        await expect(viewerPage.getByRole("dialog")).toContainText("Wallet 离线归档");
        await waitForUiTransitions(viewerPage);
        await expectUiIntegrity(viewerPage);
        await viewerPage.screenshot({
          path: testInfo.outputPath(`offline-log-${mode}-${width}.png`),
        });
      }
    }
    expect(outbound).toBe(0);
  } finally {
    viewer?.kill("SIGTERM");
    await offline.close();
  }
  await expect
    .poll(
      async () => {
        const result = await browserJson<{ items: LogArchiveJob[] }>(
          page,
          "/api/v1/settings/log-archives",
        );
        return result.body.items.find(
          (item) => item.groupId === job.groupId && item.volumeNumber === 2,
        )?.status;
      },
      { timeout: 120000 },
    )
    .toBe("ready");
  const endpoint = configuration.full ? new URL(configuration.full.minio.endpoint) : undefined;
  const objects =
    configuration.mode === "full"
      ? new (await import("../../packages/object-store/src/minio-object-store")).MinioObjectStore({
          endPoint: endpoint!.hostname,
          port: Number(endpoint!.port || 80),
          useSSL: endpoint!.protocol === "https:",
          accessKey: configuration.full!.minio.accessKey,
          secretKey: configuration.full!.minio.secretKey,
          bucket: configuration.full!.minio.bucket,
          region: configuration.full!.minio.region,
        })
      : new LocalObjectStore(directory);
  const stored = (await objects.list({ prefix: `log-archives/${month}/${job.id}/`, limit: 10 }))
    .items;
  expect(stored).toHaveLength(2);
  for (const mode of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: mode, url: "http://127.0.0.1:3100" }]);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.goto("/settings/platform?section=archives");
      await archiveRow.getByRole("button", { name: /删除平台副本$/ }).click();
      const dialog = page.getByRole("dialog", { name: "确认下载并删除平台归档副本", exact: true });
      await expect(
        dialog.getByRole("button", { name: "确认删除平台副本", exact: true }),
      ).toBeDisabled();
      await waitForUiTransitions(page);
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`archive-removal-${mode}-${width}.png`),
        fullPage: false,
      });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    }
  }
  await archiveRow.getByRole("button", { name: /删除平台副本$/ }).click();
  const removal = page.getByRole("dialog", { name: "确认下载并删除平台归档副本", exact: true });
  await removal
    .getByRole("checkbox", { name: "我已完整下载本卷，并确认离线查看正常", exact: true })
    .check();
  await removal.getByRole("button", { name: "确认删除平台副本", exact: true }).click();
  await expect
    .poll(
      async () => {
        const result = await browserJson<{ items: LogArchiveJob[] }>(
          page,
          "/api/v1/settings/log-archives",
        );
        return result.body.items.find((item) => item.id === job.id)?.copyState;
      },
      { timeout: 120000 },
    )
    .toBe("deleted");
  for (const entry of stored) expect(await objects.exists(entry.objectKey)).toBe(false);
  expect(
    (await page.request.get(`/api/v1/settings/log-archives/${job.id}/download`)).status(),
  ).toBe(410);
  const remaining = (
    await browserJson<{ items: LogArchiveJob[] }>(page, "/api/v1/settings/log-archives")
  ).body.items.find((item) => item.groupId === job.groupId && item.volumeNumber === 2)!;
  expect(remaining.copyState).toBe("retained");
  expect(
    (await objects.list({ prefix: `log-archives/${month}/${remaining.id}/`, limit: 10 })).items,
  ).toHaveLength(2);
  for (const mode of ["light", "dark"]) {
    await page
      .context()
      .addCookies([{ name: "autoforge-color-mode", value: mode, url: "http://127.0.0.1:3100" }]);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.goto(`/CaseLog?ExecutionId=${attempts[0]}`);
      await expect(page.getByRole("main")).toContainText("日志已离线归档");
      await expect(page.getByRole("main")).toContainText("com.example.wallet.ArchiveCase1");
      await waitForUiTransitions(page);
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`offline-public-log-${mode}-${width}.png`),
        fullPage: true,
      });
    }
  }
  const retainedUrl = copied
    .get("复制下载直链")!
    .split("\n")
    .find((url) => url.includes(remaining.id))!;
  const logout = await browserJson(page, "/api/v1/auth/logout", { method: "POST" });
  expect([200, 204]).toContain(logout.status);
  const expired = await browser.newContext();
  try {
    expect((await expired.request.get(retainedUrl)).status()).toBe(401);
  } finally {
    await expired.close();
  }
});
