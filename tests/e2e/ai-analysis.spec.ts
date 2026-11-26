import { test, expect } from "@playwright/test";
import { openExecutionCaseDetails } from "./support/execution-details";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
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

test("AI batch classification shares refined conclusions and exports ranked issues", async ({
  page,
}, testInfo) => {
  const stack = {
    wallet: "java.lang.AssertionError: wallet response failed",
    gateway:
      "java.lang.IllegalStateException: gateway response unavailable " +
      "upstream request evidence ".repeat(40) +
      "gateway-trace-marker",
    small: "java.lang.AssertionError: payload differs",
    fallback: "java.lang.IllegalStateException: duplicate response",
  };
  const cohorts = [
    { stack: stack.wallet, cause: "钱包数据库连接池", count: 6, rank: "第二类问题" },
    { stack: stack.wallet, cause: "钱包缓存过期", count: 5, rank: "第三类问题" },
    { stack: stack.wallet, cause: "钱包断言写错", count: 1 },
    { stack: stack.gateway, cause: "网关鉴权服务故障", count: 7, rank: "第一类问题" },
    { stack: stack.small, cause: "请求参数错误", count: 4 },
    { stack: stack.fallback, cause: "重复请求头", count: 3 },
    { stack: stack.fallback, cause: "重复流水号", count: 2 },
  ];
  const cases = cohorts.flatMap((cohort) => Array.from({ length: cohort.count }, () => cohort));
  const firstPass: Array<{ stackId: string; stack: string; count: number }> = [];
  const comparisons = new Map<number, Array<{ summary: string; reason: string }>>();
  const logFragments = new Map<number, string[]>();
  const independent = new Set<number>();
  const single = new Set<number>();
  let initialRequests = 0;
  let inFlightIndependent = 0;
  let releaseIndependent: () => void = () => undefined;
  const allowIndependent = new Promise<void>((release) => {
    releaseIndependent = release;
  });
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { messages, tools } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tool = tools[0].function.name;
    const context = JSON.parse(
      messages.find((message: { role: string }) => message.role === "user").content,
    );
    const evidence = JSON.parse(
      messages.findLast((message: { role: string }) => message.role === "tool").content,
    );
    let verdict: unknown;
    if (tool === "classify_ai_stacks") {
      if (++initialRequests === 1) {
        response.writeHead(429, { "retry-after": "1", "content-type": "application/json" });
        response.end('{"error":{"code":"rate_limit_exceeded"}}');
        return;
      }
      firstPass.push(...evidence.stacks);
      verdict = {
        categories: firstPass.slice(-evidence.stacks.length).map(({ stackId, stack }) => ({
          stackId,
          summary: `暂定 ${stack.split(": ")[1]}`,
        })),
      };
    } else {
      const run = /run-failed-(\d+)/u.exec(context.member ?? "")?.[1];
      const index = run === undefined ? -1 : Number(run);
      const text: string = evidence.text ?? "";
      const cause = /实际原因=(.+)/u.exec(text)?.[1];
      if (evidence.evidenceId.startsWith("stdout-"))
        logFragments.set(index, [...(logFragments.get(index) ?? []), text]);
      const conclusion = {
        recommendation: "business_issue_likely",
        reason: cause ? `根据业务日志确认：${cause}` : "已读取本片，继续等待实际原因。",
        evidence: cause ? `观察到 ${cause} 错误。` : "已读取日志片。",
        evidenceReferences: [evidence.evidenceId],
      };
      if (tool === "submit_ai_issue") {
        const candidates = context.existingCategories as Array<{
          categoryId: string;
          summary: string;
          reason: string;
        }>;
        comparisons.set(index, candidates);
        const match = candidates.find(({ summary }) => summary === cause);
        const improves = index === 1;
        const useExistingConclusion = !!match && !improves;
        verdict = {
          categoryId: match?.categoryId ?? null,
          useExistingConclusion,
          summary: useExistingConclusion ? "逐例复核时的临时简述" : cause,
          conclusion: {
            ...conclusion,
            reason: improves
              ? `连接池指标进一步证实：${cause}`
              : useExistingConclusion
                ? `逐例复核时的临时结论：${index}`
                : conclusion.reason,
          },
        };
      } else if (context.stage === "read_issue_member") {
        verdict = conclusion;
      } else if (context.stage === "independent_issue_member") {
        independent.add(index);
        inFlightIndependent++;
        try {
          await allowIndependent;
        } finally {
          inFlightIndependent--;
        }
        verdict = conclusion;
      } else {
        single.add(index);
        verdict = { ...conclusion, reason: "单例细查独有结论" };
      }
    }
    response.setHeader("content-type", "application/json");
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
                  id: "fixture-verdict",
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(verdict) },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((listening) => model.listen(0, "127.0.0.1", listening));
  try {
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("Model fixture did not listen.");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await ensureAdministrator(page);
    const version = await browserJson<{ id: string }>(
      page,
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
      { method: "POST", body: { name: uniqueName("AI 分类验收版本") } },
    );
    await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
    const configuration = await browserJson<{ revision: number }>(
      page,
      "/api/v1/ai-analysis/configuration",
    );
    expect(
      (
        await browserJson(page, "/api/v1/ai-analysis/configuration", {
          method: "PUT",
          body: {
            revision: configuration.body.revision,
            configuration: {
              enabled: true,
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              modelId: "classification-fixture",
              concurrency: 1,
              contextTokens: 32768,
              requestsPerMinute: 600,
              tokensPerMinute: 2_000_000,
              timeoutSeconds: 45,
            },
          },
        })
      ).status,
    ).toBe(200);
    await page.goto("/settings/platform?section=ai");
    await page.getByRole("spinbutton", { name: "AI 分析总并发" }).fill("3");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.getByText("已保存；新分析请求立即使用此配置，无需重启。")).toBeVisible();
    const suffix = uniqueName("ai-classification");
    const dataDirectory = process.env.AUTOFORGE_E2E_DATA_DIR;
    if (!dataDirectory) throw new Error("Missing E2E data directory.");
    const fixture = insertFailureAnalysisFixture(dataDirectory, version.body.id, suffix, {
      failureSummaries: cases.map((item) =>
        item.stack === stack.fallback ? "TestNG exit code:1" : item.stack,
      ),
    });
    const logs = createAttemptLogStore(resolve(dataDirectory, "attempt-logs"));
    try {
      const recordedAt = new Date().toISOString();
      for (const [index, item] of cases.entries()) {
        await logs.appendChunks({
          batchId: fixture.batchId,
          attemptId: `attempt-run-failed-${index}-${suffix}`,
          receivedAt: recordedAt,
          chunks: [
            {
              stream: "stdout",
              sequence: 0,
              recordedAt,
              content:
                `\u001b[32m全文起点 ${index}\u001b[0m\n` +
                (index === 1 ? "跨片业务正文\n".repeat(1000) : "") +
                `${item.stack}\n\tat e2e.Wallet.run(Wallet.java:${20 + index})\n\n` +
                `实际原因=${item.cause}\n全文结束 ${index}\nTestNG exit code:1\n`,
            },
            { stream: "stderr", sequence: 0, recordedAt, content: "额外诊断应忽略" },
          ],
        });
      }
    } finally {
      logs.close();
    }
    const statusPath = `/api/v1/ai-analysis?batchId=${fixture.batchId}`;
    const readStatus = () =>
      browserJson<{ job: { status: string; completed: number; classificationReviewed: number } }>(
        page,
        statusPath,
      ).then(({ body }) => body?.job);
    await page.goto(`/run-batches/${fixture.batchId}`);
    await page.getByRole("button", { name: "AI 初步分析", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "批次 AI 初步分析", exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(() => inFlightIndependent, { timeout: 90000 }).toBe(3);
    expect(await readStatus()).toMatchObject({
      status: "analyzing",
      completed: 18,
      classificationReviewed: 24,
    });
    const pending = await page.request.get(
      `/api/v1/run-batches/${fixture.batchId}/export?template=failure-analysis&scope=final`,
    );
    expect(pending.status()).toBe(200);
    const sheetWhileRunning = (await readExportedWorkbook(await pending.body())).worksheets[0]!;
    const categoryColumn = (sheetWhileRunning.getRow(1).values as string[]).indexOf(
      "AI分析问题类别",
    );
    expect(categoryColumn).toBeGreaterThan(0);
    const visibleCategories: string[] = [];
    sheetWhileRunning.eachRow((row, index) => {
      if (index > 1) visibleCategories.push(row.getCell(categoryColumn).text);
    });
    expect(visibleCategories.filter(Boolean)).toHaveLength(18);
    expect(visibleCategories.filter((value) => value === "")).toHaveLength(10);
    releaseIndependent();
    await expect.poll(readStatus, { timeout: 90000 }).toMatchObject({
      status: "completed",
      completed: cases.length,
      classificationReviewed: 24,
    });
    expect(initialRequests).toBe(2);
    expect(firstPass.map(({ stack, count }) => [stack, count])).toEqual(
      expect.arrayContaining([
        [stack.wallet, 12],
        [stack.gateway, 7],
        [stack.fallback, 5],
      ]),
    );
    expect(firstPass).toHaveLength(3);
    expect(comparisons.get(0)).toEqual([]);
    expect(comparisons.get(1)).toEqual([expect.objectContaining({ summary: "钱包数据库连接池" })]);
    expect(comparisons.get(2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "连接池指标进一步证实：钱包数据库连接池" }),
        expect.objectContaining({ summary: "钱包缓存过期" }),
        expect.objectContaining({ summary: "钱包断言写错" }),
      ]),
    );
    expect(comparisons.get(11)?.map(({ summary }) => summary)).toEqual(
      expect.arrayContaining(["钱包数据库连接池", "钱包缓存过期"]),
    );
    expect([...independent].sort((a, b) => a - b)).toEqual(
      cases.flatMap((item, index) => (item.rank ? [] : [index])),
    );
    expect(logFragments.get(1)?.length).toBeGreaterThan(1);
    for (const [index, item] of cases.entries()) {
      const stdout = logFragments.get(index)?.join("") ?? "";
      expect(stdout).toContain(`全文起点 ${index}`);
      expect(stdout).toContain(`实际原因=${item.cause}\n全文结束 ${index}`);
      expect(stdout).not.toMatch(/\u001b|TestNG exit code|额外诊断/u);
    }
    await dialog.getByRole("button", { name: "刷新进度", exact: true }).click();
    await expect(dialog.getByText(/组内已复核 24/u)).toBeVisible();
    await expect(dialog.getByText("分析完成", { exact: true }).first()).toBeVisible();
    const screenshots = testInfo.outputPath("screenshots");
    await mkdir(screenshots, { recursive: true });
    for (const [theme, width, height] of [
      ["light", 1024, 768],
      ["dark", 1536, 960],
    ] as const) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
        ]);
      await page.setViewportSize({ width, height });
      await page.reload();
      await page.getByRole("button", { name: "AI 初步分析", exact: true }).first().click();
      await expect(dialog.getByText(/组内已复核 24/u)).toBeVisible();
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `ai-classification-${theme}-${width}.png`),
        animations: "disabled",
      });
    }
    await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
    await openExecutionCaseDetails(page);
    const workspace = page.getByRole("dialog", { name: "用例执行明细", exact: true });
    await workspace
      .getByRole("row")
      .filter({ hasText: fixture.failedNames[0] })
      .getByRole("button", { name: "AI 初步分析", exact: true })
      .click();
    const singleDialog = page.getByRole("dialog", { name: "用例 AI 初步分析", exact: true });
    const attemptId = `attempt-run-failed-0-${suffix}`;
    await expect
      .poll(
        async () =>
          (
            await browserJson<{ job?: { status: string } }>(
              page,
              `${statusPath}&attemptId=${attemptId}`,
            )
          ).body?.job?.status,
        { timeout: 90000 },
      )
      .toBe("completed");
    expect([...single]).toEqual([0]);
    await expect(singleDialog.getByText(/单例细查独有结论/u).first()).toBeVisible();
    await singleDialog
      .locator(".ant-modal-footer")
      .getByRole("button", { name: "关闭", exact: true })
      .click();

    for (const template of ["results", "failure-analysis"] as const) {
      await workspace.getByRole("button", { name: "导出结果", exact: true }).click();
      const exportDialog = page.getByRole("dialog", { name: "导出执行结果", exact: true });
      await exportDialog
        .getByRole("radio", { name: /^最终结果/u })
        .locator("..")
        .click();
      if (template === "failure-analysis") {
        await exportDialog
          .getByRole("radio", { name: /失败用例分析清单/u })
          .locator("..")
          .click();
      } else {
        await exportDialog.getByRole("checkbox", { name: "成功", exact: true }).check();
      }
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        exportDialog
          .getByRole("button", {
            name: template === "results" ? "导出 Excel" : "导出分析清单",
            exact: true,
          })
          .click(),
      ]);
      const file = testInfo.outputPath(`ai-classification-${template}.xlsx`);
      await download.saveAs(file);
      const sheet = (await readExportedWorkbook(await readFile(file))).worksheets[0]!;
      const headers = sheet.getRow(1).values as string[];
      const resultColumn = headers.indexOf("AI 初步分析结果");
      expect(resultColumn).toBeGreaterThan(0);
      expect(headers.slice(resultColumn + 1, resultColumn + 4)).toEqual([
        "AI 初步分析原因",
        "AI分析问题类别",
        "问题类别简述",
      ]);
      if (template === "failure-analysis") expect(headers[resultColumn - 1]).toBe("失败堆栈");
      const exported = new Map<string, string[]>();
      sheet.eachRow((row, index) => {
        if (index > 1)
          exported.set(
            row.getCell(1).text,
            [0, 1, 2, 3].map((column) => row.getCell(resultColumn + column).text),
          );
      });
      for (const [index, item] of cases.entries()) {
        const row = exported.get(`e2e.analysis.Failed${index}Test`);
        expect(row?.[0]).toBe("业务问题需要提单");
        expect(row?.[1]).toContain(
          item.cause === "钱包数据库连接池" ? `连接池指标进一步证实：${item.cause}` : item.cause,
        );
        expect(row?.slice(2)).toEqual([item.rank ?? "非大批量问题", item.rank ? item.cause : ""]);
      }
      for (const rank of ["第一类问题", "第二类问题", "第三类问题"]) {
        const rows = [...exported.values()].filter((row) => row[2] === rank);
        expect(new Set(rows.map((row) => JSON.stringify(row))).size).toBe(1);
      }
      expect(exported.size).toBe(cases.length + (template === "results" ? 1 : 0));
      if (template === "results")
        expect(exported.get("e2e.analysis.PassedTest")).toEqual(["", "", "", ""]);
    }
  } finally {
    releaseIndependent();
    await new Promise<void>((close) => model.close(() => close()));
  }
});

test("AI reasoning effort persists and reaches connection checks with consistent desktop layout", async ({
  page,
}, testInfo) => {
  const requests: Array<{
    reasoning_effort?: string;
    max_tokens?: number;
    max_completion_tokens?: number;
  }> = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    response.setHeader("content-type", "application/json");
    if (body.reasoning_effort === "max") {
      response.writeHead(400);
      response.end(JSON.stringify({ error: { message: "unsupported reasoning_effort" } }));
      return;
    }
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
                  id: "check",
                  type: "function",
                  function: { name: "connection_check", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolveListen) => model.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("Model fixture did not listen.");
    await ensureAdministrator(page);
    await page.goto("/settings/platform?section=ai");
    await page
      .getByLabel("API 根地址", { exact: true })
      .fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel("模型 ID", { exact: true }).fill("reasoning-fixture");
    const effort = page.getByRole("combobox", { name: /思考强度$/u });
    await effort.click();
    await page.getByRole("option", { name: "最高（max）", exact: true }).click();
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(page.getByText(/模型端点不支持所选思考强度/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "检查连接", exact: true })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(requests.at(-1)).toMatchObject({ reasoning_effort: "max", max_completion_tokens: 2048 });
    await effort.click();
    await page.getByRole("option", { name: "模型默认", exact: true }).click();
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(page.getByText("模型连接与工具调用检查通过。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "检查连接", exact: true })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(requests.at(-1)).not.toHaveProperty("reasoning_effort");
    expect(requests.at(-1)).toHaveProperty("max_tokens", 512);
    await effort.click();
    await page.getByRole("option", { name: "高（high）", exact: true }).click();
    const selectedEffort = page
      .getByTitle("高（high）", { exact: true })
      .and(page.locator(".ant-select-content"));
    await expect(selectedEffort).toBeVisible();
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.getByText("已保存；新分析请求立即使用此配置，无需重启。")).toBeVisible();
    await page.reload();
    await expect(selectedEffort).toBeVisible();
    const saved = await browserJson<{ configuration: { reasoningEffort: string } }>(
      page,
      "/api/v1/ai-analysis/configuration",
    );
    expect(saved.body.configuration.reasoningEffort).toBe("high");
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(page.getByText("模型连接与工具调用检查通过。", { exact: true })).toBeVisible();
    expect(requests.at(-1)).toMatchObject({
      reasoning_effort: "high",
      max_completion_tokens: 2048,
    });
    const screenshots =
      process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
    await mkdir(screenshots, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
        ]);
      await page.goto("/settings/platform?section=ai");
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 1024 });
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshots, `ai-reasoning-${theme}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
        // Full-page capture temporarily resizes the viewport; settle its resize events before opening the popup.
        await page.evaluate(
          () =>
            new Promise<void>((resolveFrame) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
            }),
        );
        await effort.click();
        await expect(page.getByRole("option", { name: "最高（max）", exact: true })).toBeVisible();
        await page.screenshot({
          path: resolve(screenshots, `ai-reasoning-options-${theme}-${width}.png`),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
      }
    }
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      model.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});

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
      // Probe actionability without toggling; unlike an ElementHandle scroll,
      // this follows the live control if hydration replaces its initial DOM.
      await enabled.click({ trial: true });
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
  const reasoningEfforts: string[] = [];
  const inferenceRequests: Array<{
    stage: string;
    partId?: string;
    member?: string;
    evidenceId: string;
    text: string;
    members: Array<{ displayName: string }>;
    messages: string;
  }> = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    reasoningEfforts.push(input.reasoning_effort);
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
        member: instruction.member,
        evidenceId: payload.evidenceId,
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
          reasoningEffort: "high",
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
    await expect(page.getByText("高（high）", { exact: true })).toBeVisible();
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
                `\u001b[32m用例独立正文${index}\u001b[0m\n全文开始标识\npassword=e2e-business-password token=e2e-business-token\n` +
                `\u001b[31mjava.lang.AssertionError: connection reset\n\tat example.SharedTest.run(SharedTest.java:10)\u001b[0m\n\n` +
                "普通业务日志\n".repeat(index === 3 ? 9000 : 1800) +
                `全文结束标识\n用例尾部正文${index}\nTestNG exit code:1\n`,
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
    await expect(dialog.getByRole("columnheader", { name: "AI 初步分析结果" })).toBeVisible();
    await expect(dialog.getByRole("columnheader", { name: "AI 初步分析原因" })).toBeVisible();
    await dialog.getByRole("button", { name: "查看完整初析", exact: true }).first().click();
    const detail = dialog.locator(".ant-table-expanded-row").first();
    await expect(detail.getByText("AI 初步分析结果", { exact: true })).toBeVisible();
    await expect(detail.getByText("AI 初步分析原因", { exact: true })).toBeVisible();
    await expect(detail.getByText(/可能重跑通过/u)).toBeVisible();
    await expect(detail.getByText(/合成模型建议.*依赖瞬时不可用/u)).toBeVisible();
    await dialog.getByRole("button", { name: "收起完整初析", exact: true }).first().click();
    expect(attempts).toBeGreaterThan(4);
    const smallGroups = inferenceRequests.filter(
      (request) => request.stage === "independent_issue_member",
    );
    expect(smallGroups.length).toBeGreaterThan(4);
    const batchLogs = smallGroups.map((request) => request.text).join("");
    for (let index = 0; index < 4; index++) expect(batchLogs).toContain(`用例尾部正文${index}`);
    expect(batchLogs).toContain("全文开始标识");
    expect(batchLogs).toContain("java.lang.AssertionError: connection reset");
    expect(batchLogs).toContain("password=e2e-business-password token=e2e-business-token");
    expect(batchLogs).not.toContain("TestNG exit code:1");
    expect(batchLogs).toContain("全文结束标识");
    for (let index = 0; index < 4; index++) {
      const stdout = smallGroups
        .filter(
          (request) =>
            request.evidenceId.startsWith("stdout-") &&
            request.member === `run-failed-${index}-${suffix}`,
        )
        .map((request) => request.text)
        .join("");
      expect(stdout).toContain(`用例尾部正文${index}`);
      if (index === 3) {
        expect([...stdout].length).toBeGreaterThanOrEqual(25000);
        expect([...stdout].length).toBeLessThan(25000 + "普通业务日志\n".length);
        expect(stdout).toMatch(/^普通业务日志\n/u);
        expect(stdout).not.toContain("全文开始标识");
      } else {
        expect([...stdout].length).toBeGreaterThan(5000);
        expect([...stdout].length).toBeLessThan(50000);
        expect(stdout).toContain(`用例独立正文${index}\n全文开始标识`);
        expect(stdout).toContain("java.lang.AssertionError: connection reset");
      }
    }
    expect(smallGroups.every((request) => !/\\u001b|\u001b/u.test(request.messages))).toBe(true);
    expect(smallGroups.every((request) => request.member?.startsWith("run-failed-"))).toBe(true);
    expect(inferenceRequests.every((request) => !request.messages.includes("e2e-only-key"))).toBe(
      true,
    );
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
    expect(grouped.body.groups).toEqual([]);
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
      await expect(dialog.getByRole("cell", { name: /可能重跑通过/u }).first()).toBeVisible();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshots, `ai-conclusions-${theme}-${width}.png`),
          animations: "disabled",
        });
        await dialog.getByRole("button", { name: "查看完整初析", exact: true }).first().click();
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshots, `ai-conclusion-detail-${theme}-${width}.png`),
          animations: "disabled",
        });
        await dialog.getByRole("button", { name: "收起完整初析", exact: true }).first().click();
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
    await expect(singleDialog.getByText("分析完成", { exact: true }).first()).toBeVisible({
      timeout: 10000,
    });
    const fullLogs = inferenceRequests
      .filter((request) => request.stage === "single_full")
      .map((request) => request.text)
      .join("");
    expect(fullLogs).toContain("全文开始标识");
    expect(fullLogs).toContain("java.lang.AssertionError: connection reset");
    expect(fullLogs).toContain("password=e2e-business-password token=e2e-business-token");
    expect(fullLogs).not.toContain("TestNG exit code:1");
    expect(fullLogs).toContain("全文结束标识");
    expect(fullLogs).toContain("用例尾部正文0");
    expect(fullLogs).not.toMatch(/用例尾部正文[123]|\\u001b|\u001b/u);
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
    const resultColumn = headers.indexOf("AI 初步分析结果");
    const reasonColumn = headers.indexOf("AI 初步分析原因");
    expect(resultColumn).toBeGreaterThan(0);
    expect(reasonColumn).toBe(resultColumn + 1);
    expect(headers.indexOf("AI分析问题类别")).toBe(reasonColumn + 1);
    expect(headers.indexOf("问题类别简述")).toBe(reasonColumn + 2);
    expect(sheet.getRow(2).getCell(reasonColumn + 1).text).toBe("非大批量问题");
    expect(sheet.getRow(2).getCell(resultColumn).text).toBe("重跑通过");
    expect(sheet.getRow(2).getCell(reasonColumn).text).toContain("合成模型建议：依赖瞬时不可用。");
    expect(sheet.getRow(2).getCell(reasonColumn).text).toContain("依据：日志出现连接重置");
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
    const analysisResultColumn = analysisHeaders.indexOf("AI 初步分析结果");
    const analysisReasonColumn = analysisHeaders.indexOf("AI 初步分析原因");
    expect(analysisResultColumn).toBe(analysisHeaders.indexOf("失败堆栈") + 1);
    expect(analysisReasonColumn).toBe(analysisResultColumn + 1);
    expect(analysisHeaders.indexOf("AI分析问题类别")).toBe(analysisReasonColumn + 1);
    expect(analysisSheet.getRow(2).getCell(analysisReasonColumn + 1).text).toBe("非大批量问题");
    expect(analysisSheet.getRow(2).getCell(analysisResultColumn).text).toBe("重跑通过");
    expect(analysisSheet.getRow(2).getCell(analysisReasonColumn).text).toContain(
      "依据：日志出现连接重置",
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
    const automaticSuffix = uniqueName("ai-automatic");
    const automaticFixture = insertFailureAnalysisFixture(
      dataDirectory,
      version.body.id,
      automaticSuffix,
    );
    const automaticLogs = createAttemptLogStore(resolve(dataDirectory, "attempt-logs"));
    try {
      for (let index = 0; index < 4; index++)
        await automaticLogs.appendChunks({
          batchId: automaticFixture.batchId,
          attemptId: `attempt-run-failed-${index}-${automaticSuffix}`,
          receivedAt: new Date().toISOString(),
          chunks: [
            {
              stream: "stdout",
              sequence: 0,
              recordedAt: new Date().toISOString(),
              content: `渐进初析业务正文 ${index}\n\u001b[31mjava.lang.AssertionError: progressive connection reset\n\tat example.Progressive.run(Progressive.java:10)\u001b[0m\n全文结束 ${index}\n`,
            },
          ],
        });
    } finally {
      automaticLogs.close();
    }
    const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
    try {
      database.exec("BEGIN IMMEDIATE");
      database
        .prepare(
          "UPDATE run_batches SET status='running',retry_mode='round',retry_limit=2,current_round=3,scheduled_for=created_at,policy_json=?,requested_by_username='e2e-admin',requested_by_source='local' WHERE id=?",
        )
        .run(
          JSON.stringify({
            projectVersionId: version.body.id,
            aiAnalysisAfterCompletion: true,
            aiAnalysisExecutionId: automaticFixture.batchId,
          }),
          automaticFixture.batchId,
        );
      database
        .prepare("UPDATE execution_runs SET execution_round=3 WHERE batch_id=?")
        .run(automaticFixture.batchId);
      database
        .prepare(
          "UPDATE run_attempts SET execution_round=3 WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id=?)",
        )
        .run(automaticFixture.batchId);
      database
        .prepare("UPDATE execution_runs SET status='running',terminal_outcome=NULL WHERE id=?")
        .run(`run-failed-3-${automaticSuffix}`);
      database
        .prepare(
          "UPDATE run_attempts SET status='running',outcome=NULL,finished_at=NULL WHERE id=?",
        )
        .run(`attempt-run-failed-3-${automaticSuffix}`);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const manualRequestsBeforeAutomatic = submittedKeys.length;
    await page.goto(`/run-batches/${automaticFixture.batchId}`);
    await page
      .getByRole("button", { name: /AI 初步分析$/u })
      .first()
      .click();
    const progressiveDialog = page.getByRole("dialog", { name: "批次 AI 初步分析", exact: true });
    await expect
      .poll(
        async () => {
          const result = await browserJson<{
            job: {
              prepared: number;
              completed: number;
              total: number;
              acceptingFinalResults?: boolean;
            };
          } | null>(page, `/api/v1/ai-analysis?batchId=${automaticFixture.batchId}`);
          return result.body?.job;
        },
        { timeout: 60000 },
      )
      .toMatchObject({ prepared: 3, completed: 0, total: 3, acceptingFinalResults: true });
    const running = await browserJson<{ status: string }>(
      page,
      `/api/v1/run-batches/${automaticFixture.batchId}/overview`,
    );
    expect(running.body.status).toBe("running");
    expect(submittedKeys).toHaveLength(manualRequestsBeforeAutomatic);
    await expect(progressiveDialog.getByText(/末轮结果持续接收中/u)).toBeVisible();
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
        await expect(progressiveDialog.getByText(/末轮结果持续接收中/u)).toBeVisible();
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshots, `ai-progressive-${theme}-${width}.png`),
          animations: "disabled",
        });
      }
    }
    await progressiveDialog
      .locator(".ant-modal-footer")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const finishDatabase = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
    try {
      finishDatabase.exec("BEGIN IMMEDIATE");
      finishDatabase
        .prepare("UPDATE execution_runs SET status='failed',terminal_outcome='failed' WHERE id=?")
        .run(`run-failed-3-${automaticSuffix}`);
      finishDatabase
        .prepare(
          "UPDATE run_attempts SET status='failed',outcome='failed',finished_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), `attempt-run-failed-3-${automaticSuffix}`);
      finishDatabase
        .prepare("UPDATE run_batches SET status='failed',version=version+1 WHERE id=?")
        .run(automaticFixture.batchId);
      finishDatabase.exec("COMMIT");
    } finally {
      finishDatabase.close();
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
      .toBe("completed");
    const progressiveResult = await browserJson<{
      job: { total: number; completed: number };
      items: Array<{ conclusion: string }>;
      groups: Array<{ memberCount: number }>;
    }>(page, `/api/v1/ai-analysis?batchId=${automaticFixture.batchId}`);
    expect(progressiveResult.body.job).toMatchObject({ total: 4, completed: 4 });
    expect(progressiveResult.body.groups).toEqual([]);
    expect(inferenceRequests.some((input) => input.text.includes("渐进初析业务正文"))).toBe(true);
    expect(new Set(progressiveResult.body.items.map((item) => item.conclusion)).size).toBe(1);
    expect(reasoningEfforts.length).toBeGreaterThan(1);
    expect(new Set(reasoningEfforts)).toEqual(new Set(["high"]));
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      model.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});
