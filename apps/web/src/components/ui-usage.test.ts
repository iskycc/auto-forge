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
const GLOBAL_RUN_DIALOG = join(SOURCE_ROOT, "components", "global-run-dialog.tsx");
const GLOBAL_PROJECT_SWITCHER = join(SOURCE_ROOT, "components", "global-project-switcher.tsx");
const CASE_SUITE_EDITOR = join(SOURCE_ROOT, "components", "case-suite-editor.tsx");
const CASE_SELECTION_TABLE = join(SOURCE_ROOT, "components", "case-selection-table.tsx");
const CASE_SUITE_DETAILS = join(SOURCE_ROOT, "components", "case-suite-details.tsx");
const ROUTE_LOADING_SKELETON = join(SOURCE_ROOT, "components", "route-loading-skeleton.tsx");
const AUTOMATION_PAGE = join(SOURCE_ROOT, "app", "settings", "automation", "page.tsx");
const AUTOMATION_OPERATIONS = join(SOURCE_ROOT, "components", "automation-operations.tsx");
const PROJECT_SWITCH_FREE_FILES = [
  join(SOURCE_ROOT, "app", "cases", "page.tsx"),
  join(SOURCE_ROOT, "app", "execution-records", "page.tsx"),
  join(SOURCE_ROOT, "app", "insights", "page.tsx"),
  join(SOURCE_ROOT, "app", "objects", "page.tsx"),
  join(SOURCE_ROOT, "app", "audit", "page.tsx"),
  join(SOURCE_ROOT, "components", "case-suite-manager.tsx"),
  join(SOURCE_ROOT, "components", "jar-importer.tsx"),
  join(SOURCE_ROOT, "components", "project-membership-manager.tsx"),
] as const;
// Hidden inputs only carry filter state inside GET forms and have no visual
// styling, so the shared-component boundary applies to rendered controls only.
const NATIVE_CONTROL = /<(?:button|select|textarea)\b|<input\b(?![^>]*type="hidden")/;
const MINIMUM_READABLE_FONT_SIZE_PX = 12;
const REQUIRED_LAYOUT_CLASSES = [
  "content-card",
  "settings-page-header",
  "settings-tabs",
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

  it("exposes administrator capabilities as first-level navigation", () => {
    const appShell = readFileSync(APP_SHELL, "utf8");
    const accessSettings = readFileSync(ACCESS_SETTINGS, "utf8");
    const managementPage = readFileSync(MANAGEMENT_PAGE, "utf8");

    expect(appShell).not.toContain("<span>管理中心</span>");
    expect(appShell).toContain('label: "访问管理"');
    expect(appShell).toContain('label: "平台设置"');
    expect(appShell).not.toContain("AdministrationGroup");
    expect(appShell).not.toContain("nav-group-toggle");
    expect(managementPage).toContain('redirect("/settings/platform?section=configuration")');
    expect(accessSettings).toContain('id="users"');
    expect(accessSettings).toContain('id="ldap"');
  });

  it("uses flat navigation and one global project hierarchy picker", () => {
    const appShell = readFileSync(APP_SHELL, "utf8");
    const suiteManager = readFileSync(CASE_SUITE_MANAGER, "utf8");
    const projectPickerConsumers = typescriptReactFiles(SOURCE_ROOT)
      .filter((file) => readFileSync(file, "utf8").includes("<ProjectPicker"))
      .map((file) => relative(SOURCE_ROOT, file));

    expect(appShell).toContain('label: "安全审计"');
    expect(appShell).toContain('label: "执行机组"');
    expect(appShell).toContain('label: "运维计划"');
    expect(appShell).not.toContain('label: "用例批跑"');
    expect(appShell).toContain("<GlobalProjectSwitcher");
    expect(appShell).toContain("projectVersions={projectVersions}");
    const globalSwitcher = readFileSync(GLOBAL_PROJECT_SWITCHER, "utf8");
    expect(globalSwitcher).toContain('aria-label="当前项目版本"');
    expect(globalSwitcher).toContain('aria-label="当前测试阶段"');
    expect(suiteManager).not.toContain("<ProjectPicker");
    expect(suiteManager).not.toContain('aria-label="当前项目"');
    expect(suiteManager).not.toContain('aria-label="当前项目版本"');
    expect(suiteManager).not.toContain('aria-label="当前测试阶段"');
    expect(projectPickerConsumers).toEqual(["components/global-project-switcher.tsx"]);
  });

  it("does not reintroduce page-level project switches or execution parameter overrides", () => {
    for (const file of PROJECT_SWITCH_FREE_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(SOURCE_ROOT, file)).not.toContain("切换项目");
      expect(source, relative(SOURCE_ROOT, file)).not.toContain("项目筛选");
      expect(source, relative(SOURCE_ROOT, file)).not.toContain('name="projectId"');
      expect(source, relative(SOURCE_ROOT, file)).not.toContain('name="projectVersionId"');
      expect(source, relative(SOURCE_ROOT, file)).not.toContain('name="testStageId"');
    }

    const suiteEditor = readFileSync(CASE_SUITE_EDITOR, "utf8");
    const runDialog = readFileSync(GLOBAL_RUN_DIALOG, "utf8");
    const caseSelection = readFileSync(CASE_SELECTION_TABLE, "utf8");
    expect(suiteEditor).not.toContain('name="parameters"');
    expect(suiteEditor).not.toContain("参数模板");
    expect(runDialog).not.toContain("单用例参数覆盖");
    expect(runDialog).not.toContain("parseParameterRecord");
    expect(runDialog).toContain("useState(true)");
    expect(caseSelection).not.toContain("环境、参数和 Adapter 地址");
    expect(caseSelection).toContain("重跑策略与 Adapter 地址");
  });

  it("keeps operations free of stale platform and LDAP configuration shortcuts", () => {
    const operationsSource = [AUTOMATION_PAGE, AUTOMATION_OPERATIONS]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(operationsSource).not.toContain('href="/settings/platform');
    expect(operationsSource).not.toContain('href="/settings/access?section=ldap');
  });

  it("keeps low-frequency management actions in dialogs", () => {
    for (const component of [
      CASE_SUITE_MANAGER,
      CASE_SUITE_EDITOR,
      ACCESS_SETTINGS,
      join(SOURCE_ROOT, "components", "project-membership-manager.tsx"),
      join(SOURCE_ROOT, "components", "project-structure-manager.tsx"),
      join(SOURCE_ROOT, "components", "runner-group-manager.tsx"),
      join(SOURCE_ROOT, "components", "operations-settings.tsx"),
    ]) {
      expect(readFileSync(component, "utf8"), relative(SOURCE_ROOT, component)).toContain(
        "<ActionDialog",
      );
    }
    const accessSettings = readFileSync(ACCESS_SETTINGS, "utf8");
    expect(accessSettings).toContain('title="重置用户密码"');
    expect(accessSettings).toContain('title="分配用户角色"');
  });

  it("keeps dense data routes visibly responsive while loading and filtering", () => {
    for (const loadingFile of [
      join(SOURCE_ROOT, "app", "cases", "loading.tsx"),
      join(SOURCE_ROOT, "app", "case-suites", "loading.tsx"),
      join(SOURCE_ROOT, "app", "case-suites", "[suiteId]", "loading.tsx"),
      join(SOURCE_ROOT, "app", "execution-records", "loading.tsx"),
      join(SOURCE_ROOT, "app", "case-analysis", "loading.tsx"),
      join(SOURCE_ROOT, "app", "run-batches", "[batchId]", "loading.tsx"),
    ]) {
      expect(readFileSync(loadingFile, "utf8"), relative(SOURCE_ROOT, loadingFile)).toContain(
        "<RouteLoadingSkeleton",
      );
    }
    const skeleton = readFileSync(ROUTE_LOADING_SKELETON, "utf8");
    expect(skeleton).toContain('aria-busy="true"');
    expect(skeleton).toContain('role="status"');
    for (const component of [CASE_SELECTION_TABLE, CASE_SUITE_DETAILS]) {
      const source = readFileSync(component, "utf8");
      expect(source).toContain("useDeferredValue");
      expect(source).toContain("正在筛选");
      expect(source).toContain("aria-busy={filtering}");
    }
  });

  it("keeps every first-level sidebar tab at exactly four Chinese characters", () => {
    // 产品导航采用固定四字节奏。该约束属于信息架构，不允许在视觉改版中随意改回
    // “首页”“用例库”等长度不一致的标签；根级 pnpm test 会在 CI 执行本断言。
    const appShell = readFileSync(APP_SHELL, "utf8");
    const navigationSource = appShell.slice(
      appShell.indexOf("const primaryNavigation:"),
      appShell.indexOf("function isActive("),
    );
    const tabLabels = [
      ...navigationSource.matchAll(/(?:label|fallbackLabel): "([\p{Script=Han}]+)"/gu),
    ].map((match) => match[1]!);

    expect(tabLabels.length).toBeGreaterThan(10);
    expect(tabLabels.filter((label) => [...label].length !== 4)).toEqual([]);
    expect(appShell).toContain('<span className="nav-section-label">系统管理</span>');
    expect(appShell).not.toContain("nav-item-nested");
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
