import { expect, test } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { writeViewerFixture } from "./fixture";
import { expectUiIntegrity } from "../e2e/support/ui-guard";

test("embedded Ant Design viewer renders safe colored Chinese logs and bounds navigation", async ({
  browser,
}, testInfo) => {
  const directory = testInfo.outputPath("archive");
  await mkdir(directory, { recursive: true });
  await writeViewerFixture(directory);
  const executable =
    process.env.AUTOFORGE_ARCHIVE_VIEWER_EXECUTABLE ??
    resolve("resources/log-archive-viewer/viewer-linux-amd64");
  const viewer = spawn(executable, ["--directory", directory, "--no-browser"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let url = "",
    failure = "";
  viewer.stdout.on("data", (chunk: Buffer) => {
    url = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? url;
  });
  viewer.stderr.on("data", (chunk: Buffer) => {
    failure += chunk.toString();
  });
  viewer.on("error", (cause) => {
    failure = cause.message;
  });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  let outbound = 0;
  try {
    await expect
      .poll(
        () => {
          if (failure) throw new Error(failure);
          return url;
        },
        { timeout: 15000 },
      )
      .not.toBe("");
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
      outbound++;
      return route.abort();
    });
    const archivePath = testInfo.outputPath("viewer-fixture.zip");
    await promisify(execFile)(
      executable,
      [
        "--pack",
        directory,
        "--output",
        archivePath,
        "--index",
        testInfo.outputPath("viewer-fixture.index.json"),
      ],
      { timeout: 15000 },
    );
    await promisify(execFile)(executable, ["--verify", archivePath], { timeout: 15000 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByRole("button", { name: /#42 Wallet/ }).click();
    await page.getByRole("button", { name: "查看日志", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".ansi-red").last()).toContainText("红色失败：钱包中文🚀");
    await expect(dialog.locator(".log-level-info").first()).toHaveText("INFO");
    await expect(dialog).not.toContainText("[31;1m");
    await expect(dialog).not.toContainText("c2VjcmV0");
    await expect(dialog).toContainText("<img src=x onerror=alert(1)>");
    expect(await dialog.locator("img").count()).toBe(0);
    await dialog.getByRole("searchbox", { name: "查找当前日志页" }).fill("钱包中文");
    await dialog.getByRole("searchbox", { name: "查找当前日志页" }).press("Enter");
    await expect(dialog.locator("mark")).toContainText("钱包中文");
    await dialog.getByRole("switch", { name: "自动换行" }).uncheck();
    await expect(dialog.locator("pre")).toHaveCSS("white-space", "pre");
    await dialog.getByRole("switch", { name: "自动换行" }).check();
    await dialog.getByRole("button", { name: "复制当前页", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("红色失败");
    expect(copied).not.toContain("\u001b");
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate((value) => localStorage.setItem("autoforge-archive-theme", value), mode);
      await page.reload();
      await page.getByRole("button", { name: "查看日志", exact: true }).first().click();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`offline-colored-log-${mode}-${width}.png`),
        });
        const red = await dialog
          .locator(".ansi-red")
          .first()
          .evaluate((element) => getComputedStyle(element).color);
        const normal = await dialog
          .locator("pre")
          .evaluate((element) => getComputedStyle(element).color);
        expect(red).not.toBe(normal);
      }
    }
    await dialog
      .getByRole("group", { name: "日志分页" })
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    await expect(dialog.locator(".ansi-green")).toContainText("绿色继续：第101块");
    await expect(dialog).not.toContainText("2m绿色");
    expect((await dialog.locator("pre").innerText()).length).toBeLessThanOrEqual(65536);
    await dialog.getByRole("searchbox", { name: "查找当前日志页" }).fill("大日志分段3");
    await dialog.getByRole("searchbox", { name: "查找当前日志页" }).press("Enter");
    await expect(dialog.locator("mark")).toContainText("大日志分段3");
    expect((await dialog.locator("pre").innerText()).length).toBeLessThanOrEqual(65536);
    await dialog
      .getByRole("group", { name: "日志分页" })
      .getByRole("button", { name: "上一页", exact: true })
      .click();
    await expect(dialog.locator(".ansi-red").last()).toContainText("红色失败");
    await dialog.getByText("stderr", { exact: true }).click();
    await expect(dialog).toContainText("stderr 中文警告");
    await dialog.getByText("Agent 诊断", { exact: true }).click();
    await expect(dialog).toContainText("此日志流暂无内容");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.route(
      "**/api/logs?*",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "读取暂时失败，请重试。" }),
        }),
      { times: 1 },
    );
    await page.getByRole("button", { name: "查看日志", exact: true }).nth(1).click();
    await expect(dialog.getByRole("alert")).toContainText("读取暂时失败");
    await dialog.getByRole("button", { name: "重试读取", exact: true }).click();
    await expect(dialog).toContainText("用例 2 的独立日志");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate((value) => localStorage.setItem("autoforge-archive-theme", value), mode);
      await page.reload();
      await expect(page.getByRole("button", { name: "查看日志", exact: true })).toHaveCount(50);
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await expectUiIntegrity(page);
        await page.screenshot({
          path: testInfo.outputPath(`offline-case-list-${mode}-${width}.png`),
        });
      }
    }
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByRole("button", { name: "查看日志", exact: true })).toHaveCount(11);
    await page.getByRole("button", { name: /返回执行批次/ }).click();
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate((value) => localStorage.setItem("autoforge-archive-theme", value), mode);
      await page.reload();
      await expect(page.getByRole("button", { name: /#42 Wallet/ })).toBeVisible();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await expectUiIntegrity(page);
        expect(
          await page.getByRole("button", { name: /#42 Wallet/ }).evaluate((button) => {
            const text = document.createTreeWalker(button, NodeFilter.SHOW_TEXT).nextNode();
            if (!text) return false;
            const prefix = document.createRange();
            prefix.setStart(text, 0);
            prefix.setEnd(text, Math.min(3, text.textContent?.length ?? 0));
            const visible = button.getBoundingClientRect();
            const start = prefix.getBoundingClientRect();
            return start.left >= visible.left && start.right <= visible.right;
          }),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`offline-batch-list-${mode}-${width}.png`),
        });
      }
    }
    expect(outbound).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    viewer.kill("SIGTERM");
    await context.close();
    await testInfo.attach("archive-fixture", { body: directory, contentType: "text/plain" });
  }
});
