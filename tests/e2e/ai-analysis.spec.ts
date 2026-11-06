import { test, expect } from "@playwright/test";
import { openExecutionCaseDetails } from "./support/execution-details";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { readExportedWorkbook } from "./support/export-workbook";
import { createAttemptLogStore } from "../../packages/db/src/attempt-log-store";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("AI model settings keep a compact switch with an aligned handle in both themes", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const screenshots = process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
  await mkdir(screenshots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page
      .context()
      .addCookies([
        { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
      ]);
    await page.goto("/settings/platform?section=ai");
    const enabled = page.getByRole("switch", { name: "启用 AI 初步分析", exact: true });
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await enabled.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(screenshots, `ai-switch-${theme}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      const track = await enabled.boundingBox();
      expect(track).not.toBeNull();
      expect(track!.width).toBeGreaterThanOrEqual(40);
      expect(track!.width).toBeLessThanOrEqual(48);
      expect(track!.height).toBeGreaterThanOrEqual(20);
      expect(track!.height).toBeLessThanOrEqual(24);
      const initiallyChecked = await enabled.isChecked();
      for (const checked of [!initiallyChecked, initiallyChecked]) {
        await enabled.focus();
        await page.keyboard.press("Space");
        await expect(enabled).toBeChecked({ checked });
        const handle = enabled.locator(".ant-switch-handle");
        await expect
          .poll(async () => {
            const bounds = (await handle.boundingBox())!;
            return Math.abs(
              checked
                ? track!.x + track!.width - bounds.x - bounds.width - 2
                : bounds.x - track!.x - 2,
            );
          })
          .toBeLessThanOrEqual(1);
        const bounds = (await handle.boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(track!.y);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(track!.y + track!.height);
        await page.screenshot({
          path: resolve(screenshots, `ai-switch-${theme}-${width}-${checked ? "on" : "off"}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
      await expectUiIntegrity(page);
    }
  }
});

test("AI settings, durable batch and single analysis, retry and partial export preserve the execution UI", async ({
  page,
}, testInfo) => {
  let attempts = 0;
  const receivedTools: string[][] = [];
  const inferenceRequests: Array<{
    stage: string;
    partId?: string;
    text: string;
    members: Array<{ displayName: string }>;
    messages: string;
  }> = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tools = input.tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    ) as string[];
    receivedTools.push(tools);
    if (tools[0] === "submit_ai_conclusion") {
      const instruction = JSON.parse(
        input.messages.find((message: { role: string }) => message.role === "user").content,
      );
      const payload = JSON.parse(
        input.messages.findLast((message: { role: string }) => message.role === "tool").content,
      );
      inferenceRequests.push({
        stage: instruction.stage ?? "single_full",
        partId: instruction.partId,
        text: payload.text ?? "",
        members: payload.members ?? [],
        messages: JSON.stringify(input.messages),
      });
    }
    if (tools[0] === "submit_ai_conclusion" && ++attempts === 1) {
      response.writeHead(429, { "retry-after": "1", "content-type": "application/json" });
      response.end('{"error":{"code":"rate_limit_exceeded"}}');
      return;
    }
    const evidence = input.messages.findLast(
      (message: { role: string }) => message.role === "tool",
    );
    const ref = evidence ? JSON.parse(evidence.content).evidenceId : "check";
    const argumentsValue =
      tools[0] === "connection_check"
        ? {}
        : {
            recommendation: "rerun_likely",
            reason: "合成模型建议：依赖瞬时不可用。",
            evidence: "日志出现连接重置；此为离线验收合成建议。",
            evidenceReferences: [ref],
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${attempts}`,
                  type: "function",
                  function: { name: tools[0], arguments: JSON.stringify(argumentsValue) },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolveListen) => model.listen(0, "127.0.0.1", resolveListen));
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("Model fixture did not listen.");
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Plain HTTP on a LAN has getRandomValues but does not expose randomUUID.
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: undefined,
        configurable: true,
      });
    });
    await ensureAdministrator(page);
    expect(await page.evaluate(() => typeof globalThis.crypto.randomUUID)).toBe("undefined");
    expect(await page.evaluate(() => typeof globalThis.crypto.getRandomValues)).toBe("function");
    const version = await browserJson<{ id: string }>(
      page,
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
      { method: "POST", body: { name: uniqueName("AI 验收版本") } },
    );
    await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
    const existing = await browserJson<{ revision: number }>(
      page,
      "/api/v1/ai-analysis/configuration",
    );
    const saved = await browserJson(page, "/api/v1/ai-analysis/configuration", {
      method: "PUT",
      body: {
        revision: existing.body.revision,
        apiKey: "e2e-only-key",
        configuration: {
          enabled: true,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: "offline-fixture",
          contextTokens: 32768,
          outputTokens: 2048,
          concurrency: 2,
          requestsPerMinute: 120,
          tokensPerMinute: 1000000,
          timeoutSeconds: 15,
          maximumRetries: 2,
          maximumEvidenceMiB: 4,
        },
      },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("e2e-only-key");
    await page.goto("/settings/platform?section=ai");
    const enabled = page.getByRole("switch", { name: "启用 AI 初步分析", exact: true });
    await expect(enabled).toBeChecked();
    await enabled.click();
    await expect(enabled).not.toBeChecked();
    await enabled.click();
    await page.getByRole("button", { name: "参考提示词（0）", exact: true }).click();
    const prompts = page.getByRole("dialog", { name: "AI 分析参考提示词", exact: true });
    for (const [index, content] of [
      "连接重置优先考虑瞬时波动。",
      "业务错误码需要结合协议判断。",
    ].entries()) {
      await prompts.getByRole("button", { name: /添加参考提示词$/u }).click();
      await prompts
        .getByLabel("提示词标题", { exact: true })
        .nth(index)
        .fill(`验收参考 ${index + 1}`);
      await prompts.getByLabel("提示词内容", { exact: true }).nth(index).fill(content);
    }
    const promptScreenshots =
      process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
    await mkdir(promptScreenshots, { recursive: true });
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(promptScreenshots, `ai-prompts-${width}.png`),
        animations: "disabled",
      });
    }
    await prompts.getByRole("button", { name: "应用到配置", exact: true }).click();
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.getByText("已保存；新分析请求立即使用此配置，无需重启。")).toBeVisible();
    await page.reload();
    await expect(enabled).toBeChecked();
    await expect(page.getByRole("button", { name: "参考提示词（2）", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(page.getByText("模型连接与工具调用检查通过。", { exact: true })).toBeVisible();
    const screenshots =
      process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
    await mkdir(screenshots, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
        ]);
      await page.reload();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshots, `ai-settings-${theme}-${width}.png`),
          animations: "disabled",
          fullPage: true,
        });
        await page.getByRole("button", { name: "参考提示词（2）", exact: true }).click();
        await expect(prompts.getByLabel("提示词内容", { exact: true }).first()).toHaveValue(
          "连接重置优先考虑瞬时波动。",
        );
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshots, `ai-prompts-${theme}-${width}.png`),
          animations: "disabled",
        });
        await prompts
          .locator(".ant-modal-footer")
          .getByRole("button", { name: "取消", exact: true })
          .click();
      }
    }
    const suffix = uniqueName("ai-analysis");
    const dataDirectory = process.env.AUTOFORGE_E2E_DATA_DIR;
    if (!dataDirectory) throw new Error("Missing E2E data directory.");
    const fixture = insertFailureAnalysisFixture(dataDirectory, version.body.id, suffix);
    const logStore = createAttemptLogStore(resolve(dataDirectory, "attempt-logs"));
    try {
      for (let index = 0; index < 4; index++)
        await logStore.appendChunks({
          batchId: fixture.batchId,
          attemptId: `attempt-run-failed-${index}-${suffix}`,
          receivedAt: new Date().toISOString(),
          chunks: [
            {
              stream: "stdout",
              sequence: 0,
              recordedAt: new Date().toISOString(),
              content:
                `用例独立正文${index}\n全文开始标识\n` +
                "普通业务日志\n".repeat(1800) +
                "全文结束标识\njava.lang.AssertionError: connection reset\n\tat example.SharedTest.run(SharedTest.java:10)",
            },
            {
              stream: "stderr",
              sequence: 0,
              recordedAt: new Date().toISOString(),
              content: "不应传给模型的 STDERR 内容\n",
            },
            {
              stream: "agent",
              sequence: 0,
              recordedAt: new Date().toISOString(),
              content: "Agent 完整诊断标识\n",
            },
          ],
        });
    } finally {
      logStore.close();
    }
    let acceptedButDisconnected = false;
    let interruptedRequestKey = "";
    const submittedKeys: string[] = [];
    await page.route("**/api/v1/ai-analysis", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const key = route.request().postDataJSON().requestKey as string;
      submittedKeys.push(key);
      if (!acceptedButDisconnected) {
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        acceptedButDisconnected = true;
        interruptedRequestKey = key;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.goto(`/run-batches/${fixture.batchId}`);
    await page
      .getByRole("button", { name: /AI 初步分析$/u })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "批次 AI 初步分析", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Failed to fetch", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "重新分析", exact: true }).click();
    await expect.poll(() => submittedKeys.length).toBe(2);
    expect(submittedKeys[1]).toBe(interruptedRequestKey);
    expect(interruptedRequestKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await expect
      .poll(
        async () => {
          const response = await browserJson<{ job: { status: string } } | null>(
            page,
            `/api/v1/ai-analysis?batchId=${fixture.batchId}`,
          );
          return response.body?.job.status;
        },
        { timeout: 90000 },
      )
      .toMatch(/completed|partial/u);
    await dialog.getByRole("button", { name: "刷新进度", exact: true }).click();
    await dialog.getByRole("button", { name: "查看完整初析", exact: true }).first().click();
    await expect(
      dialog
        .locator(".ant-table-expanded-row")
        .getByText(/合成模型建议/u)
        .first(),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "收起完整初析", exact: true }).first().click();
    expect(attempts).toBeGreaterThan(4);
    const smallGroups = inferenceRequests.filter((request) => request.stage === "small_group_full");
    expect(smallGroups.length).toBeGreaterThan(4);
    const batchLogs = smallGroups.map((request) => request.text).join("");
    for (let index = 0; index < 4; index++) expect(batchLogs).toContain(`用例独立正文${index}`);
    expect(batchLogs).toContain("全文开始标识");
    expect(batchLogs).toContain("全文结束标识");
    expect(smallGroups.every((request) => request.members.length === 1)).toBe(true);
    expect(
      inferenceRequests.every(
        (request) =>
          !/不应传给模型的 STDERR|Agent 完整诊断标识|TESTNG_RESULT|TESTNG_ASSERTIONS_FAILED/u.test(
            request.messages,
          ),
      ),
    ).toBe(true);
    await expect(dialog.getByText("查看堆栈分组初析", { exact: true })).toHaveCount(0);
    const grouped = await browserJson<{
      items: Array<{ conclusion: string }>;
      groups: Array<{ memberCount: number; processed: number; status: string }>;
    }>(page, `/api/v1/ai-analysis?batchId=${fixture.batchId}`);
    expect(grouped.body.groups).toEqual([
      expect.objectContaining({ memberCount: 4, processed: 4, status: "completed" }),
    ]);
    expect(new Set(grouped.body.items.map((item) => item.conclusion)).size).toBe(1);
    expect(grouped.body.items.every((item) => item.conclusion.split("\n").length === 3)).toBe(true);
    expect(
      receivedTools.every((tools) =>
        tools.every((tool) => ["connection_check", "submit_ai_conclusion"].includes(tool)),
      ),
    ).toBe(true);
    for (const theme of ["light", "dark"] as const) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
        ]);
      await page.reload();
      await page
        .getByRole("button", { name: /AI 初步分析$/u })
        .first()
        .click();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshots, `ai-conclusions-${theme}-${width}.png`),
          animations: "disabled",
        });
      }
      await page.getByRole("button", { name: "关闭", exact: true }).last().click();
    }
    await openExecutionCaseDetails(page);
    const singleResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/ai-analysis" &&
        response.request().method() === "POST" &&
        response.request().postDataJSON().attemptId === `attempt-run-failed-0-${suffix}`,
    );
    await page
      .getByRole("row")
      .filter({ hasText: fixture.failedNames[0] })
      .getByRole("button", { name: "AI 初步分析", exact: true })
      .click();
    const singleDialog = page.getByRole("dialog", { name: "用例 AI 初步分析", exact: true });
    await expect(singleDialog).toBeVisible();
    expect((await singleResponse).status()).toBe(202);
    await expect
      .poll(
        async () => {
          const response = await browserJson<{ job: { status: string; strategy: string } }>(
            page,
            `/api/v1/ai-analysis?batchId=${fixture.batchId}&attemptId=attempt-run-failed-0-${suffix}`,
          );
          return response.body?.job.status;
        },
        { timeout: 90000 },
      )
      .toBe("completed");
    const fullLogs = inferenceRequests
      .filter((request) => request.stage === "single_full")
      .map((request) => request.text)
      .join("");
    expect(fullLogs).toContain("全文开始标识");
    expect(fullLogs).toContain("全文结束标识");
    expect(fullLogs).not.toContain("Agent 完整诊断标识");
    expect(fullLogs).not.toContain("不应传给模型的 STDERR");
    expect(
      inferenceRequests.every(
        (request) =>
          request.messages.includes("验收参考 1") && request.messages.includes("验收参考 2"),
      ),
    ).toBe(true);
    await expect(singleDialog.getByText(/randomUUID/u)).toHaveCount(0);
    expect(submittedKeys.at(-1)).not.toBe(interruptedRequestKey);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `ai-single-http-${width}.png`),
        animations: "disabled",
      });
    }
    await singleDialog
      .locator(".ant-modal-footer")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const exported = await page.request.get(
      `/api/v1/run-batches/${fixture.batchId}/export?template=results&scope=final&outcomes=failed,blocked`,
    );
    expect(exported.status()).toBe(200);
    const workbook = await readExportedWorkbook(await exported.body());
    const sheet = workbook.worksheets[0]!;
    const headers = sheet.getRow(1).values as string[];
    expect(headers).toContain("AI 初步分析");
    expect(sheet.getRow(2).getCell(headers.indexOf("AI 初步分析")).text).toContain("合成模型建议");
    await openExecutionCaseDetails(page);
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page
        .getByRole("button", { name: /AI 初步分析$/u })
        .nth(1)
        .scrollIntoViewIfNeeded();
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `ai-case-actions-${width}.png`),
        animations: "disabled",
      });
    }
    const analysisExport = await page.request.get(
      `/api/v1/run-batches/${fixture.batchId}/export?template=failure-analysis&scope=final`,
    );
    expect(analysisExport.status()).toBe(200);
    const analysisSheet = (await readExportedWorkbook(await analysisExport.body())).worksheets[0]!;
    const analysisHeaders = analysisSheet.getRow(1).values as string[];
    expect(analysisHeaders.indexOf("AI 初步分析")).toBe(analysisHeaders.indexOf("失败堆栈") + 1);
    expect(analysisSheet.getRow(2).getCell(analysisHeaders.indexOf("AI 初步分析")).text).toContain(
      "可能重跑通过",
    );
    const updated = await browserJson(page, `/api/v1/case-suites/suite-${suffix}`, {
      method: "PATCH",
      body: {
        expectedRevision: 1,
        policy: {
          aiAnalysisAfterCompletion: true,
          runnerIds: [`analysis-runner-${suffix}`],
          projectVersionId: version.body.id,
        },
      },
    });
    expect(updated.status).toBe(200);
    await page.goto(`/case-suites/suite-${suffix}#suite-settings`);
    await expect(page.getByLabel("任务结束后自动进行 AI 初步分析")).toBeVisible();
    await expect(page.getByLabel("任务结束后自动进行 AI 初步分析")).toBeChecked();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.getByLabel("任务结束后自动进行 AI 初步分析").scrollIntoViewIfNeeded();
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `ai-suite-option-${width}.png`),
        animations: "disabled",
      });
    }
    const automaticFixture = insertFailureAnalysisFixture(
      dataDirectory,
      version.body.id,
      uniqueName("ai-automatic"),
    );
    const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
    try {
      database
        .prepare(
          "UPDATE run_batches SET policy_json=?,requested_by_username='e2e-admin',requested_by_source='local' WHERE id=?",
        )
        .run(
          JSON.stringify({
            projectVersionId: version.body.id,
            aiAnalysisAfterCompletion: true,
            aiAnalysisExecutionId: automaticFixture.batchId,
          }),
          automaticFixture.batchId,
        );
    } finally {
      database.close();
    }
    await expect
      .poll(
        async () => {
          const result = await browserJson<{ job: { status: string } } | null>(
            page,
            `/api/v1/ai-analysis?batchId=${automaticFixture.batchId}`,
          );
          return result.body?.job.status;
        },
        { timeout: 60000 },
      )
      .toMatch(/completed|partial/u);
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      model.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});
