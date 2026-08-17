"use client";

import {
  BarChart3,
  BookOpenText,
  Bot,
  Boxes,
  ChevronDown,
  CircleHelp,
  ClipboardList,
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
import { useState, type ReactNode } from "react";

import { LogoutButton } from "./logout-button";
import { TopbarTools } from "./topbar-tools";
import { Button } from "./ui";

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
  { label: "工作概览", href: "/", icon: Home, permission: "case.read" },
  { label: "用例管理", href: "/cases", icon: BookOpenText, permission: "case.read" },
  { label: "用例任务", href: "/case-suites", icon: Layers3, permission: "case_suite.read" },
  { label: "用例批跑", href: "/run-batches", icon: PlayCircle, permission: "run.read" },
  { label: "执行记录", href: "/execution-records", icon: ClipboardList, permission: "run.read" },
  { label: "执行节点", href: "/runners", icon: Server, permission: "runner.read" },
  { label: "质量洞察", href: "/insights", icon: BarChart3, permission: "run.read" },
];

type AdministrationGroup = {
  id: string;
  label: string;
  icon: typeof Home;
  items: NavigationItem[];
};

const administrationGroups: AdministrationGroup[] = [
  {
    id: "projects-access",
    label: "项目与权限",
    icon: Landmark,
    items: [
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
        label: "目录配置",
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
    ],
  },
  {
    id: "execution-platform",
    label: "执行与平台",
    icon: FileCog,
    items: [
      {
        label: "运维审计",
        href: "/settings/automation",
        fallbackHref: "/audit",
        fallbackLabel: "安全审计",
        icon: ShieldCheck,
        anyPermissions: ["case_suite.read", "ldap.read", "audit.read"],
        preferredPermissions: ["case_suite.read", "ldap.read"],
        activePrefixes: ["/settings/automation", "/audit"],
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
      {
        label: "文件来源",
        href: "/objects",
        icon: FolderOpen,
        permission: "case_source.read",
      },
    ],
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
  // 批次详情页归属执行记录：/run-batches 是用例批跑规划页，/run-batches/[id] 是执行详情，
  // 其返回链接也指向执行记录，因此详情页激活“执行记录”而不是“用例批跑”。
  const batchDetailPath = pathname.startsWith("/run-batches/");
  const primaryItemIsActive = (item: NavigationItem): boolean => {
    if (item.href === "/run-batches") {
      return !batchDetailPath && isActive(pathname, currentSection, item);
    }
    if (item.href === "/execution-records") {
      return batchDetailPath || isActive(pathname, currentSection, item);
    }
    return isActive(pathname, currentSection, item);
  };
  const granted = new Set(permissions);
  const visibleNavigation = forcePasswordChange
    ? []
    : navigation.filter(
        (item) =>
          (!item.permission || granted.has(item.permission)) &&
          (!item.anyPermissions ||
            item.anyPermissions.some((permission) => granted.has(permission))),
      );
  const visibleGroups = forcePasswordChange
    ? []
    : administrationGroups
        .map((group) => ({
          ...group,
          items: group.items.filter(
            (item) =>
              (!item.permission || granted.has(item.permission)) &&
              (!item.anyPermissions ||
                item.anyPermissions.some((permission) => granted.has(permission))),
          ),
        }))
        .filter((group) => group.items.length > 0);
  const activeGroupIds = visibleGroups
    .filter((group) => group.items.some((item) => isActive(pathname, currentSection, item)))
    .map((group) => group.id);
  const [openGroupIds, setOpenGroupIds] = useState<ReadonlySet<string>>(
    () => new Set(activeGroupIds),
  );
  const expandedGroupIds = new Set([...openGroupIds, ...activeGroupIds]);
  const toggleGroup = (groupId: string) => {
    setOpenGroupIds((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };
  // /share 前缀是免登录的只读分享页（如执行日志分享），与登录/初始化页一样裸渲染，
  // 不展示侧边栏与顶栏。
  if (
    pathname === "/login" ||
    pathname === "/setup" ||
    pathname.startsWith("/share/") ||
    (pathname === "/" && !userName)
  ) {
    return children;
  }

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
                className={`nav-item ${primaryItemIsActive(item) ? "nav-item-active" : ""}`}
                href={href}
                key={item.href}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
          {visibleGroups.length > 0 ? <span className="nav-section-label">管理</span> : null}
          {visibleGroups.map((group) => {
            const GroupIcon = group.icon;
            const expanded = expandedGroupIds.has(group.id);
            const groupActive = group.items.some((item) =>
              isActive(pathname, currentSection, item),
            );
            return (
              <div className="nav-group" key={group.id}>
                <Button
                  type="button"
                  className={`nav-group-toggle ${groupActive ? "nav-group-toggle-active" : ""}`}
                  aria-expanded={expanded}
                  aria-controls={`nav-group-${group.id}`}
                  onClick={() => toggleGroup(group.id)}
                >
                  <GroupIcon size={19} aria-hidden="true" />
                  <span>{group.label}</span>
                  <ChevronDown
                    size={15}
                    aria-hidden="true"
                    className={`nav-group-chevron ${expanded ? "nav-group-chevron-open" : ""}`}
                  />
                </Button>
                {expanded ? (
                  <div className="nav-group-items" id={`nav-group-${group.id}`}>
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      return (
                        <Link
                          className={`nav-item nav-item-nested ${isActive(pathname, currentSection, item) ? "nav-item-active" : ""}`}
                          href={navigationHref(item, granted)}
                          key={item.href}
                        >
                          <Icon size={17} aria-hidden="true" />
                          <span>{navigationLabel(item, granted)}</span>
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </div>
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
