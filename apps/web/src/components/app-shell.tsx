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
  Settings,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type NavigationItem = {
  label: string;
  href?: string;
  icon: typeof Home;
};

const navigation: NavigationItem[] = [
  { label: "首页", href: "/", icon: Home },
  { label: "用例库", href: "/cases", icon: BookOpenText },
  { label: "执行记录", icon: PlayCircle },
  { label: "执行机", icon: Server },
  { label: "洞察", icon: BarChart3 },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

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
              <strong>Lite 模式</strong>
              <small>SQLite · 本地存储</small>
            </span>
          </div>
          <span className="nav-item nav-item-disabled" aria-disabled="true">
            <Settings size={19} aria-hidden="true" />
            <span>系统设置</span>
            <span className="nav-soon">规划中</span>
          </span>
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
            <span className="admin-label">本地管理员</span>
          </div>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
