"use client";

import {
  BarChart3,
  BookOpenText,
  Bot,
  CircleHelp,
  Home,
  PlayCircle,
  Server,
  FolderOpen,
  Layers3,
  KeyRound,
  ShieldCheck,
  Settings,
  Sparkles,
} from "lucide-react";
import type { Permission } from "@autoforge/domain";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  activePrefixes?: string[];
};

const navigation: NavigationItem[] = [
  { label: "首页", href: "/", icon: Home, permission: "case.read" },
  { label: "用例库", href: "/cases", icon: BookOpenText, permission: "case.read" },
  { label: "用例任务", href: "/case-suites", icon: Layers3, permission: "case_suite.read" },
  {
    label: "运维与审计",
    href: "/settings/automation",
    fallbackHref: "/audit",
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

const managementPermissions: Permission[] = [
  "settings.read",
  "user.read",
  "role.read",
  "ldap.read",
  "project.read",
  "environment.read",
  "secret.manage",
  "api_token.manage",
];

function isActive(pathname: string, item: NavigationItem): boolean {
  const prefixes = item.activePrefixes ?? [item.href];
  return isActiveForPrefixes(pathname, prefixes);
}

function isActiveForPrefixes(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) =>
    prefix === "/" ? pathname === prefix : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isManagementActive(pathname: string): boolean {
  return (
    isActiveForPrefixes(pathname, ["/settings"]) &&
    !isActiveForPrefixes(pathname, ["/settings/automation"])
  );
}

function navigationHref(item: NavigationItem, granted: ReadonlySet<Permission>): string {
  if (
    item.fallbackHref &&
    item.preferredPermissions &&
    !item.preferredPermissions.some((permission) => granted.has(permission))
  ) {
    return item.fallbackHref;
  }
  return item.href;
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
  if (pathname === "/login" || pathname === "/setup" || (pathname === "/" && !userName)) {
    return children;
  }
  const granted = new Set(permissions);
  const managementHref = granted.has("settings.read")
    ? "/settings"
    : granted.has("project.read")
      ? "/settings/projects"
      : granted.has("ldap.read")
        ? "/settings/automation"
        : granted.has("environment.read") || granted.has("secret.manage")
          ? "/settings/environments"
          : "/settings/access";
  const visibleNavigation = forcePasswordChange
    ? []
    : navigation.filter(
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
            return (
              <Link
                className={`nav-item ${isActive(pathname, item) ? "nav-item-active" : ""}`}
                href={href}
                key={item.href}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
          {!forcePasswordChange &&
          managementPermissions.some((permission) => granted.has(permission)) ? (
            <Link
              className={`nav-item ${isManagementActive(pathname) ? "nav-item-active" : ""}`}
              href={managementHref}
            >
              <Settings size={19} aria-hidden="true" />
              <span>管理中心</span>
            </Link>
          ) : null}
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
