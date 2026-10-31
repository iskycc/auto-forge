import { expect, test, type Page } from "@playwright/test";
import {
  browserJson,
  ensureAdministrator,
  login,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";
import {
  createInitializationProject,
  seedInitializationSource,
} from "./support/version-initialization";

test("file storage navigation groups sources, storage and archives without losing legacy filters", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  await expect(navigation.getByRole("link", { name: "文件管理", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "文件来源", exact: true })).toHaveCount(0);
  const { projectId } = await createInitializationProject(page);
  const source = await seedInitializationSource(page, projectId);
  await selectProjectContext(page, projectId, source.projectVersionId, source.testStageId);
  await page.goto("/objects");
  const tabs = page.getByRole("navigation", { name: "文件管理模块", exact: true });
  await expect(page.getByRole("heading", { name: "文件与 JAR 来源", exact: true })).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "initialization.jar" }).first(),
  ).toBeVisible();
  for (const section of [
    { label: "文件来源", key: "sources" },
    { label: "存储空间", key: "storage" },
    { label: "日志归档", key: "archives" },
  ]) {
    await tabs.getByRole("link", { name: section.label, exact: true }).click();
    await expect(tabs.getByRole("link", { name: section.label, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(navigation.getByRole("link", { name: "文件管理", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    if (section.key === "storage")
      await expect(page.locator(".storage-inventory-tree")).toBeVisible({ timeout: 30_000 });
    if (section.key === "archives")
      await expect(
        page.getByRole("button", { name: "生成并校验归档包", exact: true }),
      ).toBeVisible();
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: 960 });
      await expectUiIntegrity(page);
      await page.screenshot({
        path: testInfo.outputPath(`files-storage-${section.key}-${width}.png`),
      });
    }
  }
  await page.goBack();
  await expect(tabs.getByRole("link", { name: "存储空间", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.reload();
  await expect(tabs.getByRole("link", { name: "存储空间", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto("/settings/platform?section=storage&category=case-source&query=initialization");
  await expect(page).toHaveURL(
    /\/objects\?section=storage&category=case-source&query=initialization$/,
  );
  await expect(page.getByRole("textbox", { name: "搜索文件名称或路径" })).toHaveValue(
    "initialization",
  );
  await page.goto("/settings/platform?section=archives");
  await expect(page).toHaveURL(/\/objects\?section=archives$/);
  await page.goto("/settings/platform?section=configuration");
  const settingsTabs = page.getByRole("navigation", { name: "平台设置模块", exact: true });
  await expect(settingsTabs.getByRole("link", { name: "存储空间", exact: true })).toHaveCount(0);
  await expect(settingsTabs.getByRole("link", { name: "日志归档", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "搜索配置", exact: true }).click();
  const search = page.getByRole("dialog", { name: "配置搜索", exact: true });
  await search.getByRole("searchbox", { name: "搜索配置项" }).fill("日志归档");
  await search.getByRole("link", { name: /日志归档/ }).click();
  await expect(page).toHaveURL(/\/objects\?section=archives$/);
});

async function createScopedReader(page: Page, permission: "settings.read" | "case_source.read") {
  const key = uniqueName("file-reader");
  const role = await browserJson<{ id: string }>(page, "/api/v1/roles", {
    method: "POST",
    body: { key, name: key, scope: "system", permissions: [permission] },
  });
  expect(role.status).toBe(201);
  const password = "FileReader!Password123";
  const username = uniqueName("file-reader");
  const user = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: username, password, forcePasswordChange: false },
  });
  expect(user.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/users/${user.body.id}/system-roles`, {
        method: "POST",
        body: { roleId: role.body.id },
      })
    ).status,
  ).toBe(204);
  return { username, password };
}

test("file storage tabs retain separate source and global settings permission boundaries", async ({
  page,
  browser,
}) => {
  await ensureAdministrator(page);
  for (const permission of ["settings.read", "case_source.read"] as const) {
    const account = await createScopedReader(page, permission);
    const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
    context.setDefaultTimeout(30_000);
    try {
      const reader = await context.newPage();
      await login(reader, account.username, account.password);
      await reader.goto("/objects");
      const tabs = reader.getByRole("navigation", { name: "文件管理模块", exact: true });
      const settingsOnly = permission === "settings.read";
      await expect(
        tabs.getByRole("link", { name: settingsOnly ? "存储空间" : "文件来源", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        tabs.getByRole("link", { name: settingsOnly ? "文件来源" : "存储空间", exact: true }),
      ).toHaveCount(0);
      await expect(tabs.getByRole("link", { name: "日志归档", exact: true })).toHaveCount(
        settingsOnly ? 1 : 0,
      );
      if (settingsOnly) {
        await tabs.getByRole("link", { name: "日志归档", exact: true }).click();
        await expect(
          reader.getByRole("button", { name: "生成并校验归档包", exact: true }),
        ).toBeDisabled();
      }
      await reader.goto(`/objects?section=${settingsOnly ? "sources" : "storage"}`);
      await expect(reader).toHaveURL(/\/forbidden$/);
      expect(
        (
          await reader.request.get(
            settingsOnly ? "/api/v1/case-sources" : "/api/v1/settings/storage",
          )
        ).status(),
      ).toBe(403);
    } finally {
      await context.close();
    }
  }
});
