import { test, expect } from "@playwright/test";
import { openExecutionCaseDetails } from "./support/execution-details";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { readExportedWorkbook } from "./support/export-workbook";
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
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tools = input.tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    ) as string[];
    receivedTools.push(tools);
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
            summary: "合成模型建议：先核对失败时刻的环境依赖；不能据此确认产品缺陷。",
            possibleCauses: ["执行环境依赖可能不可用。"],
            checks: ["核对错误发生时的服务监听和请求参数。"],
            evidenceReferences: [ref],
            limitations: ["此为验收合成建议，未连接真实模型。"],
            confidence: "low",
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
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.getByText("已保存；新分析请求立即使用此配置，无需重启。")).toBeVisible();
    await page.reload();
    await expect(enabled).toBeChecked();
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(page.getByText("模型连接与工具调用检查通过。", { exact: true })).toBeVisible();
    const screenshots =
      process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
    await mkdir(screenshots, { recursive: true });
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `ai-settings-${width}.png`),
        animations: "disabled",
        fullPage: true,
      });
    }
    const suffix = uniqueName("ai-analysis");
    const dataDirectory = process.env.AUTOFORGE_E2E_DATA_DIR;
    if (!dataDirectory) throw new Error("Missing E2E data directory.");
    const fixture = insertFailureAnalysisFixture(dataDirectory, version.body.id, suffix);
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
    expect(attempts).toBeGreaterThan(1);
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
    await page
      .getByRole("row")
      .filter({ hasText: fixture.failedNames[0] })
      .getByRole("button", { name: "AI 初步分析", exact: true })
      .click();
    const singleDialog = page.getByRole("dialog", { name: "用例 AI 初步分析", exact: true });
    await expect(singleDialog).toBeVisible();
    const singleResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/ai-analysis" &&
        response.request().method() === "POST" &&
        response.request().postDataJSON().attemptId === `attempt-run-failed-0-${suffix}`,
    );
    await singleDialog.getByRole("button", { name: "重新分析", exact: true }).click();
    expect((await singleResponse).status()).toBe(202);
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
