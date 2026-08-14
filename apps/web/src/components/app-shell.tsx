"use client";

import {
  BarChart3,
  BookOpenText,
  Bot,
  Boxes,
  CircleHelp,
  Database,
  FileCog,
  Home,
  KeySquare,
  Landmark,
  Network,
  PlayCircle,
  Server,
  FolderOpen,
  Layers3,
  KeyRound,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  UserCog,
  Users,
} from "lucide-react";
import type { Permission } from "@autoforge/domain";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { LogoutButton } from "./logout-button";
import { TopbarTools } from "./topbar-tools";

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

const navigation: NavigationItem[] = [
  { label: "首页", href: "/", icon: Home, permission: "case.read" },
  { label: "用例库", href: "/cases", icon: BookOpenText, permission: "case.read" },
  { label: "用例任务", href: "/case-suites", icon: Layers3, permission: "case_suite.read" },
  {
    label: "运维与审计",
    href: "/settings/automation",
    fallbackHref: "/audit",
    fallbackLabel: "安全审计",
    icon: ShieldCheck,
    anyPermissions: ["case_suite.read", "ldap.read", "audit.read"],
    preferredPermissions: ["case_suite.read", "ldap.read"],
    activePrefixes: ["/settings/automation", "/audit"],
  },
  { label: "文件来源", href: "/objects", icon: FolderOpen, permission: "case_source.read" },
  { label: "用例批跑", href: "/run-batches", icon: PlayCircle, permission: "run.read" },
  { label: "执行机", href: "/runners", icon: Server, permission: "runner.read" },
  { label: "洞察", href: "/insights", icon: BarChart3, permission: "run.read" },
];

const administrationNavigation: NavigationItem[] = [
  { label: "项目管理", href: "/settings/projects", icon: Landmark, permission: "project.read" },
  {
    label: "用户管理",
    href: "/settings/access?section=users",
    icon: Users,
    anyPermissions: ["settings.read", "user.read"],
    activePrefixes: ["/settings/access"],
    section: "users",
    defaultSection: "users",
  },
  {
    label: "角色权限",
    href: "/settings/access?section=roles",
    icon: UserCog,
    anyPermissions: ["settings.read", "role.read"],
    activePrefixes: ["/settings/access"],
    section: "roles",
  },
  {
    label: "项目角色",
    href: "/settings/access?section=projects",
    icon: KeySquare,
    anyPermissions: ["settings.read", "user.read", "role.read"],
    activePrefixes: ["/settings/access"],
    section: "projects",
  },
  {
    label: "LDAP 目录",
    href: "/settings/access?section=ldap",
    icon: Network,
    anyPermissions: ["settings.read", "ldap.read"],
    activePrefixes: ["/settings/access"],
    section: "ldap",
  },
  {
    label: "登录会话",
    href: "/settings/access?section=sessions",
    icon: ShieldCheck,
    anyPermissions: ["settings.read", "user.read"],
    activePrefixes: ["/settings/access"],
    section: "sessions",
  },
  {
    label: "执行环境",
    href: "/settings/environments?section=environments",
    icon: Boxes,
    permission: "environment.read",
    activePrefixes: ["/settings/environments"],
    section: "environments",
    defaultSection: "environments",
  },
  {
    label: "密文管理",
    href: "/settings/environments?section=secrets",
    icon: KeyRound,
    permission: "secret.manage",
    activePrefixes: ["/settings/environments"],
    section: "secrets",
  },
  {
    label: "平台配置",
    href: "/settings/platform?section=configuration",
    icon: FileCog,
    permission: "settings.read",
    activePrefixes: ["/settings/platform"],
    section: "configuration",
    defaultSection: "configuration",
  },
  {
    label: "服务账号",
    href: "/settings/platform?section=accounts",
    icon: KeySquare,
    permission: "settings.read",
    activePrefixes: ["/settings/platform"],
    section: "accounts",
  },
  {
    label: "数据保留",
    href: "/settings/platform?section=retention",
    icon: Database,
    permission: "settings.read",
    activePrefixes: ["/settings/platform"],
    section: "retention",
  },
  {
    label: "系统诊断",
    href: "/settings/platform?section=diagnostics",
    icon: ScanSearch,
    permission: "settings.read",
    activePrefixes: ["/settings/platform"],
    section: "diagnostics",
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
  userName,
  permissions = [],
  forcePasswordChange = false,
}: {
  children: ReactNode;
  mode: "lite" | "full";
  userName?: string;
  permissions?: Permission[] | undefined;
  forcePasswordChange?: boolean;
}) {
  const pathname = usePathname();
  const currentSection = useSearchParams().get("section");
  if (pathname === "/login" || pathname === "/setup" || (pathname === "/" && !userName)) {
    return children;
  }
  const granted = new Set(permissions);
  const visibleNavigation = forcePasswordChange
    ? []
    : navigation.filter(
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

  return (
    <div className="app-shell">
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
                className={`nav-item ${isActive(pathname, currentSection, item) ? "nav-item-active" : ""}`}
                href={href}
                key={item.href}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
          {visibleAdministration.length > 0 ? (
            <span className="nav-section-label">管理</span>
          ) : null}
          {visibleAdministration.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                className={`nav-item ${isActive(pathname, currentSection, item) ? "nav-item-active" : ""}`}
                href={item.href}
                key={item.href}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{item.label}</span>
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
          {forcePasswordChange ? <span /> : <TopbarTools />}
          <div className="topbar-actions">
            {!forcePasswordChange && granted.has("case_source.manage") ? (
              <>
                <Link className="icon-button" href="/cases/import" aria-label="JAR 导入帮助">
                  <CircleHelp size={19} />
                </Link>
                <span className="header-divider" aria-hidden="true" />
              </>
            ) : null}
            {userName ? (
              <Link className="icon-button" href="/account/security" aria-label="账号安全">
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
