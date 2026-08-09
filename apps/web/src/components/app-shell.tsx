"use client";

import {
  BarChart3,
  Bell,
  BookOpenText,
  Bot,
  CircleHelp,
  Home,
  PlayCircle,
  Search,
  Server,
  FolderOpen,
  Layers3,
  Settings,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { LogoutButton } from "./logout-button";

type NavigationItem = {
  label: string;
  href?: string;
  icon: typeof Home;
};

const navigation: NavigationItem[] = [
  { label: "首页", href: "/", icon: Home },
  { label: "用例库", href: "/cases", icon: BookOpenText },
  { label: "用例任务", href: "/case-suites", icon: Layers3 },
  { label: "文件来源", href: "/objects", icon: FolderOpen },
  { label: "用例批跑", href: "/run-batches", icon: PlayCircle },
  { label: "执行机", href: "/runners", icon: Server },
  { label: "洞察", icon: BarChart3 },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  children,
  mode,
  userName,
}: {
  children: ReactNode;
  mode: "lite" | "full";
  userName?: string;
}) {
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/setup") return children;

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
          {navigation.map((item) => {
            const Icon = item.icon;
            if (!item.href) {
              return (
                <span className="nav-item nav-item-disabled" aria-disabled="true" key={item.label}>
                  <Icon size={19} aria-hidden="true" />
                  <span>{item.label}</span>
                  <span className="nav-soon">规划中</span>
                </span>
              );
            }
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
        </nav>

        <div className="sidebar-footer">
          <div className="mode-card">
            <span className="mode-indicator" aria-hidden="true" />
            <span>
              <strong>{mode === "lite" ? "Lite 模式" : "Full 模式"}</strong>
              <small>{mode === "lite" ? "SQLite · 本地存储" : "PostgreSQL · MinIO"}</small>
            </span>
          </div>
          <Link
            className={`nav-item ${isActive(pathname, "/settings") ? "nav-item-active" : ""}`}
            href="/settings/access"
          >
            <Settings size={19} aria-hidden="true" />
            <span>系统设置</span>
          </Link>
        </div>
      </aside>

      <div className="app-frame">
        <header className="topbar">
          <form className="global-search" action="/cases" role="search">
            <Search size={17} aria-hidden="true" />
            <input name="query" type="search" placeholder="搜索测试类…" aria-label="搜索测试类" />
            <kbd>⌘ K</kbd>
          </form>
          <div className="topbar-actions">
            <button className="icon-button" type="button" aria-label="通知（尚未启用）" disabled>
              <Bell size={19} />
            </button>
            <Link className="icon-button" href="/cases/import" aria-label="JAR 导入帮助">
              <CircleHelp size={19} />
            </Link>
            <span className="header-divider" aria-hidden="true" />
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
