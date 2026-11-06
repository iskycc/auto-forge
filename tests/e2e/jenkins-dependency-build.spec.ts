import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import type { JenkinsDependencyView } from "@autoforge/contracts";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity, waitForUiTransitions } from "./support/ui-guard";

test("version dependency pipeline submits real HTTP parameters, preserves credentials, and displays exact queued and finished builds", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const versionName = uniqueName("钱包依赖回归版本");
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: versionName } },
  );
  expect(version.status).toBe(201);
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  let phase: "queued" | "running" | "succeeded" | "failed" | "uncertain" = "queued";
  const submissions: Array<{ authorization: string; parameters: string }> = [];
  let queueId = 0;
  let buildNumber = 100;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://jenkins.local").pathname;
    if (
      request.headers.authorization !==
      `Basic ${Buffer.from("builder:e2e-private-token").toString("base64")}`
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "POST" && path.endsWith("/buildWithParameters")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      submissions.push({
        authorization: request.headers.authorization,
        parameters: Buffer.concat(chunks).toString("utf8"),
      });
      queueId++;
      buildNumber++;
      if (phase === "uncertain") {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(201, { location: `/jenkins/queue/item/${queueId}/` }).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (path.includes("/queue/item/")) {
      response.end(
        JSON.stringify(
          phase === "queued"
            ? { cancelled: false }
            : { executable: { number: buildNumber, url: `${jobUrl}${buildNumber}/` } },
        ),
      );
      return;
    }
    if (/\/\d+\/api\/json$/.test(path)) {
      response.end(
        JSON.stringify({
          number: buildNumber,
          url: `${jobUrl}${buildNumber}/`,
          queueId,
          building: phase === "running",
          result: phase === "running" ? null : phase === "failed" ? "FAILURE" : "SUCCESS",
          timestamp: 1793959200000,
          duration: 12345,
        }),
      );
      return;
    }
    response.end(JSON.stringify({ name: "update-dependencies", buildable: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Jenkins fixture address unavailable");
  const jobUrl = `http://127.0.0.1:${address.port}/jenkins/job/folder/job/update-dependencies/`;
  const base = `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions/${version.body.id}/jenkins-dependency`;
  const entry = page.getByRole("button", { name: "Jenkins 构建依赖", exact: true });
  const dialog = page.getByRole("dialog", { name: "Jenkins 构建依赖", exact: true });
  try {
    await page.goto("/settings/projects");
    await entry.click();
    await expect(dialog.getByLabel("Jenkins 任务地址", { exact: true })).toBeVisible();
    await dialog.getByLabel("Jenkins 任务地址", { exact: true }).fill(jobUrl);
    await dialog.getByLabel("用户名", { exact: true }).fill("builder");
    await dialog.getByLabel("API 密钥").fill("e2e-private-token");
    for (const [index, parameter] of [
      { name: "VERSION", value: "钱包 中文 &+" },
      { name: "EMPTY", value: "" },
      { name: "LONG_DESCRIPTION", value: "依赖更新需要传递的较长中文说明与构建参数 ".repeat(5) },
    ].entries()) {
      await dialog.getByRole("button", { name: "添加参数", exact: true }).click();
      await dialog.getByLabel(`参数名 ${index + 1}`, { exact: true }).fill(parameter.name);
      await dialog.getByLabel(`参数值 ${index + 1}`).fill(parameter.value);
    }
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "触发构建", exact: true })).toBeEnabled();
    const saved = await browserJson<JenkinsDependencyView>(page, base);
    expect(JSON.stringify(saved.body)).not.toContain("e2e-private-token");
    expect(saved.body.configuration?.apiTokenConfigured).toBe(true);
    await dialog.getByRole("tab", { name: "流水线配置", exact: true }).click();
    await expect(dialog.getByLabel("API 密钥")).toHaveValue("");
    await dialog.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(dialog).toContainText("连接成功，任务「update-dependencies」可构建。");
    for (const theme of ["light", "dark"]) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
        ]);
      for (const width of [1024, 1536]) {
        await dialog.getByRole("button", { name: "关闭Jenkins 构建依赖", exact: true }).click();
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await page.reload();
        await entry.scrollIntoViewIfNeeded();
        await waitForUiTransitions(page);
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`jenkins-build-entry-${theme}-${width}.png`),
          animations: "disabled",
        });
        await entry.click();
        await expect(dialog.getByRole("button", { name: "触发构建", exact: true })).toBeEnabled();
        await dialog.getByRole("tab", { name: "流水线配置", exact: true }).click();
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`jenkins-build-config-${theme}-${width}.png`),
          animations: "disabled",
        });
      }
    }
    await dialog.getByRole("tab", { name: "构建状态", exact: true }).click();
    await dialog.getByRole("button", { name: "触发构建", exact: true }).click();
    await expect(dialog).toContainText("排队中");
    expect(submissions).toHaveLength(1);
    const parameters = new URLSearchParams(submissions[0]!.parameters);
    expect(parameters.get("VERSION")).toBe("钱包 中文 &+");
    expect(parameters.has("EMPTY")).toBe(true);
    expect(parameters.get("EMPTY")).toBe("");
    expect(
      (
        await browserJson(page, `${base}/trigger`, {
          method: "POST",
          body: { requestId: "duplicate-other", expectedRevision: 1, expectedBuildRevision: 0 },
        })
      ).status,
    ).toBe(409);
    await dialog.getByRole("button", { name: "关闭Jenkins 构建依赖", exact: true }).click();
    await entry.click();
    await expect(dialog).toContainText("排队中");
    phase = "running";
    await dialog.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(dialog).toContainText("构建中");
    await expect(dialog.getByRole("link", { name: "#101" })).toHaveAttribute("target", "_blank");
    for (const theme of ["light", "dark"])
      for (const width of [1024, 1536]) {
        await dialog.getByRole("button", { name: "关闭Jenkins 构建依赖", exact: true }).click();
        await page
          .context()
          .addCookies([
            { name: "autoforge-color-mode", value: theme, url: new URL(page.url()).origin },
          ]);
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await page.reload();
        await entry.click();
        await expect(dialog).toContainText("构建中");
        await expect(
          dialog.getByRole("button", { name: "关闭Jenkins 构建依赖", exact: true }),
        ).toBeVisible();
        const jobLabel = dialog
          .locator(".ant-descriptions-item-label")
          .filter({ hasText: "Jenkins 任务" });
        await expect(jobLabel).toHaveCSS("white-space", "nowrap");
        expect((await jobLabel.boundingBox())!.width).toBeGreaterThanOrEqual(110);
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`jenkins-build-running-${theme}-${width}.png`),
          animations: "disabled",
        });
      }
    phase = "succeeded";
    await dialog.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(dialog).toContainText("构建成功");
    await expect(dialog.getByRole("button", { name: "触发构建", exact: true })).toBeEnabled();
    phase = "failed";
    await dialog.getByRole("button", { name: "触发构建", exact: true }).click();
    await dialog.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(dialog).toContainText("构建失败");
    phase = "uncertain";
    await dialog.getByRole("button", { name: "触发构建", exact: true }).click();
    await expect(dialog).toContainText("提交待核对");
    await expect(dialog.getByRole("button", { name: "触发构建", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "解除提交保护", exact: true })).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "解除提交保护", exact: true }).click();
    await expect(dialog).toContainText("已人工核对");
    expect(submissions).toHaveLength(3);
    await dialog.getByRole("button", { name: "关闭Jenkins 构建依赖", exact: true }).click();
    const nextVersion = await browserJson<{ id: string }>(
      page,
      `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
      { method: "POST", body: { name: uniqueName("独立版本") } },
    );
    expect(
      (
        await browserJson<JenkinsDependencyView>(
          page,
          `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions/${nextVersion.body.id}/jenkins-dependency`,
        )
      ).body.configuration,
    ).toBeUndefined();
    const anonymous = await page.context().browser()!.newContext();
    try {
      expect((await anonymous.request.get(new URL(base, page.url()).toString())).status()).toBe(
        401,
      );
    } finally {
      await anonymous.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
