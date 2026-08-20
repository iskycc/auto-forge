import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_PRIMITIVE = join(SOURCE_ROOT, "components", "ui.tsx");
const GLOBAL_STYLES = join(SOURCE_ROOT, "app", "globals.css");
const APP_SHELL = join(SOURCE_ROOT, "components", "app-shell.tsx");
const PLATFORM_SETTINGS = join(SOURCE_ROOT, "components", "platform-settings.tsx");
const ACCESS_SETTINGS = join(SOURCE_ROOT, "components", "access-settings.tsx");
const MANAGEMENT_PAGE = join(SOURCE_ROOT, "app", "settings", "page.tsx");
const CASE_SUITE_MANAGER = join(SOURCE_ROOT, "components", "case-suite-manager.tsx");
// Hidden inputs only carry filter state inside GET forms and have no visual
// styling, so the shared-component boundary applies to rendered controls only.
const NATIVE_CONTROL = /<(?:button|select|textarea)\b|<input\b(?![^>]*type="hidden")/;
const MINIMUM_READABLE_FONT_SIZE_PX = 12;
const REQUIRED_LAYOUT_CLASSES = [
  "content-card",
  "settings-page-header",
  "settings-tabs",
  "environment-manager-grid",
  "environment-detail-panel",
  "secret-manager-grid",
  "case-library-workspace",
  "case-directory-scroll",
  "case-inspector-pane",
  "runner-list",
  "project-structure-manager",
] as const;

describe("shared UI controls", () => {
  it("keeps native form controls inside the shared component boundary", () => {
    const violations = typescriptReactFiles(SOURCE_ROOT)
      .filter((file) => file !== UI_PRIMITIVE)
      .filter((file) => NATIVE_CONTROL.test(readFileSync(file, "utf8")))
      .map((file) => relative(SOURCE_ROOT, file));

    expect(violations).toEqual([]);
  });

  it("keeps explicit UI text at the documented readable size", () => {
    const stylesheet = readFileSync(GLOBAL_STYLES, "utf8");
    const undersizedDeclarations = [...stylesheet.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)]
      .map((match) => ({
        declaration: match[0],
        pixels: Number(match[1]) * (match[2] === "rem" ? 14 : 1),
      }))
      .filter(({ pixels }) => pixels > 0 && pixels < MINIMUM_READABLE_FONT_SIZE_PX);

    expect(undersizedDeclarations).toEqual([]);
  });

  it("defines structural styles for shared settings layouts", () => {
    const stylesheet = readFileSync(GLOBAL_STYLES, "utf8");
    const missingClasses = REQUIRED_LAYOUT_CLASSES.filter(
      (className) => !stylesheet.includes(`.${className}`),
    );

    expect(missingClasses).toEqual([]);
  });

  it("does not reference undeclared design tokens", () => {
    const stylesheet = readFileSync(GLOBAL_STYLES, "utf8");
    const declared = new Set(
      [...stylesheet.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]!),
    );
    const runtimeTokens = new Set(["--donut-value"]);
    const missing = [
      ...new Set([...stylesheet.matchAll(/var\((--[a-z0-9-]+)/gi)].map((match) => match[1]!)),
    ].filter((token) => !declared.has(token) && !runtimeTokens.has(token));

    expect(missing).toEqual([]);
  });

  it("keeps the focus indicator on the control instead of outlining its whole label", () => {
    const stylesheet = readFileSync(GLOBAL_STYLES, "utf8");

    expect(stylesheet).not.toContain("label:focus-within");
    expect(stylesheet).not.toMatch(/(?:input|select|textarea):focus-visible/);
    expect(stylesheet).toContain(".ui-input:focus");
  });

  it("exposes administrator capabilities inside administration groups", () => {
    const appShell = readFileSync(APP_SHELL, "utf8");
    const accessSettings = readFileSync(ACCESS_SETTINGS, "utf8");
    const managementPage = readFileSync(MANAGEMENT_PAGE, "utf8");

    expect(appShell).not.toContain("<span>管理中心</span>");
    expect(appShell).toContain('label: "用户管理"');
    expect(appShell).toContain('label: "目录配置"');
    expect(appShell).toContain('label: "平台配置"');
    expect(managementPage).toContain('redirect("/settings/platform?section=configuration")');
    expect(accessSettings).toContain('id="users"');
    expect(accessSettings).toContain('id="ldap"');
  });

  it("uses grouped navigation and a product project picker on dense workspaces", () => {
    const appShell = readFileSync(APP_SHELL, "utf8");
    const suiteManager = readFileSync(CASE_SUITE_MANAGER, "utf8");

    expect(appShell).toContain('label: "安全审计"');
    expect(appShell).toContain('label: "执行机组"');
    expect(appShell).toContain('label: "运维计划"');
    expect(appShell).not.toContain('label: "用例批跑"');
    expect(suiteManager).toContain("<ProjectPicker");
    expect(suiteManager).not.toContain("<Select");
  });

  it("keeps every first- and second-level sidebar tab at exactly four Chinese characters", () => {
    // 产品导航采用固定四字节奏。该约束属于信息架构，不允许在视觉改版中随意改回
    // “首页”“用例库”等长度不一致的标签；根级 pnpm test 会在 CI 执行本断言。
    const appShell = readFileSync(APP_SHELL, "utf8");
    const navigationSource = appShell.slice(
      appShell.indexOf("const navigation:"),
      appShell.indexOf("function isActive("),
    );
    const tabLabels = [
      ...navigationSource.matchAll(/(?:label|fallbackLabel): "([\p{Script=Han}]+)"/gu),
    ].map((match) => match[1]!);

    expect(tabLabels.length).toBeGreaterThan(20);
    expect(tabLabels.filter((label) => [...label].length !== 4)).toEqual([]);
    expect(appShell).toContain('<span className="nav-section-label">系统管理</span>');
  });

  it("presents the configurable JAR upload boundary in MiB", () => {
    const platformSettings = readFileSync(PLATFORM_SETTINGS, "utf8");

    expect(platformSettings).toContain("JAR 大小上限（MiB）");
    expect(platformSettings).toContain("bytesToMebibytes(initial.limits.maxJarBytes)");
  });
});

function typescriptReactFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptReactFiles(path);
    return entry.isFile() && extname(entry.name) === ".tsx" ? [path] : [];
  });
}
