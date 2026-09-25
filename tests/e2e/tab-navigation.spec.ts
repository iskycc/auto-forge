import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity } from "./support/ui-guard";

test("shared Ant motion follows browser preferences without resetting drafts", async ({ page }) => {
  await ensureAdministrator(page);
  await page.goto("/settings/platform?section=configuration");
  const address = page.locator('input[name="publicBaseUrl"]');
  await address.fill("https://motion-draft.example.invalid");
  const motionDuration = () =>
    address.evaluate((element) => {
      const duration = getComputedStyle(element)
        .getPropertyValue("--ant-motion-duration-mid")
        .trim();
      return parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
    });
  await expect.poll(motionDuration).toBeGreaterThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(motionDuration).toBeLessThanOrEqual(0.01);
  await expect(address).toHaveValue("https://motion-draft.example.invalid");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(motionDuration).toBeGreaterThan(1);
  await expect(address).toHaveValue("https://motion-draft.example.invalid");
});

test("reduced motion keeps the project popup positioned beside its trigger", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  // Make the selected project fall outside the first visible menu window even
  // when this scenario runs alone against a fresh database.
  for (let index = 0; index < 12; index++) {
    const slug = uniqueName(`popup-${index}`);
    const created = await browserJson(page, "/api/v1/projects", {
      method: "POST",
      body: { name: slug, slug },
    });
    expect(created.status).toBe(201);
  }
  await page.goto("/case-suites");
  await page.locator(".project-picker-trigger").click();
  const lastOption = page.getByRole("option").last();
  const selectedName = (await lastOption.innerText()).trim();
  await lastOption.click();
  await expect(page.locator(".project-picker-trigger")).toContainText(selectedName);
  for (const motion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion: motion });
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto("/case-suites");
      const trigger = page.locator(".project-picker-trigger");
      const initialScroll = await page.evaluate(() => window.scrollY);
      await trigger.click();
      const selected = page.getByRole("option", { selected: true });
      await expect(selected).toBeInViewport();
      expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
      await expectUiIntegrity(page);
      await capture(page, `project-popup-${motion}-${width}`);
      await selected.click();
      await expect(page.getByRole("listbox", { name: "项目列表" })).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
});

test("navigation and dialogs use bounded motion and restore keyboard focus", async ({ page }) => {
  await ensureAdministrator(page);
  await page.addInitScript(() => {
    const events: { name: string; duration: number }[] = [];
    Object.assign(window, { motionAudit: events });
    document.addEventListener("animationstart", (event) => {
      if (event.target instanceof HTMLElement)
        events.push({
          name: event.animationName,
          duration: parseFloat(getComputedStyle(event.target).animationDuration) * 1000,
        });
    });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<Element["animate"]>) {
      const animation = animate.apply(this, args);
      if (animation.id === "autoforge-content-enter")
        events.push({
          name: animation.id,
          duration: Number(animation.effect?.getTiming().duration),
        });
      return animation;
    };
  });
  const recordedMotion = () =>
    page.evaluate(
      () =>
        (window as unknown as { motionAudit: { name: string; duration: number }[] }).motionAudit,
    );
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/settings/access?section=users");
    const navigationIcon = page
      .getByRole("navigation", { name: "主导航", exact: true })
      .locator("a svg")
      .first();
    expect((await navigationIcon.boundingBox())!.width).toBeGreaterThanOrEqual(18);
    const trigger = page.getByRole("button", { name: "搜索配置", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "配置搜索", exact: true });
    await expect(dialog).toBeVisible();
    await expect
      .poll(async () => (await recordedMotion()).some((event) => /zoom.*in/i.test(event.name)))
      .toBe(true);
    await dialog.getByRole("button", { name: "关闭配置搜索", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect
      .poll(async () => (await recordedMotion()).some((event) => /zoom.*out/i.test(event.name)))
      .toBe(true);
    await page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("link", { name: "执行记录", exact: true })
      .click();
    await expect(page).toHaveURL(/\/execution-records/);
    await expect
      .poll(async () =>
        (await recordedMotion()).some((event) => event.name === "autoforge-content-enter"),
      )
      .toBe(true);
    const transitions = (await recordedMotion()).filter((event) =>
      /zoom|autoforge-content-enter/i.test(event.name),
    );
    for (const event of transitions) {
      expect(event.duration).toBeGreaterThan(0);
      expect(event.duration).toBeLessThanOrEqual(240);
    }
    await expectUiIntegrity(page);
    await capture(page, `route-motion-${width}`);
  }
});

test("case tabs keep their navigation in place across all DDT views", async ({ page }) => {
  await ensureAdministrator(page);
  await prepareCaseScope(page);
  for (const width of [1024, 1536, 1920]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/cases");
    const caseTabs = page.getByRole("navigation", { name: "用例类型", exact: true });
    await expect(caseTabs.getByRole("tab").first()).not.toHaveAttribute("aria-disabled", "true");
    const initialPosition = await position(caseTabs);
    await caseTabs.getByRole("link", { name: "DDT 管理", exact: true }).click();
    const ddtTabs = page.getByRole("tablist", { name: "DDT 功能", exact: true });
    await expect(ddtTabs).toBeVisible();
    await expect.poll(() => position(caseTabs)).toEqual(initialPosition);
    const ddtPosition = await position(ddtTabs);

    for (const tab of ["用例", "高级检索", "导入任务", "字段模板", "回收站", "开放 API", "概览"]) {
      await ddtTabs.getByRole("tab", { name: tab, exact: true }).click();
      await expect(ddtTabs.getByRole("tab", { name: tab, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(
        page.locator(".ddt-workspace").getByText("正在加载 DDT 工作台", { exact: true }),
      ).toBeHidden();
      await expect.poll(() => position(ddtTabs)).toEqual(ddtPosition);
      await expect.poll(() => position(caseTabs)).toEqual(initialPosition);
      await expectUiIntegrity(page);
      await capture(page, `ddt-${tab}-${width}`);
    }
    await caseTabs.getByRole("link", { name: "TestNG 用例", exact: true }).click();
    await expect(page.locator("#testng-case-panel")).toBeVisible();
    await expect.poll(() => position(caseTabs)).toEqual(initialPosition);
    await capture(page, `testng-${width}`);
  }
});

test("settings tabs retain the current page while loading and support browser history", async ({
  page,
}) => {
  await ensureAdministrator(page);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    for (const section of [
      {
        path: "/settings/platform?section=accounts",
        label: "平台设置模块",
        next: "数据保留",
        previous: "服务账号",
      },
      {
        path: "/settings/access?section=users",
        label: "组织管理模块",
        next: "角色权限",
        previous: "用户管理",
      },
    ]) {
      await page.goto(section.path);
      const tabs = page.getByRole("navigation", { name: section.label, exact: true });
      await expect(tabs.getByRole("tab").first()).not.toHaveAttribute("aria-disabled", "true");
      const initialPosition = await position(tabs);
      let releaseNavigation = () => {};
      const navigationReady = new Promise<void>((resolve) => {
        releaseNavigation = resolve;
      });
      let started = false;
      const pattern = "**/settings/**";
      await page.route(pattern, async (route) => {
        if (route.request().headers().rsc === "1") {
          started = true;
          await navigationReady;
        }
        await route.continue();
      });
      try {
        await tabs.getByRole("link", { name: section.next, exact: true }).click();
        await expect.poll(() => started).toBe(true);
        await expect(
          page.getByRole("heading", { name: section.previous, exact: true }).first(),
        ).toBeVisible();
        await expect.poll(() => position(tabs)).toEqual(initialPosition);
      } finally {
        releaseNavigation();
      }
      await expect(tabs.getByRole("link", { name: section.next, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await page.unroute(pattern);
      await expect.poll(() => position(tabs)).toEqual(initialPosition);
      await expectUiIntegrity(page);
      await capture(page, `${section.next}-${width}`);
      await page.goBack();
      await expect(tabs.getByRole("link", { name: section.previous, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect.poll(() => position(tabs)).toEqual(initialPosition);
      const remainingTabs =
        section.label === "平台设置模块"
          ? ["平台配置", "系统诊断", "存储空间"]
          : ["目录配置", "登录会话"];
      for (const label of remainingTabs) {
        await tabs.getByRole("link", { name: label, exact: true }).click();
        await expect(tabs.getByRole("link", { name: label, exact: true })).toHaveAttribute(
          "aria-current",
          "page",
        );
        await expect.poll(() => position(tabs)).toEqual(initialPosition);
        await expectUiIntegrity(page);
        await capture(page, `${label}-${width}`);
      }
      if (section.label === "平台设置模块") {
        await tabs.getByRole("link", { name: "平台配置", exact: true }).click();
        await expect(tabs.getByRole("link", { name: "平台配置", exact: true })).toHaveAttribute(
          "aria-current",
          "page",
        );
        await page.evaluate(() => window.scrollTo(0, 80));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(80);
        await tabs.getByRole("link", { name: "数据保留", exact: true }).click();
        await expect(tabs.getByRole("link", { name: "数据保留", exact: true })).toHaveAttribute(
          "aria-current",
          "page",
        );
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(80);
      }
    }
  }
});

test("reduced motion notifications close automatically and can be dismissed", async ({ page }) => {
  await ensureAdministrator(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings/platform?section=configuration");
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    await page.getByRole("button", { name: "保存平台配置", exact: true }).click();
    const notice = page.locator(".toast-viewport").getByRole("status");
    await expect(notice).toContainText("平台配置已保存");
    await notice.hover();
    await capture(page, `notification-reduced-motion-${width}`);
    if (width === 1024) await notice.getByRole("button", { name: "关闭通知", exact: true }).click();
    await expect(notice).toHaveCount(0, { timeout: 10_000 });
  }
});

test("tab navigation protects configuration drafts and respects reduced motion", async ({
  page,
}) => {
  await ensureAdministrator(page);
  await prepareCaseScope(page);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.goto("/settings/platform?section=configuration");
  const address = page.locator('input[name="publicBaseUrl"]');
  await address.fill("https://draft.example.invalid");
  const platformTabs = page.getByRole("navigation", { name: "平台设置模块", exact: true });
  await platformTabs.getByRole("tab", { name: "平台配置", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: "放弃未保存的配置？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(address).toHaveValue("https://draft.example.invalid");
  await expect(platformTabs.getByRole("link", { name: "平台配置", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await platformTabs.getByRole("link", { name: "服务账号", exact: true }).click();
  await confirm.getByRole("button", { name: "放弃并离开", exact: true }).click();
  await expect(page).toHaveURL(/section=accounts/);

  await page.goto("/cases?tab=ddt");
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "DDT 功能", exact: true });
  await expect(tabs.getByRole("tab").first()).not.toHaveAttribute("aria-disabled", "true");
  await tabs.getByRole("tab", { name: "概览", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(tabs.locator('[role="tab"][aria-selected="true"]')).toContainText("用例");
  expect(
    await page
      .locator(".ddt-workspace > .tab-content")
      .evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: 960 });
    await expectUiIntegrity(page);
    await capture(page, `ddt-reduced-motion-dark-${width}`);
  }
});

async function prepareCaseScope(page: Page) {
  const slug = uniqueName("tab-navigation");
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name: "Tab 切换验证", slug },
  });
  expect(project.status).toBe(201);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions`,
    {
      method: "POST",
      body: { name: "导航验证版本" },
    },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${project.body.id}/versions/${version.body.id}/stages`,
    {
      method: "POST",
      body: { name: "导航验证阶段" },
    },
  );
  expect(stage.status).toBe(201);
  await selectProjectContext(page, project.body.id, version.body.id, stage.body.id);
}

async function position(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return { x: Math.round(bounds!.x), y: Math.round(bounds!.y) };
}

async function capture(page: Page, name: string) {
  const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}
