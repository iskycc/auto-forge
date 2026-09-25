"use client";
import { Avatar } from "antd";

import { BrandMark } from "./brand-mark";
import { Menu } from "antd";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import {
  BarChart3,
  BookOpenText,
  Bot,
  CircleHelp,
  ClipboardList,
  FileCog,
  Home,
  KeyRound,
  Server,
  FolderOpen,
  Layers3,
  ShieldCheck,
  SearchCheck,
  Webhook,
} from "lucide-react";
import type { Permission } from "@autoforge/domain";
import Link from "next/link";
import { LinkButton } from "@/components/ui/link-button";
import { usePathname, useSearchParams } from "next/navigation";
import { useContentTransition } from "./ui/tab-content";
import { NavigationPendingIndicator } from "./navigation-pending-indicator";
import type { ReactNode } from "react";

import { configureBrowserCacheScope } from "@/lib/browser-read-cache";
import { LogoutButton } from "./logout-button";
import { TopbarTools } from "./topbar-tools";
import { GlobalRunDialog } from "./global-run-dialog";
import { GlobalProjectSwitcher } from "./global-project-switcher";
import { configurePlatformTimeZone } from "@/lib/platform-date-time";
import { SessionKeepalive } from "./session-keepalive";
import { ColorModeToggle } from "./color-mode-toggle";

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
    label: "组织管理",
    href: "/settings/access?section=users",
    icon: ShieldCheck,
    anyPermissions: ["project.read", "settings.read", "user.read", "role.read", "ldap.read"],
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

function navigationEntry(item: NavigationItem, active: boolean, granted: ReadonlySet<Permission>) {
  const Icon = item.icon;
  return {
    key: item.href,
    label: (
      <Link
        href={navigationHref(item, granted)}
        aria-current={active ? "page" : undefined}
        className={cn("nav-item flex items-center gap-3", active && "nav-item-active")}
      >
        <NavigationPendingIndicator className="size-5">
          <Icon size={19} className="shrink-0" aria-hidden="true" />
        </NavigationPendingIndicator>
        <span>{navigationLabel(item, granted)}</span>
      </Link>
    ),
  };
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
  canCreateProject = false,
  canManageSelectedProject = false,
  canReadSelectedProject = false,
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
  canCreateProject?: boolean;
  canManageSelectedProject?: boolean;
  canReadSelectedProject?: boolean;
  projectVersions?: Array<{
    id: string;
    name: string;
    stages: Array<{ id: string; name: string }>;
  }>;
  selectedProjectVersionId?: string | undefined;
  selectedTestStageId?: string | undefined;
}) {
  configurePlatformTimeZone(timeZone);
  if (typeof window !== "undefined")
    configureBrowserCacheScope(
      `${userId ?? "anonymous"}:${selectedProjectId ?? ""}:${selectedProjectVersionId ?? ""}:${selectedTestStageId ?? ""}:${permissions.join(",")}`,
    );
  const pathname = usePathname();
  const pageContentRef = useContentTransition<HTMLElement>(pathname);
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
    <div className={cn("app-shell", appShellStyles["app-shell"])}>
      <SessionKeepalive />
      <aside className={cn("sidebar", appShellStyles["sidebar"])}>
        <Link className={cn("brand", appShellStyles["brand"])} href="/" aria-label="AutoForge 首页">
          <span className={cn("brand-mark", appShellStyles["brand-mark"])} aria-hidden="true">
            <BrandMark />
          </span>
          <span>AutoForge</span>
        </Link>

        <nav className={cn("primary-nav", appShellStyles["primary-nav"])} aria-label="主导航">
          <Menu
            mode="inline"
            className="border-0 bg-transparent"
            selectedKeys={visibleNavigation.filter(primaryItemIsActive).map((item) => item.href)}
            items={visibleNavigation.map((item) =>
              navigationEntry(item, primaryItemIsActive(item), granted),
            )}
          />
          {visibleAdministration.length > 0 ? (
            <>
              <span className={cn("nav-section-label", appShellStyles["nav-section-label"])}>
                系统管理
              </span>
              <Menu
                mode="inline"
                className="border-0 bg-transparent"
                selectedKeys={visibleAdministration
                  .filter((item) => isActive(pathname, currentSection, item))
                  .map((item) => item.href)}
                items={visibleAdministration.map((item) =>
                  navigationEntry(item, isActive(pathname, currentSection, item), granted),
                )}
              />
            </>
          ) : null}
        </nav>

        <div className={cn("sidebar-footer", appShellStyles["sidebar-footer"])}>
          <div className={cn("mode-card", appShellStyles["mode-card"])}>
            <span
              className={cn("mode-indicator", appShellStyles["mode-indicator"])}
              aria-hidden="true"
            />
            <span>
              <strong>{mode === "lite" ? "Lite 模式" : "Full 模式"}</strong>
              <small>{mode === "lite" ? "SQLite · 本地存储" : "PostgreSQL · MinIO"}</small>
            </span>
          </div>
        </div>
      </aside>

      <div className={cn("app-frame", appShellStyles["app-frame"])}>
        <header className={cn("topbar", appShellStyles["topbar"])}>
          {forcePasswordChange ? (
            <span />
          ) : (
            <div className={cn("topbar-context", appShellStyles["topbar-context"])}>
              {selectedProjectId || canCreateProject ? (
                <GlobalProjectSwitcher
                  key={`${selectedProjectId}:${selectedProjectVersionId ?? ""}:${selectedTestStageId ?? ""}`}
                  projects={projects}
                  projectVersions={projectVersions}
                  {...(selectedProjectId ? { selectedProjectId } : {})}
                  canCreateProject={canCreateProject}
                  canManageSelectedProject={canManageSelectedProject}
                  canReadSelectedProject={canReadSelectedProject}
                  {...(selectedProjectVersionId ? { selectedProjectVersionId } : {})}
                  {...(selectedTestStageId ? { selectedTestStageId } : {})}
                />
              ) : null}
              <TopbarTools permissions={permissions} />
            </div>
          )}
          <div className={cn("topbar-actions", appShellStyles["topbar-actions"])}>
            <ColorModeToggle />
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
                <LinkButton
                  className={cn("icon-button", uiPatterns["icon-button"])}
                  href="/cases/import"
                  aria-label="JAR 导入帮助"
                  title="JAR 导入帮助"
                >
                  <CircleHelp size={19} />
                </LinkButton>
                <span
                  className={cn("header-divider", appShellStyles["header-divider"])}
                  aria-hidden="true"
                />
              </>
            ) : null}
            {userName ? (
              <LinkButton
                className={cn("icon-button", uiPatterns["icon-button"])}
                href="/account/security"
                aria-label="账号安全"
                title="账号安全"
              >
                <KeyRound size={18} />
              </LinkButton>
            ) : null}
            <Avatar className={cn("avatar", appShellStyles["avatar"])} aria-hidden="true">
              <Bot size={17} />
            </Avatar>
            <span className={cn("admin-label", appShellStyles["admin-label"])}>
              {userName ?? "未登录"}
            </span>
            {userName ? <LogoutButton /> : null}
          </div>
        </header>
        <main ref={pageContentRef} className={cn("main-content", appShellStyles["main-content"])}>
          {children}
        </main>
      </div>
    </div>
  );
}

const appShellStyles = {
  "admin-label": "max-w-28 truncate text-sm font-medium max-[1279px]:hidden",
  "app-frame": "min-h-screen ml-[208px] max-[1279px]:ml-[176px]",
  "app-shell": "min-h-screen",
  avatar:
    "inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground",
  brand:
    "flex h-16 shrink-0 items-center gap-3 border-b border-border px-5 text-xl font-semibold tracking-tight",
  "brand-mark": "inline-flex size-8 shrink-0 items-center justify-center rounded-lg",
  "header-divider": "mx-1 h-5 w-px bg-border",
  "main-content": "min-w-0 p-6 max-[1279px]:p-4",
  "mode-card":
    "flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 [&>span:last-child]:grid [&>span:last-child]:min-w-0 [&>span:last-child]:gap-1 [&_strong]:text-xs [&_strong]:font-medium [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground",
  "mode-indicator": "size-2 shrink-0 rounded-full bg-success",
  "nav-item":
    "flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
  "nav-item-active": "bg-accent text-foreground",
  "nav-section-label": "mb-1 mt-5 px-3 text-xs font-medium text-muted-foreground",
  "primary-nav": "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3",
  sidebar:
    "fixed inset-y-0 left-0 z-20 flex w-[208px] flex-col border-r border-border bg-card max-[1279px]:w-[176px]",
  "sidebar-footer": "shrink-0 p-3",
  topbar:
    "sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-border bg-card px-6 max-[1279px]:gap-3 max-[1279px]:px-4",
  "topbar-actions": "flex shrink-0 items-center gap-2 max-[1279px]:gap-1",
  "topbar-context": "flex min-w-0 flex-1 items-center gap-3",
} as const;
