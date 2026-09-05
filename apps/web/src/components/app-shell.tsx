"use client";

import {
  BarChart3,
  BookOpenText,
  Bot,
  CircleHelp,
  ClipboardList,
  FileCog,
  Home,
  KeyRound,
  Landmark,
  Server,
  FolderOpen,
  Layers3,
  ShieldCheck,
  SearchCheck,
  Sparkles,
  Webhook,
} from "lucide-react";
import type { Permission } from "@autoforge/domain";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { LogoutButton } from "./logout-button";
import { TopbarTools } from "./topbar-tools";
import { GlobalRunDialog } from "./global-run-dialog";
import { GlobalProjectSwitcher } from "./global-project-switcher";
import { configurePlatformTimeZone } from "@/lib/platform-date-time";
import { SessionKeepalive } from "./session-keepalive";

type NavigationItem = {
  label: string;
  href: string;
  icon: typeof Home;
  permission?: Permission;
  anyPermissions?: Permission[];
  preferredPermissions?: Permission[];
  fallbackHref?: string;
  fallbackLabel?: string;
  activePrefixes?: string[];
  section?: string;
  defaultSection?: string;
};

const primaryNavigation: NavigationItem[] = [
  { label: "工作概览", href: "/", icon: Home, permission: "case.read" },
  { label: "用例管理", href: "/cases", icon: BookOpenText, permission: "case.read" },
  { label: "用例任务", href: "/case-suites", icon: Layers3, permission: "case_suite.read" },
  { label: "执行记录", href: "/execution-records", icon: ClipboardList, permission: "run.read" },
  {
    label: "执行节点",
    href: "/runners",
    icon: Server,
    permission: "runner.read",
    section: "runners",
    defaultSection: "runners",
  },
  { label: "质量洞察", href: "/insights", icon: BarChart3, permission: "run.read" },
  { label: "用例分析", href: "/case-analysis", icon: SearchCheck, permission: "run.read" },
];

const administrationNavigation: NavigationItem[] = [
  {
    label: "项目管理",
    href: "/settings/projects",
    icon: Landmark,
    permission: "project.read",
  },
  {
    label: "访问管理",
    href: "/settings/access?section=users",
    icon: ShieldCheck,
    anyPermissions: ["settings.read", "user.read", "role.read", "ldap.read"],
    activePrefixes: ["/settings/access"],
  },
  {
    label: "回调通知",
    href: "/settings/webhooks",
    icon: Webhook,
    permission: "project.read",
  },
  {
    label: "执行机组",
    href: "/runners?section=groups",
    icon: Server,
    permission: "runner.read",
    activePrefixes: ["/runners"],
    section: "groups",
  },
  {
    label: "安全审计",
    href: "/audit",
    icon: ShieldCheck,
    permission: "audit.read",
  },
  {
    label: "平台设置",
    href: "/settings/platform?section=configuration",
    icon: FileCog,
    permission: "settings.read",
    activePrefixes: ["/settings/platform"],
  },
  {
    label: "文件来源",
    href: "/objects",
    icon: FolderOpen,
    permission: "case_source.read",
  },
];

function isActive(pathname: string, section: string | null, item: NavigationItem): boolean {
  const prefixes = item.activePrefixes ?? [item.href];
  if (!isActiveForPrefixes(pathname, prefixes)) return false;
  if (!item.section) return true;
  return section === item.section || (!section && item.defaultSection === item.section);
}

function isActiveForPrefixes(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) =>
    prefix === "/" ? pathname === prefix : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function navigationHref(item: NavigationItem, granted: ReadonlySet<Permission>): string {
  if (usesFallbackNavigation(item, granted) && item.fallbackHref) {
    return item.fallbackHref;
  }
  return item.href;
}

function navigationLabel(item: NavigationItem, granted: ReadonlySet<Permission>): string {
  return usesFallbackNavigation(item, granted) && item.fallbackLabel
    ? item.fallbackLabel
    : item.label;
}

function usesFallbackNavigation(item: NavigationItem, granted: ReadonlySet<Permission>): boolean {
  return Boolean(
    item.fallbackHref &&
    item.preferredPermissions &&
    !item.preferredPermissions.some((permission) => granted.has(permission)),
  );
}

export function AppShell({
  children,
  mode,
  timeZone,
  userName,
  userId,
  permissions = [],
  forcePasswordChange = false,
  projects = [],
  selectedProjectId,
  projectVersions = [],
  selectedProjectVersionId,
  selectedTestStageId,
}: {
  children: ReactNode;
  mode: "lite" | "full";
  timeZone: string;
  userName?: string;
  userId?: string;
  permissions?: Permission[] | undefined;
  forcePasswordChange?: boolean;
  projects?: Array<{ id: string; name: string }>;
  selectedProjectId?: string | undefined;
  projectVersions?: Array<{
    id: string;
    name: string;
    stages: Array<{ id: string; name: string }>;
  }>;
  selectedProjectVersionId?: string | undefined;
  selectedTestStageId?: string | undefined;
}) {
  configurePlatformTimeZone(timeZone);
  const pathname = usePathname();
  const currentSection = useSearchParams().get("section");
  // 保留 /run-batches/[id] 详情路由，但所有批次入口统一归属“执行记录”。
  const batchDetailPath = pathname.startsWith("/run-batches/");
  const primaryItemIsActive = (item: NavigationItem): boolean => {
    if (item.href === "/execution-records") {
      return batchDetailPath || isActive(pathname, currentSection, item);
    }
    return isActive(pathname, currentSection, item);
  };
  const granted = new Set(permissions);
  const visibleNavigation = forcePasswordChange
    ? []
    : primaryNavigation.filter(
        (item) =>
          (!item.permission || granted.has(item.permission)) &&
          (!item.anyPermissions ||
            item.anyPermissions.some((permission) => granted.has(permission))),
      );
  const visibleAdministration = forcePasswordChange
    ? []
    : administrationNavigation.filter(
        (item) =>
          (!item.permission || granted.has(item.permission)) &&
          (!item.anyPermissions ||
            item.anyPermissions.some((permission) => granted.has(permission))),
      );
  // /share 前缀是免登录的只读公开页（如执行日志公开访问），与登录/初始化页一样裸渲染，
  // 不展示侧边栏与顶栏。
  if (
    pathname === "/login" ||
    pathname === "/setup" ||
    pathname.startsWith("/share/") ||
    pathname.startsWith("/progress/") ||
    (pathname === "/" && !userName)
  ) {
    return children;
  }

  return (
    <div className="app-shell">
      <SessionKeepalive />
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="AutoForge 首页">
          <span className="brand-mark" aria-hidden="true">
            <Sparkles size={20} strokeWidth={2.2} />
          </span>
          <span>AutoForge</span>
        </Link>

        <nav className="primary-nav" aria-label="主导航">
          {visibleNavigation.map((item) => {
            const Icon = item.icon;
            const href = navigationHref(item, granted);
            const label = navigationLabel(item, granted);
            return (
              <Link
                className={`nav-item ${primaryItemIsActive(item) ? "nav-item-active" : ""}`}
                href={href}
                key={item.href}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
          {visibleAdministration.length > 0 ? (
            <span className="nav-section-label">系统管理</span>
          ) : null}
          {visibleAdministration.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                className={`nav-item ${isActive(pathname, currentSection, item) ? "nav-item-active" : ""}`}
                href={navigationHref(item, granted)}
                key={item.href}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{navigationLabel(item, granted)}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="mode-card">
            <span className="mode-indicator" aria-hidden="true" />
            <span>
              <strong>{mode === "lite" ? "Lite 模式" : "Full 模式"}</strong>
              <small>{mode === "lite" ? "SQLite · 本地存储" : "PostgreSQL · MinIO"}</small>
            </span>
          </div>
        </div>
      </aside>

      <div className="app-frame">
        <header className="topbar">
          {forcePasswordChange ? (
            <span />
          ) : (
            <div className="topbar-context">
              {selectedProjectId ? (
                <GlobalProjectSwitcher
                  key={`${selectedProjectId}:${selectedProjectVersionId ?? ""}:${selectedTestStageId ?? ""}`}
                  projects={projects}
                  projectVersions={projectVersions}
                  selectedProjectId={selectedProjectId}
                  {...(selectedProjectVersionId ? { selectedProjectVersionId } : {})}
                  {...(selectedTestStageId ? { selectedTestStageId } : {})}
                />
              ) : null}
              <TopbarTools permissions={permissions} />
            </div>
          )}
          <div className="topbar-actions">
            {!forcePasswordChange ? (
              <GlobalRunDialog
                userId={userId ?? ""}
                enabled={granted.has("run.create")}
                {...(selectedProjectId ? { projectId: selectedProjectId } : {})}
                {...(selectedProjectVersionId
                  ? { projectVersionId: selectedProjectVersionId }
                  : {})}
                {...(selectedTestStageId ? { testStageId: selectedTestStageId } : {})}
              />
            ) : null}
            {!forcePasswordChange && granted.has("case_source.manage") ? (
              <>
                <Link
                  className="icon-button"
                  href="/cases/import"
                  aria-label="JAR 导入帮助"
                  title="JAR 导入帮助"
                >
                  <CircleHelp size={19} />
                </Link>
                <span className="header-divider" aria-hidden="true" />
              </>
            ) : null}
            {userName ? (
              <Link
                className="icon-button"
                href="/account/security"
                aria-label="账号安全"
                title="账号安全"
              >
                <KeyRound size={18} />
              </Link>
            ) : null}
            <span className="avatar" aria-hidden="true">
              <Bot size={17} />
            </span>
            <span className="admin-label">{userName ?? "未登录"}</span>
            {userName ? <LogoutButton /> : null}
          </div>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
