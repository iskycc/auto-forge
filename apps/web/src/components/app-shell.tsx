"use client";

import {
  BarChart3,
  BookOpenText,
  Bot,
  CalendarClock,
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
};

const navigation: NavigationItem[] = [
  { label: "首页", href: "/", icon: Home, permission: "case.read" },
  { label: "用例库", href: "/cases", icon: BookOpenText, permission: "case.read" },
  { label: "用例任务", href: "/case-suites", icon: Layers3, permission: "case_suite.read" },
  {
    label: "运维计划",
    href: "/settings/automation",
    icon: CalendarClock,
    permission: "case_suite.read",
  },
  { label: "文件来源", href: "/objects", icon: FolderOpen, permission: "case_source.read" },
  { label: "用例批跑", href: "/run-batches", icon: PlayCircle, permission: "run.read" },
  { label: "执行机", href: "/runners", icon: Server, permission: "runner.read" },
  { label: "洞察", href: "/insights", icon: BarChart3, permission: "run.read" },
  { label: "安全审计", href: "/audit", icon: ShieldCheck, permission: "audit.read" },
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

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
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
    : navigation.filter((item) => !item.permission || granted.has(item.permission));

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
            return (
              <Link
                className={`nav-item ${isActive(pathname, item.href) ? "nav-item-active" : ""}`}
                href={item.href}
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
              className={`nav-item ${isActive(pathname, "/settings") ? "nav-item-active" : ""}`}
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
            {!forcePasswordChange && granted.has("case.manage") ? (
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
