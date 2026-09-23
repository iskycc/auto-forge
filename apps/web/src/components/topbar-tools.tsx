"use client";
import { Badge, Menu, Popover } from "antd";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button, Input } from "@/components/ui";

import type { GlobalSearchResult, Notification } from "@autoforge/contracts";
import type { Permission } from "@autoforge/domain";
import { Bell, Check, Search, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { notificationMessage, searchResultSubtitle } from "@/lib/topbar-presentation";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { ConfigurationSearchDialog } from "@/components/configuration-search";

type NotificationPage = { items: Notification[]; nextCursor?: string };
type UnreadNotificationCount = { count: number };
const NOTIFICATION_COUNT_REFRESH_INTERVAL_MS = 30_000;

export function TopbarTools({ permissions = [] }: { permissions?: readonly Permission[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [searchItems, setSearchItems] = useState<GlobalSearchResult["items"]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notificationCursor, setNotificationCursor] = useState<string>();
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState("");
  const [configurationSearchOpen, setConfigurationSearchOpen] = useState(false);
  const [configurationQuery, setConfigurationQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const unreadCountRequestSequence = useRef(0);

  const refreshUnreadCount = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const requestSequence = ++unreadCountRequestSequence.current;
    try {
      const result = await requestJson<UnreadNotificationCount>(
        "/api/v1/notifications/unread-count",
        signal ? { signal } : undefined,
      );
      if (requestSequence === unreadCountRequestSequence.current) {
        setUnreadCount(result.count);
      }
    } catch (problem) {
      if (signal?.aborted || (problem instanceof DOMException && problem.name === "AbortError")) {
        return;
      }
      // 通知角标属于辅助信息；短暂读取失败时保留上一次权威数量，下一轮自动重试。
    }
  }, []);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNotificationsOpen(false);
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshUnreadCount(controller.signal);
      }
    };
    refreshWhenVisible();
    const interval = window.setInterval(refreshWhenVisible, NOTIFICATION_COUNT_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshUnreadCount]);

  useEffect(() => {
    if (query.trim().length < 2) {
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void requestJson<GlobalSearchResult>(
        `/api/v1/search?query=${encodeURIComponent(query.trim())}&limit=20`,
        { signal: controller.signal },
      )
        .then((result) => {
          setSearchItems(result.items);
          setSearchOpen(true);
          setError("");
        })
        .catch((problem: unknown) => {
          if (problem instanceof DOMException && problem.name === "AbortError") return;
          setError(problem instanceof Error ? problem.message : "搜索失败。");
        });
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  function updateQuery(value: string) {
    setQuery(value);
    if (value.trim().length < 2) setSearchOpen(false);
  }

  async function openNotifications() {
    const nextOpen = !notificationsOpen;
    setNotificationsOpen(nextOpen);
    setSearchOpen(false);
    if (!nextOpen) return;
    try {
      const page = await requestJson<NotificationPage>(
        "/api/v1/notifications?unreadOnly=false&limit=30",
      );
      setNotifications(page.items);
      setNotificationCursor(page.nextCursor);
      setError("");
      void refreshUnreadCount();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "读取通知失败。");
    }
  }

  async function loadMoreNotifications() {
    if (!notificationCursor || notificationsLoading) return;
    setNotificationsLoading(true);
    try {
      const page = await requestJson<NotificationPage>(
        `/api/v1/notifications?unreadOnly=false&limit=30&cursor=${encodeURIComponent(notificationCursor)}`,
      );
      setNotifications((current) => {
        const knownIds = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !knownIds.has(item.id))];
      });
      setNotificationCursor(page.nextCursor);
      setError("");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "读取通知失败。");
    } finally {
      setNotificationsLoading(false);
    }
  }

  async function markRead(notification: Notification) {
    if (notification.readAt) return;
    await requestJson(`/api/v1/notifications/${encodeURIComponent(notification.id)}/read`, {
      method: "POST",
    });
    setNotifications((current) =>
      current.map((item) =>
        item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item,
      ),
    );
    unreadCountRequestSequence.current += 1;
    setUnreadCount((current) => Math.max(0, current - 1));
  }
  return (
    <div className={cn("topbar-tools", topbarToolsStyles["topbar-tools"])}>
      <div className={cn("global-search-shell", topbarToolsStyles["global-search-shell"])}>
        <Popover
          open={searchOpen}
          trigger="click"
          onOpenChange={(visible) => {
            if (!visible) setSearchOpen(false);
          }}
          placement="bottomLeft"
          arrow={false}
          styles={{ container: { padding: 0 } }}
          content={
            <div
              aria-label="搜索结果"
              className={cn(
                "topbar-popover search-results",
                topbarToolsStyles["topbar-popover"],
                topbarToolsStyles["search-results"],
              )}
              ref={searchResults}
            >
              <div className={cn("popover-heading", topbarToolsStyles["popover-heading"])}>
                <strong>全局搜索</strong>
                <Button
                  aria-label="关闭搜索结果"
                  onClick={() => setSearchOpen(false)}
                  type="button"
                >
                  <X size={15} />
                </Button>
              </div>
              {searchItems.length === 0 ? (
                <p className={cn("popover-empty", topbarToolsStyles["popover-empty"])}>
                  没有匹配的可访问资源。
                </p>
              ) : (
                <Menu
                  role="listbox"
                  aria-label="搜索结果"
                  selectable={false}
                  className="border-0 [&_.ant-menu-item]:h-auto [&_.ant-menu-item]:whitespace-normal [&_.ant-menu-title-content]:whitespace-normal"
                  onClick={({ key }) => {
                    setSearchOpen(false);
                    router.push(key);
                  }}
                  items={searchItems.map((item) => ({
                    key: item.href,
                    role: "option",
                    label: (
                      <Link
                        href={item.href}
                        key={`${item.kind}:${item.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSearchOpen(false);
                        }}
                      >
                        <span
                          className={cn(
                            "search-result-kind",
                            topbarToolsStyles["search-result-kind"],
                          )}
                        >
                          {kindLabel(item.kind)}
                        </span>
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {searchResultSubtitle(
                              item,
                              searchItems.filter(
                                (candidate) =>
                                  candidate.kind === item.kind &&
                                  candidate.title === item.title &&
                                  candidate.subtitle === item.subtitle,
                              ).length > 1,
                            )}
                          </small>
                        </span>
                      </Link>
                    ),
                  }))}
                />
              )}
            </div>
          }
        >
          <div className={cn("global-search", topbarToolsStyles["global-search"])} role="search">
            <Search size={17} aria-hidden="true" />
            <Input
              aria-label="全局搜索"
              onChange={(event) => updateQuery(event.target.value)}
              onFocus={() => query.trim().length >= 2 && setSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                const firstResult = searchResults.current?.querySelector<HTMLAnchorElement>("a");
                if (!firstResult) return;
                event.preventDefault();
                firstResult.focus();
              }}
              placeholder="搜索用例、任务、执行、Runner…"
              ref={searchInput}
              type="search"
              value={query}
            />
            <kbd>⌘ K</kbd>
          </div>
        </Popover>
      </div>
      <div className={cn("notification-shell", topbarToolsStyles["notification-shell"])}>
        <Button
          aria-label="搜索配置"
          className={cn("icon-button", uiPatterns["icon-button"])}
          onClick={() => {
            setConfigurationSearchOpen(true);
            setSearchOpen(false);
            setNotificationsOpen(false);
          }}
          title="搜索配置"
          type="button"
        >
          <SlidersHorizontal size={18} />
        </Button>
      </div>
      <div className={cn("notification-shell", topbarToolsStyles["notification-shell"])}>
        <Popover
          open={notificationsOpen}
          trigger="click"
          onOpenChange={(visible) => {
            if (!visible) setNotificationsOpen(false);
          }}
          placement="bottomRight"
          arrow={false}
          styles={{ container: { padding: 0 } }}
          content={
            <div
              className={cn(
                "topbar-popover notification-panel",
                topbarToolsStyles["topbar-popover"],
                topbarToolsStyles["notification-panel"],
              )}
            >
              <div className={cn("popover-heading", topbarToolsStyles["popover-heading"])}>
                <strong>通知中心</strong>
                <Button
                  aria-label="关闭通知"
                  onClick={() => setNotificationsOpen(false)}
                  type="button"
                >
                  <X size={15} />
                </Button>
              </div>
              {notifications.length === 0 ? (
                <p className={cn("popover-empty", topbarToolsStyles["popover-empty"])}>
                  暂时没有站内通知。
                </p>
              ) : (
                notifications.map((notification) => (
                  <Button
                    className={
                      notification.readAt
                        ? cn("notification-item read", topbarToolsStyles["notification-item"])
                        : cn("notification-item", topbarToolsStyles["notification-item"])
                    }
                    key={notification.id}
                    onClick={() => void markRead(notification)}
                    type="button"
                  >
                    <span
                      className={cn(
                        topbarToolsStyles["notification-severity"],
                        `notification-severity ${notification.severity}`,
                      )}
                    />
                    <span className="notification-content grid min-w-0 flex-1 gap-[3px]">
                      <strong>{notification.title}</strong>
                      <small>{notificationMessage(notification)}</small>
                      <time>{formatDate(notification.createdAt)}</time>
                    </span>
                    {notification.readAt ? <Check size={14} aria-label="已读" /> : null}
                  </Button>
                ))
              )}
              {notificationCursor ? (
                <Button
                  className={cn(
                    "notification-load-more",
                    topbarToolsStyles["notification-load-more"],
                  )}
                  disabled={notificationsLoading}
                  onClick={() => void loadMoreNotifications()}
                  type="button"
                >
                  {notificationsLoading ? "正在加载…" : "加载更多通知"}
                </Button>
              ) : null}
            </div>
          }
        >
          <Button
            aria-expanded={notificationsOpen}
            aria-label={unreadCount > 0 ? `${unreadCount} 条未读通知` : "通知"}
            className={cn("icon-button", uiPatterns["icon-button"])}
            onClick={() => void openNotifications()}
            title="通知中心"
            type="button"
          >
            <Bell size={19} />
            {unreadCount > 0 ? (
              <Badge
                count={unreadCount}
                color="var(--ant-color-error-active)"
                overflowCount={Number.MAX_SAFE_INTEGER}
                size="small"
                className="-top-0.5 -right-0.5"
                classNames={{ indicator: "notification-count" }}
                styles={{ root: { position: "absolute" }, indicator: { boxShadow: "none" } }}
              />
            ) : null}
          </Button>
        </Popover>
      </div>
      {error ? (
        <span className={cn("topbar-error", topbarToolsStyles["topbar-error"])} role="alert">
          {error}
        </span>
      ) : null}
      <ConfigurationSearchDialog
        onClose={() => setConfigurationSearchOpen(false)}
        onQueryChange={setConfigurationQuery}
        open={configurationSearchOpen}
        permissions={permissions}
        query={configurationQuery}
      />
    </div>
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? "请求失败。");
  }
  return (await response.json()) as T;
}

function kindLabel(kind: GlobalSearchResult["items"][number]["kind"]): string {
  return { case: "用例", suite: "任务", batch: "批次", run: "执行", runner: "Runner" }[kind];
}

function formatDate(value: string): string {
  return formatPlatformDateTime(value, undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const topbarToolsStyles = {
  "global-search":
    "flex w-[min(420px,_42vw)] h-10 items-center gap-[9px] mr-auto [padding:0_10px_0_12px] border border-solid border-border rounded-lg bg-card text-muted-foreground shadow-xs [&:focus-within]:border-info/10 [&:focus-within]:shadow-xs [&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:[outline:0] [&_input]:bg-transparent [&_input]:text-foreground [&_kbd]:py-0.5 [&_kbd]:px-1.5 [&_kbd]:border [&_kbd]:border-solid [&_kbd]:border-border [&_kbd]:rounded-md [&_kbd]:bg-muted [&_kbd]:text-muted-foreground [&_kbd]:text-xs max-[1181px]:[&_kbd]:hidden",
  "global-search-shell":
    "relative w-[min(620px,_100%)] min-w-0 [flex:1_1_620px] max-w-[620px] [&_.global-search]:w-full [&_.global-search]:overflow-hidden max-[1501px]:hidden max-[1181px]:max-w-[490px]",
  "notification-item":
    "flex h-auto items-center w-full whitespace-normal gap-3 p-2.5 border-0 rounded-lg bg-transparent text-foreground text-left [text-decoration:none] cursor-pointer [&:hover]:bg-muted [&:hover]:[outline:none] [&:focus-visible]:bg-muted [&:focus-visible]:[outline:none] [&_small]:text-muted-foreground [&_small]:[overflow-wrap:anywhere] [&_small]:whitespace-normal [&.read]:opacity-68 [&_time]:text-muted-foreground [&_time]:text-xs",
  "notification-load-more": "w-[calc(100%_-_24px)] [margin:8px_12px_12px]",
  "notification-panel": "right-0 w-[390px] max-h-[min(620px,_72vh)] overflow-auto",
  "notification-severity":
    "w-2 h-2 [flex:0_0_auto] rounded-full bg-info [&.warning]:bg-warning [&.critical]:bg-destructive",
  "notification-shell": "relative [flex:0_0_auto] [&_.icon-button]:relative",
  "popover-empty": "m-0 py-6 px-3 text-muted-foreground text-center",
  "popover-heading":
    "flex items-center justify-between [padding:5px_7px_10px] [&_button]:grid [&_button]:place-items-center [&_button]:w-8 [&_button]:min-h-8 [&_button]:border-0 [&_button]:rounded-lg [&_button]:bg-transparent [&_button]:text-muted-foreground [&_button]:cursor-pointer",
  "search-result-kind":
    "min-w-12 py-1 px-[7px] rounded-full bg-info/10 text-info text-xs text-center",
  "search-results":
    "left-0 w-[min(620px,_52vw)] max-h-[min(620px,_70vh)] overflow-auto [&_.ant-menu-item_a]:flex [&_.ant-menu-item_a]:items-center [&_.ant-menu-item_a]:w-full [&_.ant-menu-item_a]:gap-3 [&_.ant-menu-item_a]:p-2.5 [&_.ant-menu-item_a]:border-0 [&_.ant-menu-item_a]:rounded-lg [&_.ant-menu-item_a]:bg-transparent [&_.ant-menu-item_a]:text-foreground [&_.ant-menu-item_a]:text-left [&_.ant-menu-item_a]:[text-decoration:none] [&_.ant-menu-item_a]:cursor-pointer [&_.ant-menu-item_a:hover]:bg-muted [&_.ant-menu-item_a:hover]:[outline:none] [&_.ant-menu-item_a:focus-visible]:bg-muted [&_.ant-menu-item_a:focus-visible]:[outline:none] [&_a_>_span:last-child]:grid [&_a_>_span:last-child]:min-w-0 [&_a_>_span:last-child]:gap-[3px] [&_a_>_span:last-child]:flex-1 [&_small]:text-muted-foreground [&_small]:[overflow-wrap:anywhere] [&_small]:whitespace-normal max-[1181px]:w-[min(490px,_65vw)]",
  "topbar-error": "absolute top-[calc(100%_+_8px)] left-0 text-destructive text-xs",
  "topbar-popover": "p-2.5",
  "topbar-tools":
    "relative grid [flex:1_1_auto] grid-cols-[minmax(0,_1fr)_repeat(2,_auto)] items-center gap-2.5 min-w-min max-[1501px]:[flex:0_0_auto] max-[1501px]:grid-cols-[repeat(2,_auto)]",
} as const;
